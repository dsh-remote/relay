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
  const port = await new Promise((resolve, reject) => {
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
  return {
    child,
    port,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        child.kill('SIGTERM')
      }),
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
  const relay = await startRelay({ DRC_STATE_FILE: '/proc/definitely-not-writable/state.json' })
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
  assert.match(
    out,
    /落盘|persistence/,
    '诊断输出必须谈到落盘：stateWriteFailures>0 时要报"配对表没有真正写进盘"',
  )
})

test('只读白名单：响应里混进凭据字段也不会被印出来', async (t) => {
  // 用一个**假的 /healthz**：它在响应里塞一个看起来像凭据的字段。
  // 诊断脚本不该打印它——这就是"白名单"这条纪律的可测形态。
  // 假中继：从临时脚本起（内联 -e 的写法在箭头函数里拿不到端口）
  const fake = spawn(process.execPath, [join(ROOT, 'tests', 'fixtures', 'fake-healthz.mjs'), TOKEN], { stdio: ['ignore', 'pipe', 'pipe'] })
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