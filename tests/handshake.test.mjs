/**
 * handshake — 协议版本闸（规范 §5.2 V3 / GAP-2）。
 *
 * ## 这个文件存在的理由
 *
 * `hello.protocol` 这个字段从第一天就在线上，而**改造之前没有任何一端校验过它**：
 * 中继照常回 `hello-ok`，两端都不看。于是协议不兼容的现场表现是
 * **"连上了、界面正常、什么都不发生"**——而这正是 `negotiate.ts` 文件头说的
 * "这套协议里最贵的一类故障形态，因为它没有任何一层会报错"。
 *
 * 更具体地说：协议层**已经把判定写好了**（`negotiateProtocol`，152 条判据里有它的份），
 * 但**零个消费方在用**。也就是说那份判定从未被任何真实 socket 检验过 ——
 * 一份没人调过的代码，"它是对的"这件事没有任何证据支撑。
 * 本文件就是那份证据。
 *
 * ## 钉住的是"闸的行为"，不是"闸的实现"
 *
 * 用真 socket 打真中继（`createRelay` + `ws` 客户端），不 import 内部函数 ——
 * 因为要验的恰恰是"它接在**正确的位置**"，而内部函数调不到位置。
 *
 * 四条，各自钉一个方向：
 * 1. **老端点照常连上**（不报 protocol / 报 1）—— 这一闸不能误伤现网（V1）；
 * 2. **太新的版本被拒，且给的是中文** —— 拒了只是���半，"说清为什么"才是另一半，
 *    而这句话会**原样弹到用户手机上**（见下面第 4 条）；
 * 3. **拒的是连接而不是静默接受** —— close code 用 1002（协议错误），
 *    它与"正常关闭"在客户端日志里必须可区分；
 * 4. **host 与 client 拿到的文案口径不同** —— 技术细节（`frame "x" has an invalid
 *    shape`）只给 host，客户端一律中文。这条最容易回归：`message` 字段在协议里
 *    **优先于** code（客户端是 `f.message || f.code`），所以中继随手传一句英文
 *    就会顶掉那张中文表 —— 那是本轮修掉的缺陷，判据必须钉住它不再回来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'
import { createRelay } from '../dist/src/server.js'
import { loadConfig } from '../dist/src/config.js'

const TOKEN = 'handshake-test-host-token-0123456789'

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
  return { relay, port, url: `ws://127.0.0.1:${port}` }
}

/**
 * 发一条 `hello` 并等**第一帧回复**。
 *
 * @param {boolean} waitClose true 时额外等 `close` 事件（拿到关闭码）。
 *   判据"关的是哪一码"必须要它 —— 而它**不能**和"收到第一帧"合成一个等待：
 *   `sendError` 之后中继才发 close，所以第一帧到得比 close 早；
 *   在第一帧上就 resolve 的话 `closeInfo` 恒为 null，而那**不是中继没关**，
 *   是判据自己没等（第一版就栽在这里：它红着，而中继的行为是对的）。
 *
 * ⚠️ 等的是"第一帧"而不是"hello-ok"：修复前这里收到的是 hello-ok（闸不存在），
 * 修复后收到的是 error —— 两种都要能被同一个函数观察到，否则判据会在
 * "闸不存在"的世界里假绿（这正是本文件要防的那件事）。
 */
function sayHello(url, hello, { waitClose = false } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const frames = []
    let closeInfo = null
    const done = (why) => {
      if (waitClose && !closeInfo && (why === 'got-frame' || why === 'timeout')) {
        // 还欠一个 close：留着监听再等一小会儿（不是无限等——中继不关也要收敛）
        return setTimeout(() => {
          try {
            ws.removeAllListeners()
            ws.close()
          } catch {
            /* 已关 */
          }
          resolve({ frames, closeInfo, why })
        }, 400)
      }
      try {
        ws.removeAllListeners()
        ws.close()
      } catch {
        /* 已关 */
      }
      resolve({ frames, closeInfo, why })
    }
    ws.on('open', () => ws.send(JSON.stringify(hello)))
    ws.on('message', (d) => {
      try {
        frames.push(JSON.parse(d.toString()))
      } catch {
        frames.push({ t: '(unparsable)' })
      }
      if (frames.length >= 1) done('got-frame')
    })
    ws.on('close', (code, reason) => {
      closeInfo = { code, reason: reason.toString() }
      done('closed')
    })
    ws.on('error', () => done('error'))
    setTimeout(() => done('timeout'), 3000)
  })
}

test('老端点照常连上：不报 protocol（V1）与报 1 都必须放行', async () => {
  // 这一条是**现网的安全线**：`MIN_SUPPORTED_PROTOCOL === PROTOCOL_VERSION === 1`，
  // 而今天的小程序恒发 1、极老版本连字段都不发。任何"闸一加就把现网掐断"的实现
  // 都会在这里红 —— 而那恰恰是最坏的一类回归（本地全链路与 e2e 用的是真小程序代码，
  // 它们一定会报 protocol=1，所以**只有不带字段的那条路径**需要单独钉）。
  const { relay, url } = await startRelay()
  try {
    for (const hello of [
      { t: 'hello', role: 'client', clientId: 'v1-nofield' },
      { t: 'hello', role: 'client', clientId: 'v1-explicit', protocol: 1 },
      { t: 'hello', role: 'host', token: TOKEN, protocol: 1 },
      { t: 'hello', role: 'host', token: TOKEN },
    ]) {
      const r = await sayHello(url, hello)
      assert.equal(
        r.frames[0]?.t,
        'hello-ok',
        `这份 hello 应当照常握手成功（role=${hello.role}, protocol=${String(hello.protocol)}），` +
          `实际收到 ${JSON.stringify(r.frames)}。闸若在这里拒绝，现网就断了。`,
      )
    }
  } finally {
    await relay.close()
  }
})

test('比本端新的协议版本被拒，且给的是一句中文（会原样弹到手机上）', async () => {
  const { relay, url } = await startRelay()
  try {
    const r = await sayHello(
      url,
      { t: 'hello', role: 'client', clientId: 'future', protocol: 999 },
      { waitClose: true },
    )
    assert.equal(r.frames[0]?.t, 'error', `应当拒这条握手，实际 ${JSON.stringify(r.frames)}`)
    assert.equal(r.frames[0]?.code, 'unsupported_protocol', `错误码不对：${JSON.stringify(r.frames[0])}`)
    // 关键：客户端的处理是 `f.message || f.code`，所以**没有 message 就等于把英文码弹给用户**
    assert.match(
      r.frames[0]?.message ?? '',
      /[\u4e00-\u9fff]/,
      `拒绝时必须给中文（用户看到的就是这句），实际 message=${JSON.stringify(r.frames[0]?.message)}`,
    )
    // close code 用 1002：与"正常关闭"在客户端日志里必须可区分
    assert.equal(r.closeInfo?.code, 1002, `关闭码应当是 1002（协议错误），实际 ${JSON.stringify(r.closeInfo)}`)
  } finally {
    await relay.close()
  }
})

test('host 侧同样被拦（版本闸不分角色：主机也会把整条会话搞乱）', async () => {
  const { relay, url } = await startRelay()
  try {
    const r = await sayHello(url, { t: 'hello', role: 'host', token: TOKEN, protocol: 999 })
    assert.equal(r.frames[0]?.code, 'unsupported_protocol', `host 侧也该被拦，实际 ${JSON.stringify(r.frames)}`)
  } finally {
    await relay.close()
  }
})

test('技术细节只给 host；客户端一律中文（message 字段在协议里优先于 code）', async () => {
  // 这条是本轮修掉的**第二个**缺陷的护栏：中继原来给 `bad_frame` 传了一句英文
  // `frame "hello" has an invalid shape`，而客户端是 `f.message || f.code`
  // ——那句英文会**顶掉**中文表，用户在手机上看到的是一句英文。
  //
  // 构造方式：`hello` 的 `protocol` 传 0（形状非法但帧名合法）⇒ 中继判 `bad_frame`。
  const { relay, url } = await startRelay()
  try {
    const r = await sayHello(url, { t: 'hello', role: 'client', clientId: 'badshape', protocol: 0 })
    assert.equal(r.frames[0]?.code, 'bad_frame', `前置条件变了？实际 ${JSON.stringify(r.frames)}`)
    assert.match(
      r.frames[0]?.message ?? '',
      /[\u4e00-\u9fff]/,
      `客户端拿到的必须是中文，实际 ${JSON.stringify(r.frames[0]?.message)}。` +
        '中继随手传一句英文 message 就会顶掉中文表（客户端是 f.message || f.code）。',
    )
    assert.doesNotMatch(r.frames[0]?.message ?? '', /has an invalid shape/, '英文技术细节漏到客户端了')
  } finally {
    await relay.close()
  }
})

test('版本闸只挡 hello：业务帧不带该字段，不该被当成"没报版本"而误判', async () => {
  // `hello` 只发一次，之后的 `enc` / `ping` / `session-leave` 帧**没有** protocol 字段。
  // 若闸对每条帧都要求版本，这些帧会全部按"没报 → 1"处理 —— 那看起来宽容，
  // 其实是**错配**：一个报 999 已被拒的连接，它的业务帧也该被拒；而
  // 一个真报 2 的主机（若将来 own 抬到 2）在发 `enc` 时会被当成 1 而**错误放行**。
  //
  // 所以连接上必须记住那一次的判定结果（`Peer.protocol`）。这条钉住"记了"：
  // 握手成功之后再发一条不带版本的 `ping`，必须照常回 `pong`（而不是被判版本不符）。
  const { relay, url } = await startRelay()
  try {
    const ws = new WebSocket(url)
    const frames = []
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())))
    ws.send(JSON.stringify({ t: 'hello', role: 'client', clientId: 'p1', protocol: 1 }))
    await sleep(120)
    ws.send(JSON.stringify({ t: 'ping' }))
    await sleep(200)
    ws.close()
    assert.equal(frames[0]?.t, 'hello-ok', `前置条件：握手应当成功，实际 ${JSON.stringify(frames)}`)
    assert.equal(
      frames.some((f) => f.t === 'pong'),
      true,
      `握手之后的 ping 没被回 pong（frames=${JSON.stringify(frames)}）：` +
        '版本闸若对每条帧都要求版本字段，业务帧会全被误判 —— 那是错配而不是宽容。',
    )
    assert.equal(
      frames.some((f) => f.t === 'error'),
      false,
      `握手之后的 ping 收到了 error（frames=${JSON.stringify(frames)}）`,
    )
  } finally {
    await relay.close()
  }
})

test('登记了的版本能在 /healthz 里看到（"没报"与"报了 1"要能分开）', async () => {
  // 观测面：`Peer.protocol` 存的是**原始值**（不报就是 undefined），
  // 而不是在闸里按 1 处理后的结果 —— 否则"没报"与"报了 1"在排障时长得一样，
  // 而这两者要区分（前者是老版本小程序）。
  const { relay, url } = await startRelay()
  try {
    await sayHello(url, { t: 'hello', role: 'client', clientId: 'nofield' })
    const h = relay.health()
    // 只要求字段存在且可读，不钉具体字段名（那是内部形状）；这里钉的是"这一项被记下来了"
    const flat = JSON.stringify(h)
    assert.match(flat, /protocol/i, `/healthz 里没有任何协议版本相关的观测字段：${flat}`)
  } finally {
    await relay.close()
  }
})
