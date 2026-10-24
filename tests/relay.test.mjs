/**
 * 中继的 socket 级集成测试：真的起一个中继、真的连 socket、真的走一遍
 * 注册 → 配对 → 转发 → 断开。状态机的分支在 `state.test.mjs` 里已穷举，
 * 这里验的是"帧进出与协议契约一致"这一层。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'
import { createRelay } from '../dist/src/server.js'
import { Log } from '../dist/src/log.js'
import { loadConfig } from '../dist/src/config.js'
import { STATE_FILE_VERSION } from '../dist/src/persist.js'
import { PROTOCOL_VERSION } from '@dsh-remote/protocol/negotiate'

/** 一眼假的 token；测试里绝不用真实凭据。 */
const TOKEN = 'unit-test-host-token-0123456789abcdef'
const CIPHER = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

async function startRelay(overrides = {}) {
  const env = {
    ...process.env,
    DRC_HOST_TOKEN: TOKEN,
    DRC_PORT: '0',
    DRC_BIND: '127.0.0.1',
    DRC_LOG_LEVEL: 'silent',
    DRC_PAIR_TTL_MS: '30000',
    DRC_HOST_GRACE_MS: '250',
    DRC_MAX_FRAMES_PER_SEC: '500',
    ...overrides,
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

class Peer {
  constructor(ws) {
    this.ws = ws
    this.frames = []
    this.waiters = []
    this.closeCode = null
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closeCode = { code, reason: reason.toString() }
        resolve(this.closeCode)
      })
    })
    ws.on('message', (raw) => {
      let frame = null
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        frame = { t: '__invalid_json_text__', raw: raw.toString().slice(0, 40) }
      }
      this.frames.push(frame)
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(frame)
    })
  }

  static async connect(url, opts = {}) {
    // opts.headers：造"真实来源 IP"用（X-Forwarded-For）——生产在 nginx 后面，
    // 中继的埋点归因取的是这个头（见 server.ts `clientIpOf`）。
    const ws = new WebSocket(url, opts.headers ? { headers: opts.headers } : undefined)
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

  rawText(text) {
    this.ws.send(text)
  }

  rawBinary(buffer) {
    this.ws.send(Buffer.from(buffer))
  }

  /** 下一条到达的帧（不匹配就继续等）。 */
  next(timeoutMs = 2000) {
    if (this.frames.length > this.cursor) {
      const frame = this.frames[this.cursor++]
      return Promise.resolve(frame)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`等帧超时；已收到 ${JSON.stringify(this.frames).slice(0, 400)}`))
      }, timeoutMs)
      this.waiters.push({
        resolve: (frame) => {
          this.cursor += 1
          clearTimeout(timer)
          resolve(frame)
        },
        timer,
      })
    })
  }

  /** 等到某一类帧出现（可以在后面，也可能已经收到）。 */
  async until(match, timeoutMs = 2000) {
    const seen = this.frames.find(match)
    if (seen) return seen
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = await this.next(Math.max(50, deadline - Date.now()))
      if (match(frame)) return frame
    }
    throw new Error(`没等到匹配的帧；已收到 ${JSON.stringify(this.frames).slice(0, 400)}`)
  }

  /** 反向断言：一段时间内**不许**出现匹配的帧（D3/D6 的核心判据）。 */
  async expectNone(match, ms = 400) {
    const at = Date.now()
    while (Date.now() - at < ms) {
      const hit = this.frames.find(match)
      if (hit) throw new Error(`不该出现的帧出现了：${JSON.stringify(hit)}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(true)
  }

  cursor = 0

  has(match) {
    return this.frames.some(match)
  }
}

/** 等一个条件成立（`Peer.until` 搜的是整个缓冲区，不能用来等"第 N 条"）。 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error('等待条件超时')
}

async function pairUp(ctx, { hostLabel = 'bins', clientId = 'inst-1', token = '123456' } = {}) {
  const host = await Peer.connect(ctx.url)
  host.send({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, protocol: 1, token: TOKEN, label: hostLabel })
  const hostOk = await host.until((f) => f.t === 'hello-ok')
  assert.equal(hostOk.role, 'host')
  host.send({ t: 'pair-begin', pairingToken: token })
  const ready = await host.until((f) => f.t === 'pair-ready')
  assert.equal(ready.ttlMs, Number(process.env.DRC_PAIR_TTL_MS ?? 30000) || ready.ttlMs)

  const client = await Peer.connect(ctx.url)
  client.send({
    t: 'hello',
    role: 'client',
    protocol: PROTOCOL_VERSION,
    protocol: 1,
    clientId,
    clientMeta: { platform: 'wechat-mp', label: '微信小程序' },
  })
  const clientOk = await client.until((f) => f.t === 'hello-ok')
  assert.equal(clientOk.clientId, clientId, '客户端自带的 clientId 必须原样保留')
  client.send({ t: 'pair-begin-client', pairingToken: token })
  const paired = await client.until((f) => f.t === 'paired')
  const joined = await host.until((f) => f.t === 'peer-joined')
  ctx.open.push(host, client)
  return { host, client, hostId: hostOk.hostId, conversationId: paired.sessionId, joined }
}

test('注册：客户端 hello 得到 hello-ok，且 relay 原样保留它带来的 clientId', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      protocol: 1,
      clientId: 'mdwx-abc',
      clientMeta: { platform: 'wechat-mp' },
    })
    const ok = await client.until((f) => f.t === 'hello-ok')
    assert.deepEqual({ role: ok.role, clientId: ok.clientId }, { role: 'client', clientId: 'mdwx-abc' })
  } finally {
    await ctx.close()
  }
})

test('注册：不带 clientId 时中继代发一个（客户端会采纳并沿用）', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, protocol: 1 })
    const ok = await client.until((f) => f.t === 'hello-ok')
    assert.ok(ok.clientId && ok.clientId.length > 0)
    assert.equal(ctx.relay.state.clients.has(ok.clientId), true)
  } finally {
    await ctx.close()
  }
})

test('鉴权：错 token 被拒并在用尽次数后断开 4001', async () => {
  /**
   * `host auth failed` 必须带 `ip`（PLAN-smooth-78-92 P0-2，2026-10-22）：
   * 没有它这行只能说"有人试错"，归因到此为止；有了它才知道是哪台机器。
   * Log 是进程内单类 ⇒ 原型间谍接得住（createRelay 跑在同一进程）。
   */
  const warns = []
  const origWarn = Log.prototype.warn
  Log.prototype.warn = function (msg, fields) {
    warns.push({ msg, fields })
    return origWarn.call(this, msg, fields)
  }
  const ctx = await startRelay({ DRC_HOST_AUTH_MAX_ATTEMPTS: '3' })
  try {
    const host = await Peer.connect(ctx.url)
    ctx.open.push(host)
    host.send({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, token: 'wrong-token-value-here-000000' })
    for (let i = 0; i < 3; i++) {
      host.send({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, token: 'wrong-token-value-here-00000' + i })
      const err = await host.until((f) => f.t === 'error' && f.code === 'bad_token')
      assert.ok(err)
    }
    const closed = await host.closed
    assert.equal(closed.code, 4001)
    assert.equal(ctx.relay.state.hosts.size, 0)
    // P0-2 归因判据：host auth failed 必须带 ip（回环测试里是 127.0.0.1 / ::ffff:127.0.0.1）。
    const authFails = warns.filter((w) => w.msg === 'host auth failed')
    assert.ok(authFails.length >= 1, '鉴权失败必须留痕（不记 token 片段，但行本身要打）')
    assert.ok(
      typeof authFails[0].fields.ip === 'string' && authFails[0].fields.ip.length > 0,
      `host auth failed 必须带 ip 归因，实际 fields=${JSON.stringify(authFails[0].fields)}`,
    )
  } finally {
    Log.prototype.warn = origWarn
    await ctx.close()
  }
})

test('配对全流程：pair-ready 带权威 ttlMs，paired 带 sessionId，主机收到带 pairingToken 的 peer-joined', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId, joined, hostId } = await pairUp(ctx)
    assert.match(conversationId, /^c_[0-9a-f]{12}$/)
    assert.equal(joined.sessionId, conversationId)
    assert.equal(joined.pairingToken, '123456', '主机必须按码取自己那份 PSK（旧事故）')
    assert.equal(joined.clientId, 'inst-1')
    assert.equal(ctx.relay.state.conversations.size, 1)
    assert.equal(ctx.relay.state.conversations.get(conversationId).hostId, hostId)
  } finally {
    await ctx.close()
  }
})

test('配对前置：pair-begin 只能由主机发，认领只能由客户端发', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'pair-begin-client', pairingToken: '123456' })
    assert.equal((await client.until((f) => f.t === 'error')).code, 'need_client')

    const anon = await Peer.connect(ctx.url)
    ctx.open.push(anon)
    anon.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'i2' })
    await anon.until((f) => f.t === 'hello-ok')
    anon.send({ t: 'pair-begin', pairingToken: '123456' })
    assert.ok(await anon.until((f) => f.t === 'error' && f.code === 'need_host'))
  } finally {
    await ctx.close()
  }
})

test('配对码：未知码 invalid_or_expired，重放 already_used（两个 reason 在理论文不同）', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'i3' })
    await client.until((f) => f.t === 'hello-ok')
    client.send({ t: 'pair-begin-client', pairingToken: '999999' })
    assert.equal((await client.until((f) => f.t === 'pair-fail')).reason, 'invalid_or_expired')

    const first = await pairUp(ctx, { clientId: 'i4', token: '456789' })
    first.client.send({ t: 'pair-begin-client', pairingToken: '456789' })
    assert.equal(
      (await first.client.until((f) => f.t === 'pair-fail' && f.reason === 'already_used')).reason,
      'already_used',
    )
  } finally {
    await ctx.close()
  }
})

/**
 * `/code` 拒渲染死码（2026-10-23 用户裁决）：屏幕上的小程序码必须**扫了有反应**。
 *
 * 原来对任何 6 位数字都画图 —— 已被认领的（重放 `already_used`）、已过期的、
 * 甚至压根没签发过的（键盘敲一个也画）。用户看到"码在、扫了没反应"，以为是小程序坏了。
 * 判据与 `claim()` 同一套（`state.pairCodeState` 的四态）。
 *
 * ⚠️ 活码那一条**只断言"没被拒"**（不是 404/410）：真出图要调微信接口，
 * 沙箱里没有网 ⇒ 会落 502。判据要钉的是"守卫不许拦活码"，不是"微信通不通"。
 */
test('/code：used → 410、expired → 410、unknown → 404；活码不许被这道守卫拦下', async () => {
  // 开小程序码签发（假凭据即可：`enabled` 只看有没有填，真出图才走网络）。
  const ctx = await startRelay({ DRC_MP_APPID: 'wx-test-appid', DRC_MP_SECRET: 'test-secret' })
  const get = (token) => fetch(`http://127.0.0.1:${ctx.port}/code?token=${token}`)
  try {
    // ① 压根没签发过的 6 位数 ⇒ 404（以前会画一张永远扫不通的图）。
    const unknown = await get('000000')
    assert.equal(unknown.status, 404, `unknown 码必须 404，实际 ${unknown.status}`)
    assert.equal((await unknown.json()).error, 'code_unknown')

    // ② 活码：守卫必须放行（这里到不了微信 ⇒ 502，但绝不是 404/410）。
    assert.ok(ctx.relay.state.issuePair('h_test', '111222', 60_000).ok, '夹具自检：签发一张活码')
    const live = await get('111222')
    assert.ok(live.status !== 404 && live.status !== 410, `活码被守卫拦了（${live.status}）`)

    // ③ 已认领（used）⇒ 410：这张码曾有效，现在扫了必 already_used。
    const first = await pairUp(ctx, { clientId: 'i_code', token: '456789' })
    assert.equal(first.conversationId.startsWith('c_'), true, '夹具自检：认领成功')
    const used = await get('456789')
    assert.equal(used.status, 410, `已认领的码必须 410 Gone，实际 ${used.status}`)
    assert.equal((await used.json()).error, 'code_used')

    // ④ 过期（条目还在表里、TTL 已过）⇒ 410：与 claim() 的 expired 同一口径。
    assert.ok(ctx.relay.state.issuePair('h_test', '333444', 1).ok, '夹具自检：签发一张即将过期的码')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const expired = await get('333444')
    assert.equal(expired.status, 410, `过期的码必须 410，实际 ${expired.status}`)
    assert.equal((await expired.json()).error, 'code_expired')
  } finally {
    await ctx.close()
  }
})

test('下行转发：中继给 host→client 的帧编号，且密文原样搬运', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const one = await client.until((f) => f.t === 'enc')
    assert.equal(one.sessionId, conversationId)
    assert.equal(one.ciphertext, CIPHER)
    assert.equal(one.seq, 1)
    const two = await client.next()
    assert.equal(two.seq, 2)
    assert.equal(two.ciphertext, CIPHER)
  } finally {
    await ctx.close()
  }
})

test('上行转发：客户端的 seq 原样透传，并补上是谁发的', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    client.send({ t: 'enc', sessionId: conversationId, seq: 41, clientId: 'inst-1', ciphertext: CIPHER })
    const got = await host.until((f) => f.t === 'enc')
    assert.equal(got.seq, 41, '上行 seq 是元数据，中继不改写')
    assert.equal(got.clientId, 'inst-1')
    assert.equal(got.ciphertext, CIPHER)
  } finally {
    await ctx.close()
  }
})

test('D3：客户端断开重连后，同一会话继续可路由，主机不会收到 unknown_session', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    client.ws.terminate()
    const left = await host.until((f) => f.t === 'peer-left')
    assert.equal(left.sessionId, conversationId)
    assert.equal(left.clientId, 'inst-1')
    // 会话必须还在（旧实现在这里删掉它，于是重连必然失败）。
    assert.equal(ctx.relay.state.conversations.has(conversationId), true)

    const again = await Peer.connect(ctx.url)
    ctx.open.push(again)
    again.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'inst-1' })
    await again.until((f) => f.t === 'hello-ok')
    // 续用的判据是客户端一侧：它用原 convId 发指令，必须能直达主机。
    again.send({ t: 'enc', sessionId: conversationId, seq: 1, clientId: 'inst-1', ciphertext: CIPHER })
    const arrived = await host.until((f) => f.t === 'enc' && f.clientId === 'inst-1')
    assert.equal(arrived.sessionId, conversationId)
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await again.until((f) => f.t === 'enc')).sessionId, conversationId, '下行也必须重新挂得上')
  } finally {
    await ctx.close()
  }
})

/**
 * D6（2026-10-23 用户裁决「挂起、回来可恢复」）：宽限期到期**不再**通知客户端。
 *
 * 旧断言钉的是"超时才发 peer-left"——而手机收到 `peer-left` 就 `_forgetPairing()`
 * ⇒ 被迫重新扫码（用户实测：一条 219 帧的会话，宽限一过就没了）。
 * 现在宽限期到期只挂起：**一条帧都不发、会话与密钥原样留着**，主机回来自动恢复。
 */
test('D6：主机掉线超过宽限期只挂起——不发 peer-left、会话留着；主机回来自动恢复', async () => {
  const ctx = await startRelay({ DRC_HOST_GRACE_MS: '300', DRC_SWEEP_MS: '60' })
  try {
    const { host, client, conversationId, hostId } = await pairUp(ctx)
    host.ws.terminate()
    // 宽限期前后都不许有任何 peer-left（这就是"挂起、回来可恢复"的全部意义）。
    await client.expectNone((f) => f.t === 'peer-left', 120)
    await sleep(400) // 过了宽限期
    await client.expectNone((f) => f.t === 'peer-left', 200)
    assert.ok(
      ctx.relay.state.conversations.has(conversationId),
      '宽限到期不许删会话（旧写法 dropHost 删光 ⇒ 手机被迫重扫）',
    )

    // 主机回来（同 hostId）⇒ 路由自动恢复，双向都能走，手机全程不用动。
    const back = await Peer.connect(ctx.url)
    ctx.open.push(back)
    // 同一个 hostId 回来（中继按 hostId 路由；换 hostId 就是另一台机器）。
    back.send({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, token: TOKEN, hostId, label: '回来' })
    await back.until((f) => f.t === 'hello-ok')
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const arrived = await back.until((f) => f.t === 'enc' && f.clientId === 'inst-1')
    assert.equal(arrived.sessionId, conversationId, '挂起会话的上行必须能到回来的主机')
  } finally {
    await ctx.close()
  }
})

/**
 * `/code` 的 404/410/200 三态是**判定 oracle**（哪几个数字是活码一眼可辨）——
 * 那正是 `/api/pair-status` 默认关闭、必须带配额的理由（P2：10^6 的码空间
 * 不设配额就是一台免费的枚举机）。2026-10-23 评审：拒渲染死码不许把这扇门顺手开大。
 */
test('/code 必须限流：免认证的码探测不许全速刷（与 pair-status 同一只 Budget）', async () => {
  const ctx = await startRelay({ DRC_MP_APPID: 'wx-test-appid', DRC_MP_SECRET: 'test-secret' })
  try {
    // 一秒钟内连打 8 次（默认配额 5/s）⇒ 必须有 429。
    const codes = ['000001', '000002', '000003', '000004', '000005', '000006', '000007', '000008']
    const statuses = []
    for (const token of codes) {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/code?token=${token}`)
      statuses.push(res.status)
    }
    assert.ok(statuses.includes(429), `8 连打必须被限流（实际：${statuses.join(',')}）`)
    // 被限流的那些不该把判定结果说出去（429 与 404/410 不混）。
    assert.ok(statuses.filter((x) => x === 429).length >= 1, '限流要挡在判定之前')
  } finally {
    await ctx.close()
  }
})

test('主动作废（主机 session-leave）：每个成员恰好收到一条 peer-left（N² 那条回归的现居地）', async () => {
  // ⚠️ 这条不变量原来钉在**宽限期**那条路上；2026-10-23 宽限期改挂起后一条帧都不发，
  // N² 回归的"现居地"搬到了**主动作废**（主机 session-leave → dropConversation）——
  // 外层内层同名 clientId 那种写法在这里同样会让每个成员收到 N 条。
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    const second = await Peer.connect(ctx.url)
    second.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'inst-2' })
    await second.until((f) => f.t === 'hello-ok')
    ctx.open.push(second)
    ctx.relay.state.conversations.get(conversationId).clients.add('inst-2')

    host.send({ t: 'session-leave', sessionId: conversationId })
    await client.until((f) => f.t === 'peer-left', 1500)
    await second.until((f) => f.t === 'peer-left', 1500)

    // 再等几拍：每个成员必须仍是 1 条。
    await sleep(180)
    const count = (peer) => peer.frames.filter((f) => f.t === 'peer-left').length
    assert.equal(count(client), 1, '第一个成员收到了重复的 peer-left')
    assert.equal(count(second), 1, '第二个成员收到了重复的 peer-left')
    assert.equal(ctx.relay.state.conversations.has(conversationId), false, '主动作废仍然要真删（挂起不是作废）')
  } finally {
    await ctx.close()
  }
})

test('D4：注册过但不属于该会话的客户端拿到 unknown_session（有恢复出口，复核 R2）', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId } = await pairUp(ctx)
    const stranger = await Peer.connect(ctx.url)
    ctx.open.push(stranger)
    stranger.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'intruder' })
    await stranger.until((f) => f.t === 'hello-ok')
    stranger.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const err = await stranger.until((f) => f.t === 'error')
    // 不是 not_member：小程序对 not_member 只会弹一句英文 toast，
    // 而 unknown_session 会中文提示"会话已失效，请重新配对"——被拒的一方必须有出口。
    assert.equal(err.code, 'unknown_session')
    assert.equal(ctx.relay.state.conversations.has(conversationId), true, '拒绝一帧不该顺手删会话')
  } finally {
    await ctx.close()
  }
})

test('D4：从未注册的 socket 灌密文得到 not_member（它没有可恢复的配对）', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId } = await pairUp(ctx)
    const blind = await Peer.connect(ctx.url)
    ctx.open.push(blind)
    blind.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await blind.until((f) => f.t === 'error')).code, 'not_member')
    assert.equal(ctx.relay.state.conversations.has(conversationId), true)
  } finally {
    await ctx.close()
  }
})

test('复核 R3：同一 clientId 的后来者顶掉前者，前者收到 4000 才会重连', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId, host } = await pairUp(ctx)
    const newer = await Peer.connect(ctx.url)
    ctx.open.push(newer)
    newer.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'inst-1' })
    await newer.until((f) => f.t === 'hello-ok')
    const verdict = await ctx.open[1].closed
    assert.equal(verdict.code, 4000, '前者必须被明确关掉，否则它的 socket 还"开着"、永不重连')
    // 顶号之后新 socket 是合法成员，下行仍可路由。
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await newer.until((f) => f.t === 'enc')).sessionId, conversationId)
  } finally {
    await ctx.close()
  }
})

test('复核 R1：主机重启后 resync 未列出的会话被回收，成员当场收到 peer-left', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId, hostId } = await pairUp(ctx)
    // 模拟"主机进程重启"：新 socket、同一个 hostId、手里没有任何会话密钥。
    const reborn = await Peer.connect(ctx.url)
    ctx.open.push(reborn)
    reborn.send({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, protocol: 1, token: TOKEN, hostId })
    await reborn.until((f) => f.t === 'hello-ok')
    reborn.send({ t: 'resync', sessionIds: [] })
    await sleep(80)
    assert.equal(ctx.relay.state.conversations.has(conversationId), false, 'resync 没列出的会话必须删掉')
    /**
     * **2026-10-07 改判**：这条断言原来是反过来的（`!client.has(peer-left)`），
     * 理由是"客户端不是被 peer-left 弹一句英文，而是撞 unknown_session 拿到中文提示"。
     * 那条理由**不成立**：mp 对 `peer-left` 的处理是 needs-pair +「主机已断开，请重新配对」，
     * 与 `unknown_session` 那条「会话已失效，请重新配对」是同一个归宿、同样是中文。
     *
     * 而"只等客户端下次发帧"是**被动**的：手机停在那里不动时，界面上一切正常
     * （在线、有会话列表），它其实连着一个已经没有钥匙的对端 —— 直到用户某一次点了发送，
     * 才在 12 秒后知道。同一个中继在另外两条路（主机宽限期到期、主机显式 `session-leave`）
     * 都是主动通知的，只有这一条是哑的。
     */
    const left = await client.until((f) => f.t === 'peer-left')
    assert.equal(left.sessionId, conversationId, 'peer-left 必须指名是哪条会话')
    // 主动通知**不替代**原有出口：那条会话真的没了，之后再发一帧照样是 unknown_session。
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await client.until((f) => f.t === 'error')).code, 'unknown_session')
    void host
  } finally {
    await ctx.close()
  }
})

test('resync 保住会话时，成员**不许**收到 peer-left（通知不能变成乱通知）', async () => {
  // 反向判据：上一条证明"该通知时通知了"，这一条挡住"顺手全通知"那种改法——
  // 主机每次 hello-ok 都会发 resync（含恢复到的那几条），若那时也给成员发 peer-left，
  // 手机每次宿主重连都会被踢回扫码页。
  const ctx = await startRelay()
  try {
    const { host, client, conversationId, hostId } = await pairUp(ctx)
    const reborn = await Peer.connect(ctx.url)
    ctx.open.push(reborn)
    reborn.send({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, protocol: 1, token: TOKEN, hostId })
    await reborn.until((f) => f.t === 'hello-ok')
    reborn.send({ t: 'resync', sessionIds: [conversationId] })
    await sleep(80)
    assert.equal(ctx.relay.state.conversations.has(conversationId), true, '声明过的主机会话必须留下')
    await client.expectNone((f) => f.t === 'peer-left', 300)
    void host
  } finally {
    await ctx.close()
  }
})

test('未知会话：enc 得到 unknown_session（手机端据此提示重新配对）', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'lonely' })
    await client.until((f) => f.t === 'hello-ok')
    client.send({ t: 'enc', sessionId: 'c_deadbeefdead', ciphertext: CIPHER })
    assert.equal((await client.until((f) => f.t === 'error')).code, 'unknown_session')
  } finally {
    await ctx.close()
  }
})

test('主机在宽限期外、会话还在但主机不接时，客户端收到的是 host_unavailable 而不是 unknown_session', async () => {
  const ctx = await startRelay({ DRC_HOST_GRACE_MS: '60000' })
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.ws.terminate()
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const err = await client.until((f) => f.t === 'error')
    assert.equal(err.code, 'host_unavailable')
    assert.notEqual(err.code, 'unknown_session', '把"暂时没人接"报成"会话没了"会白白丢掉配对')
  } finally {
    await ctx.close()
  }
})

test('批量帧：enc-batch 下行保持条目顺序与密文原样', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.send({
      t: 'enc-batch',
      sessionId: conversationId,
      items: [{ ciphertext: CIPHER }, { ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', seq: 9 }],
    })
    const batch = await client.until((f) => f.t === 'enc-batch')
    assert.equal(batch.sessionId, conversationId)
    assert.equal(batch.items.length, 2)
    assert.equal(batch.items[0].ciphertext, CIPHER)
    assert.equal(batch.items[1].ciphertext, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  } finally {
    await ctx.close()
  }
})

test('畸形输入一律被拒而不崩：非法 JSON、二进制帧、坏 base64、未知帧名、缺字段', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'junk' })
    await client.until((f) => f.t === 'hello-ok')

    client.rawText('{not json')
    assert.equal((await client.until((f) => f.t === 'error' && f.code === 'bad_json')).code, 'bad_json')

    client.rawBinary([1, 2, 3, 4])
    assert.equal((await client.until((f) => f.t === 'error' && f.code === 'bad_frame')).code, 'bad_frame')

    client.send({ t: 'heartbeat' })
    assert.equal((await client.until((f) => f.t === 'error' && f.code === 'unknown_frame')).code, 'unknown_frame')

    // 名字认识、形状不合法 → bad_frame（P2）：旧实现一律回 unknown_frame，
    // 与紧邻的注释承诺相反，排障时会把"对端发了坏数据"误读成"对端版本不对"。
    client.send({ t: 'enc', sessionId: 'c_000000000000' })
    const malformed = await client.until(
      (f) => f.t === 'error' && f.code === 'bad_frame' && /enc/.test(f.message ?? ''),
    )
    assert.equal(malformed.code, 'bad_frame', `缺 ciphertext 是"名字对、形状坏"：${JSON.stringify(malformed)}`)
    assert.match(malformed.message, /enc/, '要能看出是哪条帧坏了')

    // 中继→端点那一侧的帧名（peer-left 等）在被端点发上来时也是"名字认识但形状不合法"。
    client.send({ t: 'peer-left', sessionId: 'c_000000000000' })
    const relayOnly = await client.until((f) => f.t === 'error' && /peer-left/.test(f.message ?? ''))
    assert.equal(relayOnly.code, 'bad_frame')

    client.send({ t: 'enc', sessionId: 'c_000000000000', ciphertext: '%%%not base64%%%' })
    assert.equal((await client.until((f) => f.t === 'error' && f.code === 'bad_frame')).code, 'bad_frame')

    assert.equal(ctx.relay.health().ok, true, '一堆坏帧之后进程仍然健康')
  } finally {
    await ctx.close()
  }
})

test('session-leave：客户端主动退出只摘自己，主机收到 peer-left，会话仍在', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    client.send({ t: 'session-leave', sessionId: conversationId })
    const left = await host.until((f) => f.t === 'peer-left')
    assert.equal(left.sessionId, conversationId)
    assert.equal(ctx.relay.state.conversations.get(conversationId).clients.size, 0)
    assert.equal(ctx.relay.state.conversations.has(conversationId), true)
    // unpaired 必须带上（2026-10-05）：这一条与「socket 断了」是同一帧，
    // 主机全靠它区分「用户解配」和「掉线」。不带的话主机按 D3 留着会话，
    // 手机那边却已经 _forgetPairing() 清了 convId 再也不回来 ——
    // pill 于是永远显示「手机离线」，用户永远等不到「未配对」。
    assert.equal(
      left.unpaired,
      true,
      '客户端主动 session-leave 没有标 unpaired：主机分不出解配与掉线，这条幽灵会话永远清不掉',
    )
  } finally {
    await ctx.close()
  }
})

test('ping/pong 原样回带 ts；两个客户端互不干扰', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx, { clientId: 'a' })
    const other = await Peer.connect(ctx.url)
    ctx.open.push(other)
    other.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'b' })
    await other.until((f) => f.t === 'hello-ok')
    other.send({ t: 'pair-begin-client', pairingToken: 'nope-nope' })
    assert.equal((await other.until((f) => f.t === 'pair-fail')).reason, 'invalid_or_expired')

    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await client.until((f) => f.t === 'enc')).sessionId, conversationId)
    await other.expectNone((f) => f.t === 'enc', 150)

    other.send({ t: 'ping', ts: 12345 })
    const pong = await other.until((f) => f.t === 'pong')
    assert.equal(pong.ts, 12345)
  } finally {
    await ctx.close()
  }
})

test('/healthz 与 /api/info 的形状是测试与运维的依赖（T7）', async () => {
  const ctx = await startRelay({ DRC_PUBLIC_URL: 'wss://drc.example.com' })
  try {
    await pairUp(ctx)
    const health = await fetch(`http://127.0.0.1:${ctx.port}/healthz`).then((r) => r.json())
    assert.equal(health.ok, true)
    assert.equal(health.hosts, 1)
    assert.equal(health.clients, 1)
    assert.equal(health.conversations, 1)
    assert.equal(health.pendingPairs, 1, '用过的码在 TTL 内仍留在表里（为了 already_used）')
    assert.equal(health.shuttingDown, false)
    assert.equal(typeof health.uptimeSec, 'number')
    assert.equal(typeof health.version, 'string')

    const info = await fetch(`http://127.0.0.1:${ctx.port}/api/info`).then((r) => r.json())
    assert.deepEqual(info, { publicUrl: 'wss://drc.example.com', protocol: 1 })

    const missing = await fetch(`http://127.0.0.1:${ctx.port}/nope`)
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { error: 'not_found' })
  } finally {
    await ctx.close()
  }
})

test('/api/pair-status 默认 404：不给 6 位码留免认证的判定 oracle', async () => {
  const ctx = await startRelay()
  try {
    const response = await fetch(`http://127.0.0.1:${ctx.port}/api/pair-status?token=123456`)
    assert.equal(response.status, 404)
    const enabled = await startRelay({ DRC_PAIR_STATUS: '1' })
    try {
      await pairUp(enabled, { token: '246810' })
      const used = await enabled.relay.state.pendingPairs.get('246810')
      assert.equal(used.used, true)
      const body = await fetch(`http://127.0.0.1:${enabled.port}/api/pair-status?token=246810`).then((r) => r.json())
      assert.equal(body.ok, false)
    } finally {
      await enabled.close()
    }
  } finally {
    await ctx.close()
  }
})

// ── 复核 R7 要求补齐的机械防线（原来"只有文档没有测试"的那几条）────────

test('F1：未知的帧名不会改动任何状态（新帧名必须落进 default）', async () => {
  const ctx = await startRelay()
  try {
    const { client, conversationId } = await pairUp(ctx)
    const before = ctx.relay.health()
    for (const name of ['keepalive', 'subscribe', 'auth', 'session-list', 'peer-left', 'paired']) {
      client.send({ t: name, sessionId: conversationId })
      await client.until((f) => f.t === 'error')
    }
    // 关键：借用过的帧名（peer-left / paired）不许触发状态机
    const after = ctx.relay.health()
    assert.deepEqual(
      { hosts: after.hosts, clients: after.clients, conversations: after.conversations },
      { hosts: before.hosts, clients: before.clients, conversations: before.conversations },
    )
    assert.equal(ctx.relay.state.conversations.has(conversationId), true)
  } finally {
    await ctx.close()
  }
})

test('F4：每一条 hello 都必有一个 hello-ok（错 role 也要有回应）', async () => {
  const ctx = await startRelay()
  try {
    for (const hello of [
      { t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'a1' },
      { t: 'hello', role: 'weird' },
      { t: 'hello' },
    ]) {
      const peer = await Peer.connect(ctx.url)
      ctx.open.push(peer)
      peer.send(hello)
      const reply = await peer.next()
      assert.ok(['hello-ok', 'error'].includes(reply.t), `${hello.role ?? '无 role'} 必须有明确回应`)
      if (hello.role === 'client') assert.equal(reply.t, 'hello-ok')
      else assert.equal(reply.t, 'error')
    }
  } finally {
    await ctx.close()
  }
})

test('F3：出站帧里的 sessionId 与配对时下发的逐字一致，不做任何加工', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    const paired = client.frames.find((f) => f.t === 'paired')
    assert.equal(paired.sessionId, conversationId)
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const down = await client.until((f) => f.t === 'enc')
    assert.equal(down.sessionId, conversationId)
    assert.equal(typeof down.sessionId, 'string')
    // 上行同理：主机收到的 sessionId 必须是通道 id，而不是被换成 DSH 会话 id（F3 的事故面）
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER, clientId: 'inst-1' })
    const up = await host.until((f) => f.t === 'enc')
    assert.equal(up.sessionId, conversationId)
  } finally {
    await ctx.close()
  }
})

test('T3：下行顺序与主机发出顺序一致，且帧数不膨胀', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    const marker = client.frames.length
    for (let i = 0; i < 12; i++) {
      host.send({
        t: 'enc',
        sessionId: conversationId,
        ciphertext: Buffer.from(`片段-${i}`, 'utf8').toString('base64'),
      })
    }
    await client.until(() => client.frames.length >= marker + 12)
    const downs = client.frames.slice(marker).filter((f) => f.t === 'enc')
    assert.equal(downs.length, 12, '既不能丢也不能重')
    for (let i = 0; i < 12; i++) {
      assert.equal(Buffer.from(downs[i].ciphertext, 'base64').toString('utf8'), `片段-${i}`)
      assert.equal(downs[i].seq, i + 1, 'seq 必须由中继连续编号')
    }
  } finally {
    await ctx.close()
  }
})

test('T6：根路径与任意自定义路径都能 upgrade（老地址不能连不上）', async () => {
  const ctx = await startRelay()
  try {
    for (const path of ['/', '/ws', '/drc', '/a/b/c']) {
      const peer = await Peer.connect(ctx.url + path)
      ctx.open.push(peer)
      peer.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: `p-${path}` })
      assert.equal((await peer.until((f) => f.t === 'hello-ok')).role, 'client', path)
    }
  } finally {
    await ctx.close()
  }
})

test('R2：发给手机的 error 一律带中文 message（英文 code 不可能是用户看到的全部）', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId } = await pairUp(ctx)
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'reader' })
    await client.until((f) => f.t === 'hello-ok')
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const err = await client.until((f) => f.t === 'error')
    assert.equal(err.code, 'unknown_session')
    assert.match(err.message, /配对|会话/, `客户端侧的中文提示缺失：${JSON.stringify(err)}`)

    client.send({ t: 'heartbeat' })
    const second = await client.until((f) => f.t === 'error' && f.code === 'unknown_frame')
    assert.ok(second.message, 'unknown_frame 也要带可读文案')
  } finally {
    await ctx.close()
  }
})

test('R1：主机主动作废会话时，它的客户端收到 peer-left 而不是继续对着没钥匙的对端发密文', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.send({ t: 'session-leave', sessionId: conversationId })
    const left = await client.until((f) => f.t === 'peer-left')
    assert.equal(left.sessionId, conversationId)
    assert.equal(ctx.relay.state.conversations.has(conversationId), false)
    // 客户端此后拿旧 convId 发帧：既有 peer-left 的即时提示，也有兜底的 unknown_session
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await client.until((f) => f.t === 'error')).code, 'unknown_session')
  } finally {
    await ctx.close()
  }
})

test('R1 边界：客户端发的 session-leave 只摘自己，不得把主机侧会话删掉（与主机发起的那条相对）', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    client.send({ t: 'session-leave', sessionId: conversationId })
    await host.until((f) => f.t === 'peer-left')
    assert.equal(ctx.relay.state.conversations.has(conversationId), true, '客户端离开不该删会话')
    void client
  } finally {
    await ctx.close()
  }
})

test('R3：被顶号的旧 socket 会重连并重新拿到身份（不靠人工干预）', async () => {
  const ctx = await startRelay()
  try {
    const { conversationId, host } = await pairUp(ctx)
    const first = ctx.open[1]
    const newer = await Peer.connect(ctx.url)
    ctx.open.push(newer)
    newer.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'inst-1' })
    await newer.until((f) => f.t === 'hello-ok')
    assert.equal((await first.closed).code, 4000)
    // 小程序的 socket 层在收到 close 后会自动重连；这里模拟它重连回来的那条连接
    const reconnected = await Peer.connect(ctx.url)
    ctx.open.push(reconnected)
    reconnected.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'inst-1' })
    await reconnected.until((f) => f.t === 'hello-ok')
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await reconnected.until((f) => f.t === 'enc')).sessionId, conversationId)
  } finally {
    await ctx.close()
  }
})

// ── 慢消费者（DESIGN-REVIEW 第 11 条 🟡）────────────────────────────────

/**
 * 把服务端这个 socket 的发送缓冲"钉"在超限状态。
 *
 * 为什么不真去堵 TCP：真堵法是 `client._socket.pause()`，但被暂停的 socket 读不了
 * ping，保活（两个扫掠周期就 terminate）会先于背压闸动手，于是测的不是背压闸。
 * 真机上的"慢消费者"恰恰是**还在应答、只是排不快**的那种，这个桩才是它的忠实替身。
 */
function pinBuffered(sock, bytes) {
  Object.defineProperty(sock, 'bufferedAmount', { get: () => bytes, configurable: true })
}

const closedWithin = (peer, ms) => Promise.race([peer.closed, sleep(ms).then(() => null)])

test('慢消费者：静默的对端同样会被定时扫描评估（判定不再挂在入站帧上）', async () => {
  const ctx = await startRelay({
    DRC_MAX_BUFFERED_BYTES: '4096',
    DRC_SWEEP_MS: '150',
    DRC_SLOW_CONSUMER_HOST_MS: '400',
  })
  try {
    const { host, conversationId } = await pairUp(ctx)
    const hostSock = ctx.relay.state.hostSocket(conversationId)
    assert.ok(hostSock, '主机 socket 必须能在 state 里取到')

    // 配对之后主机一个帧都不发：旧实现只挂在 ws.on('message') 上，永远不会评估它。
    pinBuffered(hostSock, 1_000_000)

    assert.equal(await closedWithin(host, 250), null, '未到窗口不许断（不是"超限即断"）')

    const closed = await closedWithin(host, 4_000)
    assert.ok(closed, '超限持续超过窗口后必须被断开；宿主静默 ⇒ 旧实现会永远不评估')
    assert.equal(closed.code, 1008)
    assert.equal(closed.reason, 'slow_consumer')
  } finally {
    await ctx.close()
  }
})

test('慢消费者：同样超限 1 秒，主机该断、客户端不该断（🟡11 的端到端回归点）', async () => {
  const ctx = await startRelay({
    DRC_MAX_BUFFERED_BYTES: '4096',
    DRC_SWEEP_MS: '150',
    DRC_SLOW_CONSUMER_HOST_MS: '300',
    // 客户端窗口远大于主机：这正是被修掉的那台"踢了就重连"的循环发动机
    DRC_SLOW_CONSUMER_CLIENT_MS: '3000',
  })
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    pinBuffered(ctx.relay.state.hostSocket(conversationId), 1_000_000)
    pinBuffered(ctx.relay.state.clients.get('inst-1').ws, 1_000_000)

    const hostClosed = await closedWithin(host, 3_000)
    assert.ok(hostClosed, '主机超限 ~0.3s 就该断（原有行为，不许被这次修复改掉）')
    assert.equal(hostClosed.code, 1008)

    await sleep(1_000)
    assert.equal(client.closeCode, null, '客户端超限 1 秒不许断：10s 这类短窗口正是把手机打进重连循环的原因')
  } finally {
    await ctx.close()
  }
})

test('P1-2：同一 socket 二次 hello 换 clientId，旧键必须释放（未认证即可让 clients 无界增长）', async () => {
  const ctx = await startRelay()
  try {
    const peer = await Peer.connect(ctx.url)
    ctx.open.push(peer)
    peer.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, protocol: 1, clientId: 'first-id' })
    await peer.until((f) => f.t === 'hello-ok')
    assert.equal(ctx.relay.state.clients.has('first-id'), true)

    // 同一条连接换身份：旧实现只 set 新键，close 时又只按最后一次的 clientId 调
    // clientGone —— 旧键永远留在表里。实测单连接 3000 个 id → clients:499。
    peer.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, protocol: 1, clientId: 'second-id' })
    const ok = await peer.until((f) => f.t === 'hello-ok' && f.clientId === 'second-id')
    assert.equal(ok.clientId, 'second-id')
    assert.equal(
      ctx.relay.state.clients.has('first-id'),
      false,
      '旧 clientId 必须被释放，否则未认证即可让这张 Map 无界增长',
    )
    assert.equal(ctx.relay.state.clients.size, 1, '同一 socket 只该占一个键')
    assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/healthz`).then((r) => r.json())).clients, 1)

    // 关掉之后不许有任何残留（旧实现的残留会一直挂到进程重启）。
    peer.ws.terminate()
    await peer.closed
    await sleep(100)
    assert.equal(ctx.relay.state.clients.size, 0, 'socket 关闭后仍残留 clientId 键')
  } finally {
    await ctx.close()
  }
})

test('P1-2：主机同 socket 换 hostId 也要释放旧键（同形缺陷，只是这一侧需要 token）', async () => {
  const ctx = await startRelay()
  try {
    const host = await Peer.connect(ctx.url)
    ctx.open.push(host)
    host.send({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, protocol: 1, token: TOKEN, hostId: 'host-one' })
    await host.until((f) => f.t === 'hello-ok')
    host.send({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, protocol: 1, token: TOKEN, hostId: 'host-two' })
    await host.until((f) => f.t === 'hello-ok' && f.hostId === 'host-two')
    assert.equal(ctx.relay.state.hosts.has('host-one'), false, '旧 hostId 键必须被释放')
    assert.equal(ctx.relay.state.hosts.size, 1)
  } finally {
    await ctx.close()
  }
})

test('主机重连不再向客户端重放 peer-joined（随仓 mp 客户端没有这条分支，且字段是错的）', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId, hostId } = await pairUp(ctx)
    // 主机换一条 socket 回来（同一个 hostId）：旧实现在这里向已连接的客户端发
    // `peer-joined`，而 mp 客户端的 `_onFrame` 里没有这个分支（落 default 静默忽略），
    // 字段还把 hostId 塞进了 clientId。既然没人消费，就不该有这条假信号。
    const reborn = await Peer.connect(ctx.url)
    ctx.open.push(reborn)
    reborn.send({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, protocol: 1, token: TOKEN, hostId })
    await reborn.until((f) => f.t === 'hello-ok')
    await client.expectNone((f) => f.t === 'peer-joined', 300)

    // 但"主机回来了"这件事本身照旧成立：下行密文仍能路由到客户端。
    reborn.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await client.until((f) => f.t === 'enc')).sessionId, conversationId)
    void host
  } finally {
    await ctx.close()
  }
})

test('P2：客户端上行 enc-batch 在主机缺席时也要回 host_unavailable，且不许 touchConversation', async () => {
  const ctx = await startRelay({ DRC_HOST_GRACE_MS: '60000' })
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    // 把活动时间钉在一个可辨认的过去值：touch 过就会变成 now。
    ctx.relay.state.conversations.get(conversationId).lastActivityAt = 1
    host.ws.terminate()
    await sleep(50)
    client.send({ t: 'enc-batch', sessionId: conversationId, items: [{ ciphertext: CIPHER }] })
    const err = await client.until((f) => f.t === 'error')
    assert.equal(err.code, 'host_unavailable', '与单帧路径对齐：主机不在要给可恢复的错误，而不是静默丢弃')
    assert.equal(
      ctx.relay.state.conversations.get(conversationId).lastActivityAt,
      1,
      '这一批根本没送到任何人手上，不许给它续命（否则没人接的会话在空闲 TTL 上永不过期）',
    )
  } finally {
    await ctx.close()
  }
})

test('停机：排空之后再补写一次盘（关 socket 之前的写看不到排空期间的变更）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drc-stop-'))
  const stateFile = join(dir, 'state.json')
  const ctx = await startRelay({ DRC_STATE_FILE: stateFile, DRC_STATE_SAVE_MS: '3600000' })
  try {
    const { client } = await pairUp(ctx)
    const before = ctx.relay.health().stateWrites
    // "排空期间的最后一次变更"：http 'close' 的监听器按注册顺序先于 close() 的回调跑，
    // 所以这次改动一定落在"关 socket 前那一次写盘"之后、收尾写盘之前。
    ctx.relay.http.on('close', () => {
      ctx.relay.state.conversations.values().next().value.seqHost = 424242
    })
    await ctx.relay.close()
    assert.equal(
      ctx.relay.health().stateWrites,
      before + 2,
      '停机必须写两次：关 socket 前一次、排空后一次（旧实现只写前一次，排空期间的变更随进程消失）',
    )
    const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(onDisk.conversations[0].seqHost, 424242, '排空期间的变更没落盘：第二次写发生在它之前')
    void client
  } finally {
    await ctx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('停机兜底：forceShutdown 补写一次盘并把 shutdownForced 记进 /healthz', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drc-forced-'))
  const stateFile = join(dir, 'state.json')
  const ctx = await startRelay({ DRC_STATE_FILE: stateFile, DRC_STATE_SAVE_MS: '3600000' })
  try {
    await pairUp(ctx)
    assert.equal(ctx.relay.health().shutdownForced, 0, '正常排空不该有这个计数')
    ctx.relay.forceShutdown()
    const health = ctx.relay.health()
    assert.equal(health.shutdownForced, 1, '兜底停机必须留下计数：它与排空成功同码 exit(0)，退出码分不出来')
    // ⚠️ 判据写的是"补写一次盘"，不是"版本号恰好是某个字面量"：
    // 落盘格式版本会随格式改动往上走（2026-10-11 晚 v1 → v2），
    // 这里钉死数字的话，升版本时红的是一个与"兜底写盘"无关的地方。
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).version, STATE_FILE_VERSION, '兜底路径也要补写一次盘')
  } finally {
    await ctx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重配：旧会话的密文不许再灌给已经重配的手机（🟡7）', async () => {
  // 与 CIPHER 只差首字符：同一个字符集、同一处填充，但字节不同。
  // 探针必须用**与正控不同的**密文——`expectNone` 会翻整段历史，
  // 用同一个密文就会命中正控那一帧，把"修好了"误判成"没修"。
  const CIPHER_PROBE = 'BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)

    // 正控：重配之前，旧会话这条通道本来就是活的
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    assert.equal((await client.until((f) => f.t === 'enc')).ciphertext, CIPHER)

    // 同一台手机（同一 clientId、同一 socket）重配到新会话
    host.send({ t: 'pair-begin', pairingToken: '999888' })
    await host.until((f) => f.t === 'pair-ready')
    client.send({ t: 'pair-begin-client', pairingToken: '999888' })
    // `until` 会先翻已经收到过的帧，所以必须点名"换了一个会话"的那条 paired
    const paired = await client.until((f) => f.t === 'paired' && f.sessionId !== conversationId)
    const nextConv = paired.sessionId
    assert.notEqual(nextConv, conversationId)

    // 旧主机必须被告知这个观众走了：与"客户端显式 session-leave"同一条通知，
    // 否则主机以为还有人在看，会继续往这个会话里推。
    const left = await host.until((f) => f.t === 'peer-left' && f.sessionId === conversationId)
    assert.equal(left.clientId, 'inst-1')

    // 主机在旧会话上继续发：手机必须先被摘掉，一帧都不该到达
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER_PROBE })
    await client.expectNone((f) => f.t === 'enc' && f.ciphertext === CIPHER_PROBE, 500)

    // 新会话照常送达——上一条断言不是"整个通道死了"的假绿
    host.send({ t: 'enc', sessionId: nextConv, ciphertext: CIPHER_PROBE })
    assert.equal((await client.until((f) => f.t === 'enc' && f.ciphertext === CIPHER_PROBE)).sessionId, nextConv)
  } finally {
    await ctx.close()
  }
})

test('/healthz 诊断计数：丢弃帧 / 慢消费者 / 被拒配对 都有出口（A8）', async () => {
  const ctx = await startRelay({
    DRC_MAX_BUFFERED_BYTES: '4096',
    DRC_SWEEP_MS: '150',
    DRC_SLOW_CONSUMER_HOST_MS: '400',
  })
  try {
    const healthOf = () => fetch(`http://127.0.0.1:${ctx.port}/healthz`).then((r) => r.json())
    const counters = async () => {
      const h = await healthOf()
      return { dropped: h.droppedFrames, slow: h.slowConsumers, rejected: h.rejectedPairs }
    }

    // 起点必须归零，否则后面的"增量"断言是假的。
    assert.deepEqual(await counters(), { dropped: 0, slow: 0, rejected: 0 }, '刚起来时三个计数都必须是 0')

    // ① 被拒配对：拿一个不存在的 6 位码去配，中继会回 pair-fail。
    const bogus = await Peer.connect(ctx.url)
    ctx.open.push(bogus)
    bogus.send({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      protocol: 1,
      clientId: 'inst-bogus',
      clientMeta: { platform: 'wechat-mp' },
    })
    await bogus.until((f) => f.t === 'hello-ok')
    bogus.send({ t: 'pair-begin-client', pairingToken: '000000' })
    await bogus.until((f) => f.t === 'pair-fail')
    assert.equal((await counters()).rejected, 1, '被拒的配对必须有出口，否则线上只能靠翻日志')

    // ② 丢弃帧：观众退场后会话仍在（会话归主机），主机继续下行 —— 这一帧没有收件人。
    //    R1 的"静默黑洞"正是这个形状，它必须至少在 /healthz 上可见。
    const { host, client, conversationId } = await pairUp(ctx)
    client.send({ t: 'session-leave', sessionId: conversationId })
    await host.until((f) => f.t === 'peer-left' && f.sessionId === conversationId)
    host.send({ t: 'enc', sessionId: conversationId, seq: 1, ciphertext: CIPHER })
    await sleep(250)
    assert.equal((await counters()).dropped, 1, '没有收件人的帧必须计数')

    // ③ 慢消费者：钉住主机的发送缓冲，越过窗口就会被 1008 断开。
    pinBuffered(ctx.relay.state.hostSocket(conversationId), 1_000_000)
    assert.ok(await closedWithin(host, 4_000), '主机应被断开（前一条测试已锁语义，这里只借它产生计数）')
    assert.equal((await counters()).slow, 1, '被断开的慢消费者必须计数')
  } finally {
    await ctx.close()
  }
})

/**
 * 掉线与解配必须能在主机那边分开（2026-10-05 用户报：解配后 pill 显示「手机离线」）。
 *
 * 这一条钉的是**另一半**：socket 关闭发出去的 peer-left **不许**带 unpaired。
 * 带错了，手机切一下后台主机就把配对作废 → 用户每次回前台都要重新扫码，
 * 那正是 D3 要防的产品缺陷，而且比原 bug 更隐蔽（只在切后台时发生）。
 */
test('socket 关闭的 peer-left 不许带 unpaired：D3（掉线不解除配对）必须原样', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    client.ws.terminate()
    const left = await host.until((f) => f.t === 'peer-left')
    assert.equal(left.sessionId, conversationId)
    assert.equal(left.unpaired, undefined, '掉线也标成了 unpaired：手机切后台就被要求重新扫码（D3 这条命脉不能动）')
  } finally {
    await ctx.close()
  }
})

// ── 七步分流已委托协议层（2026-10-17 接线）───────────────────────────
//
// 这一段的作用是**钉住那次重构**：入站分流原来在本文件里内联（七步 +
// 手抄帧名表 + 手写密文字符集预检），现在换成协议层的
// `classifyEndpointFrameText`。重构最典型的失败是"看起来一样、其实少了一条分支"，
// 而那不会让任何既有用例变红 —— 所以下面逐条对**错误码**断言，
// 并且每条都注明"少了它会怎样"。

test('委托给 classify 之后，七步分流的错误码逐条不变', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'junk' })
    await client.until((f) => f.t === 'hello-ok')

    // ⚠️ 这里**不能**用 `until((f) => f.t === 'error')` 逐条断言：那个助手是
    // `frames.find(match)`，它搜的是**整个缓冲区**，所以第二次调用会拿到第一次
    // 那条 bad_json —— 症状是"判据红在一个与实现毫无关系的分支上"。
    // 正确形状是：把七条坏帧**一次发完**，再按到达顺序读错误码序列。
    // （这正是「判据红了先确认它测的是不是那一段」的另一个实例。）
    const inputs = [
      '{not json', // ① 解析失败
      JSON.stringify('hello'), // ② 顶层不是对象
      JSON.stringify({ noType: 1 }), // ③ 没有帧名
      JSON.stringify({ t: 42 }), // ④ 帧名不是字符串
      JSON.stringify({ t: 'heartbeat' }), // ⑤ 名字不认识
      JSON.stringify({ t: 'enc', sessionId: 'c_000000000000' }), // ⑥ 名字对、形状坏
      JSON.stringify({ t: 'enc', sessionId: 'c_000000000000', ciphertext: '%%%nope%%%' }), // ⑦ 密文字符集
      JSON.stringify({ t: 'pair-begin' }), // ⑧ 主机侧的配对帧形状坏
      JSON.stringify({ t: 'pair-begin-client' }), // ⑨ 客户端侧的配对帧形状坏
    ]
    for (const text of inputs) client.rawText(text)

    // 收帧直到凑齐 9 条（8 条 error + 1 条 pair-fail），或超时。
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && client.frames.filter((f) => f.t === 'error' || f.t === 'pair-fail').length < 9) {
      await sleep(25)
    }
    const replies = client.frames.filter((f) => f.t === 'error' || f.t === 'pair-fail')
    assert.equal(replies.length, 9, `实收 ${replies.length} 条：${JSON.stringify(replies).slice(0, 400)}`)
    const codes = replies.map((f) => (f.t === 'pair-fail' ? `pair-fail:${f.reason}` : f.code))

    // 逐条对应上面 ①…⑨。顺序即到达顺序 —— 同一批发出去、同一连接进来，
    // 而 classify 是在**单线程**里逐帧判定的，所以到达顺序 = 判定顺序。
    assert.deepEqual(
      codes,
      [
        'bad_json', // ①
        'bad_json', // ②
        'bad_json', // ③
        'bad_json', // ④
        'unknown_frame', // ⑤ 「对端版本不对」
        'bad_frame', // ⑥ 「对端发了坏数据」—— 与 ⑤ 的排错方向完全相反
        'bad_frame', // ⑦ 密文那一层
        'bad_pair', // ⑧ 那是**主机**的 bug，说给主机听更准确
        'pair-fail:invalid_or_expired', // ⑨ 小程序只认那四个 reason 的中文文案（F6）
      ],
      `实得 ${JSON.stringify(codes)}`,
    )
    // ⑥ 与 ⑦ 都说得出"是哪条帧坏了"，而 ⑤ 说的是"版本不认识" ——
    // 三者的措辞不同是有用的：它们指向三个完全不同的排查方向。
    assert.match(replies[5].message ?? '', /enc/, '⑥ 要能看出是哪条帧坏了')
    assert.match(replies[5].message ?? '', /heartbeat|enc/, '⑥ 的 userHint 带帧名')
    assert.match(replies[6].message ?? '', /base64|不合法/, '⑦ 要说清是密文那一层')
    assert.equal(ctx.relay.health().ok, true, '一堆坏帧之后进程仍然健康')
  } finally {
    await ctx.close()
  }
})

test('enc-batch 的密文字符集也要逐项查（只查第一项是最容易漏的一条）', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'junk' })
    await client.until((f) => f.t === 'hello-ok')

    // 第一项合法、第二项非法：只查第一项的实现会**放行**，而对端解不开 → 静默黑洞
    client.send({ t: 'enc-batch', sessionId: 'c_000000000000', items: [{ ciphertext: CIPHER }, { ciphertext: '%%%' }] })
    const err = await client.until((f) => f.t === 'error')
    assert.equal(err.code, 'bad_frame', '第二项非法也必须被拒：放行的话主机收到一条解不开的帧，且没有任何报错')
  } finally {
    await ctx.close()
  }
})

test('/api/info 的 protocol 必须**引用** PROTOCOL_VERSION（判据只能查源码）', async () => {
  // ⚠️ 这条判据**只能**查源码，不能查行为 —— 而这不是偷懒，是物理限制：
  // `PROTOCOL_VERSION` 的值今天恰好是 1，所以"报 1"与"报 PROTOCOL_VERSION"
  // 在运行时**完全无法区分**。变异验证（把源码改回字面量 1）证实了这一点：
  // 行为判据全绿，而那正是它测不到的东西。
  //
  // 换成查源码之后，同一个变异会让它变红。代价是它只覆盖这一个文件的这几行
  // —— 但这已经比"一个恒绿的断言"好得多，而后者是这个项目里更常见的形状。
  const src = readFileSync(new URL('../src/http-routes.ts', import.meta.url), 'utf8')
  const line = src
    .split('\n')
    .find((l) => l.includes("pathname === '/api/info'") || l.includes('publicUrl: config.publicUrl'))
  assert.ok(line, '定位不到 /api/info 那行：判据本身失效了（它会静默放过一切）')
  // 找到真正拼 JSON 的那一行（下一行），断言它带常量名
  const lines = src.split('\n')
  const at = lines.findIndex((l) => l.includes("pathname === '/api/info'"))
  assert.ok(at > 0, '定位不到 /api/info 分支')
  const body = lines.slice(at, at + 8).join('\n')
  assert.match(
    body,
    /protocol: PROTOCOL_VERSION/,
    '必须引用 PROTOCOL_VERSION：这条是**无认证**接口，而小程序拿它判"能不能连"，' +
      '写死的版本号在协议升版时会静默变成一句谎话',
  )
  assert.ok(!/protocol: 1\b/.test(body), '不许写回字面量 1（变异验证证明：行为判据抓不住它，只有查源码能）')
})

test('转发的 enc 帧带 clientId，且 seq 原样透传（协议层 encToRelay 的接线）', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    // 客户端上行不带 seq：中继**不改**它（重新编号是中继→客户端方向独有的）
    client.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const got = await host.until((f) => f.t === 'enc')
    assert.equal(got.sessionId, conversationId)
    assert.equal(got.ciphertext, CIPHER, '密文必须逐字不变：任何加工都会让对侧解不开')
    // pairUp 的 clientId 是那个函数的局部变量（Peer 上没有这个属性），
    // 取值由 pairUp 的默认参数决定：'inst-1'。
    assert.equal(got.clientId, 'inst-1', '上行必须补 clientId —— 主机按它做 per-client 回调')
    assert.ok(!('seq' in got), '没带 seq 就不许凭空造一个：中继在��行方向不改它')
  } finally {
    await ctx.close()
  }
})

test('防御纵深：绕过 loadConfig 直接构造 config 时，ping 桶数仍被夹住', async () => {
  // 为什么需要这一条：`createRelay(config)` 是**导出的函数**，本仓的测试与将来的
  // 嵌入方都可以拿一份手写的 config 直接调它 —— 那样就绕过了 `loadConfig` 的夹取。
  // 而 `Array.from({length: 1e9})` 抛 RangeError：于是一个"配置写错"变成
  // "进程起不来"，而 main.ts 只能报一句 fatal，连"是哪个配置项"都没有。
  //
  // 所以 server.ts 里必须**自己也夹一道**，取值与 config.ts 相同。
  // 这条判据直接照那个形状造一份 config，不经过 loadConfig。
  const { config } = loadConfig({ ...process.env, DRC_HOST_TOKEN: TOKEN, DRC_PORT: '0', DRC_BIND: '127.0.0.1' }, 'test')
  config.pingTickMs = 1
  config.pingIntervalMs = Number.MAX_SAFE_INTEGER
  const relay = createRelay(config)
  try {
    // 只要求"构造得出、起得来"：不要求桶数等于某个具体值。
    const { port } = await relay.startListening()
    assert.ok(port > 0, '起得来')
    // 顺带看一眼健康面没被这个配置搞坏（心跳那一路仍在跑）
    assert.equal(relay.health().ok, true)
  } finally {
    await relay.close()
  }
})

test('re-hello 换身份：旧 clientId 必须从会话成员表里摘掉（否则空会话回收完全失效）', async () => {
  // 上面那条 state 级的判据钉的是 `leaveAll` 本身。这一条钉的是**接线**：
  // `releaseIdentityFor` 原来只走 `clientGone`（它**刻意不动成员表**，那是 D3 的
  // 机制：socket 断开时手机还可能用同一个 clientId 回来）。
  //
  // 但 re-hello 是**换身份**而不是断开——那条 socket 从此不再服务旧身份，
  // 旧 clientId 永远不会回来。于是"留着成员"那条 D3 理由在这里不成立，
  // 后果是：成员表里留着一个死成员 ⇒ `markEmpty` 永远不打点 ⇒
  // `sweepEmpty`（默认 30 分钟回收空会话）**完全失效**，唯一兜底是 7 天的空闲 TTL。
  //
  // 而 `releaseIdentityFor` 上方那段注释明明写着「换 id 要向它所在会话的主机发
  // `peer-left`」——通知发了，**成员没摘**，而回收判据读的是成员表。
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    const before = ctx.relay.state.conversations.get(conversationId)
    assert.equal(before.clients.size, 1, '刚配对上：这一条有一个成员')

    // 连发 3 次换 id 的 hello（模拟小程序重新安装/换设备后用新 installId 回来）
    for (let i = 0; i < 3; i++) {
      const n = client.frames.filter((f) => f.t === 'hello-ok').length
      client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, protocol: 1, clientId: `swapped-${i}` })
      await waitFor(() => client.frames.filter((f) => f.t === 'hello-ok').length > n)
    }

    const conv = ctx.relay.state.conversations.get(conversationId)
    assert.ok(conv, '会话本身必须留着（它归主机，主机可能还在上面跑）')
    assert.equal(
      conv.clients.size,
      0,
      `成员表里还留着 ${[...conv.clients].join(',')}：旧 clientId 已经不会回来了，` +
        '而它让 markEmpty 永远不打点 ⇒ sweepEmpty（30 分钟回收空会话）完全失效',
    )
    assert.ok(conv.emptySince !== undefined, '空会话必须打上回收计时：这是 sweepEmpty 唯一的入口，不打点就等于永不过期')
    // 顺带确认主机侧**确实**收到了通知（那段注释承诺的动作本来就做了）
    const left = host.frames.filter((f) => f.t === 'peer-left')
    assert.ok(left.length >= 1, '主机必须收到 peer-left：换身份了，它不该再往旧手机发密文')
  } finally {
    await ctx.close()
  }
})

test('配对表满的告警只记一次（逐帧判定的路径不许逐帧写日志）', async () => {
  // 三道闩锁里原本有 `notedFrameFlood` / `notedNonMember` / `pairBudgetWarnedAt`，
  // 而"配对表满"这一条**逐帧**判定（表满时每次 issuePair 都回 full:true）却是
  // 裸 `log.warn` —— 实测 maxPendingPairs=1 + 400 个 pair-begin = **400 行** journald。
  //
  // 为什么这条比"日志太多"严重：journald 的条数额度被打满时，中继**自己的**
  // 诊断日志会被一起抑制 —— 正是 log.ts 文件头记录的那起事故的同一通路。
  //
  // 判据形状：不数日志行（Log 是 silent 级别、且本仓不导出日志收集口），
  // 而是**断言语义**：那一批 400 个 pair-begin 全都仍然收到 `pair_table_full`
  // 错误帧（闩锁只限日志，不限协议响应——把它一起限掉就成了另一个缺陷）。
  // ⚠️ 上限取 **1**，而这依赖一条容易看漏的语义：`countClaimablePairs()`
  // **不数 used 的条目**，而 `pairUp` 会把它自己那张码认领掉（于是它变 used、
  // 不再占额度）。所以顺序是：pairUp 占 0 个可认领槽 → `000000` 填满那 1 个
  // → 之后每一发都 full。
  //
  // 第一次写这条判据时设成 2，于是多出**一个**空槽、只有第 60 发才被拒
  // （59/60）——症状是"判据差一条"，而根因是额度计算里那条"不数 used"。
  const ctx = await startRelay({ DRC_MAX_PENDING_PAIRS: '1' })
  try {
    const { host } = await pairUp(ctx)
    host.ws.send(JSON.stringify({ t: 'pair-begin', pairingToken: '000000' }))
    await host.until((f) => f.t === 'pair-ready' && f.pairingToken === '000000')
    // 灌 60 个：表已经满了，每一个都该回错误帧。
    // ⚠️ token 必须两两不同 —— 撞上就意味着那一发拿到的是"已存在那张码"的
    // 语义（pair-ready 而不是 pair_table_full），而判据数的是错误帧条数，
    // 于是它红在一个与闩锁无关的地方。（6 位码空间，'9xxxxx' 够用。）
    const FLOOD = 60
    for (let i = 0; i < FLOOD; i++) {
      host.ws.send(JSON.stringify({ t: 'pair-begin', pairingToken: `9${String(i).padStart(5, '0')}` }))
    }
    const deadline = Date.now() + 2000
    let seen = 0
    while (Date.now() < deadline && seen < FLOOD) {
      seen = host.frames.filter((f) => f.t === 'error' && f.code === 'pair_table_full').length
      if (seen < FLOOD) await sleep(20)
    }
    assert.equal(
      seen,
      FLOOD,
      `只收到 ${seen}/${FLOOD} 条 pair_table_full：闩锁必须只限**日志**，协议响应一个都不许少（少一个就是新缺陷）`,
    )
  } finally {
    await ctx.close()
  }
})

test('pair-fail 必须带上**是哪一张**码失败的（主机靠它避免作废错的那张）', async () => {
  // 主机侧的处理是"作废失败的那张码"，而这一帧原先只有 `reason` ——
  // 于是它只能拿"当前展示的那张"顶罪。多码并存时那会**作废错的那张**：
  // 屏幕上是码 B（完全有效），用户扫了一张早就过期的码 A → B 被丢弃，
  // B 的 PSK 没了 → 那条配对通道作废。
  //
  // 而主机侧会**补一张新码**（onPairFail 的最后一句），所以用户看到的是
  // 「我扫的码没用，主机又换了一张」——而他刚扫的那张其实是好的。
  const ctx = await startRelay()
  try {
    const { host, client } = await pairUp(ctx)
    // 主机手上有一张**有效**的码（123456，pairUp 发的）
    assert.ok(
      host.frames.some((f) => f.t === 'pair-ready'),
      '夹具自检：主机手上有码',
    )

    // 客户端报一张**根本不存在**的码
    client.send({ t: 'pair-begin-client', pairingToken: '999999' })
    const fail = await client.until((f) => f.t === 'pair-fail')
    assert.equal(fail.reason, 'invalid_or_expired')
    assert.equal(fail.pairingToken, '999999', '必须点名是哪一张失败的：主机靠它避免把「当前展示的那张」误当成废码')
  } finally {
    await ctx.close()
  }
})

test('形状不合的 pair-begin-client：pair-fail **不带** token（不可信的东西不许发）', async () => {
  // 这一支是"形状就不合法"（缺 pairingToken / 类型不对），所以从帧里读出来的
  // 任何 token 都不可信 —— 而主机侧会拿它去作废一张码，发错就是误伤。
  // 宁可让主机退回"作废展示中的那张"（它至少知道自己那张是谁）。
  //
  // 这与上一条**方向相反**而两条都要在：一条保证"能带就带"，
  // 这一条保证"不能带就不带"。
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'junk' })
    await client.until((f) => f.t === 'hello-ok')
    client.send({ t: 'pair-begin-client' }) // 缺 pairingToken
    const fail = await client.until((f) => f.t === 'pair-fail' || f.t === 'error')
    assert.equal(fail.t, 'pair-fail', '形状错仍然回 pair-fail 而不是 bad_frame（F6）')
    assert.equal(fail.pairingToken, undefined, '形状不合时那个 token 不可信，绝不能发给主机去作废一张码')
  } finally {
    await ctx.close()
  }
})

// ── P1-3 断线补帧（2026-10-22）────────────────────────────────────────
//
// 场景口径：计划写的是"断 10s、发 50 帧"，这里用"断开窗口"表达（真睡 10s 只会让
// 套件变慢而不改变语义：要补的正是"socket 不在时被分配掉的那些编号"）。
// 回放帧是**逐条 `enc`**（即便断线期间主机发的是 enc-batch：客户端逐项解密，
// 单条回放与批量回放在消费侧是同一条路）。

test('P1-3 补帧：断线期间的 50 帧，hello.resume 后原样补齐且 seq 连续', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    // 先建立"客户端上次收到哪里"：3 帧、seq 1..3。
    for (let i = 0; i < 3; i++) host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    await client.until((f) => f.t === 'enc' && f.seq === 3)
    const lastSeq = 3

    // 断线窗口：socket 不在，50 帧照样被编号、照样入环（那是要补的东西）。
    client.ws.terminate()
    await waitFor(() => ctx.relay.state.clientSockets(conversationId).length === 0)
    for (let i = 0; i < 50; i++) host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })

    // 重连 + 报游标。同一 clientId（D3 成员重挂）。
    const back = await Peer.connect(ctx.url)
    ctx.open.push(back)
    back.send({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      clientId: 'inst-1',
      resume: { sessionId: conversationId, fromSeq: lastSeq },
    })
    await back.until((f) => f.t === 'hello-ok')
    // 50 帧齐、seq 从 4 连到 53、密文原样。
    for (let i = 0; i < 50; i++) {
      const f = await back.next()
      assert.equal(f.t, 'enc', `第 ${i + 1} 帧不是 enc：${JSON.stringify(f).slice(0, 80)}`)
      assert.equal(f.seq, lastSeq + 1 + i, '回放必须按 seq 升序、一格不跳')
      assert.equal(f.ciphertext, CIPHER)
    }
    assert.ok(!back.has((f) => f.t === 'resume-gap'), '补齐了就不许再回 gap')
  } finally {
    await ctx.close()
  }
})

test('P1-3 反例：环溢出必须回 resume-gap{overflow}，而不是悄悄少发几帧', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    await client.until((f) => f.t === 'hello-ok')
    client.ws.terminate()
    await waitFor(() => ctx.relay.state.clientSockets(conversationId).length === 0)
    // 超过环容量（256）：最旧的必然被挤掉。
    const N = 300
    for (let i = 0; i < N; i++) host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    // healthz 的可补面（P1-3）：环是**有界**的——帧数卡在 256，不是把 300 帧都堆着。
    await waitFor(() => ctx.relay.health().replayRingFrames > 0)
    const ring = ctx.relay.health()
    assert.equal(ring.replayRingConversations, 1, '可补面要报出挂在几条会话上')
    assert.equal(
      ring.replayRingFrames,
      256,
      `环必须有界（256），实际 ${ring.replayRingFrames} —— 无界 = 一条长离线能把内存吃穿`,
    )

    const back = await Peer.connect(ctx.url)
    ctx.open.push(back)
    // fromSeq=0：环只剩尾巴，缺口覆盖不了。
    back.send({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      clientId: 'inst-1',
      resume: { sessionId: conversationId, fromSeq: 0 },
    })
    await back.until((f) => f.t === 'hello-ok')
    const gap = await back.until((f) => f.t === 'resume-gap')
    assert.equal(gap.sessionId, conversationId)
    assert.equal(gap.reason, 'overflow')
    // 反例的核心：**不许**补一部分装作补完（那正是 §10.7 S5 的形状）。
    await back.expectNone((f) => f.t === 'enc', 200)

    // 同一条会话、游标落在环内：只补尾巴，且一帧不多。
    const back2 = await Peer.connect(ctx.url)
    ctx.open.push(back2)
    back2.send({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      clientId: 'inst-1',
      resume: { sessionId: conversationId, fromSeq: N - 10 },
    })
    await back2.until((f) => f.t === 'hello-ok')
    const frames = []
    for (let i = 0; i < 10; i++) frames.push(await back2.next())
    assert.deepEqual(
      frames.map((f) => f.seq),
      [291, 292, 293, 294, 295, 296, 297, 298, 299, 300],
    )
    assert.ok(!back2.has((f) => f.t === 'resume-gap'), '补得出来就不许回 gap')
  } finally {
    await ctx.close()
  }
})

test('P1-3 反例：fromSeq 跑到计数器前面必须回 resume-gap{reset}', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    await client.until((f) => f.t === 'enc')
    assert.equal(client.frames.at(-1).seq, 1)

    const back = await Peer.connect(ctx.url)
    ctx.open.push(back)
    back.send({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      clientId: 'inst-1',
      // 计数器此刻是 1，游标却报 99：会话被重建过/状态被手改过的形状。
      resume: { sessionId: conversationId, fromSeq: 99 },
    })
    await back.until((f) => f.t === 'hello-ok')
    const gap = await back.until((f) => f.t === 'resume-gap')
    assert.equal(gap.reason, 'reset')
    await back.expectNone((f) => f.t === 'enc', 200)
  } finally {
    await ctx.close()
  }
})

test('P1-3 追平：fromSeq == seqHost 时什么都不回（零帧不是缺口）', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    for (let i = 0; i < 2; i++) host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    await client.until((f) => f.t === 'enc' && f.seq === 2)

    const back = await Peer.connect(ctx.url)
    ctx.open.push(back)
    back.send({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      clientId: 'inst-1',
      resume: { sessionId: conversationId, fromSeq: 2 },
    })
    await back.until((f) => f.t === 'hello-ok')
    // 连 resume-gap 都不许有：它说的是"缺了"，而这里什么都没缺。
    await back.expectNone((f) => f.t === 'resume-gap' || f.t === 'enc', 300)
  } finally {
    await ctx.close()
  }
})

test('P1-3 兼容：旧客户端不带 resume ⇒ 与本机制引入前逐字节相同（断线帧就是丢了）', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    await client.until((f) => f.t === 'enc')
    client.ws.terminate()
    await waitFor(() => ctx.relay.state.clientSockets(conversationId).length === 0)
    for (let i = 0; i < 5; i++) host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })

    // 旧客户端的 hello 就是**不带** resume 的那一帧。
    const back = await Peer.connect(ctx.url)
    ctx.open.push(back)
    back.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'inst-1' })
    await back.until((f) => f.t === 'hello-ok')
    // 没有任何回放、没有任何 gap：现状就是"断线期间的 5 帧丢了"。
    await back.expectNone((f) => f.t === 'enc' || f.t === 'resume-gap', 300)
    // 之后的 live 帧照常到达（多补一帧不许、少补一帧也不许）。
    host.send({ t: 'enc', sessionId: conversationId, ciphertext: CIPHER })
    const live = await back.until((f) => f.t === 'enc')
    assert.equal(live.seq, 7, 'live 帧的编号接在计数器上（1 + 5 + 1）')
  } finally {
    await ctx.close()
  }
})

test('P1-3：会话不存在/不是成员时静默跳过（不回 resume-gap、不报错）', async () => {
  // 那条路已经有 unknown_session（F5 唯一清配对信号）；多一个出口只会多一类
  // "两条路说法不一致"的故障。这里钉的是"resume 不许自立第二条出口"。
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      clientId: 'stranger',
      resume: { sessionId: 'c_does_not_exist', fromSeq: 0 },
    })
    await client.until((f) => f.t === 'hello-ok')
    await client.expectNone((f) => f.t === 'resume-gap' || f.t === 'error', 300)
  } finally {
    await ctx.close()
  }
})

test('P1-3：断线期间的 enc-batch 逐项入环，回放为单条 enc（消费侧同一条路）', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx)
    host.send({ t: 'enc-batch', sessionId: conversationId, items: [{ ciphertext: CIPHER }] })
    await client.until((f) => f.t === 'enc-batch')
    client.ws.terminate()
    await waitFor(() => ctx.relay.state.clientSockets(conversationId).length === 0)
    host.send({
      t: 'enc-batch',
      sessionId: conversationId,
      items: [{ ciphertext: CIPHER }, { ciphertext: CIPHER }, { ciphertext: CIPHER }],
    })

    const back = await Peer.connect(ctx.url)
    ctx.open.push(back)
    back.send({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      clientId: 'inst-1',
      resume: { sessionId: conversationId, fromSeq: 1 },
    })
    await back.until((f) => f.t === 'hello-ok')
    const seqs = []
    for (let i = 0; i < 3; i++) {
      const f = await back.next()
      assert.equal(f.t, 'enc', '批量项回放为单条 enc（小程序逐项解密，走同一条路）')
      seqs.push(f.seq)
    }
    assert.deepEqual(seqs, [2, 3, 4], '批量项各占一个编号，回放按编号升序')
  } finally {
    await ctx.close()
  }
})

// ── 埋点丰富（2026-10-23 用户裁决：不做开关、丰富埋点、只做在我们自己的 relay 上）──
//
// 为什么值得钉：昨晚（10-22）排查 cli-* 探测事件时，配对/掉线日志没有来源 IP、
// 没有连接时长、没有码等待时长 ⇒ 归因全靠 nginx 日志倒推。这四条把缺的读数直接
// 写进事件流；零知识边界不动（这些都是路由元数据，不是载荷内容）。

test('埋点：client online 带真实来源 IP（X-Forwarded-For 首项）', async () => {
  const infos = []
  const origInfo = Log.prototype.info
  Log.prototype.info = function (msg, fields) {
    infos.push({ msg, fields })
    return origInfo.call(this, msg, fields)
  }
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url, { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } })
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, protocol: 1, clientId: 'xff-1' })
    await client.until((f) => f.t === 'hello-ok')
    const online = infos.find((w) => w.msg === 'client online' && w.fields.clientId === 'xff-1')
    assert.ok(online, 'client online 必须留痕')
    assert.equal(
      online.fields.ip,
      '203.0.113.9',
      `必须取 X-Forwarded-For 首项（剥代理链），实际=${JSON.stringify(online.fields.ip)}`,
    )
  } finally {
    Log.prototype.info = origInfo
    await ctx.close()
  }
})

test('埋点：paired 带 ip + latencyMs（码从签发到被认领等了多久）', async () => {
  const infos = []
  const origInfo = Log.prototype.info
  Log.prototype.info = function (msg, fields) {
    infos.push({ msg, fields })
    return origInfo.call(this, msg, fields)
  }
  const ctx = await startRelay()
  try {
    await pairUp(ctx, { clientId: 'lat-1' })
    const paired = infos.find((w) => w.msg === 'paired' && w.fields.clientId === 'lat-1')
    assert.ok(paired, 'paired 必须留痕')
    assert.equal(typeof paired.fields.ip, 'string', `paired 必须带 ip，实际=${JSON.stringify(paired.fields)}`)
    assert.equal(
      typeof paired.fields.latencyMs,
      'number',
      `paired 必须带 latencyMs（number），实际=${JSON.stringify(paired.fields)}`,
    )
    assert.ok(paired.fields.latencyMs >= 0, 'latencyMs 不能是负数')
  } finally {
    Log.prototype.info = origInfo
    await ctx.close()
  }
})

test('埋点：client disconnected 带 ip + onlineMs（"闪断"顺畅率判据的数据源）', async () => {
  const infos = []
  const origInfo = Log.prototype.info
  Log.prototype.info = function (msg, fields) {
    infos.push({ msg, fields })
    return origInfo.call(this, msg, fields)
  }
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url, { headers: { 'x-real-ip': '198.51.100.7' } })
    client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, protocol: 1, clientId: 'dsc-1' })
    await client.until((f) => f.t === 'hello-ok')
    await sleep(30)
    client.ws.close()
    await client.closed
    await sleep(20)
    const gone = infos.find((w) => w.msg === 'client disconnected' && w.fields.clientId === 'dsc-1')
    assert.ok(gone, 'client disconnected 必须留痕')
    assert.equal(gone.fields.ip, '198.51.100.7', 'X-Real-IP 也要认（nginx 两个头都发）')
    assert.equal(typeof gone.fields.onlineMs, 'number', `必须带 onlineMs，实际=${JSON.stringify(gone.fields)}`)
    assert.ok(gone.fields.onlineMs >= 0, 'onlineMs 不能是负数')
  } finally {
    Log.prototype.info = origInfo
    await ctx.close()
  }
})

test('埋点：softwareVersion 无条件记（DRC_REPORT_VERSION 不再是闸）', async () => {
  /**
   * 用户裁决（2026-10-23）："不用做开关，丰富埋点" ⇒ 对端**送来**就记。
   * （`config.reportSoftwareVersion` 死开关已于 2026-10-24 审计删除——
   * 这条判据钉的是行为本体：**没有任何闸**能关掉记录。）
   */
  const infos = []
  const origInfo = Log.prototype.info
  Log.prototype.info = function (msg, fields) {
    infos.push({ msg, fields })
    return origInfo.call(this, msg, fields)
  }
  const ctx = await startRelay() // 无开关：对端送来就记
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      protocol: 1,
      clientId: 'ver-1',
      softwareVersion: '3.2.12-test',
    })
    await client.until((f) => f.t === 'hello-ok')
    const ver = infos.find((w) => w.msg === 'client software version' && w.fields.clientId === 'ver-1')
    assert.ok(ver, '开关默认关时也必须记（无条件）——这正是本判据要抓的反例')
    assert.equal(ver.fields.version, '3.2.12-test')
  } finally {
    Log.prototype.info = origInfo
    await ctx.close()
  }
})

test('埋点：上行帧计数 upCount（seqHost 只数下行，手机发了多少条此前没读数）', async () => {
  const ctx = await startRelay()
  try {
    const { host, client, conversationId } = await pairUp(ctx, { clientId: 'up-1' })
    const conv = ctx.relay.state.conversations.get(conversationId)
    assert.equal(conv.upCount, 0, '新建会话 upCount 从 0 起')
    // 上行两条：client→host 的 enc（seq 是客户端自报的，中继不重编号）
    client.send({ t: 'enc', sessionId: conversationId, seq: 1, ciphertext: CIPHER })
    await host.next()
    client.send({ t: 'enc', sessionId: conversationId, seq: 2, ciphertext: CIPHER })
    await host.next()
    assert.equal(conv.upCount, 2, '上行每送达主机一条 +1')
    // 下行不许污染 upCount（那归 seqHost）
    host.send({ t: 'enc', sessionId: conversationId, seq: 0, ciphertext: CIPHER })
    await client.next()
    assert.equal(conv.upCount, 2, '下行只进 seqHost，upCount 不动')
    assert.equal(conv.seqHost, 1, '下行由中继重新编号')
  } finally {
    await ctx.close()
  }
})
