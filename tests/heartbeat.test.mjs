/**
 * heartbeat — 保活 ping 的**分桶轮转**语义（C1）。
 *
 * 这个文件存在的理由：把心跳从"每 sweep 全表 ping"改成"每 tick 只 ping 一桶"之后，
 * 全仓 74 条测试**一条都不会红**——因为原来没有任何一条测试锁过心跳节奏。
 * 那正是这类改动最危险的形状：省下的带宽是真的，退化的判活也是真的，而沉默的只有测试。
 *
 * 四条断言各自锁住一个方向：
 * 1. **总量**按 `pingIntervalMs` 走，不是按 `sweepMs`（否则等于没拆）；
 * 2. 突发被**打散**：同一个 tick 窗口里的 ping 数远小于连接总数（否则只是把 96 ms 的
 *    阻塞换个时间发生）；
 * 3. **表清扫仍按 `sweepMs`**：配对码不会因为心跳周期变长而多活一个心跳周期——
 *    这条是 C1 的红线，把 `DRC_SWEEP_MS` 一起调大就会让它红；
 * 4. 半开对端**仍会被回收**，并把回收代价（约两个心跳周期）明写在断言里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import crypto from 'node:crypto'
import WebSocket from 'ws'
import { createRelay } from '../dist/src/server.js'
import { loadConfig } from '../dist/src/config.js'

/** 一眼假的 token；测试里绝不用真实凭据。 */
const TOKEN = 'unit-test-host-token-0123456789abcdef'

async function startRelay(overrides = {}) {
  const env = {
    ...process.env,
    DRC_HOST_TOKEN: TOKEN,
    DRC_PORT: '0',
    DRC_BIND: '127.0.0.1',
    DRC_LOG_LEVEL: 'silent',
    ...overrides,
  }
  const { config, problems } = loadConfig(env, 'test')
  assert.equal(problems.filter((p) => p.level === 'error').length, 0, '测试配置不合法')
  const relay = createRelay(config)
  const { port } = await relay.startListening()
  return { relay, port, config, url: `ws://127.0.0.1:${port}` }
}

/**
 * 连上一条"会回 pong"的正常客户端（`ws` 库按 RFC 自动回 pong），
 * 把它收到每一个 WS ping 的**时刻**记下来。
 */
async function pingingClient(url, id) {
  const ws = new WebSocket(url)
  const stamps = []
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.on('ping', () => stamps.push(Date.now()))
  ws.send(JSON.stringify({ t: 'hello', role: 'client', clientId: id, protocol: 1 }))
  return { ws, stamps }
}

test('分桶后 ping 的总量按 pingIntervalMs 走，不按 sweepMs', async () => {
  const tick = 40
  const interval = 400
  const sweepMs = 50
  const N = 30
  const { relay, url } = await startRelay({
    DRC_SWEEP_MS: String(sweepMs),
    DRC_PING_TICK_MS: String(tick),
    DRC_PING_INTERVAL_MS: String(interval),
  })
  const clients = []
  try {
    for (let i = 0; i < N; i += 1) clients.push(await pingingClient(url, `hb-a-${i}`))
    const started = Date.now()
    const windowMs = 1700
    await sleep(windowMs)
    const elapsed = Date.now() - started

    const total = clients.reduce((acc, c) => acc + c.stamps.length, 0)
    // 期望：每条连接约 elapsed/interval 次。
    const expected = (N * elapsed) / interval
    // 没拆桶会是多少：每 tick 全表 → ×(interval/tick)=10 倍；每 sweep 全表 → ×8 倍。
    // 所以这道带（0.5–1.9 倍期望）足够把两种"没改对"都判红。
    assert.ok(
      total >= expected * 0.5 && total <= expected * 1.9,
      `ping 总量 ${total} 不在期望 ${Math.round(expected)} 的带内（没拆桶会到 ${Math.round(expected * 8)}~${Math.round(expected * 10)}）`,
    )

    // 同一条连接相邻两次 ping 的下界：必须远大于 sweepMs，否则"表清扫"和"心跳"又粘回去了。
    const gaps = []
    for (const c of clients) for (let i = 1; i < c.stamps.length; i += 1) gaps.push(c.stamps[i] - c.stamps[i - 1])
    if (gaps.length > 0) {
      const minGap = Math.min(...gaps)
      assert.ok(minGap >= interval * 0.75, `有连接在 ${minGap}ms 内被 ping 了两次（周期应为 ${interval}ms）`)
    }
  } finally {
    for (const c of clients) c.ws.terminate()
    await relay.close()
  }
})

test('同一个 tick 窗口里的 ping 被打散，不是全表一起发', async () => {
  const tick = 40
  const interval = 480 // 12 个桶
  const N = 36
  const { relay, url } = await startRelay({
    DRC_SWEEP_MS: '50',
    DRC_PING_TICK_MS: String(tick),
    DRC_PING_INTERVAL_MS: String(interval),
  })
  const clients = []
  try {
    for (let i = 0; i < N; i += 1) clients.push(await pingingClient(url, `hb-b-${i}`))
    const started = Date.now()
    await sleep(1500)
    // 把所有 ping 时刻按 tick 分箱，看最挤的一箱装了多少。
    const bins = new Map()
    for (const c of clients) {
      for (const at of c.stamps) {
        const bin = Math.floor((at - started) / tick)
        bins.set(bin, (bins.get(bin) ?? 0) + 1)
      }
    }
    const busiest = Math.max(0, ...bins.values())
    // 均匀的话每箱约 N/桶数 = 3；给足调度抖动余量到 N/3。
    // 而"全表一起 ping"会让某一箱直接等于 N=36——这条断言就是为它准备的。
    assert.ok(
      busiest <= N / 3,
      `最挤的一个 tick 装了 ${busiest} 个 ping（连接数 ${N}，桶数 ${interval / tick}）：突发没被打散`,
    )
  } finally {
    for (const c of clients) c.ws.terminate()
    await relay.close()
  }
})

test('表清扫仍按 sweepMs 跑：配对码不会跟着心跳周期一起变长', async () => {
  // 心跳周期**故意**拉到远大于配对 TTL：这是最容易被做错的组合
  // （有人会把 DRC_SWEEP_MS 一起调大来"省 ping"，那等于把配对码的失效粒度也拉长到心跳）。
  const sweepMs = 50
  const pairTtl = 150
  const { relay, url, port } = await startRelay({
    DRC_SWEEP_MS: String(sweepMs),
    DRC_PING_TICK_MS: '100',
    DRC_PING_INTERVAL_MS: '5000',
    DRC_PAIR_TTL_MS: String(pairTtl),
  })
  const ws = new WebSocket(url)
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.send(JSON.stringify({ t: 'hello', role: 'host', token: TOKEN, hostId: 'hb-pair-host', protocol: 1 }))
    await new Promise((resolve) => ws.once('message', resolve))
    ws.send(JSON.stringify({ t: 'pair-begin', pairingToken: '246813' }))
    await sleep(60)
    assert.equal(relay.health().pendingPairs, 1, '配对码应该还在表里')

    const started = Date.now()
    // 等到 TTL 过 + 两轮清扫的余量；远小于心跳周期（5000ms），所以"被扫掉"只能归功于 sweepMs。
    while (relay.health().pendingPairs > 0 && Date.now() - started < pairTtl + 8 * sweepMs) {
      await sleep(20)
    }
    const aged = Date.now() - started
    assert.equal(relay.health().pendingPairs, 0, `配对码在 ${aged}ms 还没被清掉（sweepMs=${sweepMs}）`)
    assert.ok(aged < 1000, `清掉用了 ${aged}ms：表清扫被拖到了心跳尺度，红线破了（应接近 ${pairTtl}+几×${sweepMs}ms）`)
  } finally {
    ws.terminate()
    await relay.close()
  }
})

test('半开对端仍会被回收，代价是约两个心跳周期（C1 的明码标价）', async () => {
  const tick = 50
  const interval = 400
  const { relay, url, port } = await startRelay({
    DRC_SWEEP_MS: '50',
    DRC_PING_TICK_MS: String(tick),
    DRC_PING_INTERVAL_MS: String(interval),
  })
  try {
    const started = Date.now()
    const closedAt = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('error', reject)
      socket.once('connect', () => {
        // 只做到握手，之后**一个 pong 都不回**：这就是"没有 FIN/RST 的半开对端"。
        const key = crypto.randomBytes(16).toString('base64')
        socket.write(
          `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        )
      })
      // 收到的 ping 帧一律不看、不回（回 pong 是 `ws` 库替我们做的，这里刻意不用它）。
      socket.on('data', () => {})
      socket.once('close', () => resolve(Date.now() - started))
      socket.setTimeout(6000, () => socket.destroy(new Error('半开对端一直没被回收')))
    })
    // `alive` 是单轮标志（结构没动，只是换了节奏）：第一轮清标志并 ping，第二轮才发现没 pong。
    // 所以回收要**两个**心跳周期，这是拆桶的代价，写进断言里让它可见：
    // 谁把它改成一轮判活，或者把 interval 悄悄调大，这条都会红。
    assert.ok(
      closedAt >= interval && closedAt <= 3 * interval + 4 * tick,
      `半开对端在 ${closedAt}ms 被回收，不在 [${interval}, ${3 * interval + 4 * tick}]ms（2×pingInterval 的预期带）内`,
    )
  } finally {
    await relay.close()
  }
})
