#!/usr/bin/env node
/**
 * loadtest-conns.mjs — C0 压测装置：量"一万条挂着不动的连接到底花多少"。
 *
 * 起一个**本地中继进程**（就是生产用的那个单文件产物），开 N 条 ws，每条只走完
 * `hello` → `hello-ok` 就挂着不发业务帧，然后每 5 s 采一次：RSS、fd 数、中继出站字节
 * 速率、ping 控制帧到达数、/healthz 应答延迟、中继日志增速。一个采样窗口一行 CSV。
 *
 * 为什么所有指标都从**外面**量，而不先往 server.ts 里加计数器：
 * C1/C3/C6 要改的正是这些路径，先有基线数才知道阈值该定在哪、也才知道改动有没有把数打下来。
 * "sweep 一轮多久"这种只有进程自己知道的量，用 /healthz 的**事件循环延迟**做代理——
 * sweep 里那两次全表遍历是同步的，它跑多久，HTTP 应答就被堵多久。
 *
 * 每连接成本一律按**差分**算：`(rss - 建连前的 rss) / 连接数`。
 * 直接 rss/连接数会得到一个随 N 变化而剧烈漂移的假数——分子里躺着几十 MB 的 V8 堆和代码段。
 *
 * 用法：
 *   node scripts/loadtest-conns.mjs --n=1000 --seconds=45
 *   node scripts/loadtest-conns.mjs --n=10000
 *
 * 已知读数边界（这台机器不等于生产，别把数搬错地方）：
 * - 本机 8 vCPU / 16 GB，生产中继 2 vCPU。RSS/连接、fd/连接这类**每连接成本**可外推；
 *   CPU 与突发类**不能**——同一批 ping 写在 2 核上排队更久。
 * - macOS 没有 `/proc`：fd 数走 `lsof`（10k fd 时一次要几百 ms 到几秒），CPU 秒数走
 *   `ps -o cputime=`，1 s 分辨率。所以 lsof 放在**探针窗口之外**跑，不污染延迟分位数；
 *   单窗口 CPU 只是量级，整轮平均核数在汇总里给。
 * - 中继日志保持默认级别（info）：建连风暴本身会写 N 行 `host online`/`client online`，
 *   那正是 C4 要治的东西，不能为了读数好看把它调哑。
 */
import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import cpus from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const argv = process.argv.slice(2)
function opt(name, dflt) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}
function positive(s, label) {
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${label} 必须是正整数，收到 ${s}`)
  return Math.round(n)
}

const N = positive(opt('n', '1000'), 'n')
const SECONDS = positive(opt('seconds', '45'), 'seconds')
const SAMPLE_MS = positive(opt('sample-ms', '5000'), 'sample-ms')
const PROBE_MS = positive(opt('probe-ms', '250'), 'probe-ms')
const RAMP_BATCH = positive(opt('ramp-batch', '250'), 'ramp-batch')
// host:client 是个**假设**而非测得的数：生产上主机少、手机多。每连接成本对这个比例不敏感
// （两边都是一个 Peer 对象 + 一条 socket），但它得写在明面上。
const HOST_FRACTION = Number(opt('host-fraction', '0.1'))
const OUT_DIR = opt('out-dir', 'data/loadtest')

const BUNDLE = `${ROOT}dist/bundle/main.js`
if (!existsSync(BUNDLE)) {
  console.error(`缺产物 ${BUNDLE}\n先跑一次：pnpm build`)
  process.exit(2)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(OUT_DIR, { recursive: true })
const csvPath = `${OUT_DIR}/conns-n${N}-${stamp}.csv`
const relayLogPath = `${OUT_DIR}/conns-n${N}-${stamp}.relay.log`

// ── 被测进程 ──────────────────────────────────────────────────────────
const HOST_TOKEN = 'loadtest-token-0123456789abcdef0123456789abcdef'
let relayExit = null
let relay = null
let relayLog = null
/** 所有客户端槽位。**声明在 try 之外**：收尾函数要在"还没建连就抛错"的路径上也能安全读它。 */
const slots = []

/**
 * 收尾：关掉所有客户端、向子中继发 SIGTERM、等它退出、关日志流。
 *
 * 抽成函数是为了让它同时挂在**两条**路径上：正常跑完，以及本轮任何一步抛错时的
 * finally（P2）。旧写法只在文件最后内联收尾，于是 `waitForPort()` 抛错（中继起不来）
 * 或采样中途任何一次 throw 都会把子进程与日志流留在机器上——一次失败的压测会留下
 * 一个继续占端口、继续吃内存的中继，日志也停在没 flush 的半截。
 */
async function stopRelay() {
  for (const s of slots) {
    try {
      s.ws.close()
    } catch {
      /* 已经断了 */
    }
  }
  if (relay && relay.exitCode === null) relay.kill('SIGTERM')
  for (let i = 0; i < 200 && !relayExit; i += 1) await sleep(50)
  if (relayLog) relayLog.end()
  return relayExit
}

try {
  relay = spawn(process.execPath, [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      DRC_HOST_TOKEN: HOST_TOKEN,
      DRC_PORT: '0', // 系统分配，从启动日志读回来：不猜端口、不撞端口
      // 连接数闸默认 200，不抬到 N 以上测的就是闸门不是容量。
      DRC_MAX_CONNS: String(N + 64),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  relayLog = createWriteStream(relayLogPath)
  relay.stdout.pipe(relayLog)
  relay.stderr.pipe(relayLog)
  relay.on('exit', (code, sig) => {
    relayExit = { code, sig }
  })

  const port = await waitForPort()
  console.log(`中继 pid=${relay.pid} port=${port}`)

  async function waitForPort() {
    for (let i = 0; i < 200; i += 1) {
      let text = ''
      try {
        text = readFileSync(relayLogPath, 'utf8')
      } catch {
        /* 还没落盘 */
      }
      const m = text.match(/"msg":"relay listening","port":(\d+)/)
      if (m) return Number(m[1])
      if (relayExit) throw new Error(`中继提前退出 code=${relayExit.code} sig=${relayExit.sig}\n${text}`)
      await sleep(25)
    }
    throw new Error('等不到中继的 "relay listening" 日志')
  }

  // ── 观测：全部从进程外部取 ────────────────────────────────────────────
  function rssKb(pid) {
    try {
      if (process.platform === 'linux') {
        // /proc/<pid>/statm 第二个字段是驻留页数；页按 4 KB 折成 KB。
        const pages = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/)[1])
        return pages * 4
      }
      return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()))
    } catch {
      return -1
    }
  }

  function fdCount(pid) {
    try {
      if (process.platform === 'linux') return readdirSync(`/proc/${pid}/fd`).length
      // macOS：-F 走机器可读格式，每条 fd 记录以 'f' 开头。
      const out = execFileSync('lsof', ['-p', String(pid), '-Ff'], { encoding: 'utf8', maxBuffer: 128 << 20 })
      let n = 0
      for (const line of out.split('\n')) if (line.charCodeAt(0) === 102 /* 'f' */) n += 1
      return n
    } catch {
      return -1
    }
  }

  function cpuSeconds(pid) {
    try {
      const raw = execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' }).trim()
      return raw.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)
    } catch {
      return -1
    }
  }

  /** 戳一次 /healthz：返回耗时与解析结果。sweep 的同步阻塞就体现在这个耗时上。 */
  function healthzOnce() {
    return new Promise((resolve) => {
      const started = process.hrtime.bigint()
      const req = request({ host: '127.0.0.1', port, path: '/healthz', timeout: 5000 }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          const ms = Number((process.hrtime.bigint() - started) / 1000000n)
          let body = {}
          try {
            body = JSON.parse(text)
          } catch {
            /* 坏应答按空处理，耗时仍然有效 */
          }
          resolve({ ms, body })
        })
      })
      req.on('timeout', () => {
        req.destroy()
        resolve({ ms: Number((process.hrtime.bigint() - started) / 1000000n), body: {}, timeout: true })
      })
      req.on('error', () => resolve({ ms: -1, body: {} }))
      req.end()
    })
  }

  // ── 建连：走完 hello/hello-ok 就挂着 ──────────────────────────────────
  let pingFrames = 0
  let ready = 0
  let failed = 0
  let handshakeRejected = 0

  function openOne(role, id) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      const slot = { ws, role, id, ok: false }
      slots.push(slot)
      let settled = false
      const done = (ok) => {
        if (settled) return
        settled = true
        if (ok) ready += 1
        else failed += 1
        resolve(ok)
      }
      ws.on('open', () => {
        const frame =
          role === 'host'
            ? { t: 'hello', role: 'host', token: HOST_TOKEN, hostId: id, label: 'loadtest', protocol: 1 }
            : { t: 'hello', role: 'client', clientId: id, protocol: 1, clientMeta: { platform: 'loadtest' } }
        ws.send(JSON.stringify(frame))
      })
      ws.on('message', (raw) => {
        if (slot.ok) return
        try {
          const f = JSON.parse(String(raw))
          if (f.t === 'hello-ok') {
            slot.ok = true
            done(true)
          } else if (f.t === 'error') {
            handshakeRejected += 1
            done(false)
          }
        } catch {
          done(false)
        }
      })
      // 保活走 WS 层 ping（见 server.ts 的 sweep）；ws 库自动回 pong，
      // 但事件照样抛给我们——这就是数 ping 突发的手段。
      ws.on('ping', () => {
        pingFrames += 1
      })
      ws.on('close', () => done(false))
      ws.on('error', () => done(false))
      setTimeout(() => done(false), 15_000).unref?.()
    })
  }

  /**
   * 出站字节 = 所有客户端 socket 的 TCP 层 bytesRead 之和（中继发出去的都算，
   * 含 WS ping 控制帧）。`ws` 的 `upgrade` 事件在客户端这边**不会抛**（实测），
   * 所以要的句柄只能取 `ws._socket` 这个内部字段。
   * 取不到的连接一律计入 unsampled——**读数偏小比读数为 0 更危险**，所以宁可让它红。
   */
  let unsampledSockets = 0
  function inboundBytes() {
    let n = 0
    unsampledSockets = 0
    for (const s of slots) {
      const sock = s.ws._socket
      if (sock && typeof sock.bytesRead === 'number') n += sock.bytesRead
      else unsampledSockets += 1
    }
    return n
  }

  /** 中继稳态基线：一条连接都还没建之前先量一次，后面所有"每连接"都是对它做差分。 */
  async function baseline() {
    const h = await healthzOnce()
    return { rss: rssKb(relay.pid), fds: fdCount(relay.pid), cpu: cpuSeconds(relay.pid), healthz: h.ms }
  }

  const base = await baseline()
  console.log(`空载基线：rss=${base.rss}KB fds=${base.fds} healthz=${base.healthz}ms`)

  const hostTarget = Math.max(1, Math.round(N * HOST_FRACTION))
  console.log(`建连：目标 ${N}（host ${hostTarget} / client ${N - hostTarget}），每批 ${RAMP_BATCH}`)
  const rampStart = Date.now()
  for (let i = 0; i < N; i += RAMP_BATCH) {
    const batch = []
    for (let j = i; j < Math.min(i + RAMP_BATCH, N); j += 1) {
      const role = j < hostTarget ? 'host' : 'client'
      batch.push(openOne(role, `${role}-lt-${j}`))
    }
    await Promise.all(batch)
  }
  const rampMs = Date.now() - rampStart
  console.log(
    `建连完成：ready=${ready} failed=${failed}（其中握手被拒 ${handshakeRejected}）用时 ${(rampMs / 1000).toFixed(1)}s`,
  )

  // ── 稳态采样 ──────────────────────────────────────────────────────────
  const header = [
    'window',
    'window_ms',
    'ready',
    'rss_kb',
    'rss_delta_kb',
    'rss_kb_per_conn',
    'fds',
    'fd_delta',
    'fd_per_conn',
    'cpu_sec_in_window',
    'out_bytes',
    'out_bytes_per_sec',
    'out_kbps',
    'out_bps_per_conn',
    'ping_frames',
    'pings_per_sec',
    'healthz_p50_ms',
    'healthz_p95_ms',
    'healthz_max_ms',
    'probes',
    'healthz_hosts',
    'healthz_clients',
    'healthz_conversations',
    'last_ping_ago_s',
    'dropped_frames',
    'slow_consumers',
    'relay_log_bytes_per_sec',
  ]
  const rows = [header]
  const deadline = Date.now() + SECONDS * 1000
  let prevOut = inboundBytes()
  let prevPing = pingFrames
  let prevCpu = cpuSeconds(relay.pid)
  let prevLogBytes = statSync(relayLogPath).size
  let window = 0

  while (Date.now() < deadline) {
    const t0 = Date.now()
    // 探针只在采样窗口内跑：lsof/ps 这些外部命令放在窗口**之外**，
    // 否则 10k fd 的 lsof 一卡几秒，延迟分位数就不是中继的阻塞而是我们的工具。
    const lat = []
    while (Date.now() < t0 + SAMPLE_MS) {
      const r = await healthzOnce()
      if (r.ms >= 0) lat.push(r)
      await sleep(PROBE_MS)
    }
    const t1 = Date.now()
    const winSec = (t1 - t0) / 1000

    const out = inboundBytes()
    const rss = rssKb(relay.pid)
    const fds = fdCount(relay.pid)
    const cpu = cpuSeconds(relay.pid)
    const logBytes = statSync(relayLogPath).size
    const last = lat.at(-1)?.body ?? {}
    const sorted = lat.map((r) => r.ms).sort((a, b) => a - b)
    const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : -1)
    const outDelta = out - prevOut
    const pingDelta = pingFrames - prevPing

    rows.push([
      (window += 1),
      Math.round(winSec * 1000),
      ready,
      rss,
      rss - base.rss,
      ready ? Math.round((rss - base.rss) / ready) : '',
      fds,
      fds - base.fds,
      ready ? +((fds - base.fds) / ready).toFixed(2) : '',
      cpu - prevCpu,
      out,
      Math.round(outDelta / winSec),
      ((outDelta * 8) / winSec / 1000).toFixed(1),
      ready ? Math.round((outDelta * 8) / winSec / ready) : '',
      pingDelta,
      (pingDelta / winSec / Math.max(1, ready)).toFixed(3),
      pct(0.5),
      pct(0.95),
      pct(1),
      lat.length,
      String(last.hosts ?? ''),
      String(last.clients ?? ''),
      String(last.conversations ?? ''),
      String(last.lastPingAgo ?? ''),
      String(last.droppedFrames ?? ''),
      String(last.slowConsumers ?? ''),
      Math.round((logBytes - prevLogBytes) / winSec),
    ])
    prevOut = out
    prevPing = pingDelta + prevPing
    prevCpu = cpu
    prevLogBytes = logBytes
    const r = rows.at(-1)
    console.log(
      `w${r[0]} rss+${r[5]}KB/conn fds+${r[8]}/conn out=${(r[11] / 1024).toFixed(0)}KB/s ` +
        `(${r[13]}bps/conn) ping=${r[14]} healthz p50/p95/max=${r[16]}/${r[17]}/${r[18]}ms ` +
        `log=${r[26]}B/s`,
    )
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────
  const w = rows.slice(1)
  const num = (i) => w.map((r) => Number(r[i] || 0))
  const avg = (i) => (w.length ? num(i).reduce((a, b) => a + b, 0) / w.length : 0)
  const windowSec = avg(1) / 1000
  const last = w.at(-1) ?? []

  const summary = {
    平台: `${process.platform} node ${process.version} 逻辑核 ${cpus.cpus().length} 内存 ${(cpus.totalmem() / 1073741824).toFixed(0)}GB`,
    目标连接: N,
    实际ready: ready,
    失败: failed,
    握手被拒: handshakeRejected,
    未采到socket: unsampledSockets,
    建连用时_s: +(rampMs / 1000).toFixed(1),
    建连速率_conn_s: +(ready / (rampMs / 1000)).toFixed(0),
    空载_rss_MB: +(base.rss / 1024).toFixed(1),
    每连接RSS_KB: Math.round(avg(5)),
    每连接fd: last[8] === undefined ? null : +Number(last[8]).toFixed(2),
    出站每连接_bps: Math.round(avg(13)),
    出站合计_KB_s: Math.round(avg(11) / 1024),
    每条连接每秒收到ping帧: +avg(15).toFixed(3),
    healthz延迟_p50_p95_max_ms: [Math.round(avg(16)), Math.round(avg(17)), Math.max(0, ...num(18))],
    平均CPU核数: +(avg(9) / windowSec).toFixed(2),
    中继日志_B_s: Math.round(avg(26)),
    CSV: csvPath,
    中继日志: relayLogPath,
  }

  writeFileSync(csvPath, rows.map((r) => r.join(',')).join('\n') + '\n')
  console.log('\n── 汇总 ──')
  console.log(JSON.stringify(summary, null, 1))

  // 读数自检：出站字节为 0 而 ping 帧非 0，只可能是探针没采到 socket（不是"真没流量"）。
  if (unsampledSockets > 0) {
    console.error(`!! ${unsampledSockets} 条连接取不到 socket —— 出站字节类读数不可信`)
  }
  if (avg(11) === 0 && avg(14) > 0) {
    console.error('!! ping 帧非 0 但出站字节为 0：探针失效，别引用这次的字节数')
  }
  console.log(`中继侧计数（末窗口）：hosts=${last[20] ?? ''} clients=${last[21] ?? ''} conversations=${last[22] ?? ''}`)

  // ── 收尾交给 finally 里的 stopRelay()：这里只留"跑完了"的出口 ──
} catch (error) {
  // 压测装置自己失败：打印原因、退出码非 0；子进程与日志流由 finally 回收。
  console.error(`loadtest 失败：${error?.stack ?? error}`)
  process.exitCode = 1
} finally {
  const verdict = await stopRelay()
  console.log(`中继退出 code=${verdict?.code} sig=${verdict?.sig}（期望 code=0）`)
  if (verdict?.code !== 0) process.exitCode = 1
}

// 收尾已经在 finally 里做完（子中继已退出、日志流已 end）。显式退出：与旧行为一致，
// 不把"还有没有活句柄"交给事件循环判断——一个压测装置挂在 99% 会让人以为是中继的问题。
process.exit(process.exitCode ?? 0)
