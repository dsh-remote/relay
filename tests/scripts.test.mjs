/**
 * scripts.test — 两个随仓发布的运维脚本的判据（P2）。
 *
 * 它们不在 tsc 的编译面里，但都是"照着文档就会跑"的东西，错了同样是线上事故：
 * - `relay-start.mjs` 曾经默认 `DRC_LOG_LEVEL=debug`，而中继在 debug 级会打印
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
const RELAY_START = join(ROOT, 'scripts', 'relay-start.mjs')
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

test('relay-start.mjs：默认日志级别是 info —— debug 级会把完整配对码打进日志', () => {
  const source = readFileSync(RELAY_START, 'utf8')
  // ⚠️ v2 的判据写的是 `/DRC_LOG_LEVEL:-info/`（那是 shell 的 `${X:-info}` 语法）。
  // v3 改成 `.mjs` 之后默认值由 `??` 表达，锚点跟着改——**判据要测的东西没变**：
  // 默认必须是显式的 info。两条正则都留着，删掉任何一条都会让这条判据变弱。
  assert.match(
    source,
    /DRC_LOG_LEVEL\s*\?\?\s*'info'/,
    '默认级别必须是显式的 info：server.ts 在 debug 级打印完整配对码（pair token issued (debug)）',
  )
  assert.doesNotMatch(
    source,
    /DRC_LOG_LEVEL\s*\?\?\s*'debug'/,
    '照文档起一个中继不该默认把完整配对码落进终端/日志；要排错请显式 DRC_LOG_LEVEL=debug',
  )
  // 反向判据：旧 shell 形态不该再出现（.mjs 里留着它说明有人把 shell 写法抄了回来）
  assert.doesNotMatch(source, /DRC_LOG_LEVEL:-/, '这是 shell 的 ${X:-info} 写法，不该出现在 .mjs 里')
})

test('readHostToken：patch 文件里的 hostToken 各种写法都能取到（v2 用 grep -oE 拼的）', async () => {
  // 动态 import 拿纯函数出来测。v2 那条 `grep -oE | head -1 | sed -E` 没法被单测直接调，
  // 换 .mjs 之后它就是一段纯函数，**每个形态都能逐格验**。
  const { readHostToken } = await import(RELAY_START)
  for (const [yaml, want] of [
    ['plugins:\n  hostToken: abc123\n', 'abc123'],
    ['hostToken: "quoted-token"\n', 'quoted-token'],
    ["hostToken: 'single-quoted'\n", 'single-quoted'],
    ['  hostToken:   spaced-out   \n', 'spaced-out'],
    ['hostToken: with-hash # 这是注释\n', 'with-hash', '行尾注释要被去掉'],
    ['a: 1\nhostToken: second-line\nb: 2\n', 'second-line', '取第一条命中'],
    ['plugins:\n  other: x\n', '', '没有这一行 ⇒ 空字符串（不是抛异常）'],
    ['', '', '空文件 ⇒ 空字符串'],
  ]) {
    assert.equal(readHostToken(yaml), want, `${JSON.stringify(yaml)} ⇒ ${JSON.stringify(want)}`)
  }
  // 反向判据：值里的 `#` 不该被当注释吃掉（只有**空白 + #** 才是注释）
  assert.equal(readHostToken('hostToken: has#hash\n'), 'has#hash', '值里的 # 不是行尾注释')
})

test('relay-start.mjs：patch 文件里的短 token 一个字符都不打印（长度守卫）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drc-start-'))
  try {
    // 短于 4 字符：`%"${TOKEN#????}"` 在旧写法里会求值出整个 token。
    writeFileSync(join(dir, 'cordis.patch.yml'), 'plugins:\n  hostToken: abc\n')
    const env = { ...process.env, DSH_PROFILE: dir, DRC_PORT: '0' }
    // 必须让脚本走"从 patch 文件读"的这条路：环境里有 DRC_HOST_TOKEN 就轮不到它。
    delete env.DRC_HOST_TOKEN
    const child = spawn(process.execPath, [RELAY_START], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => (out += c.toString()))
    child.stderr.on('data', (c) => (out += c.toString()))
    try {
      // 脚本是 `exec node …`：等到中继真的起来了，就说明整条路都跑通了。
      const up = await waitUntil(() => out.includes('relay listening'), 8000)
      assert.ok(up, `relay-start.mjs 没起来（或没打印启动行）：${out.slice(-400)}`)
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
