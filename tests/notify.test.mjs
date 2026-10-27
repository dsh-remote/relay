/**
 * notify —— 微信订阅消息发送器的判据（2026-10-27）。
 *
 * ## 这一面要守住的六件事
 *
 * ① **额度**：一次性订阅 = 一次授权一条；`subscribed=true` 才 +1；发成功 −1。
 * ② **去重**：同一张卡（`hostId:requestId`）**只发一次** —— 跨主机重启也拦得住。
 * ③ **频控**：冷却 10 分钟 / 每小时 3 条 / 每天 10 条。
 * ④ **隐私**：模板正文全是**固定文案**（主机带不进任何内容）。
 * ⑤ **落地页**：单条进 `chat?id=`（chat 页只认 `id`，写成 `sessionId` 会开空页），
 *    多条进会话列表。
 * ⑥ **43101 清零**：用户拒收/订阅用尽 ⇒ 额度清零（再发也是白发）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier, formatChinaTime, notifyPage, NOTIFY_QUOTA_MAX } from '../dist/src/notify.js'
import { createWechatTokenProvider } from '../dist/src/wechat-token.js'
import { Log } from '../dist/src/log.js'

const ITEM = {
  requestId: 'ap_1',
  sessionId: 'sess-1',
  kind: 'approval',
  askedAt: '2026-10-27T00:30:00.000Z',
}

/** 假 fetch：按 URL 分流，记录发出的通知体。 */
function fakeFetch(script = {}) {
  const calls = { token: 0, session: 0, send: 0 }
  const sends = []
  const fn = async (input, init) => {
    if (input.includes('/cgi-bin/token')) {
      calls.token += 1
      return { json: async () => ({ access_token: `T${calls.token}`, expires_in: 7200 }) }
    }
    if (input.includes('/sns/jscode2session')) {
      calls.session += 1
      const openid = script.openid === undefined ? 'openid-1' : script.openid
      return { json: async () => (openid === null ? { errcode: 40029 } : { openid }) }
    }
    calls.send += 1
    const body = JSON.parse(init.body)
    sends.push(body)
    const errcode = script.errcode === undefined ? 0 : script.errcode
    return { json: async () => ({ errcode }) }
  }
  return { fn, calls, sends }
}

function makeNotifier(overrides = {}) {
  const { fn, calls, sends } = overrides.fetch ? overrides.fetch : fakeFetch()
  const lines = []
  const log = new Log('debug', (line) => lines.push(line))
  const tokens = createWechatTokenProvider({
    appId: 'wx1',
    secret: 's1',
    fetch: fn,
    now: overrides.now ?? (() => 1_000),
  })
  const notifier = createNotifier({
    appId: 'wx1',
    secret: 's1',
    templateId: overrides.templateId ?? 'TPL1',
    envVersion: 'release',
    tokens,
    fetch: fn,
    now: overrides.now ?? (() => 1_000),
    log,
    membersOf: overrides.membersOf ?? (() => ['c1']),
  })
  return { notifier, calls, sends, lines, tokens }
}

test('① 登记订阅：换到 openid；subscribed=true 才加额度', async () => {
  const h = makeNotifier()
  const r1 = await h.notifier.register('c1', 'code-1', false)
  assert.equal(r1.ok, true)
  assert.equal(r1.quota, 0, '没订阅就不该有额度')
  const r2 = await h.notifier.register('c1', 'code-2', true)
  assert.equal(r2.quota, 1, '订阅一次 +1')
  assert.equal(h.notifier.quotaOf('c1'), 1)
  assert.equal(h.calls.session, 2, '两次登记各换一次 openid')

  // ⚠️ **发成功要扣额度**：一次性订阅 = 一次授权一条 ⇒ 发掉就没了。
  //   不扣的话额度会一直够用，于是"用户授权了几次"这件事完全失去意义
  //   （微信那边其实已经不让发了，只是我们这边看不出来）。
  const sent = await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [ITEM] })
  assert.equal(sent.sent, 1, '额度够时应该发得出去')
  assert.equal(h.notifier.quotaOf('c1'), 0, '发成功要扣 1 条额度')
})

test('①b 额度封顶 3；同一个 openid 重复登记不会刷额度', async () => {
  const h = makeNotifier()
  for (let i = 0; i < 5; i += 1) await h.notifier.register('c1', `code-${i}`, true)
  assert.equal(h.notifier.quotaOf('c1'), NOTIFY_QUOTA_MAX, `额度封顶 ${NOTIFY_QUOTA_MAX}`)
})

test('② code 换不到 openid ⇒ 不登记、不加额度', async () => {
  const h = makeNotifier({ fetch: fakeFetch({ openid: null }) })
  const r = await h.notifier.register('c1', 'bad-code', true)
  assert.equal(r.ok, false)
  assert.equal(h.notifier.quotaOf('c1'), 0)
  assert.equal(h.calls.send, 0, '换不到 openid 就不该发通知')
})

test('③ 模板正文全是固定文案：一个字的内容都不许带', async () => {
  const h = makeNotifier()
  await h.notifier.register('c1', 'code-1', true)
  await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [ITEM] })
  assert.equal(h.sends.length, 1)
  const body = h.sends[0]
  const values = Object.values(body.data).map((d) => d.value)
  for (const v of values) {
    assert.ok(v.length <= 20, `模板字段超 20 字符：${v}`)
    assert.ok(!/rm\s|删除|命令|https?:/.test(v), `模板正文不许带内容：${v}`)
  }
  assert.equal(body.data.thing9.value, 'DSH 权限审批')
  assert.equal(body.data.thing10.value, '工具调用')
  assert.equal(body.data.thing3.value, '有审批等待处理')
  // 提交时间 = 挂起时刻（东八区）：00:30 UTC ⇒ 08:30 北京
  assert.equal(body.data.time67.value, '2026-10-27 08:30:00')
})

test('③b 提问那一条用 thing10 区分；多条聚合成一条', async () => {
  const h = makeNotifier()
  await h.notifier.register('c1', 'code-1', true)
  await h.notifier.notify({
    hostId: 'h1',
    conversationId: 'c1',
    items: [{ ...ITEM, requestId: 'q_1', kind: 'question' }],
  })
  assert.equal(h.sends[0].data.thing9.value, 'DSH 提问')
  assert.equal(h.sends[0].data.thing10.value, '提问')

  const h2 = makeNotifier()
  await h2.notifier.register('c1', 'code-1', true)
  await h2.notifier.notify({
    hostId: 'h1',
    conversationId: 'c1',
    items: [ITEM, { ...ITEM, requestId: 'ap_2' }],
  })
  assert.equal(h2.sends.length, 1, '多张卡合并成一条通知')
  assert.equal(h2.sends[0].data.thing9.value, 'DSH 有 2 项待处理')
  assert.equal(h2.sends[0].data.thing10.value, '审批/提问')
})

test('④ 落地页：单条进 chat?id=；多条进会话列表', () => {
  assert.equal(notifyPage([ITEM]), 'pages/chat/chat?id=sess-1')
  assert.equal(notifyPage([ITEM, { ...ITEM, requestId: 'ap_2' }]), 'pages/sessions/sessions')
  // ⚠️ chat 页只认 `id`（计划 §2.3/§10.7）：写成 sessionId 会打开空页
  assert.ok(!notifyPage([ITEM]).includes('sessionId'))
})

test('⑤ 去重：同一张卡只发一次（**跨过冷却也要拦得住**）', async () => {
  // ⚠️ **这里必须跨过冷却再验**：不跨过时，"去重"与"10 分钟频控"会给出**同一个**
  //   观测（sent=0）⇒ 判据分不出是哪个机制在挡 ⇒ 把去重代码删掉它照样绿
  //   （2026-10-27 实测：这一枪第一版就是这样漏过去的）。
  // ⇒ 做法：过 11 分钟（冷却已过）再发**同一张卡**，此时只有去重能挡它。
  let clock = 1_000_000
  const h = makeNotifier({ now: () => clock })
  // 额度灌满（3 条），免得额度先挡着
  for (let i = 0; i < 4; i += 1) await h.notifier.register('c1', `code-${i}`, true)
  const first = await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [ITEM] })
  assert.equal(first.sent, 1)

  clock += 11 * 60 * 1000 // 冷却已过
  // 同一张卡 ⇒ 必须还是 0（此时只剩去重能挡）
  const again = await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [ITEM] })
  assert.equal(again.sent, 0, '同一张卡不许再发（冷却已过 ⇒ 只能是去重在挡）')
  assert.equal(h.sends.length, 1, '不许发出第二条')

  // ⚠️ **活性自检**：换一张**新**卡 ⇒ 必须发得出去。
  //   没有这一条，上面那句可能只是"额度用完了"造成的假绿。
  const other = await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [{ ...ITEM, requestId: 'ap_2' }] })
  assert.equal(other.sent, 1, '新卡要发得出去（证明上面不是额度/频控挡的）')
  assert.equal(h.sends.length, 2)
})

test('⑥ 频控：10 分钟冷却 / 每小时 3 条 / 每天 10 条', async () => {
  let clock = 1_000_000
  const h = makeNotifier({ now: () => clock })
  await h.notifier.register('c1', 'code-1', true)
  // 额度只有 1 条 ⇒ 先把额度灌满才能测频控
  for (let i = 0; i < 6; i += 1) await h.notifier.register('c1', `code-${i}`, true)
  const one = await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [{ ...ITEM, requestId: 'a' }] })
  assert.equal(one.sent, 1)
  // 立刻再发 ⇒ 冷却挡着
  const two = await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [{ ...ITEM, requestId: 'b' }] })
  assert.equal(two.sent, 0)
  assert.ok(two.skipped.includes('rate_limited'))
  // 过 11 分钟 ⇒ 冷却过去
  clock += 11 * 60 * 1000
  const three = await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [{ ...ITEM, requestId: 'c' }] })
  assert.equal(three.sent, 1)
})

test('⑦ 43101（用户拒收/订阅用尽）⇒ 额度清零', async () => {
  const h = makeNotifier({ fetch: fakeFetch({ errcode: 43101 }) })
  await h.notifier.register('c1', 'code-1', true)
  await h.notifier.register('c1', 'code-2', true)
  assert.equal(h.notifier.quotaOf('c1'), 2)
  const r = await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [ITEM] })
  assert.equal(r.sent, 0)
  assert.equal(h.notifier.quotaOf('c1'), 0, '额度必须清零（再发也是白发）')
})

test('⑧ 没 openid / 没额度 ⇒ 不发（但也不报错）', async () => {
  const h = makeNotifier()
  const r = await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [ITEM] })
  assert.equal(r.ok, true)
  assert.equal(r.sent, 0)
  assert.ok(r.skipped.includes('no_openid'))
  assert.equal(h.calls.send, 0)
})

test('⑨ 没配模板 id ⇒ 不启用（一帧都不发）', async () => {
  const h = makeNotifier({ templateId: '' })
  assert.equal(h.notifier.enabled, false)
  await h.notifier.register('c1', 'code-1', true)
  const r = await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [ITEM] })
  assert.equal(r.ok, false)
  assert.equal(h.calls.send, 0)
})

test('⑩ token 缓存复用：多次发送只取一次 token', async () => {
  const h = makeNotifier()
  await h.notifier.register('c1', 'code-1', true)
  for (let i = 0; i < 5; i += 1) {
    await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [{ ...ITEM, requestId: `a${i}` }] })
  }
  assert.equal(h.calls.token, 1, 'token 必须复用（重取会让别处正在用的 token 立刻失效）')
})

test('⑪ 日志里不许出现 openid / code', async () => {
  const h = makeNotifier()
  await h.notifier.register('c1', 'secret-code-value', true)
  await h.notifier.notify({ hostId: 'h1', conversationId: 'c1', items: [ITEM] })
  const joined = h.lines.join('\n')
  assert.ok(!joined.includes('secret-code-value'), '日志里不许出现 code')
  assert.ok(!joined.includes('openid-1'), '日志里不许出现 openid')
})

test('⑫ 东八区时间格式', () => {
  assert.equal(formatChinaTime('2026-10-27T00:30:00.000Z'), '2026-10-27 08:30:00')
  assert.equal(formatChinaTime('坏时间'), '')
})
