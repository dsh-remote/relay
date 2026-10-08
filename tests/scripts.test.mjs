/**
 * scripts.test — 两个随仓发布的运维脚本的判据（P2）。
 *
 * 它们不在 tsc 的编译面里，但都是"照着文档就会跑"的东西，错了同样是线上事故：
 * - `relay-start.sh` 曾经默认 `DRC_LOG_LEVEL=debug`，而中继在 debug 级会打印
 *   **完整配对码**——"起一个本地中继"于是默认落一份完整码在终端/日志里；
 *   另外它用 `%"${VAR#????}"` 取前 4 位，token 短于 4 字符时求值出的是**整个值**。
 * - `loadtest-conns.mjs` 原本没有 try/finally：装置自己抛错时子中继进程与日志流
 *   都不回收（一次失败的压测留下一个继续占端口、继续吃内存的中继），
 *   ROOT 还用 `URL.pathname`（路径里有空格/中文时拿到的是 URL 编码）。
 *
 * 行为判据尽量落在"外部可观测的事实"上，而不是源码里有没有某个字符串：
 * 短 token 那条真的起一次脚本、看它有没有把值打出来；收尾那条真的让装置抛错，
 * 再看子中继有没有走完停机（停机路径会补写一次状态文件，见下）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RELAY_START = join(ROOT, 'scripts', 'relay-start.sh')
const LOADTEST = join(ROOT, 'scripts', 'loadtest-conns.mjs')

/** 轮询等一个条件成立；超时返回 false，不抛（调用方自己给断言消息）。 */
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20)
  }
  return predicate()
}

test('relay-start.sh：默认日志级别是 info —— debug 级会把完整配对码打进日志', () => {
  const source = readFileSync(RELAY_START, 'utf8')
  assert.match(
    source,
    /DRC_LOG_LEVEL:-info/,
    '默认级别必须是显式的 info：server.ts 在 debug 级打印完整配对码（pair token issued (debug)）',
  )
  assert.ok(
    !/DRC_LOG_LEVEL:-debug/.test(source),
    '照文档起一个中继不该默认把完整配对码落进终端/日志；要排错请显式 DRC_LOG_LEVEL=debug',
  )
})

test('relay-start.sh：patch 文件里的短 token 一个字符都不打印（长度守卫）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drc-start-'))
  try {
    // 短于 4 字符：`%"${TOKEN#????}"` 在旧写法里会求值出整个 token。
    writeFileSync(join(dir, 'cordis.patch.yml'), 'plugins:\n  hostToken: abc\n')
    const env = { ...process.env, DSH_PROFILE: dir, DRC_PORT: '0' }
    // 必须让脚本走"从 patch 文件读"的这条路：环境里有 DRC_HOST_TOKEN 就轮不到它。
    delete env.DRC_HOST_TOKEN
    const child = spawn('sh', [RELAY_START], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => (out += c.toString()))
    child.stderr.on('data', (c) => (out += c.toString()))
    try {
      // 脚本是 `exec node …`：等到中继真的起来了，就说明整条路都跑通了。
      const up = await waitUntil(() => out.includes('relay listening'), 8000)
      assert.ok(up, `relay-start.sh 没起来（或没打印启动行）：${out.slice(-400)}`)
      assert.ok(!out.includes('abc'), `短 token 的值被打出来了：${out.slice(0, 200)}`)
      assert.match(out, /短于 4 字符/, '短 token 要走守卫分支并说明只报了长度')
    } finally {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.on('exit', resolve))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadtest-conns.mjs：ROOT 用 fileURLToPath，不再用 URL.pathname', () => {
  const source = readFileSync(LOADTEST, 'utf8')
  assert.match(source, /fileURLToPath\(new URL\('\.\.', import\.meta\.url\)\)/, 'ROOT 要能被 fileURLToPath 正确解码')
  assert.ok(
    !/new URL\('\.\.', import\.meta\.url\)\.pathname/.test(source),
    'pathname 在路径带空格/中文时给出 URL 编码，会让产物路径找不到',
  )
})

test('loadtest-conns.mjs：装置自己抛错时也回收子中继（try/finally + kill）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drc-loadtest-'))
  // 子中继的停机路径（close() → persistNow()）会写一次状态文件。它是"子进程真的
  // 收到了 SIGTERM 并走完停机"的外部可观测证据——不需要去猜 pid、也不需要扫进程表。
  const stateFile = join(dir, 'state.json')
  try {
    const child = spawn(
      process.execPath,
      [LOADTEST, '--n=2', '--seconds=3', '--sample-ms=400', '--probe-ms=25', '--ramp-batch=1', `--out-dir=${dir}`],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          DRC_LOG_LEVEL: 'info',
          DRC_STATE_FILE: stateFile,
          // 关掉周期补写（sweep 不跑）：状态文件只可能由停机那一次写盘产生。
          DRC_SWEEP_MS: '3600000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c.toString()))
    const exited = new Promise((resolve) => child.on('exit', resolve))

    // 采样期第一次 `statSync(relayLogPath)` 之前把中继日志删掉：装置会在
    // "子进程已经起来之后"抛错——这正是旧实现把子进程留在机器上的那条路径。
    const logFile = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 10_000
      const tick = () => {
        const hit = readdirSync(dir).find((name) => name.endsWith('.relay.log'))
        if (hit) return resolve(join(dir, hit))
        if (Date.now() > deadline) return reject(new Error(`等不到中继日志文件；stderr=${stderr.slice(0, 300)}`))
        setTimeout(tick, 10)
      }
      tick()
    })
    unlinkSync(logFile)

    const code = await exited
    assert.notEqual(code, 0, `装置抛错后必须非 0 退出（实际 ${code}）`)
    assert.match(stderr, /loadtest 失败/, `失败原因要落在 stderr 上：${stderr.slice(0, 300)}`)
    assert.ok(
      existsSync(stateFile),
      '子中继没被回收：装置抛错后没有 kill，停机写盘（状态文件）不存在——旧实现会在这里留下一个孤儿中继进程',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
