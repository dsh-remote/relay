/**
 * `/api/claim-token`：认领一枚**属于这一台机器**的 host token（2026-10-11）。
 *
 * ## 为什么这条接口值得单独钉
 *
 * 它是「装完就能用」那条路的**最后一环**：之前 token 只能由用户写进
 * `cordis.patch.yml`，于是"装完不能用"成了默认结局。
 *
 * ⚠️ 而它同时是这台中继**最需要被看住的一个口子** —— 无认证接口。
 * 下面几条钉的正是它的边界：认领会**轮换**（所以"随时换 token"是免费的）、
 * 限频、只收 POST、**必须带 hostId**、超限体回 413、停机中不受理。
 *
 * ⚠️ 2026-10-11 晚：`hostId` 从"可选"变成"**必须**"（用户裁决不做老客户端兼容）。
 * 不带 hostId 的认领原来落到"未绑定槽位"，而那枚令牌对**任意** hostId 都算数
 * —— 无认证接口上的一把万能钥匙。现在它回 400 `host_id_required`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../dist/src/config.js'
import { createRelay } from '../dist/src/server.js'

const TOKEN = 'claim-token-test-token-0123456789abcdef'
const hex48 = (n) => /^[0-9a-f]{48}$/

/** 从认领响应里取 token（取不到就回 undefined，让断言自己红出真实原因）。 */
const bodyToken = (body) => (typeof body?.token === 'string' ? body.token : undefined)

/** 带 hostId 的认领（**所有**正当认领都长这样：不带 hostId 会被 400 拒掉）。 */
const claimAs = (base, hostId) =>
  fetch(`${base}/api/claim-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId }),
  })

async function up(overrides = {}) {
  const env = { DRC_HOST_TOKEN: TOKEN, DRC_PORT: '0', DRC_HOST_AUTH_MAX_ATTEMPTS: '5', ...overrides }
  const { config, problems } = loadConfig(env, 'test')
  assert.equal(problems.filter((p) => p.level === 'error').length, 0, '测试配置不合法')
  const relay = createRelay(config)
  const { port } = await relay.startListening()
  return { relay, base: `http://127.0.0.1:${port}` }
}

test('认领得到一枚 48 位十六进制 token，且与 env 里那枚不同', async () => {
  const { relay, base } = await up()
  try {
    const res = await claimAs(base, 'host-claim-1')
    // ⚠️ 报错消息里不能写 `await res.text()`：body 只能读一次，而消息是在
    // 断言**已经失败之后**才求值的 —— 那时 body 早就被下面的 json() 读走了。
    // （`Body is unusable: Body has already been read` 就是这么来的。）
    const body = await res.json().catch(() => ({}))
    assert.equal(res.status, 200, `认领失败：${res.status} ${JSON.stringify(body)}`)
    assert.ok(hex48(body.token), `token 形状不对（要 48 位十六进制，tokenMatches 是定长比较）：${body.token}`)
    assert.notEqual(body.token, TOKEN, '和 env 里那枚相同 ⇒ 那就是"把大家共用的 token 发出去"，等于公开')
    assert.match(body.rotatedAt, /^\d{4}-\d{2}-\d{2}T/, '要告诉对方这枚是什么时候换的')
  } finally {
    await relay.close()
  }
})

test('认领即轮换：同一台机器再领一枚，旧的那枚就作废（"随时换 token"是免费的）', async () => {
  // ⚠️ 这条判据的旧版是**假绿**的：它连着 POST 两次，而第二次吃 429、
  // body 里根本没有 `token`，于是 `a.token !== b.token` 拿一个 undefined 比出了"通过"。
  // 现在两枚都得先**真拿到**，比值才有意义。限频在这条里被特意关掉
  // （`DRC_CLAIM_MIN_INTERVAL_MS=0`），限频本身由下面那条用默认配置钉着。
  const { relay, base } = await up({ DRC_CLAIM_MIN_INTERVAL_MS: '0' })
  try {
    const a = await (await claimAs(base, 'host-rotate')).json()
    const b = await (await claimAs(base, 'host-rotate')).json()
    assert.ok(hex48(bodyToken(a)), `第一枚形状不对（限频是不是没关掉？）：${JSON.stringify(a)}`)
    assert.ok(hex48(bodyToken(b)), `第二枚形状不对（限频是不是没关掉？）：${JSON.stringify(b)}`)
    assert.notEqual(a.token, b.token, '同一台机器两次认领拿到同一枚 ⇒ 轮换根本没发生')
  } finally {
    await relay.close()
  }
})

test('**不带 hostId 的认领 ⇒ 400**（2026-10-11 晚：没有"未绑定槽位"这条兼容路了）', async () => {
  const { relay, base } = await up({ DRC_CLAIM_MIN_INTERVAL_MS: '0' })
  try {
    for (const init of [
      { method: 'POST' },
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"hostId":""}' },
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"hostId":42}' },
    ]) {
      const res = await fetch(`${base}/api/claim-token`, init)
      assert.equal(res.status, 400, `这份请求该被拒：${JSON.stringify(init)}（实得 ${res.status}）`)
      const body = await res.json()
      assert.equal(body.error, 'host_id_required', '要说清是"缺身份"而不是"身份不合法"')
      assert.equal(body.token, undefined, '被拒的请求不许回一枚可用的令牌')
    }
    // 反证：带 hostId 的正当认领照旧 200（别把闸设成"谁来都 400"）
    assert.equal((await claimAs(base, 'host-ok')).status, 200)
  } finally {
    await relay.close()
  }
})

test('限频：连着打第二次要吃 429，并带上还剩多少毫秒', async () => {
  const { relay, base } = await up()
  try {
    const first = await claimAs(base, 'host-rate')
    assert.equal(first.status, 200)
    const second = await claimAs(base, 'host-rate')
    assert.equal(second.status, 429, '连打没有被限住 ⇒ 这台中继会被人拿来批量领 token')
    const body = await second.json()
    assert.equal(body.error, 'too_soon')
    assert.ok(body.retryAfterMs > 0, '要告诉调用方还等多久，否则它只能盲目重试')
  } finally {
    await relay.close()
  }
})

test('只收 POST：GET 不发 token（浏览器地址栏一发就是一个 GET）', async () => {
  const { relay, base } = await up()
  try {
    const res = await fetch(`${base}/api/claim-token`)
    assert.equal(res.status, 405, 'GET 也受理 ⇒ 任何人在地址栏里就能领走一枚')
    assert.match(await res.text(), /use POST/, '要说清该用哪个方法')
  } finally {
    await relay.close()
  }
})

/**
 * 体超限 ⇒ **413**，而不是"连接被重置"。
 *
 * ## 这条判据是被一次实测逼出来的（2026-10-11）
 *
 * 原来 `readBody` 在 `data` 回调里先 `reject` 再同步 `req.destroy()` ——
 * 调用方拿到拒绝去写响应时 socket 已经没了。实测（真 HTTP，2KB 体）：
 * `fetch failed / UND_ERR_SOCKET`，**一个状态码都收不到**，
 * 而那段代码的注释写着"超限立刻回 413"。
 *
 * 这是**无认证**接口，超限是陌生人最容易触发的一条路；让对方看不见
 * "你发太大了"（而不是"服务端挂了"）会把排错方向带偏。
 */
test('体超限 ⇒ 413（不是连接重置，也不是 500）', async () => {
  const { relay, base } = await up({ DRC_CLAIM_MIN_INTERVAL_MS: '0' })
  try {
    // 上限是 1024 字节：给一个明显超限的 JSON 体
    const big = JSON.stringify({ hostId: 'h'.repeat(4000) })
    const res = await fetch(`${base}/api/claim-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
    })
    assert.equal(res.status, 413, `超限体应当回 413，收到 ${res.status}`)
    const body = await res.json()
    assert.equal(body.error, 'body_too_large')
    assert.equal(typeof body.limitBytes, 'number', '要说清上限是多少，否则调用方只能猜')
    // 反证：限之内的正常体照旧 200（别把闸设成"谁来都 413"）
    const ok = await fetch(`${base}/api/claim-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostId: 'probe-413' }),
    })
    assert.equal(ok.status, 200, '限内的正常认领必须照旧成功')
  } finally {
    await relay.close()
  }
})
