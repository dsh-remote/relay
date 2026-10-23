/**
 * 小程序码签发器（2026-10-21）。
 *
 * 守四件事：
 * 1. token 只取一次、按 expires_in 缓存（重复取会让**上一次的 token 立刻失效**，40001）；
 * 2. 同一张配对码的图片只向微信要一次（页面轮询是常态，配额 10 万/天）；
 * 3. 40001/42001 **只重取一次** token（坏 secret 不能打成热循环）；
 * 4. 没配凭据时 `enabled=false` 且 `codeFor` 抛错（上层用 501，不拿空 appid 去调）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMpCodeIssuer } from '../dist/src/mpcode.js'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

/** 假 fetch：按 URL 分流，记录调用次数。 */
function fakeFetch(script) {
  const calls = { token: 0, code: 0 }
  const fn = async (input) => {
    if (input.includes('/cgi-bin/token')) {
      calls.token += 1
      return { json: async () => script.token(calls.token) }
    }
    calls.code += 1
    // 成功时是 JPEG 字节，失败时微信同样回 200、body 是 JSON —— 两种都要模拟。
    return { json: async () => ({}), arrayBuffer: async () => bytesOf(script.code(calls.code)) }
  }
  return { fn, calls }
}

const bytesOf = (value) =>
  value instanceof Uint8Array
    ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    : new TextEncoder().encode(JSON.stringify(value)).buffer

test('token 只取一次；不同配对码各要一次图；同一张码走缓存', async () => {
  const { fn, calls } = fakeFetch({
    token: () => ({ access_token: 'T1', expires_in: 7200 }),
    code: () => JPEG,
  })
  const issuer = createMpCodeIssuer({ appId: 'wx1', secret: 's1', fetch: fn, now: () => 1_000 })
  assert.equal(issuer.enabled, true)

  const a = await issuer.codeFor('111111')
  const b = await issuer.codeFor('222222')
  const a2 = await issuer.codeFor('111111')
  assert.deepEqual([...a], [...JPEG])
  assert.deepEqual([...b], [...JPEG])
  assert.deepEqual([...a2], [...JPEG])
  assert.equal(calls.token, 1, 'token 必须复用')
  assert.equal(calls.code, 2, '同一张配对码不许重复要图')
})

test('token 失效（40001）⇒ 重取一次并成功', async () => {
  let first = true
  const { fn, calls } = fakeFetch({
    token: (n) => ({ access_token: `T${n}`, expires_in: 7200 }),
    code: () => {
      if (first) {
        first = false
        return { errcode: 40001, errmsg: 'invalid credential' }
      }
      return JPEG
    },
  })
  const issuer = createMpCodeIssuer({ appId: 'wx1', secret: 's1', fetch: fn, now: () => 1_000 })
  const bytes = await issuer.codeFor('333333')
  assert.deepEqual([...bytes], [...JPEG])
  assert.equal(calls.token, 2, '40001 之后必须重取一次 token')
})

test('持续 40001 ⇒ 只重取一次就抛（不许打成热循环）', async () => {
  const { fn, calls } = fakeFetch({
    token: (n) => ({ access_token: `T${n}`, expires_in: 7200 }),
    code: () => ({ errcode: 40001 }),
  })
  const issuer = createMpCodeIssuer({ appId: 'wx1', secret: 's1', fetch: fn, now: () => 1_000 })
  await assert.rejects(() => issuer.codeFor('444444'), /小程序码生成失败/)
  assert.equal(calls.token, 2, '最多两次：初始一次 + 失效一次')
  assert.equal(calls.code, 2, '最多两次：初始一次 + 重试一次')
})

test('没配凭据 ⇒ enabled=false 且调用直接抛（上层回 501）', async () => {
  const issuer = createMpCodeIssuer({
    appId: '',
    secret: '',
    fetch: async () => ({ json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }),
  })
  assert.equal(issuer.enabled, false)
  await assert.rejects(() => issuer.codeFor('555555'), /未配置/)
})

test('场景值就是配对码本身（≤32 字符，psk 不进 scene）', async () => {
  let body
  const fn = async (input, init) => {
    if (input.includes('/cgi-bin/token')) return { json: async () => ({ access_token: 'T', expires_in: 7200 }) }
    body = JSON.parse(init.body)
    return { json: async () => ({}), arrayBuffer: async () => JPEG }
  }
  const issuer = createMpCodeIssuer({ appId: 'wx1', secret: 's1', fetch: fn, now: () => 1_000 })
  await issuer.codeFor('042915')
  assert.equal(body.scene, '042915')
  assert.ok(!JSON.stringify(body).includes('psk'), 'psk 不许出现在 scene 里')
  assert.equal(body.page, 'pages/sessions/sessions')
  assert.equal(body.check_path, false, 'page 不要求已发布版本里存在（排错期那份页面还没发布）')
  assert.equal(body.env_version, 'release', '缺省打开正式版（与微信接口默认一致）')
})

test('DRC_MP_ENV 决定码打开哪一版：不配这一项，新版在体验版时扫码永远进老版本', async () => {
  let body
  const fn = async (input, init) => {
    if (input.includes('/cgi-bin/token')) return { json: async () => ({ access_token: 'T', expires_in: 7200 }) }
    body = JSON.parse(init.body)
    return { json: async () => ({}), arrayBuffer: async () => JPEG }
  }
  const trial = createMpCodeIssuer({ appId: 'wx1', secret: 's1', envVersion: 'trial', fetch: fn, now: () => 1_000 })
  await trial.codeFor('042915')
  assert.equal(body.env_version, 'trial')
  // 认不出来的值按正式版落地：配置写错不该让整个中继起不来，也不该悄悄打开开发版。
  const bogus = createMpCodeIssuer({ appId: 'wx1', secret: 's1', envVersion: 'staging', fetch: fn, now: () => 1_000 })
  await bogus.codeFor('042916')
  assert.equal(body.env_version, 'release')
})
