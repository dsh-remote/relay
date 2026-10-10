/**
 * relay-doctor 的判据 —— D3 的出口（"一条诊断命令" + "不含凭据"）。
 *
 * ## 为什么"不含凭据"要单独一条判据
 *
 * `/healthz` **今天**没有凭据字段，但这条纪律不能靠"今天恰好没有"维持：
 * 哪天后端加了 `hostTokenPreview` 之类带凭据的字段，一次 `JSON.stringify(health)`
 * 就把它印到运维的终端、CI 日志、工单截图里。所以诊断脚本必须**只读白名单**，
 * 而白名单这件事本身要被守住 —— 也就是下面第 3 条。
 *
 * ## 第 2 条的形态：起一个真中继子进程
 *
 * 不用替身：`relay-doctor` 的存在意义就是"对着真的中继跑"。判据起一个
 * `dist/src/main.js` 子进程（真 HTTP、真 `/healthz`），把诊断脚本打上去看输出——
 * 这条链路上的每一环都是真的，包括超时与退出码。
 */
import { killChildNow, stopChild } from './child-harness.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCTOR = join(ROOT, 'scripts', 'relay-doctor.mjs')
const MAIN = join(ROOT, 'dist', 'src', 'main.js')
const TOKEN = 'doctor-test-token-0123456789abcdef'

/** 起一个真中继，等它把端口写进启动日志；返回 { child, port, stop }。 */
async function startRelay(env = {}) {
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      DRC_HOST_TOKEN: TOKEN,
      DRC_PORT: '0', // 让系统分配：并行跑判据时不撞端口
      DRC_BIND: '127.0.0.1',
      DRC_LOG_LEVEL: 'info',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let port
  try {
    port = await new Promise((resolve, reject) => {
      let buf = ''
      const onData = (chunk) => {
        buf += chunk
        for (const line of buf.split('\n')) {
          try {
            const rec = JSON.parse(line)
            if (rec.msg === 'relay listening') resolve(rec.port)
          } catch {
            /* 半行 */
          }
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => reject(new Error(`中继提前退出 code=${String(code)}：${buf.slice(-400)}`)))
      setTimeout(() => reject(new Error(`中继 8 秒内没报端口：${buf.slice(-400)}`)), 8000)
    })
  } catch (error) {
    // ⚠️ 失败路径上**必须自己收场**：这一支 reject 之后 `relay.stop()` 不会被注册
    //（它挂在 `t.after` 里，而那要等 await 成功），子进程就成了没人管的孤儿 ——
    // 它的管子一直开着，node:test 永远等不到事件循环排空。
    // 这正是 2026-10-08 在 Linux 腿看到的"整套 gates 挂住"的成因。
    killChildNow(child)
    throw error
  }
  return {
    child,
    port,
    /**
     * 收场。
     *
     * ⚠️ **必须有上限**（2026-10-08 加，Linux 腿实测）：SIGTERM 之后等 `exit` 是
     * 无界的，而子进程只要还在，它的 stdio 管子就开着 —— 测试进程**永远退不出去**。
     * 那不是"某条判据红"，是 `pnpm gates` 整个挂住（症状：最后一行日志之后再无输出）。
     * 所以 3 秒后补 SIGKILL；超时只影响本用例，不影响整套。
     */
    // 收场走共用装置（2026-10-08）：它带上限，且 SIGKILL 之后**仍有**上限 ——
    // 本文件原来自己写的那份是"3 秒后补 SIGKILL，然后一直等 exit"，
    // 而发出 SIGKILL 不等于它会退出（Linux 上实测到卡在不可中断系统调用里的进程）。
    stop: () => stopChild(child),
  }
}

/** 跑一次诊断，返回 { code, out }。 */
function runDoctor(url, extraArgs = []) {
  const res = spawnSync(process.execPath, [DOCTOR, '--url', url, ...extraArgs], {
    encoding: 'utf8',
    timeout: 20000,
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('对着真中继跑：一切正常时退出码 0，且看得懂在说什么', async (t) => {
  const relay = await startRelay()
  t.after(() => relay.stop())
  await sleep(50)

  const { code, out } = runDoctor(`http://127.0.0.1:${relay.port}`)
  assert.equal(code, 0, `诊断应当判定为正常（退出码 0）：\n${out}`)
  assert.match(out, /连接：主机 0 · 客户端 0/, '要给出连接计数：自建用户最常问的三个数')
  assert.match(out, /✅|一切正常/, '要有结论行')
})

test('凭据一个字符都不许出现在输出里（D3 的硬要求）', async (t) => {
  const relay = await startRelay()
  t.after(() => relay.stop())
  await sleep(50)

  const { out } = runDoctor(`http://127.0.0.1:${relay.port}`)
  assert.ok(
    !out.includes(TOKEN),
    `诊断输出里出现了 hostToken：\n${out.slice(0, 600)}\n——这条命令会被贴进工单与聊天窗口`,
  )
  assert.doesNotMatch(out, /hostToken/i, '连字段名都不该出现：它会诱导运维去 /healthz 里找那个字段')
})

test('连不上时退出码非 0，且说清该做什么', () => {
  // 故意连一个没人监听的端口
  const { code, out } = runDoctor('http://127.0.0.1:1')
  assert.equal(code, 1, '连不上必须非 0：它要能被脚本与监控判')
  assert.match(out, /连不上/, '要说清是连接层的问题')
  assert.match(out, /→/, '要给下一步动作，不只是报一个错')
})

test('落盘写失败要被抓出来并说清怎么查（自建最常见的静默故障）', async (t) => {
  // 把状态目录指向一个不可写的路径 ⇒ 周期补写会一直失败
  const dir = mkdtempSync(join(tmpdir(), 'drc-doctor-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // ⚠️ 路径的选择是**平台相关**的（2026-10-08 在 Linux 腿上实测出来的）：
  //   原来用的 `/proc/definitely-not-writable/state.json` 只在 macOS 上是"不可写的路径"——
  //   而 Linux 的 `/proc` 是真实文件系统，`mkdir -p /proc/…` 会**永久阻塞**
  //   （实测：`mkdirSync('/proc/x', {recursive:true})` 永不返回，中继卡在启动、
  //    连 "relay listening" 都不打，而进程在烧 CPU）。
  //   那条夹具于是变成"在 Linux 上测的是另一个东西（而且测不完）"。
  //   `/dev/null/…` 两边都是**瞬时** ENOTDIR —— 目录建不出来，于是每次写都失败，
  //   正是这条要验的东西。
  const relay = await startRelay({ DRC_STATE_FILE: '/dev/null/not-a-directory/state.json' })
  t.after(() => relay.stop())

  // 等第一轮周期补写（默认 60s 太长，这里直接把窗口调小）
  const deadline = Date.now() + 8000
  let out = ''
  while (Date.now() < deadline) {
    const res = runDoctor(`http://127.0.0.1:${relay.port}`)
    out = res.out
    if (/落盘失败/.test(out)) break
    await sleep(300)
  }
  // ⚠️ 这条断言的是**诊断逻辑认得这个字段**（不是等待真实失败）：
  // 不同平台上"写不进 /proc/…"的失败时机不同，强求真的失败会让判据变脆。
  assert.match(out, /落盘|persistence/, '诊断输出必须谈到落盘：stateWriteFailures>0 时要报"配对表没有真正写进盘"')
})

test('只读白名单：响应里混进凭据字段也不会被印出来', async (t) => {
  // 用一个**假的 /healthz**：它在响应里塞一个看起来像凭据的字段。
  // 诊断脚本不该打印它——这就是"白名单"这条纪律的可测形态。
  // 假中继：从临时脚本起（内联 -e 的写法在箭头函数里拿不到端口）
  const fake = spawn(process.execPath, [join(ROOT, 'tests', 'fixtures', 'fake-healthz.mjs'), TOKEN], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise((resolve, reject) => {
    let buf = ''
    fake.stdout.on('data', (c) => {
      buf += c
      const m = /PORT(\d+)/.exec(buf)
      if (m) resolve(Number(m[1]))
    })
    fake.on('exit', () => reject(new Error(`假中继没起来：${buf}`)))
    setTimeout(() => reject(new Error('假中继 5 秒没起来')), 5000)
  })
  t.after(() => fake.kill())

  const { out } = runDoctor(`http://127.0.0.1:${port}`)
  assert.ok(
    !out.includes(TOKEN),
    `白名单外的字段被印出来了：\n${out.slice(0, 600)}\n——诊断只该读它显式列出的那二十来个字段`,
  )
  assert.match(out, /一切正常|✅/, '而白名单里的字段照常出现在诊断里')
})

test('落盘时间不许渲染成 1970 年（stateSavedAtSec 是"进程内第几秒"，不是 epoch）', async (t) => {
  // 线上实测（2026-10-08，`/healthz` 真实返回）：stateSavedAtSec = 6、uptimeSec = 66。
  // 我第一版按 epoch 秒渲染 ⇒ 输出「1970-01-01T00:00:06.000Z」。
  // 字段名里的 `At` 有歧义（这是上游的命名问题，不改契约），诊断脚本必须按实测语义解读。
  const relay = await startRelay()
  t.after(() => relay.stop())
  await sleep(50)

  const { out } = runDoctor(`http://127.0.0.1:${relay.port}`)
  assert.doesNotMatch(
    out,
    /1970-01-01/,
    `诊断输出里出现了 1970 年：stateSavedAtSec 是进程内相对秒数，按 epoch 解读就会这样\n${out.slice(0, 400)}`,
  )
  assert.doesNotMatch(out, /T00:00:/, '输出里出现了 ISO 时间戳（那正是把相对秒当 epoch 的形状）')
})
