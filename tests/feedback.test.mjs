/**
 * feedback — 反馈面的中继侧判据（2026-10-26）。
 *
 * 这一面是**明文**的（反馈本来就是明文：它的读者是"要改这个产品的人"），
 * 所以它同时是**信任边界**与**产品承诺的执行点**。四条纪律，各一组判据：
 *
 *   ① **只有配对成功的用户能提**（产品裁决）：中继以"这个 clientId 是不是某条
 *      活跃会话的成员"为凭据 —— 那需要真走过一次扫码 + SAS 确认，不是自报能伪造的。
 *   ② **只看得到自己的**：列表按 clientId 过滤，反馈是明文，"谁能看到谁的"
 *      必须在中继这一侧就定死，不能靠客户端自觉。
 *   ③ **限频出声**：客户端**无鉴权**（clientId 自报），闸门用尽要回 `rate_limited`
 *      而不是静默丢 —— 静默丢会让用户以为提交成功了。
 *   ④ **承诺可查**：未回/逾期条数按 24 小时口径给运维接口 —— 一条没人查的
 *      承诺等于没有承诺。
 *
 * 另外两条运维纪律：
 *   · 运维接口**没配令牌就不存在**（404 而不是 401：后者会告诉探测者"这里有东西"）；
 *   · 反馈落盘**独立于会话表**（另一个文件）⇒ 独立失败域。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createRelay } from '../dist/src/server.js'
import { loadConfig } from '../dist/src/config.js'
import { FeedbackStore } from '../dist/src/feedback.js'
import { PROTOCOL_VERSION } from '@dsh-remote/protocol/negotiate'

const TOKEN = 'feedback-test-host-token-0123456789abcd'
const ADMIN = 'feedback-admin-token-0123456789'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'drc-feedback-'))
}

function quietLog() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }
}

async function startRelay(overrides = {}) {
  const env = {
    ...process.env,
    DRC_HOST_TOKEN: TOKEN,
    DRC_PORT: '0',
    DRC_BIND: '127.0.0.1',
    DRC_LOG_LEVEL: 'silent',
    DRC_PAIR_TTL_MS: '30000',
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

/** 配对成功：主机发码 → 手机认领 ⇒ 手机成为某条会话的成员。 */
async function pairUp(ctx, { clientId = 'inst-1', token = '123456' } = {}) {
  const host = await Peer.connect(ctx.url)
  ctx.open.push(host)
  host.send({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, hostId: 'h-1', token: TOKEN, label: 'bins' })
  await host.until((f) => f.t === 'hello-ok')
  host.send({ t: 'pair-begin', pairingToken: token })
  await host.until((f) => f.t === 'pair-ready')

  const client = await Peer.connect(ctx.url)
  ctx.open.push(client)
  client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId })
  await client.until((f) => f.t === 'hello-ok')
  client.send({ t: 'pair-begin-client', pairingToken: token })
  const paired = await client.until((f) => f.t === 'paired' || f.t === 'error')
  assert.equal(paired.t, 'paired', '配对必须成功（判据装置自检）')
  return { host, client }
}

// ── 存储层 ────────────────────────────────────────────────────────────

test('存储：收一条、列出、按 id 找到；同 id 再来一次是重发不是新的一条', () => {
  const store = new FeedbackStore({
    path: '',
    maxEntries: 10,
    perClientPerHour: 5,
    perIpPerHour: 10,
    log: quietLog(),
  })
  const first = store.add('c-1', '1.2.3.4', { id: 'fb_1', text: '码扫不上' }, 1000)
  assert.equal(first.ok, true)
  const again = store.add('c-1', '1.2.3.4', { id: 'fb_1', text: '码扫不上' }, 1001)
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'duplicate', '同 id 必须是重发（幂等键）')
  assert.equal(store.size, 1, '重发不许变成两条')
})

test('存储：列表只含自己的条目（反馈是明文，谁能看到谁的要在这里定死）', () => {
  const store = new FeedbackStore({
    path: '',
    maxEntries: 10,
    perClientPerHour: 5,
    perIpPerHour: 10,
    log: quietLog(),
  })
  store.add('c-1', '1.1.1.1', { id: 'fb_1', text: 'A 的意见' }, 1000)
  store.add('c-2', '2.2.2.2', { id: 'fb_2', text: 'B 的意见' }, 1001)
  const mine = store.listFor('c-1')
  assert.equal(mine.length, 1)
  assert.equal(mine[0].text, 'A 的意见')
  // 协议形状里**不许**出现 clientId / ip（那是运维字段）
  assert.deepEqual(Object.keys(mine[0]).sort(), ['at', 'id', 'status', 'text'])
})

test('存储：限频出声（per client 与 per IP 两道闸）', () => {
  const store = new FeedbackStore({
    path: '',
    maxEntries: 100,
    perClientPerHour: 2,
    perIpPerHour: 2,
    log: quietLog(),
  })
  assert.equal(store.add('c-1', '1.1.1.1', { id: 'a', text: 'x' }, 1000).ok, true)
  assert.equal(store.add('c-1', '1.1.1.1', { id: 'b', text: 'x' }, 1001).ok, true)
  const third = store.add('c-1', '1.1.1.1', { id: 'c', text: 'x' }, 1002)
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'rate_limited_client')
  // 换个 clientId，但同一个 IP —— IP 那道闸还在
  const other = store.add('c-9', '1.1.1.1', { id: 'd', text: 'x' }, 1003)
  assert.equal(other.ok, false)
  assert.equal(other.reason, 'rate_limited_ip')
  // 被拒的提交**不消耗**配额：再用一个新 clientId 从同一个 IP 来，仍被 IP 闸挡住
  const other2 = store.add('c-10', '1.1.1.1', { id: 'e', text: 'x' }, 1004)
  assert.equal(other2.reason, 'rate_limited_ip', '被拒的那次不该把 client 额度吃掉')
})

test('存储：回复推进到 replied，不覆盖原话；SLA 按 24 小时口径算逾期', () => {
  const store = new FeedbackStore({
    path: '',
    maxEntries: 10,
    perClientPerHour: 5,
    perIpPerHour: 10,
    log: quietLog(),
  })
  store.add('c-1', '1.1.1.1', { id: 'fb_1', text: '码扫不上' }, 1000)
  const slaBefore = store.slaCounts(1000 + 25 * 3600 * 1000)
  assert.equal(slaBefore.open, 1)
  assert.equal(slaBefore.overdue, 1, '超过 24 小时还没回 ⇒ 逾期')
  assert.equal(slaBefore.slaHours, 24, '承诺的数要能被别人读到')

  assert.equal(store.reply('fb_1', '收到，正在查', 1000 + 3600 * 1000), true)
  const item = store.listFor('c-1')[0]
  assert.equal(item.status, 'replied')
  assert.equal(item.text, '码扫不上', '回复不许覆盖用户原话')
  assert.equal(item.reply, '收到，正在查')
  assert.equal(store.slaCounts(1000 + 25 * 3600 * 1000).open, 0, '回过就不算未回')
  assert.equal(store.reply('fb_不存在', 'x', 1), false, '回一条不存在的 ⇒ 失败而不是新建')
})

test('落盘往返：带**回复**的那条也要原样回来（2026-10-26 线上事故的判据）', () => {
  // ⚠️ 这条判据是**线上事故逼出来的**：0.5.4 的 sanitizeEntry 里把 `raw.reply`
  // 写成了 `raw.raw`（笔误）⇒ 凡是带回复的条目读回时全被丢（`dropped: 1, kept: 0`）。
  // 而当时的判据只验了"内存里回复推进到 replied"，**没走 save → load 的往返**
  // —— 丢字段的地方恰恰是往返。
  // ⇒ 这条钉住：**带回复、带联系方式的条目**写盘再读回来必须一字不差。
  const dir = tmpDir()
  try {
    const p = join(dir, 'feedback.json')
    const store = new FeedbackStore({
      path: p,
      maxEntries: 10,
      perClientPerHour: 5,
      perIpPerHour: 10,
      log: quietLog(),
    })
    store.add('c-1', '1.1.1.1', { id: 'fb_open', text: '还没回的' }, 1000)
    store.add('c-1', '1.1.1.1', { id: 'fb_done', text: '已经回的', contact: 'a@b.c' }, 1001)
    store.reply('fb_done', '收到，下一版就改', 1002)

    const restored = new FeedbackStore({
      path: p,
      maxEntries: 10,
      perClientPerHour: 5,
      perIpPerHour: 10,
      log: quietLog(),
    })
    const kept = restored.load()
    assert.equal(kept, 2, `两条都要回来（线上那次是 kept: 0, dropped: 1）`)
    const done = restored.listFor('c-1').find((i) => i.id === 'fb_done')
    assert.ok(done, '带回复的那条必须在')
    assert.equal(done.status, 'replied')
    assert.equal(done.reply, '收到，下一版就改', '回复正文不能丢')
    assert.equal(done.contact, 'a@b.c', '联系方式不能丢')
    assert.equal(done.repliedAt, 1002, '回复时刻不能丢')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('落盘：写出来再读回来还是那几条；坏文件按空处理（不抛）', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'feedback.json')
    const store = new FeedbackStore({
      path: p,
      maxEntries: 10,
      perClientPerHour: 5,
      perIpPerHour: 10,
      log: quietLog(),
    })
    store.add('c-1', '1.1.1.1', { id: 'fb_1', text: '码扫不上' }, 1000)
    store.add('c-1', '1.1.1.1', { id: 'fb_2', text: '还有一条', contact: 'a@b.c' }, 1001)

    const raw = JSON.parse(readFileSync(p, 'utf8'))
    assert.equal(raw.entries.length, 2, '反馈必须真的落盘（明文，但独立文件）')

    const restored = new FeedbackStore({
      path: p,
      maxEntries: 10,
      perClientPerHour: 5,
      perIpPerHour: 10,
      log: quietLog(),
    })
    assert.equal(restored.load(), 2, '重启后反馈要回来（否则用户提的意见凭空消失）')
    assert.equal(restored.listFor('c-1').length, 2)

    // 坏文件：JSON 坏 ⇒ 按空处理，**不抛**（起不来的中继等于产品停摆）
    writeFileSync(p, '{ 这不是 json', 'utf8')
    const broken = new FeedbackStore({
      path: p,
      maxEntries: 10,
      perClientPerHour: 5,
      perIpPerHour: 10,
      log: quietLog(),
    })
    assert.equal(broken.load(), 0, '坏文件按空处理')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 帧路由 ────────────────────────────────────────────────────────────

test('资格闸：未配对的客户端提反馈 ⇒ not_paired（且**不是** unknown_session）', async () => {
  const ctx = await startRelay()
  try {
    const client = await Peer.connect(ctx.url)
    ctx.open.push(client)
    client.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'inst-x' })
    await client.until((f) => f.t === 'hello-ok')
    client.send({ t: 'feedback', id: 'fb_1', text: '我配不上' })
    const err = await client.until((f) => f.t === 'error')
    assert.equal(err.code, 'not_paired', '未配对必须被拒')
    assert.notEqual(err.code, 'unknown_session', '⚠️ 绝不能是 unknown_session —— 那个码会让客户端清配对要求重扫')
    assert.ok(err.message && err.message.includes('配对'), '给用户的文案要说清"先配对"')
  } finally {
    await ctx.close()
  }
})

test('配对之后：提交即收到自己的列表（已收到是可见的），别人看不到', async () => {
  const ctx = await startRelay()
  try {
    const { client } = await pairUp(ctx, { clientId: 'inst-1' })
    client.send({ t: 'feedback', id: 'fb_1', text: '配对页的码扫不上' })
    const list = await client.until((f) => f.t === 'feedback-list')
    assert.equal(list.items.length, 1)
    assert.equal(list.items[0].text, '配对页的码扫不上')
    assert.equal(list.items[0].status, 'open')

    // 另一台手机（配对到同一台主机）**看不到**这条
    const other = await Peer.connect(ctx.url)
    ctx.open.push(other)
    other.send({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId: 'inst-2' })
    await other.until((f) => f.t === 'hello-ok')
    other.send({ t: 'feedback-poll' })
    const otherList = await other.until((f) => f.t === 'feedback-list')
    assert.equal(otherList.items.length, 0, '别人的反馈不许出现在我的列表里')
  } finally {
    await ctx.close()
  }
})

test('主机不能替用户提反馈（反馈只认客户端）', async () => {
  const ctx = await startRelay()
  try {
    const { host } = await pairUp(ctx)
    host.send({ t: 'feedback', id: 'fb_1', text: '主机塞的一条' })
    const err = await host.until((f) => f.t === 'error')
    assert.equal(err.code, 'need_client', '主机发反馈必须被拒')
  } finally {
    await ctx.close()
  }
})

test('重发同一条（网络抖动）不产生第二条', async () => {
  const ctx = await startRelay()
  try {
    const { client } = await pairUp(ctx)
    client.send({ t: 'feedback', id: 'fb_1', text: '同一条' })
    await client.until((f) => f.t === 'feedback-list')
    client.send({ t: 'feedback', id: 'fb_1', text: '同一条' })
    const list = await client.until((f) => f.t === 'feedback-list' && f.items.length === 1)
    assert.equal(list.items.length, 1, '重发不许变成两条')
  } finally {
    await ctx.close()
  }
})

// ── 运维接口 ──────────────────────────────────────────────────────────

test('运维接口：没配令牌 ⇒ 整条路由不存在（404，不是 401）', async () => {
  const ctx = await startRelay()
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/feedback`)
    assert.equal(res.status, 404, '没有令牌就没有这个接口（401 会告诉探测者"这里有东西"）')
  } finally {
    await ctx.close()
  }
})

test('运维接口：带令牌能读全部反馈与 SLA 计数；回一条会推给在线的手机', async () => {
  const ctx = await startRelay({ DRC_ADMIN_TOKEN: ADMIN })
  try {
    const { client } = await pairUp(ctx)
    client.send({ t: 'feedback', id: 'fb_1', text: '配对页的码扫不上' })
    await client.until((f) => f.t === 'feedback-list')

    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/feedback`, {
      headers: { 'x-drc-admin-token': ADMIN },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.total, 1)
    assert.equal(body.open, 1)
    assert.equal(body.overdue, 0)
    assert.equal(body.slaHours, 24, '承诺的 24 小时要能被读到')
    assert.equal(body.items[0].text, '配对页的码扫不上')

    // 回一条 ⇒ 在线的那台手机立刻收到更新后的列表
    const replyRes = await fetch(`http://127.0.0.1:${ctx.port}/api/feedback/reply`, {
      method: 'POST',
      headers: { 'x-drc-admin-token': ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'fb_1', text: '收到，下一版修' }),
    })
    assert.equal(replyRes.status, 200)
    const updated = await client.until(
      (f) => f.t === 'feedback-list' && f.items.length > 0 && f.items[0].status === 'replied',
    )
    assert.equal(updated.items[0].reply, '收到，下一版修')
  } finally {
    await ctx.close()
  }
})

test('运维接口：令牌不对 ⇒ 404（不泄露"这里有管理接口"）', async () => {
  const ctx = await startRelay({ DRC_ADMIN_TOKEN: ADMIN })
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/feedback`, {
      headers: { 'x-drc-admin-token': 'wrong-token' },
    })
    assert.equal(res.status, 404)
  } finally {
    await ctx.close()
  }
})
