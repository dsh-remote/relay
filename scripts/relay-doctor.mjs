#!/usr/bin/env node
/**
 * relay-doctor — 一条命令回答"中继现在通不通、落不落盘、版本对不对"（V3-PLAN D3）。
 *
 * ## 为什么要有它
 *
 * 自建用户遇到问题的**第一反应**是打开文档找命令，而文档里有十几条
 * `curl .../healthz | jq ...`。D3 的出口是"**一条诊断命令**"，而且必须满足：
 *
 * 1. **绝不打印凭据**：`DRC_HOST_TOKEN` 一个字符都不出现在输出里
 *    （既有纪律：`/healthz` 本身就不含它，这条脚本更不能自己加进去）。
 * 2. **给出下一步**：每一条异常都带一句"该做什么"，而不只是列出字段名。
 * 3. **不需要额外依赖**：`node` + 三个内置模块就跑得起来。
 *    一个自建中继的用户很可能没装 jq。
 *
 * ## 用法
 *
 * ```sh
 * DRC_HOST_TOKEN=… node dist/bundle/main.js     # 另一个终端
 * node scripts/relay-doctor.mjs --url http://127.0.0.1:8787
 * DRC_HOST_TOKEN=… node scripts/relay-doctor.mjs --url wss://drc.provid.cc   # 走 TLS 的公网实例
 * ```
 *
 * 退出码：**0 = 一切正常**，**1 = 有需要处理的事**（便于脚本与监控判它）。
 */
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { URL } from 'node:url'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const baseUrl = arg('url', process.env.DRC_URL ?? 'http://127.0.0.1:8787')
const timeoutMs = Number(arg('timeout', '5000'))

/** `wss?://` → 走 TLS，否则明文。顺手支持 https://（反代在前面终止 TLS 的形态）。 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const client = u.protocol === 'https:' || u.protocol === 'wss:' ? httpsRequest : httpRequest
    const req = client(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
        if (body.length > 1_000_000) req.destroy(new Error('响应体过大'))
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}${res.statusMessage ? ` ${res.statusMessage}` : ''}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(new Error(`响应不是合法 JSON：${String(error?.message ?? error)}`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`超时 ${timeoutMs}ms：中继没在监听？`)))
    req.on('error', reject)
    req.end()
  })
}

/**
 * ⚠️ **防凭据泄露：只读白名单里的字段，绝不整体回显响应。**
 *
 * `/healthz` 今天的实现里没有凭据，但**这条纪律不能靠"今天恰好没有"**：
 * 哪天后端加了 `hostTokenPreview` 之类带凭据的字段，一次 `JSON.stringify(health)`
 * 就把它印到运维的终端与日志里。所以下面用一个显式白名单取字段——
 * 新字段默认**不出现**在这份诊断里，要出现必须有人在这里加一行。
 */
const READ = [
  'ok', 'version', 'uptimeSec', 'hosts', 'clients', 'conversations', 'pendingPairs',
  'droppedFrames', 'slowConsumers', 'rejectedPairs', 'shutdownForced',
  'persistence', 'stateRestored', 'stateSavedAtSec', 'stateWrites', 'stateWriteFailures',
  'shuttingDown', 'protocolSelf', 'protocolMin', 'peerProtocolMin', 'peerProtocolMax', 'peersNoProtocol',
]
const pick = (src) => Object.fromEntries(READ.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]))

/** 一条诊断结论：ok / warn / bad。 */
const findings = []
const report = (level, what, action) => findings.push({ level, what, action })

/** 顶层 await 只在 .mjs 的**模块顶层**合法；这是普通函数，所以走 .then()。 */
async function main() {
  process.stdout.write(`\n中继诊断：${baseUrl}\n${'─'.repeat(60)}\n`)
  let health
  try {
    // 过白名单再进诊断逻辑：即使响应里混进了凭据字段，下面的代码也看不到它。
    health = pick(await fetchJson(`${baseUrl}/healthz`))
  } catch (error) {
    report('bad', `连不上 /healthz —— ${String(error?.message ?? error)}`, '看服务是否在跑；反代是否转发了 Upgrade 头；端口对不对')
    print()
    return 1
  }

  // ① 活着没
  if (health.ok === true) report('ok', `服务在跑（版本 ${health.version ?? '未知'}，已运行 ${Math.round((health.uptimeSec ?? 0) / 60)} 分钟）`)
  else report('bad', '/healthz 的 ok 不是 true', '看日志里的 fatal 行')

  // ② 版本对不对（运维判断"线上跑的是哪一版"就靠这个字段）
  if (!health.version || health.version === '0.0.0') {
    report(
      'bad',
      `version 是 ${health.version ?? '缺失'}——**单文件产物没带上版本号**`,
      '打包要注入 define（scripts/bundle-relay.mjs）；没有它无法判断线上是哪一版',
    )
  }

  // ③ 落盘（自建最常见的静默故障：以为在存，其实一直失败）
  if (health.persistence === 'off') {
    report('warn', 'persistence=off：重启会丢全部配对（纯内存）', '生产建议设 DRC_STATE_FILE')
  } else {
    if (Number(health.stateWriteFailures) > 0) {
      report(
        'bad',
        `落盘失败过 ${health.stateWriteFailures} 次 —— 配对表**没有真正写进盘**`,
        '查状态目录权限与磁盘空间；systemd 下要 StateDirectory（见 deploy/systemd）',
      )
    } else if (Number(health.stateWrites) > 0) {
      report('ok', `落盘正常（已写 ${health.stateWrites} 次，最后一次 ${health.stateSavedAtSec ? new Date(Number(health.stateSavedAtSec) * 1000).toISOString() : '未知'}）`)
    } else {
      report('warn', '配好了落盘但一次都没写成功过', '会话表没变化时不写是正常的；跑一次配对再复查')
    }
  }
  if (health.stateRestored === true) report('ok', '上次启动从状态文件恢复了会话表')

  // ④ 连接与限流（排错时最常问的三个数）
  report('info', `连接：主机 ${health.hosts ?? 0} · 客户端 ${health.clients ?? 0} · 会话 ${health.conversations ?? 0} · 待配对 ${health.pendingPairs ?? 0}`)
  if (Number(health.droppedFrames) > 0) {
    report('warn', `丢过 ${health.droppedFrames} 帧`, '多为慢消费者；调 DRC_MAX_BUFFERED_BYTES 或两个慢消费者窗口')
  }
  if (Number(health.slowConsumers) > 0) {
    report('warn', `有 ${health.slowConsumers} 个慢消费者被处置过`, '看对端网络；客户端窗口必须大于它自己的重连周期')
  }
  if (Number(health.rejectedPairs) > 0) {
    report('warn', `拒绝过 ${health.rejectedPairs} 次配对`, '多为 token 不一致——确认插件与中继的 DRC_HOST_TOKEN 逐字相同')
  }
  if (Number(health.shutdownForced) > 0) {
    report('warn', `上次停机排空超时 ${health.shutdownForced} 次（强制退出）`, '有连接没在 5 秒内结束；也可能是被硬杀的（Windows 服务停止 / docker kill）')
  }

  // ⑤ 协议版本协商
  if (health.protocolSelf !== undefined) {
    const line = `协议：本端 v${health.protocolSelf}，接受 [${health.protocolMin ?? '?'} …]，对端最小 ${health.peerProtocolMin ?? '—'} / 最大 ${health.peerProtocolMax ?? '—'}`
    report('info', line)
    if (Number(health.peersNoProtocol) > 0) {
      report('warn', `有 ${health.peersNoProtocol} 个对端没报协议版本`, '老版本客户端；该升')
    }
  }

  print()
  const bad = findings.filter((f) => f.level === 'bad').length
  const warn = findings.filter((f) => f.level === 'warn').length
  process.stdout.write(
    bad === 0
      ? warn === 0
        ? '\n✅ 一切正常。\n\n'
        : `\n⚠️  ${warn} 条提醒，没有致命问题。\n\n`
      : `\n❌ ${bad} 条需要处理。\n\n`,
  )
  return bad === 0 ? 0 : 1
}

function print() {
  const mark = { ok: '✅', warn: '⚠️ ', bad: '❌', info: '·  ' }
  for (const f of findings) {
    process.stdout.write(`${mark[f.level]} ${f.what}\n`)
    if (f.action && f.level !== 'info') process.stdout.write(`   → ${f.action}\n`)
  }
}

main().then((code) => process.exit(code))