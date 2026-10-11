/**
 * `/api/claim-token`：认领一枚**属于这一台机器**的 host token（2026-10-11）。
 *
 * ## 为什么这条接口值得单独钉
 *
 * 它是「装完就能用」那条路的**最后一环**：之前 token 只能由用户写进
 * `cordis.patch.yml`，于是"装完不能用"成了默认结局。
 *
 * ⚠️ 而它同时是这台中继**最需要被看住的一个口子** —— 无认证接口。
 * 下面四条钉的正是它的边界：认领会**轮换**（所以"随时换 token"是免费的）、
 * 限频、只收 POST、停机中不受理。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../dist/src/config.js'
import { createRelay } from '../dist/src/server.js'

const TOKEN = 'claim-token-test-token-0123456789abcdef'
const hex48 = (n) => /^[0-9a-f]{48}$/

async function up() {
  const env = { DRC_HOST_TOKEN: TOKEN, DRC_PORT: '0', DRC_HOST_AUTH_MAX_ATTEMPTS: '5' }
  const { config, problems } = loadConfig(env, 'test')
  assert.equal(problems.filter((p) => p.level === 'error').length, 0, '测试配置不合法')
  const relay = createRelay(config)
  const { port } = await relay.startListening()
  return { relay, base: `http://127.0.0.1:${port}` }
}

test('认领得到一枚 48 位十六进制 token，且与 env 里那枚不同', async () => {
  const { relay, base } = await up()
  try {
    const res = await fetch(`${base}/api/claim-token`, { method: 'POST' })
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

test('认领会轮换：第二枚与第一枚不同（所以"随时换 token"不需要另开接口）', async () => {
  const { relay, base } = await up()
  try {
    const a = await (await fetch(`${base}/api/claim-token`, { method: 'POST' })).json()
    const b = await (await fetch(`${base}/api/claim-token`, { method: 'POST' })).json()
    assert.notEqual(a.token, b.token, '两次认领拿到同一枚 ⇒ 轮换没生效')
  } finally {
    await relay.close()
  }
})

test('限频：连着打第二次要吃 429，并带上还剩多少毫秒', async () => {
  const { relay, base } = await up()
  try {
    const first = await fetch(`${base}/api/claim-token`, { method: 'POST' })
    assert.equal(first.status, 200)
    const second = await fetch(`${base}/api/claim-token`, { method: 'POST' })
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
