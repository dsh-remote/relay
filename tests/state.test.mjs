/**
 * 中继状态机的纯内存测试（不起 socket、不占端口）。
 *
 * `state.ts` 刻意不 import `ws`，所以这里可以用假 socket 把配对、成员校验、
 * 断开、宽限期、清扫全部驱动一遍——这类测试跑得快，而且红了就是状态机本身错了，
 * 不用怀疑网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayState, WS_OPEN } from '../dist/src/state.js'

const CLOSED = 3

class FakeSock {
  constructor(name) {
    this.name = name
    this.readyState = WS_OPEN
    this.sent = []
    this.closedWith = null
  }

  send(text) {
    this.sent.push(text)
  }

  close(code, reason) {
    this.closedWith = { code, reason }
    this.readyState = CLOSED
  }

  last() {
    return JSON.parse(this.sent.at(-1))
  }
}

function harness({ now = 1_000, maxPendingPairs = 100 } = {}) {
  const clock = { now }
  const state = new RelayState({ now: () => clock.now, maxPendingPairs })
  const host = new FakeSock('host')
  const client = new FakeSock('client')
  state.attachHost('h1', host, 'my-macbook')
  state.attachClient('inst-1', client)
  return { state, clock, host, client, advance: (ms) => (clock.now += ms) }
}

test('配对：认领成功才会创建会话，且 sessionId 是 c_ + 12 hex', () => {
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  const claimed = state.claim('123456', 'inst-1')
  assert.equal(claimed.ok, true)
  assert.match(claimed.conversationId, /^c_[0-9a-f]{12}$/)
  assert.equal(claimed.hostId, 'h1')
  assert.equal(state.conversations.size, 1)
  assert.equal(state.conversations.get(claimed.conversationId).clients.has('inst-1'), true)
})

test('D1：待配对表里根本没有地方放 PSK（类型与运行时双重确认）', () => {
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  const entry = state.pendingPairs.get('123456')
  // `issuedAt`（2026-10-23 埋点）：首次签发时刻，claim 用来算 latencyMs——非秘密元数据。
  assert.deepEqual(Object.keys(entry).sort(), ['expiresAt', 'hostId', 'issuedAt', 'used'])
  assert.equal('psk' in entry, false)
})

test('配对码一次性：**别人**重放得到 already_used，而不是 invalid_or_expired', () => {
  /**
   * **B 口径翻转**（裁决出处：2026-10-24 晚「不顺」根因诊断 + 用户"动手修改"）。
   *
   * 原判据钉的是"任何重放都 already_used"——而 2026-10-24 晚的线上日志证明
   * 这正是旧小程序客户端（3.2.11 前）死循环的燃料：socket 每抖一次就拿死码
   * 再认领 → already_used → `_forgetPairing` 主动断线 → 重连 → 再认领……
   * 一台手机 2 分钟转 7 圈。**同 clientId 重认领**现在走幂等档（回原会话），
   * 这条判据收窄成"**别人**重放仍然 already_used"——那才是安全边界
   * （不同 clientId 拿烧掉的码不许换到任何东西）。
   */
  const { state, advance } = harness()
  state.issuePair('h1', '123456', 180_000)
  assert.equal(state.claim('123456', 'inst-1').ok, true)
  const replay = state.claim('123456', 'inst-other')
  assert.equal(replay.ok, false)
  assert.equal(replay.reason, 'already_used', '别的 clientId 重放必须仍是 already_used')
  // used 条目留在表里直到 TTL 清扫——否则重放会被误报成"码不存在"，手机文案就错了（F6）。
  advance(180_001)
  const gone = state.claim('123456', 'inst-1')
  assert.equal(gone.reason, 'invalid_or_expired')
})

test('幂等重认领：同一 clientId 拿自己烧掉的码再认领 ⇒ 回原会话，不新建、不摘人', () => {
  /**
   * 掐死旧客户端死循环的**中继侧**修法（2026-10-24）：重认领是
   * "连接抖动后的重试"而不是攻击——认领者与烧码者是**同一个 clientId**、
   * 会话还活着 ⇒ 把原会话原样还回去（`idempotent` 档），客户端的
   * `_onPaired` 拿到后清掉脏 token，循环当场熄火。
   *
   * ⚠️ 安全边界：**绝不重发 pair-grant**（psk 只随第一次的 clientPub 送过；
   * 重发给新公钥 = 给冒名者开后门）。幂等档只回 `paired` 帧（sessionId + hostId，
   * 都不是秘密）。detached 必须为空——幂等不许把人从旧会话里摘走。
   */
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  const first = state.claim('123456', 'inst-1')
  assert.equal(first.ok, true)
  const again = state.claim('123456', 'inst-1')
  assert.equal(again.ok, true, '同 clientId 重认领必须成功（不是 already_used）')
  assert.equal(again.idempotent, true, '必须走幂等档（调用方据此不重发 pair-grant）')
  assert.equal(again.conversationId, first.conversationId, '回的必须是原会话')
  assert.deepEqual(again.detached, [], '幂等不许摘人')
  assert.equal(state.conversations.size, 1, '不许新建会话')
})

test('幂等重认领的边界：会话没了 / clientId 不同 ⇒ 退回 already_used', () => {
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  const first = state.claim('123456', 'inst-1')
  assert.equal(first.ok, true)
  // ① 会话被清扫 ⇒ 不许指一条死会话回去
  state.dropConversation(first.conversationId)
  const dangling = state.claim('123456', 'inst-1')
  assert.equal(dangling.ok, false)
  assert.equal(dangling.reason, 'already_used', '原会话没了就退回 already_used')
  // ② 冒名者（不同 clientId）永远拿不到幂等档
  state.issuePair('h1', '654321', 180_000)
  state.claim('654321', 'inst-2')
  const impostor = state.claim('654321', 'inst-evil')
  assert.equal(impostor.reason, 'already_used')
})

test('幂等档只认同一把一次性公钥：换钥重扫 ⇒ already_used（新意图，不许吊在等确认码）', () => {
  /**
   * 判别子的另一半（2026-10-24 第二刀，mp-page-pairing「不一致后重扫」判据咬出来的）：
   * 同 clientId 但**换了公钥** = "不一致"之后重扫（`_startScenePair` 每次新生成密钥对）
   * ⇒ 这是新意图，必须仍回 `already_used`（有声音的失败，引导拿新码）。
   * 幂等回 `paired` 却不带 pair-grant 的话，用户会吊在"等确认码"上——比失败更糟。
   */
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  const first = state.claim('123456', 'inst-1', 'PUB-A')
  assert.equal(first.ok, true)
  const samePub = state.claim('123456', 'inst-1', 'PUB-A')
  assert.equal(samePub.idempotent, true, '同一把公钥重认领 = 连接重试 ⇒ 幂等')
  const freshPub = state.claim('123456', 'inst-1', 'PUB-B')
  assert.equal(freshPub.ok, false)
  assert.equal(freshPub.reason, 'already_used', '换钥重扫 = 新意图 ⇒ 有声音的失败')
})

test('多配对码并存：每张码各自独立，用哪张得到哪个主机的会话（旧事故回归）', () => {
  const clock = { now: 1_000 }
  const state = new RelayState({ now: () => clock.now })
  const hostA = new FakeSock('A')
  const hostB = new FakeSock('B')
  const clientA = new FakeSock('cA')
  const clientB = new FakeSock('cB')
  state.attachHost('hA', hostA, 'A')
  state.attachHost('hB', hostB, 'B')
  state.attachClient('iA', clientA)
  state.attachClient('iB', clientB)
  state.issuePair('hA', '111111', 180_000)
  state.issuePair('hB', '222222', 180_000)
  const first = state.claim('111111', 'iA')
  const second = state.claim('222222', 'iB')
  assert.equal(first.hostId, 'hA')
  assert.equal(second.hostId, 'hB')
  assert.equal(state.conversations.get(first.conversationId).hostId, 'hA')
  assert.equal(state.conversations.get(second.conversationId).hostId, 'hB')
})

test('配对的前置拒绝：码不存在 / 已过期 / 主机不在线', () => {
  const { state, advance } = harness()
  assert.equal(state.claim('999999', 'inst-1').reason, 'invalid_or_expired')
  state.issuePair('h1', '123456', 1_000)
  advance(2_000)
  assert.equal(state.claim('123456', 'inst-1').reason, 'invalid_or_expired')
  const h = harness()
  h.state.issuePair('h1', '123456', 180_000)
  h.host.readyState = CLOSED
  assert.equal(h.state.claim('123456', 'inst-1').reason, 'host_offline')
})

test('待配对表有界：超出上限拒绝新码，但已存在的码允许覆盖', () => {
  const { state } = harness({ maxPendingPairs: 3 })
  assert.equal(state.issuePair('h1', '111111', 1000).ok, true)
  assert.equal(state.issuePair('h1', '222222', 1000).ok, true)
  assert.equal(state.issuePair('h1', '333333', 1000).ok, true)
  const overflow = state.issuePair('h1', '444444', 1000)
  assert.equal(overflow.ok, false)
  assert.equal(overflow.full, true)
  const replace = state.issuePair('h1', '222222', 9000)
  assert.equal(replace.ok, true)
  assert.equal(replace.replaced, true)
  assert.equal(state.pendingPairs.get('222222').expiresAt, 1_000 + 9_000)
})

test('D3：客户端断开不删会话、不删成员；同一 clientId 重连后原会话直接可用', () => {
  const { state, host, client } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  assert.equal(state.routeFrom(conversationId, client), null)

  const notices = state.clientGone('inst-1', client)
  assert.deepEqual(notices, [{ conversationId, clientId: 'inst-1' }])
  // 旧实现在这里删会话；本版必须留着它，并且**成员关系也留着**，
  // 否则 D4 会把重连回来的合法客户端永远拒掉。
  assert.equal(state.conversations.size, 1)
  assert.equal(state.conversations.get(conversationId).clients.has('inst-1'), true)
  // 状态层只给清单，不发帧：通知谁、用什么帧是 server.ts 的事（在 relay.test.mjs 里验）。
  assert.deepEqual(host.sent, [], '状态机不直接写 socket')

  const reborn = new FakeSock('client-2')
  state.attachClient('inst-1', reborn)
  assert.equal(state.routeFrom(conversationId, reborn), null, '重连后必须重新成为可路由成员')
  const sent = state.clientSockets(conversationId)
  assert.deepEqual(sent, [reborn])
})

test('D3 竞态：同一 clientId 已有更新 socket 时，旧 socket 的 close 什么都不许做', () => {
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  const newer = new FakeSock('newer')
  state.attachClient('inst-1', newer)
  const stale = new FakeSock('stale')
  assert.deepEqual(state.clientGone('inst-1', stale), [], '旧 socket 的 close 不得产生任何通知')
  assert.equal(state.clients.get('inst-1').ws, newer)
  assert.equal(state.routeFrom(conversationId, newer), null)
})

test('D4：转发前校验发送方是该会话成员，陌生 socket 与不存在的会话分别报不同 code', () => {
  const { state, client } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  const stranger = new FakeSock('stranger')
  assert.equal(state.routeFrom(conversationId, stranger), 'not_member')
  assert.equal(state.routeFrom('c_000000000000', client), 'unknown_session')
  assert.equal(state.routeFrom(conversationId, client), null)
  const host = state.hosts.get('h1').ws
  assert.equal(state.routeFrom(conversationId, host), null)
})

/**
 * D6（2026-10-23 用户裁决「挂起、回来可恢复」）：宽限期到期是**挂起**，不是判死。
 *
 * 旧断言钉的是"超时判死 + 删会话 + 通知客户端重配对"——那正是用户报的
 * 「一条 219 帧的会话，宽限一过就没了」。现在会话与密钥必须原样留着，
 * 主机回来自动恢复；每台只报一次挂起（日志每 3 秒一轮，不许刷屏）。
 */
test('D6：主机断开先进宽限期，超时**挂起**（会话留着、不发 peer-left）；主机回来自动恢复', () => {
  const { state, host, client, advance } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')

  assert.equal(state.hostGone('h1', host), true)
  assert.equal(state.conversations.size, 1, '宽限期内会话必须还在')
  assert.deepEqual(state.suspendExpiredHosts(120_000), [], '没到宽限期不该报挂起')

  advance(119_000)
  assert.deepEqual(state.suspendExpiredHosts(120_000), [])
  advance(2_000)
  assert.deepEqual(state.suspendExpiredHosts(120_000), ['h1'], '到期报一次挂起')
  // **挂起不是判死**：会话、密钥、成员全留着（这就是这次改语义的全部意义）。
  assert.equal(state.conversations.size, 1, '挂起不许删会话（旧写法在这里 dropHost 删光）')
  assert.deepEqual([...state.conversations.get(conversationId).clients], ['inst-1'], '成员表不许动')
  assert.deepEqual(state.suspendExpiredHosts(120_000), [], '重复扫描不许重复报（日志会刷屏）')

  // 主机回来：重新 attach 即撤销离线标记与挂起记号；下一次再掉线要重新报。
  const freshHost = new FakeSock('host-again')
  state.attachHost('h1', freshHost, 'my-macbook')
  assert.equal(state.conversations.get(conversationId).hostOfflineSince, undefined, '回来即清离线标记')
  advance(999_000)
  assert.deepEqual(state.suspendExpiredHosts(120_000), [], '重连成功后不得再报挂起')

  // 再掉一次：挂起要重新报（记号已随回归清掉）。
  assert.equal(state.hostGone('h1', freshHost), true)
  advance(121_000)
  assert.deepEqual(state.suspendExpiredHosts(120_000), ['h1'], '第二次掉线的挂起必须重新报')
  void client
})

/**
 * 评审 §5.3 的边界①：**hostId 变了（重装/换机）不能复活**。
 *
 * 「挂起、回来可恢复」里的"回来"必须是**同一台主机**（同一个 hostId）。
 * 换了 hostId 就是另一台机器：它既拿不到 A 的会话流量，也删不掉 A 的会话
 * （`resync` 按 hostId 隔离）。这条错一次就等于开后门 —— 新机器可以作废旧机器的通道。
 */
test('换 hostId 拿不到复活：B 的 resync 删不到 A 的会话，A 的流量也落不到 B', () => {
  let now = 1_000
  const state = new RelayState({ now: () => now })
  const sockA = new FakeSock('host-A')
  const sockB = new FakeSock('host-B')
  state.attachHost('hA', sockA, 'macbook-A')
  state.attachClient('inst-1', new FakeSock('client'))
  state.issuePair('hA', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  assert.equal(state.hostGone('hA', sockA), true, '夹具自检：A 掉线')

  // B 上线（同一部手机换了主机 / 主机重装过）：它跟 A 的会话毫无关系。
  state.attachHost('hB', sockB, 'macbook-B')
  const resync = state.resync('hB', [])
  assert.deepEqual(resync.dropped, [], 'B 的 resync 不许删 A 的会话（hostId 隔离是硬边界）')
  assert.ok(state.conversations.has(conversationId), 'A 的会话必须还在（挂起中）')

  // 流量落点：A 的会话只认 A 的 socket；B 拿不到（也回不了 —— A 不在就是不在）。
  assert.equal(state.hostSocket(conversationId), undefined, 'A 的会话不许被 B 接管')

  // A 真的回来才复活（这条在 relay.test 的 D6 里验到帧级；这里验记号层）。
  const sockA2 = new FakeSock('host-A-again')
  state.attachHost('hA', sockA2, 'macbook-A')
  assert.equal(state.hostSocket(conversationId), sockA2, '同 hostId 回来必须自动接回')
})

/**
 * 评审 §5.3 的边界②：挂起会话**占表位** ⇒ 表满时的回收策略要一起设计。
 * 两档：先回收「已空」的（便宜），还不够再回收「挂起中」的（主机都不在的那批）——
 * 拒绝新配对（`table_full`）是最后手段，不是第一反应。
 */
/**
 * `/code` 判定与 `claim()` 的过期边界**同一个不等号**（2026-10-23 评审抓的）。
 *
 * `claim()` 用 `expiresAt < now` 判过期（= 到期那一毫秒还认领），`pairCodeState()`
 * 曾写 `<=` ⇒ 同一毫秒里「码能认领、但 /code 拒画」。判据里写着「与 claim() 同一口径，
 * 不许多一种、不许少一种」——这条就是把那句话钉到边界上。
 */
test('/code 判定与 claim() 的过期边界同口径（expiresAt === now 那一毫秒两边一致）', () => {
  const { state, advance } = harness()
  // 边界上：两边都放行。
  state.issuePair('h1', '123456', 1_000)
  advance(1_000)
  assert.equal(state.pairCodeState('123456'), 'claimable', '到期那一毫秒 claim() 还放行 ⇒ /code 也必须放行')
  assert.equal(state.claim('123456', 'inst-1').ok, true, '夹具自检：claim 在边界上仍成功')

  // 过了边界 1 ms：两边都拒。
  state.issuePair('h1', '654321', 1_000)
  advance(1_001)
  assert.equal(state.pairCodeState('654321'), 'expired', '过期 1ms 后 /code 必须拒')
  assert.equal(state.claim('654321', 'inst-1').ok, false, 'claim 同样拒（invalid_or_expired）')
})

test('表满腾位两档：先回收已空的，还不够再回收挂起中的，新认领必须成功', () => {
  let now = 1_000
  const state = new RelayState({ now: () => now, maxConversations: 2 })
  state.attachHost('hA', new FakeSock('host-A'), 'A')
  state.attachHost('hB', new FakeSock('host-B'), 'B')
  state.attachClient('inst-1', new FakeSock('c1'))
  state.attachClient('inst-2', new FakeSock('c2'))
  state.attachClient('inst-3', new FakeSock('c3'))

  // 两条会话：A 的（随后挂起、**有成员**）、B 的（在用）。
  state.issuePair('hA', '111111', 180_000)
  const first = state.claim('111111', 'inst-1')
  state.issuePair('hB', '222222', 180_000)
  const second = state.claim('222222', 'inst-2')
  assert.equal(state.conversations.size, 2, '夹具自检：表已满')
  assert.equal(state.hostGone('hA', state.hosts.get('hA').ws), true, 'A 掉线 ⇒ 第一条进入挂起计时')
  now += 200_000
  assert.deepEqual(state.suspendExpiredHosts(120_000), ['hA'], 'A 的会话已挂起')

  // 第三条认领：表满。旧写法第一档只看「已空」⇒ 两条都不空 ⇒ table_full。
  state.issuePair('hB', '333333', 180_000)
  const third = state.claim('333333', 'inst-3')
  assert.equal(third.ok, true, `表满时必须靠回收挂起腾位，实际 ${JSON.stringify(third)}`)
  assert.ok(state.conversations.has(third.conversationId), '新会话必须建出来')
  assert.ok(state.conversations.has(second.conversationId), '在用的那条不许被回收')
  assert.ok(
    !state.conversations.has(first.conversationId),
    '挂起中的那条是第二档牺牲品（主机都不在；7 天后 sweepIdle 也会删它）',
  )
  assert.equal(first.ok, true, '夹具自检')
})

test('D6 竞态：主机重连后，旧 socket 的 close 不得把会话打成离线', () => {
  const { state, host } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  const newer = new FakeSock('host-new')
  const { replaced } = state.attachHost('h1', newer, 'my-macbook')
  assert.equal(replaced, host)
  assert.equal(state.hostGone('h1', host), false, '旧 socket 的 close 必须被守卫跳过')
  assert.equal(state.conversations.get(conversationId).hostOfflineSince, undefined)
})

test('会话空闲回收：touch 会续期，超时才丢；丢之后不需要通知任何人', () => {
  const { state, client, advance } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  state.nextHostSequence(conversationId)
  const ttl = 7 * 24 * 3600 * 1000
  assert.deepEqual(state.sweepIdle(ttl), [])
  advance(ttl)
  assert.deepEqual(state.sweepIdle(ttl), [conversationId])
  assert.equal(state.conversations.size, 0)
  // 客户端下次用旧 convId 发帧 → routeFrom 给出 unknown_session → 手机提示重配对（F5）。
  assert.equal(state.routeFrom(conversationId, client), 'unknown_session')
})

test('session-leave 只摘自己；不存在的成员返回 false', () => {
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  assert.equal(state.leave('inst-1', conversationId), true)
  assert.equal(state.conversations.get(conversationId).clients.size, 0)
  assert.equal(state.conversations.size, 1, '客户端离开不该删掉主机的会话')
  assert.equal(state.leave('nobody', conversationId), false)
  assert.equal(state.leave('inst-1', 'c_ffffffffffff'), false)
})

test('过期配对码被清扫；used 与新发都算完', () => {
  const { state, advance } = harness()
  state.issuePair('h1', '111111', 1_000)
  state.issuePair('h1', '222222', 1_000)
  state.claim('111111', 'inst-1')
  advance(1_500)
  assert.deepEqual(state.expirePairs().sort(), ['111111', '222222'])
  assert.equal(state.pendingPairs.size, 0)
})

test('counts 与 reset 服务于 /healthz 与测试隔离', () => {
  const { state } = harness()
  state.issuePair('h1', '123456', 180_000)
  state.claim('123456', 'inst-1')
  // hostTokens 是这一轮新增的第五张表（按 hostId 一机一枚）：`counts()` 少报它
  // ⇒ /healthz 上看不出令牌表在长，而它正是"认领没人管"那类故障的唯一观测面。
  state.issueHostToken('h1', 'a'.repeat(48), 1_000)
  /**
   * **B 口径翻转**（M4 数据面，2026-10-23 迭代轮）：counts 新增版本分布
   * `hostVersions` / `clientVersions`（T+24h 观察窗与"关老兼容以版本分布为准"要的读数）。
   * 没上报版本的连接归 `unknown` 桶 —— 这里两个 attach 都没传版本。
   */
  assert.deepEqual(state.counts(), {
    hosts: 1,
    clients: 1,
    conversations: 1,
    pendingPairs: 1,
    hostTokens: 1,
    hostVersions: { unknown: 1 },
    clientVersions: { unknown: 1 },
  })
  state.reset()
  assert.deepEqual(state.counts(), {
    hosts: 0,
    clients: 0,
    conversations: 0,
    pendingPairs: 0,
    hostTokens: 0,
    hostVersions: {},
    clientVersions: {},
  })
})

// ── 重配（复核 🟡7）────────────────────────────────────────────────────

test('重配：同一 clientId 认领新码时，必须从旧会话的成员表里摘掉', () => {
  const { state } = harness()
  state.issuePair('h1', '111111', 180_000)
  const first = state.claim('111111', 'inst-1')
  assert.equal(first.ok, true)

  state.issuePair('h1', '222222', 180_000)
  const second = state.claim('222222', 'inst-1')
  assert.equal(second.ok, true)
  assert.notEqual(second.conversationId, first.conversationId, '每次认领都是一个新会话')
  assert.deepEqual(second.detached, [first.conversationId], '必须报告摘掉了哪个旧会话（调用方要通知主机）')

  assert.equal(
    state.conversations.get(first.conversationId).clients.has('inst-1'),
    false,
    '摘不干净的话，主机在旧会话上的流会把密文继续灌给这台已经换了钥匙的手机',
  )
  assert.equal(state.conversations.get(second.conversationId).clients.has('inst-1'), true)
  assert.equal(
    state.conversations.has(first.conversationId),
    true,
    '旧会话保留：它归主机（与客户端 session-leave 同一条原则），不该由中继删',
  )
})

test('leaveAll：一个 clientId 只会留在最后一次认领的会话里', () => {
  const { state } = harness()
  state.issuePair('h1', '111111', 180_000)
  const a = state.claim('111111', 'inst-1')
  state.issuePair('h1', '222222', 180_000)
  const b = state.claim('222222', 'inst-1')
  assert.equal(state.conversations.get(a.conversationId).clients.has('inst-1'), false)
  assert.deepEqual(state.leaveAll('inst-1'), [b.conversationId], '最后一个会话同样要能被摘掉')
  assert.equal(state.conversations.get(b.conversationId).clients.size, 0)
  assert.deepEqual(state.leaveAll('不存在的客户端'), [], '不认识的 clientId 不许抛')
})

test('P2-⑤ 空会话回收：最后一个客户端离开起算；socket 断开不算（D3 免扫码不受影响）', () => {
  const { state, client, advance } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')

  // 手机 socket 断开：成员表不动、**不打**回收计时——这是 D3 重挂的机制本身。
  state.clientGone('inst-1', client)
  assert.equal(
    state.conversations.get(conversationId).emptySince,
    undefined,
    'socket 断开被当成空会话：手机回前台就要重新扫码，直接违反 D3',
  )

  // 手机显式 session-leave：成员表空了才开始计时。
  assert.equal(state.leave('inst-1', conversationId), true)
  const conv = state.conversations.get(conversationId)
  assert.equal(conv.clients.size, 0)
  assert.ok(typeof conv.emptySince === 'number', '最后一个客户端走了要打上计时基线')

  const ttl = 30 * 60 * 1000
  advance(ttl - 1)
  assert.deepEqual(state.sweepEmpty(ttl), [], '没到 30 分钟不许回收')
  advance(1)
  assert.deepEqual(state.sweepEmpty(ttl), [conversationId], '到点就回收（默认值 30 分钟，P2-⑤ 用户拍板）')
  assert.equal(state.conversations.size, 0)
})

test('P2-⑤ 还有客户端的会话永不回收；重配 detach 也会起算', () => {
  const { state, advance } = harness()
  state.issuePair('h1', '111111', 180_000)
  state.issuePair('h1', '222222', 180_000)
  const a = state.claim('111111', 'inst-a')
  const b = state.claim('222222', 'inst-b')
  const ttl = 30 * 60 * 1000

  advance(ttl * 2)
  assert.deepEqual(state.sweepEmpty(ttl), [], '两边都还有客户端：一个都不许动')

  // inst-a 重配：新 claim 会把它从旧会话摘干净（复核 🟡7），旧会话至此空了。
  state.issuePair('h1', '333333', 180_000)
  const c = state.claim('333333', 'inst-a')
  assert.ok(c.detached.includes(a.conversationId), '重配必须把旧会话里的自己摘掉')
  assert.equal(state.conversations.get(a.conversationId).clients.size, 0)
  assert.equal(state.conversations.get(b.conversationId).clients.size, 1)

  advance(ttl)
  assert.deepEqual(state.sweepEmpty(ttl), [a.conversationId], '只回收空了的那条')
  assert.equal(state.conversations.has(b.conversationId), true, '还有客户端的必须留着')
  assert.equal(state.conversations.has(c.conversationId), true, '新会话更得留着')
})

test('P2-⑤ resync 时才知道的空会话：从这一时刻起算，不会挂到 7 天', () => {
  const { state, advance } = harness()
  state.issuePair('h1', '123456', 180_000)
  const { conversationId } = state.claim('123456', 'inst-1')
  state.leave('inst-1', conversationId)
  // 主机重启后重新声明这条会话（resync 保留它）。
  state.resync('h1', [conversationId])
  const ttl = 30 * 60 * 1000
  advance(ttl)
  assert.deepEqual(state.sweepEmpty(ttl), [conversationId], '重启前就掏空的会话也不许多挂')
})

test('resync 的 kept 数的是"真的被留下的会话"，不是声明里的 id 数', () => {
  const clock = { now: 1_000 }
  const state = new RelayState({ now: () => clock.now })
  const h1 = new FakeSock('h1')
  const h2 = new FakeSock('h2')
  const client = new FakeSock('c')
  state.attachHost('h1', h1, 'one')
  state.attachHost('h2', h2, 'two')
  state.attachClient('inst-1', client)

  state.issuePair('h1', '111111', 180_000)
  const a = state.claim('111111', 'inst-1')
  state.issuePair('h1', '222222', 180_000)
  const b = state.claim('222222', 'inst-1')
  state.issuePair('h2', '333333', 180_000)
  const foreign = state.claim('333333', 'inst-1')
  assert.equal(foreign.ok, true)

  // 声明里塞进：不属于它的会话 + 一条根本不存在的 convId。
  // 旧写法 `claimed.size - dropped.length` 会把这些一起算进 kept（4 而不是 2），
  // 而这条日志正是运维判断"主机还记得几条会话"的唯一出口。
  const verdict = state.resync('h1', [a.conversationId, b.conversationId, foreign.conversationId, 'c_ffffffffffff'])
  assert.equal(verdict.kept, 2, `kept 虚高：${JSON.stringify(verdict)}`)
  assert.deepEqual(verdict.dropped, [])
  assert.equal(state.conversations.has(foreign.conversationId), true, '别的主机的会话不许被 resync 删掉')

  // 反向：真删掉一条时 kept 也不能被算成 0（旧写法 1 - 1 = 0）。
  const second = state.resync('h1', [a.conversationId])
  assert.equal(second.kept, 1, 'kept 必须等于实际留下的条数')
  assert.deepEqual(second.dropped, [b.conversationId])
})

// ── re-hello 换身份：旧 clientId 必须从**所有**会话的成员表里摘掉 ──────
//
// ## 缺陷形状
//
// `clientGone` **刻意不动成员表**——那是 D3 的机制（socket 断开时手机还可能用同一个
// clientId 回来，会员关系必须留着）。
//
// 但 re-hello 是**换身份**而不是断开：那条 socket 从此不再服务旧身份，旧 clientId
// 也永远不会回来。于是"留着成员"那条 D3 理由在这里不成立，而后果是：
// 成员表里留着一个死成员 ⇒ `clients.size !== 0` ⇒ **`markEmpty` 永远不打点**
// ⇒ `sweepEmpty`（P2-⑤，默认 30 分钟回收空会话）**完全失效**，
// 唯一兜底是 7 天的 `sweepIdle`，`/healthz` 的 `conversations` 长期虚高。
//
// 而 server.ts 那一侧的注释明明写着「换 id 要向它所在会话的主机发 `peer-left`」
// ——通知发了，**成员没摘**，而回收判据读的是成员表。

test('leaveAll 把 clientId 从所有会话摘掉，并给空的那几条打上 emptySince', () => {
  const clock = { now: 1_000 }
  const state = new RelayState({ now: () => clock.now })
  const host = new FakeSock('host')
  state.attachHost('h1', host, 'my-macbook')
  state.issuePair('h1', '111111', 180_000)
  const conv1 = state.claim('111111', 'inst-1').conversationId
  // ⚠️ 造"同一个 clientId 挂在多条会话上"这个状态**不能**靠连续 claim：
  // `claim` 自己就先调了 `leaveAll`（复核 🟡7：重配必须摘干净），所以连续
  // 两次 claim 之后 inst-1 只在最新那一条上。第一次写这条判据时用了连续 claim，
  // 于是它红在一个与实现无关的地方（"conv1 的成员是 0"），而真正要验的
  // "leaveAll 跨多条会话"根本没被测到。
  // 正确形状是主机**重启续用**那条路：会话表在，主机 resync 声明"我仍持有这些"。
  state.conversations.set('c_restored', {
    hostId: 'h1',
    clients: new Set(['inst-1', 'inst-2']),
    seqHost: 0,
    lastActivityAt: 1_000,
  })
  state.resync('h1', [conv1, 'c_restored'])
  const conv3 = 'c_restored'

  assert.equal(state.conversations.get(conv1).clients.size, 1)
  assert.equal(state.conversations.get(conv3).clients.size, 2, '这一条有两个人')

  const touched = state.leaveAll('inst-1')
  assert.deepEqual(touched.sort(), [conv1, conv3].sort(), '它所在的两条都被摘到')
  assert.equal(state.conversations.get(conv1).clients.size, 0)
  assert.equal(state.conversations.get(conv3).clients.size, 1, '别人的会话里只摘自己')
  // ⚠️ 这一条才是本缺陷的要害：空会话必须**打上计时**，否则回收判据看不见它。
  assert.ok(
    state.conversations.get(conv1).emptySince !== undefined,
    '成员表空了却不打 emptySince：那条会话再也等不到回收',
  )
  assert.equal(
    state.conversations.get(conv3).emptySince,
    undefined,
    '还有别的成员就不许打点（否则同一台手机重挂会被误回收）',
  )
})

test('反向判据：leaveAll 不许删会话本身（会话归主机，主机可能还在上面跑）', () => {
  const clock = { now: 1_000 }
  const state = new RelayState({ now: () => clock.now })
  const host = new FakeSock('host')
  state.attachHost('h1', host, 'my-macbook')
  state.issuePair('h1', '111111', 180_000)
  const conv = state.claim('111111', 'inst-1').conversationId
  state.leaveAll('inst-1')
  assert.ok(state.conversations.has(conv), '会话必须留着：删了就是"手机每次回前台都要重扫"')
  assert.equal(state.conversations.get(conv).hostId, 'h1', '归属不变')
})

test('反向判据：leaveAll 一个不在任何会话里的 clientId 是安全的空操作', () => {
  const clock = { now: 1_000 }
  const state = new RelayState({ now: () => clock.now })
  const host = new FakeSock('host')
  state.attachHost('h1', host, 'my-macbook')
  state.attachClient('inst-1', new FakeSock('c1'))
  state.issuePair('h1', '111111', 180_000)
  const conv = state.claim('111111', 'inst-1').conversationId
  assert.deepEqual(state.leaveAll('never-seen'), [], '不该凭空造出"受影响的会话"')
  assert.equal(state.conversations.get(conv).emptySince, undefined, '空操作不许误打点')
  assert.equal(state.conversations.get(conv).clients.size, 1, '也不许摘掉别人的')
})

// ── 埋点（2026-10-23）：claim 的 latencyMs 与上行计数 upCount ──────────────

test('埋点：claim 返回 latencyMs = 认领时刻 - 首次签发时刻（同码重发不改基线）', () => {
  const clock = { now: 1_000 }
  const state = new RelayState({ now: () => clock.now })
  state.attachHost('h1', new FakeSock('h1'), 'box')
  state.issuePair('h1', '111111', 180_000)
  clock.now = 1_000 + 90_000
  // 同码重发只延长 TTL：issuedAt 必须还是首次那个 1_000，否则 latencyMs 会从重发起算。
  state.issuePair('h1', '111111', 180_000)
  clock.now = 1_000 + 120_000
  const got = state.claim('111111', 'inst-1')
  assert.equal(got.ok, true)
  assert.equal(got.latencyMs, 120_000, `latencyMs 必须从首次签发起算，实际=${got.latencyMs}`)
})

test('埋点：countUplink 记上行条数，且不动 seqHost', () => {
  const clock = { now: 1_000 }
  const state = new RelayState({ now: () => clock.now })
  state.attachHost('h1', new FakeSock('h1'), 'box')
  state.issuePair('h1', '111111', 180_000)
  const { conversationId } = state.claim('111111', 'inst-1')
  const conv = state.conversations.get(conversationId)
  assert.equal(conv.upCount, 0)
  state.countUplink(conversationId)
  state.countUplink(conversationId)
  assert.equal(conv.upCount, 2)
  assert.equal(conv.seqHost, 0, '上行不占下行编号')
  state.nextHostSequence(conversationId)
  assert.equal(conv.upCount, 2, '下行也不许污染 upCount')
})
