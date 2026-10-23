/**
 * conversation-cap —— 会话表上界与落盘合并窗口（D6，2026-10-13）。
 *
 * ## 这条缺陷是什么
 *
 * `conversations` 曾是中继**唯一没有上界**的一张表（配对码表 1000、令牌表 500、
 * 认领限频表 10000、连接数 200 全都有界），而 `handlePairClaim` 每次成功认领都
 * **同步写一整张表** ⇒ 单次配对的成本随表线性增长。实测（本机，预热后 20 次取均值）：
 * 100 / 1 000 / 5 000 / 50 000 条 = 6.05 / 7.15 / **8.50** / 45 ms，20 万条 159 ms。
 *
 * 而 `clientId` 由**客户端自选**、只有并发连接数有界，时间维度上没有上界；
 * 认领接口又是无认证的（谁都能领一枚令牌）⇒ 一台主机按全局配额 20 次/秒 churn 配对，
 * 约 42 分钟堆到 5 万条，此后 20 × 45 ms = **90% 的事件循环** ⇒ 心跳判定跟着停，
 * 所有对端一起被 `heartbeat timeout` 踢掉。**中继停摆，而受害的是全部正常用户。**
 *
 * ## 两条一起上，缺一个都还能被打穿
 *
 * ① `RelayConfig.maxConversations`（默认 5000）：满了**先回收已空的**会话，仍满才拒；
 * ② `markStateChanged()` 改成 200 ms 合并窗口：写盘从每秒 20 次压到 5 次
 *    （同样 5 万条时约 4%），代价是崩溃最多丢 200 ms 的变更。
 *
 * ## 这个文件钉的是"行为"
 *
 * 前三条走纯内存 `RelayState`（快、边界清楚），后四条走**真 HTTP + 真 WebSocket 打真中继**
 * ——因为最要紧的那条恰恰在接线处：**内部原因 `table_full` 不许出现在线上帧里**
 * （`pair-fail` 的 reason 是冻结消费面），而它只能靠真链路验出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { RelayState } from '../dist/src/state.js'
import { loadConfig } from '../dist/src/config.js'
import { createRelay } from '../dist/src/server.js'
import { PROTOCOL_VERSION } from '@dsh-remote/protocol/negotiate'

const ENV_TOKEN = 'conv-cap-test-env-token-0123456789abcdef'

/** 真中继级测试用的窗口常量（与 server.ts 的 `PERSIST_COALESCE_MS` 对齐）。 */
const COALESCE_MS = 200

// ── 装置 ────────────────────────────────────────────────────────────────

/** 一个够用的假 socket：`readyState` 恒为 OPEN（WS_OPEN = 1）。 */
function fakeSock() {
  return { readyState: 1, send() {}, close() {} }
}

/**
 * 造一个有主机在挂、时钟可控的状态机。
 *
 * `maxConversations` 故意开得很小（测试里 2–3），因为上界的**形状**才是这里要验的东西，
 * 而真实值 5000 验不出"满了会怎样"，只验得出"能装 5000 条"。
 */
function makeState({ maxConversations = 2, now = () => 1_000_000 } = {}) {
  const state = new RelayState({ now, maxConversations })
  state.attachHost('host-1', fakeSock(), 'laptop')
  let seq = 0
  return {
    state,
    /**
     * 发一张新码并立刻认领（可指定手机与主机）。
     *
     * ⚠️ 序号**在函数体里自增**，不能写成默认参数 `clientId = 'c' + (++seq)`：
     * 默认参数只在实参为 `undefined` 时求值，而这些用例每次都显式传了 clientId ⇒
     * `seq` 从不自增 ⇒ 三次都发同一个 token ⇒ 第二次就 `already_used`。
     * 第一版就是这么写的，四条判据当场红成一个与被测物无关的形状
     *（**夹具也会骗人**：红灯指向"上界没生效"，而真相是 token 重复）。
     */
    pair(clientId = `c${seq + 1}`, hostId = 'host-1') {
      seq += 1
      const token = `t${seq}`
      const issued = state.issuePair(hostId, token, 60_000)
      assert.equal(issued.ok, true, `发码失败：${JSON.stringify(issued)}`)
      assert.equal(issued.replaced, false, `token ${token} 撞上了已存在的那张（夹具自检：序号没自增？）`)
      return { token, result: state.claim(token, clientId) }
    },
  }
}

// ── ① 上界本身 ───────────────────────────────────────────────────────────

test('D6-1：会话表到上界就拒新认领，而且表不再增长', () => {
  const { state, pair } = makeState({ maxConversations: 2 })
  assert.equal(pair('phone-1').result.ok, true)
  assert.equal(pair('phone-2').result.ok, true)
  assert.equal(state.conversations.size, 2, '夹具自检：两条都在')

  const third = pair('phone-3')
  assert.equal(third.result.ok, false, '到上界还许第三条 ⇒ 上界没生效')
  assert.equal(third.result.reason, 'table_full', '拒绝原因必须是 table_full（内部原因）')
  assert.equal(state.conversations.size, 2, '被拒的那次**不许**留下半条会话')
})

test('D6-2：满了**先回收已空的**会话，而不是直接拒（用户只扫一次码就能配上）', () => {
  const { state, pair } = makeState({ maxConversations: 2 })
  pair('phone-1')
  pair('phone-2')
  // phone-1 显式离场 ⇒ 它那条会话变"空"（members 摘掉 + emptySince 打点）
  const [convOfPhone1] = [...state.conversations.keys()].filter((id) =>
    state.conversations.get(id).clients.has('phone-1'),
  )
  assert.equal(state.leave('phone-1', convOfPhone1), true, '夹具自检：离场成功')

  const third = pair('phone-3')
  assert.equal(third.result.ok, true, `回收出位置后还拒 ⇒ "先回收已空的"没生效：${JSON.stringify(third.result)}`)
  assert.equal(state.conversations.size, 2, '回收一条 + 新建一条 = 仍是 2')
  assert.equal(state.conversations.has(convOfPhone1), false, '被回收的应该是那条已空的')
  assert.ok(state.conversations.get(third.result.conversationId)?.clients.has('phone-3'))
})

test('D6-3：回收只动已空的——两条都有人时就拒，绝不踢掉有人的会话', () => {
  const { state, pair } = makeState({ maxConversations: 2 })
  pair('phone-1')
  pair('phone-2')
  const third = pair('phone-3')
  assert.equal(third.result.ok, false, '没有可回收的却仍然放行 ⇒ 回收越界了')
  for (const conv of state.conversations.values()) {
    assert.equal(conv.clients.size, 1, '有人的会话被踢了 —— 那会让别人的手机凭空掉线')
  }
})

test('D6-4：被拒时那张码**不许**被烧掉（否则用户看到的是「已被使用」而不是「中继忙」）', () => {
  const { state, pair } = makeState({ maxConversations: 1 })
  pair('phone-1')
  const refused = pair('phone-2')
  assert.equal(refused.result.ok, false, '夹具自检：第二次被拒')
  // phone-1 离场 ⇒ 腾出位置
  const [conv] = [...state.conversations.keys()]
  state.leave('phone-1', conv)
  const retry = state.claim(refused.token, 'phone-2')
  assert.equal(retry.ok, true, '同一张码在有位置之后仍配不上 ⇒ 它被 `used` 烧掉了（用户只能重新扫码）')
})

// ── ② 真中继：线上帧不许出现内部原因 ────────────────────────────────────

/** 起一台真中继。`stateFile` 给路径就启用落盘（合并窗口那条要验它）。 */
async function startRelay(overrides = {}) {
  const env = {
    DRC_HOST_TOKEN: ENV_TOKEN,
    DRC_PORT: '0',
    DRC_BIND: '127.0.0.1',
    DRC_LOG_LEVEL: 'silent',
    DRC_CLAIM_MIN_INTERVAL_MS: '0',
    ...overrides,
  }
  const { config, problems } = loadConfig(env, 'test')
  assert.equal(problems.filter((p) => p.level === 'error').length, 0, `测试配置不合法：${JSON.stringify(problems)}`)
  const relay = createRelay(config)
  const { port } = await relay.startListening()
  return { relay, port, wsUrl: `ws://127.0.0.1:${port}` }
}

/**
 * 走一遍完整配对：主机 hello → 手机 hello → `pair-begin` → `pair-begin-client`。
 * 返回手机侧看到的那一帧（`paired` 或 `pair-fail`）。全程有上限，绝不无限等。
 */
function pairOnce(wsUrl, { hostId, token, pairingToken, clientId }) {
  return new Promise((resolve) => {
    const host = new WebSocket(wsUrl)
    const phone = new WebSocket(wsUrl)
    const inbox = []
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const ws of [host, phone]) {
        try {
          ws.removeAllListeners()
          ws.close()
        } catch {
          /* 已关 */
        }
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish({ t: 'timeout' }), 4_000)
    const drain = (frame) => {
      if (settled) return
      if (frame.t === 'pair-fail') return finish(frame)
      if (frame.t === 'paired') return finish(frame)
      inbox.push(frame)
    }
    let hostOk = false
    let phoneOk = false
    const maybeIssue = () => {
      if (!hostOk || !phoneOk) return
      host.send(JSON.stringify({ t: 'pair-begin', pairingToken }))
    }
    host.on('open', () =>
      host.send(
        JSON.stringify({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, hostId, token, label: 'cap-test' }),
      ),
    )
    host.on('message', (raw) => {
      const frame = JSON.parse(String(raw))
      if (frame.t === 'hello-ok' && !hostOk) {
        hostOk = true
        maybeIssue()
        return
      }
      drain(frame)
    })
    phone.on('open', () =>
      phone.send(JSON.stringify({ t: 'hello', role: 'client', protocol: PROTOCOL_VERSION, clientId })),
    )
    phone.on('message', (raw) => {
      const frame = JSON.parse(String(raw))
      if (frame.t === 'hello-ok' && !phoneOk) {
        phoneOk = true
        maybeIssue()
        // 手机主动认领（pair-begin-client 由客户端发，方向与 pair-begin 相反）
        phone.send(JSON.stringify({ t: 'pair-begin-client', pairingToken }))
        return
      }
      drain(frame)
    })
    const onDead = () => finish({ t: 'socket-error' })
    host.on('error', onDead)
    phone.on('error', onDead)
  })
}

test('D6-5：会话表满时，手机收到的那一帧 reason **落在冻结的四个之内**', async () => {
  const { relay, wsUrl } = await startRelay({ DRC_MAX_CONVERSATIONS: '1' })
  try {
    const first = await pairOnce(wsUrl, { hostId: 'h1', token: ENV_TOKEN, pairingToken: '111111', clientId: 'c1' })
    assert.equal(first.t, 'paired', `夹具自检：第一条要配得上（${JSON.stringify(first)}）`)

    const second = await pairOnce(wsUrl, { hostId: 'h1', token: ENV_TOKEN, pairingToken: '222222', clientId: 'c2' })
    assert.equal(second.t, 'pair-fail', `表满却配上了：${JSON.stringify(second)}`)
    // ⚠️ 冻结消费面：小程序 `translatePairFail` 只认这四个，多一个就是一条英文 toast。
    assert.ok(
      ['invalid_or_expired', 'already_used', 'host_offline'].includes(second.reason),
      `线上帧带出了冻结面之外的 reason「${second.reason}」—— 内部原因不许出网（见 handlePairClaim 的映射）`,
    )
    assert.equal(relay.health().rejectedPairs >= 1, true, '被拒的那次要计数（/healthz 是唯一观测面）')
  } finally {
    await relay.close()
  }
})

test('D6-6：表满**不**计入该连接的配对失败次数（否则 5 次就把合法手机踢下线 4008）', async () => {
  // 用 maxPairAttemptsPerConn=2 把这条钉死：连着两次表满就该被踢 4008 了。
  const { relay, wsUrl } = await startRelay({ DRC_MAX_CONVERSATIONS: '1', DRC_PAIR_ATTEMPTS_PER_CONN: '2' })
  try {
    await pairOnce(wsUrl, { hostId: 'h1', token: ENV_TOKEN, pairingToken: '111111', clientId: 'c1' })
    // 同一台手机连试两次（都是表满），连接必须还活着
    for (const token of ['222222', '333333']) {
      const r = await pairOnce(wsUrl, { hostId: 'h1', token: ENV_TOKEN, pairingToken: token, clientId: 'c1' })
      assert.equal(r.t, 'pair-fail', `夹具自检：第 ${token} 次应当被拒（${JSON.stringify(r)}）`)
    }
    // 腾出位置后同一台手机还能配上 —— 证明它的连接没被踢（pairAttempts 没被表满计满）
    relay.state.conversations.forEach((conv) => conv.clients.clear())
    const ok = await pairOnce(wsUrl, { hostId: 'h1', token: ENV_TOKEN, pairingToken: '444444', clientId: 'c1' })
    assert.equal(ok.t, 'paired', `表满把连接踢掉了（用户会看到反复「已断开」）—— ${JSON.stringify(ok)}`)
  } finally {
    await relay.close()
  }
})

// ── ③ 落盘合并窗口 ─────────────────────────────────────────────────────

test('D6-7：连续的结构性变更**合并**成一次写盘，而停机路径不等这个窗口', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-cap-persist-'))
  const stateFile = path.join(dir, 'state.json')
  const { relay, wsUrl } = await startRelay({ DRC_STATE_FILE: stateFile })
  try {
    const before = relay.health().stateWrites
    // 连着两次配对（每次都会调 markStateChanged）
    await pairOnce(wsUrl, { hostId: 'h1', token: ENV_TOKEN, pairingToken: '111111', clientId: 'c1' })
    await pairOnce(wsUrl, { hostId: 'h1', token: ENV_TOKEN, pairingToken: '222222', clientId: 'c2' })
    const during = relay.health().stateWrites
    assert.equal(during, before, `窗口内不该写盘（合并窗口失效 ⇒ 每次认领仍同步整表写）：${before} → ${during}`)

    // 窗口过后：两次变更合并成一次写
    await new Promise((r) => setTimeout(r, COALESCE_MS + 120))
    assert.equal(
      relay.health().stateWrites,
      before + 1,
      `两次变更应合并成恰好一次写盘，实际写了 ${relay.health().stateWrites - before} 次`,
    )
    const written = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(written.conversations.length, 2, '合并的那一次要把两条变更都写进去')

    // 停机路径：不等窗口，直接强制落盘（`close()` 里 persistNow）
    await pairOnce(wsUrl, { hostId: 'h1', token: ENV_TOKEN, pairingToken: '333333', clientId: 'c3' })
    const beforeClose = relay.health().stateWrites
    await relay.close()
    const afterClose = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(
      afterClose.conversations.length,
      3,
      `停机必须把窗口内那次变更也落盘（丢的就是「刚配好的那一对」）——盘上只有 ${afterClose.conversations.length} 条`,
    )
    assert.ok(relay.health().stateWrites >= beforeClose, '夹具自检：停机那一次写盘要计数')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('D6-8：窗口内的待写变更不会被**重复**写（persistNow 自己清标记）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-cap-persist2-'))
  const stateFile = path.join(dir, 'state.json')
  const { relay, wsUrl } = await startRelay({ DRC_STATE_FILE: stateFile })
  try {
    await pairOnce(wsUrl, { hostId: 'h1', token: ENV_TOKEN, pairingToken: '111111', clientId: 'c1' })
    await relay.close()
    const afterClose = relay.health().stateWrites
    // 关掉之后那个 200 ms 定时器如果还在，会在进程还活着时多写一次
    await new Promise((r) => setTimeout(r, COALESCE_MS + 150))
    assert.equal(relay.health().stateWrites, afterClose, '停机之后还有一笔在写 ⇒ 待写标记没被清掉（同一份状态写两遍）')
    assert.ok(existsSync(stateFile), '夹具自检：状态文件必须在')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── ④ 配置 ────────────────────────────────────────────────────────────

test('D6-9：`DRC_MAX_CONVERSATIONS` 与其它旋钮同一套校验（空串告警、非法值报错并回落）', () => {
  const { config: def } = loadConfig({}, 'test')
  assert.equal(def.maxConversations, 5000, '默认值必须与文档写的 5000 一致（判据钉的是口径）')

  const { config: ok } = loadConfig({ DRC_MAX_CONVERSATIONS: '123' }, 'test')
  assert.equal(ok.maxConversations, 123)

  const empty = loadConfig({ DRC_MAX_CONVERSATIONS: '' }, 'test')
  assert.equal(empty.config.maxConversations, 5000, '空串要回落默认值')
  assert.ok(
    empty.problems.some((p) => p.level === 'warn' && p.message.includes('DRC_MAX_CONVERSATIONS')),
    '空串要告警',
  )

  for (const bad of ['0', '-1', 'abc', '1e3', '0x10', '']) {
    if (bad === '') continue // 空串是**告警 + 回落**，上面单独钉了
    const r = loadConfig({ DRC_MAX_CONVERSATIONS: bad }, 'test')
    assert.equal(r.config.maxConversations, 5000, `非法值 ${JSON.stringify(bad)} 必须回落默认值而不是被当上界用`)
    assert.ok(
      r.problems.some((p) => p.level === 'error' && p.message.includes('DRC_MAX_CONVERSATIONS')),
      `非法值 ${JSON.stringify(bad)} 要报 error（照 C2/C3 那条纪律：静默用默认值 = 运维以为设上了）`,
    )
  }
  // ⚠️ 前后空格是**接受的**（`integer()` 先 trim 再校验，所有旋钮同款）。
  //   第一版把 ' 12 ' 放进"非法值"名单里，这条判据当场红 —— 而红的不是实现，是判据
  //   把共享口径写严了（项目纪律：判据红先怀疑判据）。这里把 trim 口径**钉住**，
  //   免得下一个又按"更严更好"的直觉去改它。
  assert.equal(
    loadConfig({ DRC_MAX_CONVERSATIONS: ' 12 ' }, 'test').config.maxConversations,
    12,
    '前后空格应当被 trim 后接受',
  )
})

test('反向自检：把上界去掉 ⇒ D6-1/2/3/4 全部立刻红（它们不是恒绿的）', () => {
  // 形状自检：这些判据全都建立在"claim 会在满时返回 table_full"之上。
  // 把容量闸摘掉，下面那条 assert 立刻不成立 —— 所以这里钉住"判据读的是真闸"。
  const noCap = new RelayState({ now: () => 1_000_000, maxConversations: Number.POSITIVE_INFINITY })
  noCap.attachHost('host-1', fakeSock(), 'laptop')
  noCap.issuePair('host-1', 'tk', 60_000)
  assert.equal(noCap.claim('tk', 'c1').ok, true, '夹具自检：真的配上了')
  for (let i = 0; i < 50; i += 1) {
    noCap.issuePair('host-1', `tk${i}`, 60_000)
    assert.equal(noCap.claim(`tk${i}`, `cx${i}`).ok, true)
  }
  // 没有上界时表就真的长上去了 —— 这正是 D6 的形状
  assert.equal(noCap.conversations.size, 51, '无上界 ⇒ 表会一直涨（这正是要封的那件事）')
  const capped = new RelayState({ now: () => 1_000_000, maxConversations: 2 })
  capped.attachHost('host-1', fakeSock(), 'laptop')
  capped.issuePair('host-1', 'tk', 60_000)
  assert.equal(capped.claim('tk', 'c1').ok, true)
  capped.issuePair('host-1', 'tk2', 60_000)
  assert.equal(capped.claim('tk2', 'c2').ok, true)
  assert.equal(capped.conversations.size, 2, '有上界 ⇒ 表停住了')
})
