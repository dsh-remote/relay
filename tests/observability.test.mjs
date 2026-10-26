/**
 * 埋点判据 —— "被迫重扫"这条主线能不能被**数出来**（2026-10-26）。
 *
 * ## 这份文件存在的理由
 *
 * 线上排查"用户为什么总是要重扫"时，最关键的三个数字是：
 *
 *   ① `unknown session`      —— 手机撞到死会话 ⇒ **它会清配对并要求重扫**（被迫重扫）；
 *   ② `session left by client` —— **用户自己**解的配（不是故障）；
 *   ③ `conversation voided by host` —— 主机说"这条我不要了"（作废）。
 *
 * 在这三条埋点之前，中继只记 ③，而且**不记 hostId** ⇒
 * "93 次作废"只能靠时间线反推是哪台主机（本次分析里 78/93 靠"上线后 120 秒内"猜出来），
 * 而 ① ② 一个都不记 ⇒ **"用户被迫重扫多少次"这个数字在线上根本数不出来**。
 *
 * ⇒ 这里用**真 socket + 真中继**验三条日志真的出现、且带着归因要的字段。
 * 判据取的是**行为**（日志里实际出现了什么），不是源码文本 ——
 * 源码里写了 `hostId: peer.hostId` 而实际没打出来，是完全可能发生的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createRelay } from '../dist/src/server.js'
import { loadConfig } from '../dist/src/config.js'

const TOKEN = 'observability-test-host-token-0123456789'

/**
 * 抓住中继打到 stdout 的每一行 JSON。
 *
 * 中继的 `Log` 默认写 `process.stdout.write(line + '\n')` ⇒
 * **在调用那一刻**才取这个属性 ⇒ 替换 `process.stdout.write` 就能抓住。
 */
function captureStdout() {
  const lines = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    try {
      const text = String(chunk)
      if (text.startsWith('{') && text.trimEnd().endsWith('}')) {
        try {
          lines.push(JSON.parse(text))
        } catch {
          /* 不是 JSON 行就当普通输出 */
        }
      }
    } catch {
      /* 捕捉失败不许影响被测对象 */
    }
    return original(chunk, ...rest)
  }
  return {
    lines,
    stop: () => {
      process.stdout.write = original
    },
    find: (msg) => lines.find((l) => l.msg === msg),
    all: (msg) => lines.filter((l) => l.msg === msg),
  }
}

async function startRelay() {
  const env = {
    ...process.env,
    DRC_HOST_TOKEN: TOKEN,
    DRC_PORT: '0',
    DRC_BIND: '127.0.0.1',
    DRC_LOG_LEVEL: 'info',
    DRC_PAIR_TTL_MS: '30000',
  }
  const { config, problems } = loadConfig(env, 'test')
  assert.equal(problems.filter((p) => p.level === 'error').length, 0, '测试配置不合法')
  const relay = createRelay(config)
  const { port } = await relay.startListening()
  const ctx = { relay, port, url: `ws://127.0.0.1:${port}`, open: [] }
  ctx.close = async () => {
    for (const peer of ctx.open) peer.ws.terminate()
    await relay.close()
  }
  return ctx
}

/** 极简对端：连、发、等某类帧。 */
class Peer {
  constructor(ws) {
    this.ws = ws
    this.frames = []
    this.waiters = []
    ws.on('message', (raw) => {
      let frame = null
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        frame = { t: '__invalid_json_text__' }
      }
      this.frames.push(frame)
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(frame)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    const peer = new Peer(ws)
    await new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    return peer
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame))
  }

  async until(match, timeoutMs = 3000) {
    const seen = this.frames.find(match)
    if (seen) return seen
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`等帧超时；已收到 ${JSON.stringify(this.frames).slice(0, 300)}`)),
          400,
        )
        this.waiters.push({
          resolve: (f) => {
            clearTimeout(timer)
            resolve(f)
          },
        })
      })
      if (match(frame)) return frame
    }
    throw new Error(`没等到匹配的帧；已收到 ${JSON.stringify(this.frames).slice(0, 300)}`)
  }
}

/** 配成一对（主机发码 → 手机认领）。 */
async function pairUp(ctx, { clientId = 'inst-1', token = '123456', hostId = 'h-obs' } = {}) {
  const host = await Peer.connect(ctx.url)
  ctx.open.push(host)
  host.send({ t: 'hello', role: 'host', protocol: 1, hostId, token: TOKEN, label: 'bins' })
  await host.until((f) => f.t === 'hello-ok')
  host.send({ t: 'pair-begin', pairingToken: token })
  await host.until((f) => f.t === 'pair-ready')

  const client = await Peer.connect(ctx.url)
  ctx.open.push(client)
  client.send({ t: 'hello', role: 'client', protocol: 1, clientId })
  await client.until((f) => f.t === 'hello-ok')
  client.send({ t: 'pair-begin-client', pairingToken: token })
  const paired = await client.until((f) => f.t === 'paired' || f.t === 'error')
  assert.equal(paired.t, 'paired', '配对必须成功（判据装置自检）')
  return { host, client, sessionId: paired.sessionId }
}

test('① 客户端主动解配 ⇒ 中继记一条「session left by client」（区分"用户解的"与"主机作废的"）', async () => {
  const ctx = await startRelay()
  const cap = captureStdout()
  try {
    const { client, sessionId } = await pairUp(ctx, { clientId: 'inst-left' })
    client.send({ t: 'session-leave', sessionId, clientId: 'inst-left' })
    // 等这条日志出现（异步落点）
    const deadline = Date.now() + 3000
    let line = null
    while (Date.now() < deadline) {
      line = cap.find('session left by client')
      if (line) break
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.ok(line, '必须记「客户端主动离开」—— 没有它，"作废"会被误读成"主机把会话丢了"')
    assert.equal(line.sessionId, sessionId)
    assert.equal(line.clientId, 'inst-left', '要能归因到是哪台手机')
    assert.equal(line.hostId, 'h-obs', '要能归因到是哪台主机')
  } finally {
    cap.stop()
    await ctx.close()
  }
})

test('② 主机作废会话 ⇒ 日志里必须有 hostId（没有它，93 次作废只能靠猜）', async () => {
  const ctx = await startRelay()
  const cap = captureStdout()
  try {
    const { host, sessionId } = await pairUp(ctx, { clientId: 'inst-void', hostId: 'h-void' })
    host.send({ t: 'session-leave', sessionId })
    const deadline = Date.now() + 3000
    let line = null
    while (Date.now() < deadline) {
      line = cap.find('conversation voided by host')
      if (line) break
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.ok(line, '主机作废必须留下日志')
    assert.equal(line.hostId, 'h-void', '⚠️ hostId 是这条日志的"谁"：没有它就只能靠时间线反推')
    assert.equal(line.sessionId, sessionId)
  } finally {
    cap.stop()
    await ctx.close()
  }
})

test('③ 客户端撞上死会话 ⇒ 记一条「unknown session」（用户被迫重扫的直接信号）', async () => {
  const ctx = await startRelay()
  const cap = captureStdout()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: 1, clientId: 'inst-dead' })
    await client.until((f) => f.t === 'hello-ok')
    // 往一条不存在的会话发帧 ⇒ 中继回 unknown_session（客户端据此清配对要求重扫）
    client.send({
      t: 'enc',
      sessionId: 'c_deadbeefdead',
      seq: 1,
      clientId: 'inst-dead',
      ciphertext: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    })
    const err = await client.until((f) => f.t === 'error')
    assert.equal(err.code, 'unknown_session')
    const deadline = Date.now() + 3000
    let line = null
    while (Date.now() < deadline) {
      line = cap.find('unknown session')
      if (line) break
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.ok(line, '必须记「撞上死会话」—— 这是"用户被迫重扫"的唯一直接信号')
    assert.equal(line.clientId, 'inst-dead')
    assert.equal(line.sessionId, 'c_deadbeefdead')
  } finally {
    cap.stop()
    await ctx.close()
  }
})
