/**
 * 会话表落盘的测试（HANDOFF §1.1 方案 A）。
 *
 * 判据就是 §1.1 写死的那五条验收，外加三组纯内存单测（读/写/恢复的边界）。
 * 集成那几条**真的起中继、真的连 socket、真的重启进程内的中继实例**——
 * 因为"重启后配对还在"这件事只有跨实例才验得出来，在同一个实例里它是废话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createRelay } from '../dist/src/server.js'
import { loadConfig } from '../dist/src/config.js'
import { Log } from '../dist/src/log.js'
import { RelayState, WS_OPEN } from '../dist/src/state.js'
import { STATE_FILE_VERSION, readStateFile, restoreState, snapshotState, writeStateFile } from '../dist/src/persist.js'
import { skipUnlessPosix } from './test-platform.mjs'

const TOKEN = 'unit-test-host-token-0123456789abcdef'
const CIPHER = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'drc-persist-'))
}

/** 抓日志：验收第 4 条要判"中继照常起来**且日志说清**"，所以必须能看见说了什么。
 *
 * `messages` 是 **getter**，而且**不能解构**：解构会在那一刻就把 getter 求值成一个空数组，
 * 于是每条"要留痕"的判据都恒假——判据自己不会红，只会永远绿。凡是要看日志的判据，
 * 一律留着 `cap` 这个持有者、现取 `cap.messages`。 */
function captureLog(level = 'debug') {
  const records = []
  const log = new Log(level, (line) => records.push(JSON.parse(line)))
  return {
    log,
    records,
    get messages() {
      return records.map((r) => r.msg)
    },
  }
}

async function startRelay(env = {}) {
  const merged = {
    ...process.env,
    DRC_HOST_TOKEN: TOKEN,
    DRC_PORT: '0',
    DRC_BIND: '127.0.0.1',
    DRC_LOG_LEVEL: 'silent',
    DRC_PAIR_TTL_MS: '30000',
    DRC_HOST_GRACE_MS: '250',
    // 默认关：环境里若真设了 DRC_STATE_FILE，也不该渗进"行为与今天完全一致"那条判据。
    DRC_STATE_FILE: '',
    ...env,
  }
  const { config, problems } = loadConfig(merged, 'test')
  assert.equal(problems.filter((p) => p.level === 'error').length, 0, '测试配置不合法')
  const relay = createRelay(config)
  const { port } = await relay.startListening()
  return { relay, port, url: `ws://127.0.0.1:${port}`, open: [] }
}

async function stopRelay(ctx) {
  for (const peer of ctx.open) peer.terminate()
  await ctx.relay.close()
}

class Peer {
  constructor(ws) {
    this.ws = ws
    this.frames = []
    this.waiters = []
    this.cursor = 0
    ws.on('message', (raw) => {
      let frame = null
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        frame = { t: '__invalid_json__' }
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

  terminate() {
    this.ws.terminate()
  }

  next(timeoutMs = 2000) {
    if (this.frames.length > this.cursor) return Promise.resolve(this.frames[this.cursor++])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`等帧超时；已收到 ${JSON.stringify(this.frames).slice(0, 300)}`)),
        timeoutMs,
      )
      this.waiters.push({
        resolve: (f) => {
          this.cursor += 1
          clearTimeout(timer)
          resolve(f)
        },
        timer,
      })
    })
  }

  async until(match, timeoutMs = 2000) {
    const seen = this.frames.find(match)
    if (seen) return seen
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = await this.next(Math.max(50, deadline - Date.now()))
      if (match(frame)) return frame
    }
    throw new Error(`没等到匹配的帧；已收到 ${JSON.stringify(this.frames).slice(0, 300)}`)
  }
}

async function pairUp(ctx, { clientId = 'inst-1', token = '123456' } = {}) {
  const host = await Peer.connect(ctx.url)
  host.send({ t: 'hello', role: 'host', protocol: 1, token: TOKEN, label: 'bins' })
  const hostOk = await host.until((f) => f.t === 'hello-ok')
  host.send({ t: 'pair-begin', pairingToken: token })
  await host.until((f) => f.t === 'pair-ready')

  const client = await Peer.connect(ctx.url)
  client.send({
    t: 'hello',
    role: 'client',
    protocol: 1,
    clientId,
    clientMeta: { platform: 'wechat-mp' },
  })
  await client.until((f) => f.t === 'hello-ok')
  client.send({ t: 'pair-begin-client', pairingToken: token })
  const paired = await client.until((f) => f.t === 'paired')
  ctx.open.push(host, client)
  return { host, client, hostId: hostOk.hostId, conversationId: paired.sessionId, clientId }
}

// ── 验收 1：重启中继 → conversations 仍然 > 0 ──────────────────────────

test('验收 1：配对后重启中继，会话表不是空的', async () => {
  const dir = tmpDir()
  const stateFile = join(dir, 'state.json')
  try {
    const first = await startRelay({ DRC_STATE_FILE: stateFile })
    const { conversationId } = await pairUp(first)
    assert.equal(first.relay.health().conversations, 1)
    // 配对那一刻就该落盘——不等清扫、不等周期补写。
    const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(onDisk.version, STATE_FILE_VERSION)
    assert.equal(onDisk.conversations.length, 1)
    assert.equal(onDisk.conversations[0].conversationId, conversationId)
    await stopRelay(first)

    const second = await startRelay({ DRC_STATE_FILE: stateFile })
    try {
      const health = second.relay.health()
      assert.equal(health.conversations, 1, '重启后会话必须还在')
      assert.equal(health.persistence, 'on')
      assert.equal(health.stateRestored, 1)
      assert.ok(health.stateWrites >= 0)
    } finally {
      await stopRelay(second)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 验收 2：手机带旧 convId 连上来 → 不回 unknown_session ───────────────

test('验收 2：重启后手机用旧 convId 发帧，不回 unknown_session（不用重新扫码）', async () => {
  const dir = tmpDir()
  const stateFile = join(dir, 'state.json')
  try {
    const first = await startRelay({ DRC_STATE_FILE: stateFile })
    const { conversationId, clientId } = await pairUp(first)
    await stopRelay(first)

    const second = await startRelay({ DRC_STATE_FILE: stateFile })
    try {
      // 同一台手机冷启动：还是存储里那个 clientId、那个 convId。
      const phone = await Peer.connect(second.url)
      second.open.push(phone)
      phone.send({ t: 'hello', role: 'client', protocol: 1, clientId, clientMeta: { platform: 'wechat-mp' } })
      await phone.until((f) => f.t === 'hello-ok')
      phone.send({ t: 'enc', sessionId: conversationId, seq: 1, ciphertext: CIPHER })
      const reply = await phone.until(
        (f) => f.t === 'error' || f.t === 'paired' || f.t === 'enc' || f.t === 'enc-batch',
      )
      // 核心判据：绝不能是 unknown_session（那正是"会话已失效，请重新扫码"）。
      // 主机还没回来时给 host_unavailable 才是对的——那不丢配对，等主机回来重发即可；
      // 反过来把 host_unavailable 也当成失败，就等于要求"重启后立刻能跑"，而那条路由
      // 依赖主机连回来（下面 2b 验的就是它）。
      assert.notEqual(reply.code, 'unknown_session', '重启后旧 convId 不该被判为失效')
      assert.ok(
        reply.t !== 'error' || reply.code === 'host_unavailable',
        `只该是"主机还没回来"，实际收到：${JSON.stringify(reply)}`,
      )
    } finally {
      await stopRelay(second)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('验收 2b：重启后主机 resync 声明该会话，手机与主机之间的密文能重新跑通', async () => {
  const dir = tmpDir()
  const stateFile = join(dir, 'state.json')
  try {
    const first = await startRelay({ DRC_STATE_FILE: stateFile })
    const { conversationId, hostId } = await pairUp(first)
    await stopRelay(first)

    const second = await startRelay({ DRC_STATE_FILE: stateFile })
    try {
      // 主机回来：声明它仍持有的会话（复核 R1 那条路）。
      // **必须带上原来的 hostId**：不带的话中继会 `newHostId()` 发一个新的身份，
      // 那台"新主机"自然不属于这条会话——路由是对的，身份认错了（真实插件总会带它）。
      const host = await Peer.connect(second.url)
      second.open.push(host)
      host.send({ t: 'hello', role: 'host', protocol: 1, token: TOKEN, label: 'bins', hostId })
      const hostOk = await host.until((f) => f.t === 'hello-ok')
      assert.equal(hostOk.hostId, hostId, '主机身份必须原样认回')
      host.send({ t: 'resync', sessionIds: [conversationId] })

      const phone = await Peer.connect(second.url)
      second.open.push(phone)
      phone.send({ t: 'hello', role: 'client', protocol: 1, clientId: 'inst-1' })
      await phone.until((f) => f.t === 'hello-ok')
      // 上行：手机发一帧，**主机**收得到。成功的上行对发送方是静默的（不回任何帧），
      // 所以判据要落在收件人身上——落在手机身上等回复，等的是一条永远不存在的消息。
      phone.send({ t: 'enc', sessionId: conversationId, seq: 1, ciphertext: CIPHER })
      const up = await host.until((f) => f.t === 'enc' || f.t === 'error')
      assert.equal(up.t, 'enc', `上行应当通：${JSON.stringify(up)}`)
      assert.equal(up.ciphertext, CIPHER)

      // 下行：主机推一帧，手机收得到——链路真的通了，不只是没报错。
      host.send({ t: 'enc', sessionId: conversationId, seq: 1, ciphertext: CIPHER })
      const down = await phone.until((f) => f.t === 'enc' || f.t === 'error')
      assert.equal(down.t, 'enc', `下行应当通：${JSON.stringify(down)}`)
      assert.equal(down.sessionId, conversationId)
      assert.equal(down.ciphertext, CIPHER)
    } finally {
      await stopRelay(second)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 验收 3：没状态文件时行为与今天完全一致 ─────────────────────────────

test('验收 3：不配 DRC_STATE_FILE 时行为不变，也不凭空多出状态文件', async () => {
  const dir = tmpDir()
  try {
    const ctx = await startRelay()
    try {
      const { conversationId, host, client } = await pairUp(ctx)
      const health = ctx.relay.health()
      assert.equal(health.persistence, 'off')
      assert.equal(health.conversations, 1)
      assert.equal(health.stateWrites, 0)
      // 数据面照常（没开落盘不代表功能坏了——这条守住"默认关闭"没有顺手关掉别的东西）。
      host.send({ t: 'enc', sessionId: conversationId, seq: 1, ciphertext: CIPHER })
      const down = await client.until((f) => f.t === 'enc' || f.t === 'error')
      assert.equal(down.t, 'enc')
      assert.deepEqual(readdirSync(dir), [], '没配路径就不该写出任何文件')
    } finally {
      await stopRelay(ctx)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 验收 4：状态文件损坏 → 照常起来，日志说清，按空处理 ──────────────────

test('验收 4：状态文件损坏时中继照常起来，日志说清，并按空处理', async () => {
  const dir = tmpDir()
  const stateFile = join(dir, 'state.json')
  try {
    writeFileSync(stateFile, '{ this is not json at all')
    // 起不来的中继等于整个产品停摆；所以这里必须记日志，否则"配对总丢"会查无实据。
    const cap = captureLog('debug')
    assert.equal(restoreState(stateFile, new RelayState(), cap.log, 1000), 0)
    assert.ok(
      cap.messages.some((m) => m.includes('corrupt')),
      `坏文件要留痕，实际日志：${JSON.stringify(cap.messages)}`,
    )
    const ctx = await startRelay({ DRC_STATE_FILE: stateFile })
    try {
      const health = ctx.relay.health()
      assert.equal(health.ok, true, '坏状态文件不许让中继起不来')
      assert.equal(health.conversations, 0, '按空处理')
      assert.equal(health.stateRestored, 0)
      // 数据面照常：中继起来了就必须还能用（"起不来"与"起来了但半残"同样是停摆）。
      const phone = await Peer.connect(ctx.url)
      ctx.open.push(phone)
      phone.send({ t: 'hello', role: 'client', protocol: 1, clientId: 'inst-1' })
      const ok = await phone.until((f) => f.t === 'hello-ok')
      assert.equal(ok.clientId, 'inst-1')
    } finally {
      await stopRelay(ctx)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('验收 4b：版本不认识 / 顶层形状坏 → 一律按空，不猜字段', () => {
  const dir = tmpDir()
  try {
    for (const [name, body] of [
      ['version.json', JSON.stringify({ version: 99, savedAt: 1, conversations: [] })],
      ['shape.json', JSON.stringify([1, 2, 3])],
      ['nested.json', JSON.stringify({ version: STATE_FILE_VERSION, savedAt: 1, conversations: 'nope' })],
    ]) {
      const p = join(dir, name)
      writeFileSync(p, body)
      const cap = captureLog()
      assert.equal(restoreState(p, new RelayState(), cap.log, 1000), 0, name)
      assert.ok(cap.messages.length > 0, `${name} 应当留痕`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 验收 5：会话被回收后重启 → 不会复活 ─────────────────────────────────

test('验收 5：主机作废会话后重启，那条会话不会被读回来', async () => {
  const dir = tmpDir()
  const stateFile = join(dir, 'state.json')
  try {
    const first = await startRelay({ DRC_STATE_FILE: stateFile })
    const { host, conversationId, client } = await pairUp(first)
    // 主机作废（session-leave 的主机侧分支）＝永久删除。
    host.send({ t: 'session-leave', sessionId: conversationId })
    await client.until((f) => f.t === 'peer-left')
    assert.equal(first.relay.health().conversations, 0)
    // 同步删盘：这一刻盘上就不能再有它，否则重启会把它复活（纪律第 3 条）。
    const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.deepEqual(onDisk.conversations, [], '回收必须同步删盘')
    await stopRelay(first)

    const second = await startRelay({ DRC_STATE_FILE: stateFile })
    try {
      assert.equal(second.relay.health().conversations, 0, '已回收的会话不许复活')
      assert.equal(second.relay.health().stateRestored, 0)
    } finally {
      await stopRelay(second)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('验收 5b：空会话回收同样同步删盘（走清扫那条路）', async () => {
  const dir = tmpDir()
  const stateFile = join(dir, 'state.json')
  try {
    const first = await startRelay({
      DRC_STATE_FILE: stateFile,
      // 回收阈值压到 1 ms，让 sweep() 立刻判死，不必等 30 分钟。
      DRC_CONV_EMPTY_TTL_MS: '1',
      DRC_SWEEP_MS: '20',
    })
    const { host, client, conversationId } = await pairUp(first)
    // 客户端走 session-leave：peer-left 是发给**主机**的（对客户端而言 peer-left 只有
    // 一个合法触发——主机离开），所以这里等的是 host，不是 client。
    client.send({ t: 'session-leave', sessionId: conversationId })
    await host.until((f) => f.t === 'peer-left')
    // 清扫跑掉之后盘上也要清干净。
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (JSON.parse(readFileSync(stateFile, 'utf8')).conversations.length === 0) break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).conversations, [])
    await stopRelay(first)
    const second = await startRelay({ DRC_STATE_FILE: stateFile })
    try {
      assert.equal(second.relay.health().conversations, 0)
    } finally {
      await stopRelay(second)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 单测：写盘与恢复的边界 ─────────────────────────────────────────────

// ⚠️ 纯 POSIX 权限位判据：win32 上 `chmod` 只切只读位、`statSync().mode & 0o777` 无意义。
test('临时文件残留 / pid 复用：最终状态文件仍是 0600（mode 只在创建那一刻生效）', skipUnlessPosix(), () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const tmp = `${p}.${process.pid}.tmp`
    // 伪造一份"上次崩溃留下的"临时文件：0644、内容是旧快照。
    // 临时名是固定的 `${path}.${pid}.tmp`，崩溃残留 + 那次崩溃的 pid 被系统复用，
    // 就会让 writeFileSync 写在一份已存在的 0644 文件上——mode 选项对已存在的文件
    // 不生效，rename 之后最终状态文件也就成了 0644（P2）。
    writeFileSync(tmp, '{"version":1,"savedAt":0,"conversations":[]}\n')
    chmodSync(tmp, 0o644)
    assert.equal(statSync(tmp).mode & 0o777, 0o644, '前置条件：残留临时文件确实是 0644')

    const { log } = captureLog()
    const state = new RelayState()
    state.conversations.set('c_aaaaaaaaaaaa', {
      hostId: 'h1',
      clients: new Set(['inst-1']),
      seqHost: 3,
      lastActivityAt: 1234,
    })
    assert.equal(writeStateFile(p, snapshotState(state, 999), log), true)
    assert.equal(statSync(p).mode & 0o777, 0o600, '最终状态文件沿用了残留临时文件的权限')
    assert.deepEqual(readdirSync(dir), ['state.json'], '临时文件不许留在盘上过夜')
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).savedAt, 999, '内容必须是这一次的新快照')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('原子写：不留临时文件，落盘内容可完整读回', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const { log } = captureLog()
    const state = new RelayState()
    state.conversations.set('c_aaaaaaaaaaaa', {
      hostId: 'h1',
      clients: new Set(['inst-1', 'inst-1', 'inst-2']),
      seqHost: 7,
      lastActivityAt: 1234,
    })
    assert.equal(writeStateFile(p, snapshotState(state, 999), log), true)
    // 同目录不该出现任何 .tmp 残留——它是"一份没人读的完整状态"，运维会以为那才是真相。
    assert.deepEqual(readdirSync(dir), ['state.json'])
    const back = readStateFile(p, log)
    assert.equal(back.savedAt, 999)
    assert.equal(back.conversations.length, 1)
    // 成员表里重复的 clientId 被去重（Set 语义，JSON 数组没这个保证）。
    assert.deepEqual(back.conversations[0].clients, ['inst-1', 'inst-2'])
    assert.equal(back.conversations[0].seqHost, 7)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('逐条筛：坏掉 1 行不该让整份状态作废（代价是全部手机重扫）', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const good = {
      conversationId: 'c_aaaaaaaaaaaa',
      hostId: 'h1',
      clients: ['inst-1'],
      seqHost: 0,
      lastActivityAt: 1000,
    }
    const cases = [
      { ...good, conversationId: 'not-a-conv-id' }, // 路由凭证形状不对
      { ...good, hostId: '' }, // 空 hostId
      { ...good, clients: 'inst-1' }, // 成员不是数组
      { ...good, clients: ['inst-1', 7] }, // 成员里有非字符串
      { ...good, seqHost: -1 }, // 序号为负
      { ...good, seqHost: 1.5 }, // 序号不是整数
      { ...good, lastActivityAt: 'soon' }, // 时间戳不是数
      null,
    ]
    writeFileSync(p, JSON.stringify({ version: STATE_FILE_VERSION, savedAt: 1, conversations: [good, ...cases] }))
    const cap = captureLog()
    const restored = restoreState(p, new RelayState(), cap.log, 1000)
    assert.equal(restored, 1, '好的那条必须留下')
    assert.ok(
      cap.messages.some((m) => m.includes('entries dropped')),
      `要报出丢了多少条：${JSON.stringify(cap.messages)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('安全模型不变：盘上没有任何秘密（D1：中继从来不持有 PSK）', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const { log } = captureLog()
    const state = new RelayState()
    const fakeHost = { ws: { readyState: WS_OPEN, send() {}, close() {} }, label: 'bins' }
    state.attachHost('h1', fakeHost.ws, 'bins')
    state.issuePair('h1', '123456', 60_000)
    const claimed = state.claim('123456', 'inst-1')
    assert.equal(claimed.ok, true)
    writeStateFile(p, snapshotState(state, 1), log)
    const raw = readFileSync(p, 'utf8')
    // 配对码绝不入盘：它是短命的一次性语义，而它还在 pendingPairs 里就已经过期风险很小了。
    assert.ok(!raw.includes('123456'), '配对码不许落盘')
    const parsed = JSON.parse(raw)
    const fields = Object.keys(parsed.conversations[0]).sort()
    assert.deepEqual(fields, ['clients', 'conversationId', 'hostId', 'lastActivityAt', 'seqHost'])
    for (const key of ['psk', 'token', 'secret', 'password']) {
      assert.ok(!raw.toLowerCase().includes(key), `不该出现 ${key}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hostOfflineSince 刻意不落盘，也不从（被手塞的）盘上恢复', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const { log } = captureLog()
    const state = new RelayState()
    state.conversations.set('c_bbbbbbbbbbbb', {
      hostId: 'h1',
      clients: new Set(['inst-1']),
      seqHost: 0,
      lastActivityAt: 1000,
    })
    // 构造一份带 hostOfflineSince 的状态（模拟有人"顺手"把它加回去，或旧版本写过）。
    writeFileSync(
      p,
      JSON.stringify({
        version: STATE_FILE_VERSION,
        savedAt: 1,
        conversations: [
          {
            conversationId: 'c_bbbbbbbbbbbb',
            hostId: 'h1',
            clients: ['inst-1'],
            seqHost: 0,
            lastActivityAt: 1000,
            hostOfflineSince: 0,
          },
        ],
      }),
    )
    const restored = new RelayState()
    assert.equal(restoreState(p, restored, log, 1000), 1)
    const conv = restored.conversations.get('c_bbbbbbbbbbbb')
    assert.equal(conv.hostOfflineSince, undefined, '宽限期计时不得从盘上恢复')
    // 这条才是关键判据：一次 130 秒的停机维护不能把会话判死。
    // （照搬 hostOfflineSince 的话，此刻已经过期 1000+130000 ms，会话当场被回收。）
    assert.deepEqual(restored.expireOfflineHosts(120_000), [], '重启后宽限期必须重新起算')
    // 顺带确认正常写出的快照里也没有这个字段。
    assert.ok(!Object.keys(snapshotState(restored, 1).conversations[0]).includes('hostOfflineSince'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宽限期本身仍然有效：真掉过线的主机照样会被判死（防止"修好"成永不打点）', () => {
  let now = 1000
  const state = new RelayState({ now: () => now })
  const sock = { readyState: WS_OPEN, send() {}, close() {} }
  state.attachHost('h1', sock, 'bins')
  state.issuePair('h1', '123456', 60_000)
  const claimed = state.claim('123456', 'inst-1')
  assert.equal(claimed.ok, true)
  assert.deepEqual(state.expireOfflineHosts(120_000), [], '还没到期不该判死')
  state.hostGone('h1', sock)
  now += 119_000
  assert.deepEqual(state.expireOfflineHosts(120_000), [], '差 1 s 也不该判死')
  now += 2_000
  const dropped = state.expireOfflineHosts(120_000)
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].conversationId, claimed.conversationId)
})

test('emptySince 的两种恢复：有成员就不计时，空的从此刻（或盘上）起算', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const { log } = captureLog()
    writeFileSync(
      p,
      JSON.stringify({
        version: STATE_FILE_VERSION,
        savedAt: 1,
        conversations: [
          { conversationId: 'c_111111111111', hostId: 'h1', clients: ['inst-1'], seqHost: 0, lastActivityAt: 1 },
          { conversationId: 'c_222222222222', hostId: 'h1', clients: [], seqHost: 0, lastActivityAt: 1 },
          {
            conversationId: 'c_333333333333',
            hostId: 'h1',
            clients: [],
            seqHost: 0,
            lastActivityAt: 1,
            emptySince: 500,
          },
        ],
      }),
    )
    const state = new RelayState()
    restoreState(p, state, log, 2000)
    assert.equal(state.conversations.get('c_111111111111').emptySince, undefined, '还有成员就不计时')
    // 空会话且盘上没打点：按此刻起算，否则它会掉进 sweepIdle 与 sweepEmpty 之间那条缝，
    // 一直挂到 7 天空闲 TTL。
    assert.equal(state.conversations.get('c_222222222222').emptySince, 2000)
    // 盘上有打点：跨重启延续。
    assert.equal(state.conversations.get('c_333333333333').emptySince, 500)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置：默认关闭，DRC_STATE_FILE 设为空串也照样是关', () => {
  const base = { DRC_HOST_TOKEN: TOKEN }
  const off = loadConfig(base, 'test').config
  assert.equal(off.stateFile, '', '默认必须关——本地随手起的中继不该多出状态文件')
  assert.equal(loadConfig({ ...base, DRC_STATE_FILE: '' }, 'test').config.stateFile, '')
  assert.equal(
    loadConfig({ ...base, DRC_STATE_FILE: '/var/lib/drc/state.json' }, 'test').config.stateFile,
    '/var/lib/drc/state.json',
  )
})

test('状态文件所在目录不存在时会自己建（部署只配了路径、没 mkdir 的情形）', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'nested', 'deeper', 'state.json')
    const { log } = captureLog()
    const state = new RelayState()
    state.conversations.set('c_cccccccccccc', {
      hostId: 'h1',
      clients: new Set(),
      seqHost: 0,
      lastActivityAt: 1,
      emptySince: 1,
    })
    assert.equal(writeStateFile(p, snapshotState(state, 1), log), true)
    assert.ok(existsSync(p))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写盘失败只记日志、绝不抛（起不来的中继等于整个产品停摆）', () => {
  const dir = tmpDir()
  try {
    // 让目标路径被一个**目录**占住：临时文件写得出来，rename 必然失败。
    const p = join(dir, 'state.json')
    mkdirSync(p)
    const cap = captureLog()
    const state = new RelayState()
    state.conversations.set('c_dddddddddddd', {
      hostId: 'h1',
      clients: new Set(),
      seqHost: 0,
      lastActivityAt: 1,
    })
    assert.equal(writeStateFile(p, snapshotState(state, 1), cap.log), false)
    assert.ok(
      cap.messages.some((m) => m.includes('write failed')),
      '失败要留痕',
    )
    // 失败也不许把临时文件留在盘上过夜。
    assert.deepEqual(readdirSync(dir), ['state.json'], '临时文件必须清掉')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
