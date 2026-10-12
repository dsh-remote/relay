/**
 * host token 模型：**按 hostId 一机一枚**（C 方案，2026-10-11）。
 *
 * ## 这个文件是被一次真实事故逼出来的
 *
 * 旧模型是「**全局单令牌 + 认领即轮换**」：`POST /api/claim-token` 一被调用，
 * **所有人的**令牌当场作废。而主机侧"盘上有 token 就不再认领"⇒ 被顶掉的那台
 * **不会自愈**、永久连不上。
 *
 * 2026-10-11 那天真实发生：本机（112.48.57.86）在 14:34 / 15:43 / 16:57 被
 * **另外三台机器**（63.178.90.28、218.86.249.169、172.172.119.98，UA 都是 `node`
 * = 别的机器上的插件）各顶掉一次。而这条接口是**无认证**的公网接口 ⇒
 * 那个模型下"任何能 POST 它的人都能把合法主机永久踢下线"。
 *
 * 于是有了现在这套：带 `{hostId}` 认领**只顶掉这台机器自己**旧的那一枚
 * （用户原话："后面的顶掉前面的"），env 那枚永不参与轮换，令牌随之落盘。
 *
 * ⚠️ 2026-10-11 晚（用户裁决「不需要兼容老客户端」）**拿掉了"未绑定槽位"**：
 * 不带 hostId 的认领从 200 改成 400 `host_id_required`，`hostTokenAccepted` 也不再认它。
 * 那枚令牌原来对**任意** hostId 都算数 ⇒ 谁领一枚就能冒充任何主机（② 那条判据的由来）。
 *
 * ## 这个文件钉的是"行为"，不是"实现"
 *
 * 全部用真 HTTP + 真 WebSocket 打真中继（`createRelay` + `loadConfig`），
 * 不 import 内部函数 —— 要验的恰恰是"它接在正确的位置、接对了两条来源"。
 * 每条判据都配一个**反证**（要么在同一测试里，要么就是另一条测试的阳性面）：
 * 只证明"能连上"是不够的，还得证明"该拒的真的拒了"，否则一条恒绿的断言
 * 可以在"闸根本不存在"的世界里通过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { loadConfig } from '../dist/src/config.js'
import { createRelay } from '../dist/src/server.js'
import { PROTOCOL_VERSION } from '@dsh-remote/protocol/negotiate'

const ENV_TOKEN = 'host-tokens-test-env-token-0123456789abcdef'
const hex48 = /^[0-9a-f]{48}$/

/** 起一台中继。`stateFile` 传进来就能验"令牌跨重启还在"。 */
async function startRelay(overrides = {}) {
  const env = {
    DRC_HOST_TOKEN: ENV_TOKEN,
    DRC_PORT: '0',
    DRC_BIND: '127.0.0.1',
    DRC_LOG_LEVEL: 'silent',
    // 判据不该靠"等 4 秒"来绕过限频：把闸关掉，专门验"令牌模型"这件事。
    // 限频本身由 claim-token.test.mjs 用**默认配置**钉着（那里才是它该被验的地方）。
    DRC_CLAIM_MIN_INTERVAL_MS: '0',
    ...overrides,
  }
  const { config, problems } = loadConfig(env, 'test')
  assert.equal(problems.filter((p) => p.level === 'error').length, 0, '测试配置不合法')
  const relay = createRelay(config)
  const { port } = await relay.startListening()
  return { relay, port, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` }
}

/** 认领一枚。**必须给 hostId** —— 不带 hostId 的认领从 2026-10-11 晚起一律 400。 */
async function claim(base, hostId) {
  const init = { method: 'POST' }
  if (hostId !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify({ hostId })
  }
  const res = await fetch(`${base}/api/claim-token`, init)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

/**
 * 拿一枚令牌去握手，等**第一帧**。
 *
 * 等第一帧而不是等 hello-ok：拒的时候第一帧是 `error`，两种都要能观察到，
 * 否则判据会在"闸不存在"的世界里假绿（`handshake.test.mjs` 里踩过这个坑）。
 */
function sayHello(wsUrl, hostId, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl)
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        ws.removeAllListeners()
        ws.close()
      } catch {
        /* 已关 */
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish({ t: 'timeout' }), 3_000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'host', protocol: PROTOCOL_VERSION, hostId, token, label: 'test' }))
    })
    ws.on('message', (raw) => {
      clearTimeout(timer)
      let frame
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return finish({ t: 'unparsable' })
      }
      finish(frame)
    })
    ws.on('error', () => finish({ t: 'socket-error' }))
  })
}

// ── ① 核心回归：别人的认领顶不掉我（就是那天真实发生的故障）──────────────

test('① 别人的认领顶不掉我：A、B 各领一枚，B 认领后 A 那枚仍然能连上', async () => {
  const { relay, base, wsUrl } = await startRelay()
  try {
    const a = await claim(base, 'host-aaa')
    const b = await claim(base, 'host-bbb')
    assert.ok(hex48.test(a.body.token), `A 的 token 形状不对：${a.body.token}`)
    assert.ok(hex48.test(b.body.token), `B 的 token 形状不对：${b.body.token}`)
    assert.notEqual(a.body.token, b.body.token, '两台机器领到同一枚 ⇒ 那还是共享令牌')
    assert.equal(a.body.hostId, 'host-aaa', '响应要把 hostId 原样回给对方（排障用）')

    // 阳性：A 拿自己那枚连得上
    assert.equal((await sayHello(wsUrl, 'host-aaa', a.body.token)).t, 'hello-ok', 'A 自己那枚必须能用')
    // **这一次是关键**：B 认领之后 A 仍然能用（旧模型下这里必红）
    assert.equal((await sayHello(wsUrl, 'host-aaa', a.body.token)).t, 'hello-ok', 'B 认领把 A 顶掉了 ⇒ 回到了事故模型')
    // 反证：拿 B 的令牌冒充 A 必须被拒（否则"按 hostId 查"根本没生效，只是谁都能进）
    assert.equal((await sayHello(wsUrl, 'host-aaa', b.body.token)).t, 'error', 'B 的令牌不该能代表 A 连上来')
  } finally {
    await relay.close()
  }
})

test('①b 同一台机器再认领 ⇒ 只顶掉它自己旧的那一枚（"后面的顶掉前面的"）', async () => {
  const { relay, base, wsUrl } = await startRelay()
  try {
    const first = await claim(base, 'host-aaa')
    const second = await claim(base, 'host-aaa')
    assert.notEqual(first.body.token, second.body.token, '同一台机器再认领必须换一枚')
    assert.equal((await sayHello(wsUrl, 'host-aaa', first.body.token)).t, 'error', '旧的那枚该立刻失效')
    assert.equal((await sayHello(wsUrl, 'host-aaa', second.body.token)).t, 'hello-ok', '新的那枚必须能用')
  } finally {
    await relay.close()
  }
})

// ── ② 不带 hostId 的认领**一律拒**（2026-10-11 晚：不做老客户端兼容）──────────

test('② 不带 hostId 的认领 ⇒ 400 `host_id_required`，一枚都不签', async () => {
  const { relay, base, wsUrl } = await startRelay()
  try {
    const before = await claim(base, 'host-aaa')
    // 老客户端那条路（不带体）现在被**明确**拒绝：它原来落到"未绑定槽位"，
    // 而那枚令牌对任意 hostId 都算数 ⇒ 谁领一枚就能冒充任何主机。
    const legacy = await claim(base)
    assert.equal(legacy.status, 400, `不带 hostId 必须 400，实得 ${legacy.status}`)
    assert.equal(legacy.body.error, 'host_id_required')
    assert.equal(legacy.body.token, undefined, '被拒的请求不许回一枚可用的令牌')
    // 反证：按 hostId 的那枚**完全不受影响**（拒掉的那次没动任何槽位）
    assert.equal(
      (await sayHello(wsUrl, 'host-aaa', before.body.token)).t,
      'hello-ok',
      '被拒的认领动了别人的令牌 ⇒ 拒绝路径本身在改状态',
    )
  } finally {
    await relay.close()
  }
})

test('②b 空字符串 / 非字符串 / 坏 JSON 的 hostId 也一律 400（没有"宽松兼容"这条退路）', async () => {
  const { relay, base } = await startRelay()
  try {
    for (const body of ['{"hostId":""}', '{"hostId":42}', '{nope', '[1,2,3]']) {
      const res = await fetch(`${base}/api/claim-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      assert.equal(res.status, 400, `体 ${body} 该被拒，实得 ${res.status}`)
      const answer = await res.json()
      assert.ok(
        typeof answer.error === 'string' && answer.error.length > 0,
        '要给出错误码（排错时"为什么没领到"全靠它）',
      )
    }
  } finally {
    await relay.close()
  }
})

// ── ③ env 那枚永不参与轮换（"陌生人 POST 一次就能踢掉合法主机"这条没了）──

test('③ env 里的 DRC_HOST_TOKEN 认领多少次都还在（它就是运维的兜底凭据）', async () => {
  const { relay, base, wsUrl } = await startRelay()
  try {
    for (const hostId of ['host-aaa', 'host-bbb', 'host-aaa', 'host-ccc']) {
      const res = await claim(base, hostId)
      assert.equal(res.status, 200, `认领失败：${res.status}`)
      assert.notEqual(res.body.token, ENV_TOKEN, '签出来的必须是一枚新的，不能把 env 那枚发出去')
    }
    assert.equal((await sayHello(wsUrl, 'host-env', ENV_TOKEN)).t, 'hello-ok', 'env 那枚被认领轮换掉了 ⇒ 运维兜底没了')
  } finally {
    await relay.close()
  }
})

// ── ④ 令牌跨重启还在（中继重启不再把主机搁死）────────────────────────────

test('④ 落盘：中继重启后按 hostId 的那枚仍然能连上（旧模型下重启会回到 env 那枚）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-host-tokens-'))
  const stateFile = path.join(dir, 'state.json')
  let first = await startRelay({ DRC_STATE_FILE: stateFile })
  let token
  try {
    const res = await claim(first.base, 'host-persist')
    token = res.body.token
    assert.equal((await sayHello(first.wsUrl, 'host-persist', token)).t, 'hello-ok')
  } finally {
    await first.relay.close()
  }
  // 换一个进程（同一个状态文件）：令牌必须还在
  const second = await startRelay({ DRC_STATE_FILE: stateFile })
  try {
    assert.equal(
      (await sayHello(second.wsUrl, 'host-persist', token)).t,
      'hello-ok',
      '重启后那枚失效了 ⇒ 主机侧"有 token 就不再认领"会让它永久连不上',
    )
    // 反证：没领过的 hostId 拿同一枚令牌必须被拒（不是"表里随便查都过"）
    assert.equal((await sayHello(second.wsUrl, 'host-other', token)).t, 'error', '按 hostId 查这件事在重启后也得成立')
  } finally {
    await second.relay.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── ⑤ 有界：先丢没用过的占位条目，用过的一枚永远留住 ─────────────────────

test('⑤ 令牌表有界：超限时先丢"签了没人用"的，用过的那枚必须留住', async () => {
  const { relay, base, wsUrl } = await startRelay({ DRC_MAX_HOST_TOKENS: '2' })
  try {
    const used = await claim(base, 'host-used')
    // ⚠️ 必须真的用一次：`lastUsedAt` 只有成功鉴权才打点，而裁剪顺序按它分档。
    assert.equal((await sayHello(wsUrl, 'host-used', used.body.token)).t, 'hello-ok')
    const placeholder1 = await claim(base, 'host-p1')
    const placeholder2 = await claim(base, 'host-p2')
    // 上限 2：签了第 3 枚时该丢的是"最早那个没用过的占位条目"
    assert.equal(
      (await sayHello(wsUrl, 'host-used', used.body.token)).t,
      'hello-ok',
      '用过的那枚被裁掉了 ⇒ 表现是"用得好好的主机突然永久连不上"',
    )
    // 刚认领的那台必须能用（不然令牌表一边签一边丢，认领等于没领）
    assert.equal((await sayHello(wsUrl, 'host-p2', placeholder2.body.token)).t, 'hello-ok', '最新签的那枚必须还在')
    // 被丢掉的占位条目确实连不上了（证明裁剪真的发生了，而不是"上限没生效"）
    assert.equal(
      (await sayHello(wsUrl, 'host-p1', placeholder1.body.token)).t,
      'error',
      'DRC_MAX_HOST_TOKENS 没生效 ⇒ 这条判据在验一个不存在的边界',
    )
  } finally {
    await relay.close()
  }
})

// ── ⑥ 门口的形状校验 + 观测面不泄露凭据 ────────────────────────────────

test('⑥ hostId 形状不合法 ⇒ 400（不签、也不落盘）', async () => {
  const { relay, base } = await startRelay()
  try {
    for (const bad of ['has space', 'a'.repeat(201), 'quote"inside', 'semi;colon']) {
      const res = await claim(base, bad)
      assert.equal(res.status, 400, `hostId=${JSON.stringify(bad)} 该被拒`)
      assert.equal(res.body.error, 'bad_host_id')
    }
    // 反证：合法形状（含 . _ : -）必须能过 —— 别把正常主机名误伤
    assert.equal((await claim(base, 'drc-748e9a9ce167')).status, 200)
    assert.equal((await claim(base, 'my_host:1.2')).status, 200)
  } finally {
    await relay.close()
  }
})

test('⑥b /healthz 只报令牌**条数**，绝不泄露任何一枚令牌', async () => {
  const { relay, base } = await startRelay()
  try {
    const a = await claim(base, 'host-aaa')
    const b = await claim(base, 'host-bbb')
    const text = await (await fetch(`${base}/healthz`)).text()
    const health = JSON.parse(text)
    assert.equal(health.hostTokens, 2, `令牌条数不对：${health.hostTokens}`)
    assert.ok(!text.includes(a.body.token), '/healthz 里出现了令牌本身')
    assert.ok(!text.includes(b.body.token), '/healthz 里出现了令牌本身')
    assert.ok(!text.includes(ENV_TOKEN), '/healthz 里出现了 env 那枚')
  } finally {
    await relay.close()
  }
})
