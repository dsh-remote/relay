/**
 * 加固与运维行为测试：全部在**真实子进程**里跑。
 *
 * 为什么这些不起在进程内：限流断开、maxPayload 的 1009、SIGTERM 的退出码、
 * 日志落在 stdout 上的样子——都是只有"另一个进程"才能证明的事实。
 *
 * 端口用 `DRC_PORT=0` 让系统分配，再从启动日志里读回真实端口：
 * 不猜端口、不撞端口，也不依赖本机有空闲的固定端口。
 */
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'

const TOKEN = 'hardening-test-token-0123456789abcdef'
const MAIN = fileURLToPath(new URL('../dist/src/main.js', import.meta.url))

/** 启动中继子进程，等到它把真实端口写进启动日志。 */
async function boot(env = {}) {
  const lines = []
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      DRC_HOST_TOKEN: TOKEN,
      DRC_PORT: '0',
      DRC_BIND: '127.0.0.1',
      DRC_LOG_LEVEL: 'info',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let resolvePort
  const portReady = new Promise((resolve, reject) => {
    resolvePort = resolve
    child.on('exit', (code) => reject(new Error(`中继提前退出，code=${String(code)}；日志：${lines.join('\n')}`)))
  })
  const onData = (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      lines.push(line)
      try {
        const record = JSON.parse(line)
        if (record.msg === 'relay listening') resolvePort(record.port)
      } catch {
        /* 非 JSON 行（例如 node 的 fatal 栈）留给退出码断言用 */
      }
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const port = await portReady
  return {
    child,
    port,
    lines,
    url: `ws://127.0.0.1:${port}`,
    text: () => lines.join('\n'),
    async kill() {
      if (child.exitCode === null) child.kill('SIGKILL')
      await sleep(50)
    },
  }
}

function connect(url) {
  const ws = new WebSocket(url)
  const frames = []
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
  const closed = new Promise((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  )
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  return { ws, frames, closed, opened, send: (f) => ws.send(JSON.stringify(f)) }
}

async function waitFor(peer, match, timeoutMs = 3000) {
  const at = Date.now()
  for (;;) {
    const hit = peer.frames.find(match)
    if (hit) return hit
    if (Date.now() - at > timeoutMs)
      throw new Error(`等不到匹配帧；已收到 ${JSON.stringify(peer.frames).slice(0, 300)}`)
    await sleep(20)
  }
}

async function waitFrames(peer, count, timeoutMs = 3000) {
  const at = Date.now()
  while (peer.frames.length < count) {
    if (Date.now() - at > timeoutMs) throw new Error(`只收到 ${peer.frames.length}/${count} 帧`)
    await sleep(20)
  }
  return peer.frames
}

test('没有 DRC_HOST_TOKEN 就拒绝启动（CI 里也守这条）', async () => {
  const env = { ...process.env }
  delete env.DRC_HOST_TOKEN
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c.toString()))
  const code = await new Promise((resolve) => child.on('exit', resolve))
  assert.notEqual(code, 0)
  assert.match(stderr, /DRC_HOST_TOKEN/, '报错必须说清楚缺哪个变量')
})

test('坏配置直接失败：端口越界与未知日志级别', async () => {
  for (const env of [{ DRC_PORT: '70000' }, { DRC_LOG_LEVEL: 'verbose' }]) {
    const child = spawn(process.execPath, [MAIN], {
      env: { ...process.env, DRC_HOST_TOKEN: TOKEN, DRC_PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c) => (out += c.toString()))
    child.stderr.on('data', (c) => (out += c.toString()))
    const code = await new Promise((resolve) => child.on('exit', resolve))
    assert.notEqual(code, 0, JSON.stringify(env))
    assert.match(out, /DRC_|必须是/, JSON.stringify(env))
  }
})

test('SIGTERM：对端收到 1001，进程 exit 0（systemd 的 TimeoutStopSec 依赖这个语义）', async () => {
  const server = await boot()
  try {
    const peer = connect(server.url)
    await peer.opened
    peer.send({ t: 'hello', role: 'client', clientId: 'term-1' })
    await waitFrames(peer, 1)
    const closed = peer.closed
    server.child.kill('SIGTERM')
    const verdict = await closed
    assert.equal(verdict.code, 1001)
    const code = await new Promise((resolve) => server.child.on('exit', resolve))
    assert.equal(code, 0)
    assert.match(server.text(), /"msg":"shutting down"/)
  } finally {
    await server.kill()
  }
})

test('超大帧被 1009 切断（这是"流式输出说到一半就重连"的根因，不能调小上限）', async () => {
  const server = await boot({ DRC_MAX_MSG_BYTES: '4096' })
  try {
    const peer = connect(server.url)
    await peer.opened
    peer.send({ t: 'hello', role: 'client', clientId: 'big-1' })
    await waitFrames(peer, 1)
    peer.ws.send(JSON.stringify({ t: 'ping', ts: 'x'.repeat(9000) }))
    const verdict = await peer.closed
    assert.equal(verdict.code, 1009)
  } finally {
    await server.kill()
  }
})

test('帧洪泛：先回一次 rate_limited，持续违规则 1008 断开', async () => {
  const server = await boot({ DRC_MAX_FRAMES_PER_SEC: '20' })
  try {
    const peer = connect(server.url)
    await peer.opened
    peer.send({ t: 'hello', role: 'client', clientId: 'flood-1' })
    await waitFrames(peer, 1)
    for (let i = 0; i < 400; i++) peer.send({ t: 'ping', ts: i })
    const verdict = await peer.closed
    assert.equal(verdict.code, 1008)
    const reported = peer.frames.filter((f) => f.t === 'error' && f.code === 'rate_limited')
    assert.ok(reported.length >= 1, '必须至少告诉客户端一次为什么被限流')
    assert.ok(reported.length < 20, `限流提示不能变成错误洪水（实际 ${reported.length} 条）`)
    // 规范 §12.2 E2：限流要带 `retryAfterMs`（端点据此退避，而不是盲退）。
    // 帧闸是固定 1 秒窗口，所以这个数落在 (0, 1000]。
    for (const frame of reported) {
      assert.equal(Number.isInteger(frame.retryAfterMs), true, `retryAfterMs 必须是正整数，收到 ${frame.retryAfterMs}`)
      assert.ok(
        frame.retryAfterMs > 0 && frame.retryAfterMs <= 1000,
        `retryAfterMs 超出 1 秒窗口：${frame.retryAfterMs}`,
      )
    }
  } finally {
    await server.kill()
  }
})

test('配对爆破：单连接用尽尝试次数后 4008 断开', async () => {
  const server = await boot({ DRC_PAIR_ATTEMPTS_PER_CONN: '3' })
  try {
    const peer = connect(server.url)
    await peer.opened
    peer.send({ t: 'hello', role: 'client', clientId: 'brute-1' })
    await waitFrames(peer, 1)
    for (let i = 0; i < 6; i++) peer.send({ t: 'pair-begin-client', pairingToken: String(100000 + i) })
    const verdict = await peer.closed
    assert.equal(verdict.code, 4008)
    const fails = peer.frames.filter((f) => f.t === 'pair-fail')
    assert.ok(fails.length >= 3 && fails.length <= 3, `每次尝试一次 pair-fail，得到 ${fails.length} 条`)
  } finally {
    await server.kill()
  }
})

test('全局配对配额：超预算必须被拒，但落到线上的 reason 必须是小程序能翻译的那四个（F6）', async () => {
  const server = await boot({ DRC_PAIR_GLOBAL_PER_SEC: '2', DRC_PAIR_ATTEMPTS_PER_CONN: '100' })
  try {
    const peer = connect(server.url)
    await peer.opened
    peer.send({ t: 'hello', role: 'client', clientId: 'quota-1' })
    await waitFrames(peer, 1)
    for (let i = 0; i < 12; i++) peer.send({ t: 'pair-begin-client', pairingToken: String(200000 + i) })
    const frames = await waitFrames(peer, 12)
    const failed = frames.filter((f) => f.t === 'pair-fail')
    assert.ok(failed.length >= 5, `超预算的请求必须被拒（实际拒了 ${failed.length} 条）`)
    // 小程序 `translatePairFail` 只认这四个键；发别的（例如内部的 rate_limited）
    // 就等于把英文字面量弹到用户脸上——这条曾经真的发生过。
    const TRANSLATABLE = ['invalid_or_expired', 'already_used', 'host_offline', 'bad_token']
    for (const frame of failed) {
      assert.ok(TRANSLATABLE.includes(frame.reason), `pair-fail 带了小程序翻译不了的 reason：${String(frame.reason)}`)
    }
    // 真实原因不能丢：限速发生在服务端，运维必须在日志里看得见。
    const logText = server.text()
    assert.match(logText, /pair budget exhausted/, '配额用尽没进日志：运维只能看到一个"码无效"的假象')
    assert.match(logText, /rate_limited/, '日志里要写着真正的原因是 rate_limited')
  } finally {
    await server.kill()
  }
})

test('主机鉴权爆破：用尽 4001 断开', async () => {
  const server = await boot({ DRC_HOST_AUTH_MAX_ATTEMPTS: '2' })
  try {
    const peer = connect(server.url)
    await peer.opened
    peer.send({ t: 'hello', role: 'host', token: 'nope-nope-nope-nope-0000000001' })
    peer.send({ t: 'hello', role: 'host', token: 'nope-nope-nope-nope-0000000002' })
    const verdict = await peer.closed
    assert.equal(verdict.code, 4001)
  } finally {
    await server.kill()
  }
})

test('连接数上限：第 maxConnections 条仍被接受，第 maxConnections+1 条才 1013（off-by-one）', async () => {
  // 旧写法 `wss.clients.size + 1 > max` 把**新连接算了两次**（ws 在回调前就已经
  // clients.add），于是 DRC_MAX_CONNS=3 实际只收 2 条——只断言"至少一个被拒"
  // 的测试永远发现不了它。这条钉死精确边界。
  const server = await boot({ DRC_MAX_CONNS: '3' })
  try {
    const kept = []
    for (let i = 0; i < 3; i++) {
      const peer = connect(server.url)
      await peer.opened
      peer.send({ t: 'hello', role: 'client', clientId: `cap-${i}` })
      await waitFrames(peer, 1)
      kept.push(peer)
    }
    for (const [i, peer] of kept.entries()) {
      assert.equal(peer.frames[0]?.t, 'hello-ok', `第 ${i + 1} 条连接被拒了：上限被 off-by-one 少算了一条`)
    }

    const extra = connect(server.url)
    await extra.opened.catch(() => {})
    const verdict = await Promise.race([extra.closed, sleep(1500).then(() => null)])
    assert.ok(verdict, '第 maxConnections+1 条必须被拒')
    assert.equal(verdict.code, 1013)

    // 先建立的三条必须都还在（拒绝新连接不该顺手拆掉旧连接）。
    for (const peer of kept) {
      peer.send({ t: 'ping', ts: 1 })
      const frames = await waitFrames(peer, 2)
      assert.ok(frames.some((f) => f.t === 'pong'))
    }
    assert.equal((await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json()).clients, 3)
  } finally {
    await server.kill()
  }
})

/**
 * 发一条**原样**的 HTTP 请求（不走 fetch：Host 头是 fetch 不让我们随便写的），
 * 返回服务端回的全部字节。socket 关掉/超时都算结束——判据是"进程还活着"，
 * 不是"回了什么"。
 */
function rawHttp(port, request, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const chunks = []
    const socket = net.connect(port, '127.0.0.1')
    const done = () => {
      socket.destroy()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    socket.on('error', done)
    socket.on('close', done)
    socket.setTimeout(timeoutMs, done)
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => chunks.push(chunk))
  })
}

/**
 * P0-1：一个未认证的畸形 `Host` 头就能让中继 exit 1（远程 DoS）。
 *
 * 实测（修复前）：`GET /healthz` + `Host: [` → 无响应、进程 exit 1、日志
 * `uncaught exception: Invalid URL`；`Host: x:99999`、absolute-form 同样崩。
 * 根因是 request listener 里同步抛的 `new URL(req.url, \`http://${req.headers.host}\`)`
 * ——Node 不兜底，异常冒到 main.ts 的 uncaughtException 分支 exit(1)。
 *
 * 修复后：URL 的 base 固定（不用客户端 Host）、整段 try/catch、clientError 兜底。
 * 判据就是"进程仍活着，且后续 /healthz 仍 200"。
 */
test('畸形 Host 头不许打挂进程（P0-1）：[ / x:99999 / absolute-form 之后仍能服务', async () => {
  const server = await boot()
  try {
    for (const raw of [
      'GET /healthz HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n',
      'GET /healthz HTTP/1.1\r\nHost: x:99999\r\nConnection: close\r\n\r\n',
      'GET http://[/healthz HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n',
      'GET /healthz HTTP/1.1\r\nHost: ]:not a host\r\nConnection: close\r\n\r\n',
    ]) {
      const reply = await rawHttp(server.port, raw)
      assert.ok(reply.length > 0, `畸形请求一个字节都没回：${JSON.stringify(raw)}`)
      assert.equal(server.child.exitCode, null, `畸形 Host 把中继打挂了：${JSON.stringify(raw)}`)
    }
    await sleep(100)
    assert.equal(server.child.exitCode, null, '中继进程已经不在了（uncaught exception → exit 1）')
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`).then((r) => r.json())
    assert.equal(health.ok, true, '挨了一串畸形请求之后 /healthz 必须照常 200')
    assert.ok(!/uncaught exception/.test(server.text()), '日志里出现了 uncaught exception：异常冒到进程了')
  } finally {
    await server.kill()
  }
})

test('超长自报字段不许放大日志：单行有界（P1-3）', async () => {
  const server = await boot({ DRC_LOG_LEVEL: 'info' })
  try {
    const peer = connect(server.url)
    await peer.opened
    // 400 KiB 的 clientMeta.platform。**协议侧 2026-10-06 起给了 max(128)**，
    // 于是这一帧在 schema 就被拒（unknown_frame）、根本进不到日志——
    // 这是比"截断后照登"更强的结果，所以判据跟着它走：
    // ① 没有任何一行被放大；② 这条连接**没有**被登记（没有 client online）。
    // 中继自己的值截断（256 字符）仍然保留：它是防御纵深——协议上限之外的字段
    // （错误文案、内部 id）也照样会被写进日志。
    peer.send({
      t: 'hello',
      role: 'client',
      clientId: 'big-meta',
      clientMeta: { platform: 'x'.repeat(400 * 1024) },
    })
    await waitFrames(peer, 1)
    await sleep(150)
    const longest = server.lines.reduce((max, line) => Math.max(max, Buffer.byteLength(line)), 0)
    assert.ok(longest <= 1024, `单行日志 ${longest} 字节：对端自报字段把日志放大了`)
    assert.equal(
      server.lines.some((line) => line.includes('client online')),
      false,
      '超大 clientMeta 的连接不该被登记：协议上限是第一道闸，它已经挡住了',
    )
    assert.equal(server.child.exitCode, null)

    // 合法但顶格的字段（platform/label 各 128、token 不带）仍要照常登记，
    // 且日志行有界——防的是"为了挡放大而把正常连接也挡了"。
    const ok = connect(server.url)
    await ok.opened
    ok.send({
      t: 'hello',
      role: 'client',
      clientId: 'max-meta',
      clientMeta: { platform: 'p'.repeat(128), label: 'l'.repeat(128) },
    })
    await waitFrames(ok, 1)
    await sleep(150)
    assert.ok(
      server.lines.some((line) => line.includes('client online') && line.includes('max-meta')),
      '顶格但合法的 clientMeta 必须照常登记',
    )
    const longest2 = server.lines.reduce((max, line) => Math.max(max, Buffer.byteLength(line)), 0)
    assert.ok(longest2 <= 1024, `顶格字段也要有界：实得 ${longest2}`)
    ok.ws.close()
  } finally {
    await server.kill()
  }
})

test('P2：/api/pair-status 开启后有限流（无认证的 10^6 空间判定 oracle）', async () => {
  const server = await boot({ DRC_PAIR_STATUS: '1', DRC_PAIR_STATUS_PER_SEC: '2' })
  try {
    const statuses = []
    for (let i = 0; i < 6; i++) {
      statuses.push((await fetch(`http://127.0.0.1:${server.port}/api/pair-status?token=12345${i}`)).status)
    }
    assert.equal(statuses[0], 200, '配额内的请求必须照常应答')
    assert.ok(statuses.includes(429), `超配额的请求必须被拒（实际状态码：${statuses.join(',')}）`)
    assert.match(server.text(), /pair-status budget exhausted/, '限流必须留痕：否则线上只看到一批"码不存在"')
    assert.match(server.text(), /rate_limited/, '日志里要写清真正的原因是 rate_limited')
  } finally {
    await server.kill()
  }
})

test('待配对表有界：装满后新码得到 pair_table_full，而不是无界吃内存', async () => {
  const server = await boot({ DRC_MAX_PENDING_PAIRS: '3' })
  try {
    const host = connect(server.url)
    await host.opened
    host.send({ t: 'hello', role: 'host', token: TOKEN, hostId: 'bounded' })
    await waitFrames(host, 1)
    for (let i = 0; i < 3; i++) host.send({ t: 'pair-begin', pairingToken: String(300000 + i) })
    await waitFrames(host, 4)
    host.send({ t: 'pair-begin', pairingToken: '399999' })
    const frames = await waitFrames(host, 5)
    assert.ok(frames.some((f) => f.t === 'error' && f.code === 'pair_table_full'))
    assert.equal(host.frames.filter((f) => f.t === 'pair-ready').length, 3)
  } finally {
    await server.kill()
  }
})

test('D2 + 零知识：info 级日志里既没有载荷明文，也没有 6 位配对码', async () => {
  const server = await boot({ DRC_LOG_LEVEL: 'info' })
  try {
    const marker = '机密指令正文-绝不该出现在服务端'
    const host = connect(server.url)
    await host.opened
    host.send({ t: 'hello', role: 'host', token: TOKEN, hostId: 'zk1' })
    host.send({ t: 'pair-begin', pairingToken: '823913' })
    await waitFrames(host, 2)

    const client = connect(server.url)
    await client.opened
    client.send({
      t: 'hello',
      role: 'client',
      clientId: 'zkc',
      clientMeta: { platform: 'wechat-mp', label: '微信小程序' },
    })
    await waitFrames(client, 1)
    client.send({ t: 'pair-begin-client', pairingToken: '823913' })
    await waitFrames(client, 2)
    const paired = client.frames.find((f) => f.t === 'paired')

    // 走一遍真实数据面：上行命令 + 下行事件（都是密文）。
    client.send({
      t: 'enc',
      sessionId: paired.sessionId,
      seq: 1,
      clientId: 'zkc',
      ciphertext: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    })
    host.send({ t: 'enc', sessionId: paired.sessionId, ciphertext: Buffer.from(marker, 'utf8').toString('base64') })
    await waitFrames(client, 3)
    await sleep(150)

    const log = server.text()
    assert.ok(!log.includes(marker), '服务端日志里出现了载荷明文（哪怕是"看起来已加密"的 base64 原文）')
    assert.ok(!log.includes('机密指令'), '日志里不许出现任何业务明文')
    assert.ok(!log.includes('823913'), 'info 级日志不许出现完整配对码（D2）')
    assert.ok(log.includes('"token":"<redacted>"'), '配对码事件仍要可诊断，所以留一条脱敏记录')
    // 反向确认：明文被 base64 搬运这件事本身没被日志放大。
    assert.ok(!/[A-Za-z0-9+/]{60,}={0,2}/.test(log), '日志里不该出现长 base64 串（密文搬运）')
    // 结构化：每一行都是合法 JSON，运维才能直接 jq。
    for (const line of server.lines) {
      assert.doesNotThrow(() => JSON.parse(line), `日志行不是合法 JSON：${line.slice(0, 80)}`)
    }
  } finally {
    await server.kill()
  }
})

test('debug 级才允许出现配对码，且仍然不含载荷明文', async () => {
  const server = await boot({ DRC_LOG_LEVEL: 'debug' })
  try {
    const host = connect(server.url)
    await host.opened
    host.send({ t: 'hello', role: 'host', token: TOKEN, hostId: 'dbg1' })
    host.send({ t: 'pair-begin', pairingToken: '716253' })
    await waitFrames(host, 2)
    await sleep(100)
    assert.ok(server.text().includes('716253'), 'debug 级要能看到完整码，否则本地排错无从下手')
    assert.ok(!server.text().includes('ciphertext'), '即便 debug 也不许打印密文内容')
  } finally {
    await server.kill()
  }
})

test('同一 hostId 顶号：旧 socket 收到 4000，会话与已配对的客户端不受影响', async () => {
  const server = await boot()
  try {
    const hostA = connect(server.url)
    await hostA.opened
    hostA.send({ t: 'hello', role: 'host', token: TOKEN, hostId: 'same' })
    await waitFrames(hostA, 1)
    hostA.send({ t: 'pair-begin', pairingToken: '500100' })
    await waitFrames(hostA, 2)
    const client = connect(server.url)
    await client.opened
    client.send({ t: 'hello', role: 'client', clientId: 'survivor' })
    await waitFrames(client, 1)
    client.send({ t: 'pair-begin-client', pairingToken: '500100' })
    await waitFrames(client, 2)
    const paired = client.frames.find((f) => f.t === 'paired')

    const hostB = connect(server.url)
    await hostB.opened
    hostB.send({ t: 'hello', role: 'host', token: TOKEN, hostId: 'same' })
    const replaced = await hostA.closed
    assert.equal(replaced.code, 4000)
    await waitFrames(hostB, 1)
    // 顶号之后下行必须能从新 socket 走（旧 socket 的 close 不许把会话删掉）。
    hostB.send({ t: 'enc', sessionId: paired.sessionId, ciphertext: 'AAECAwQFBgcICQoLDA0ODw==' })
    // 等"这一帧"，不等"第 N 帧"：帧数会随中继"顺手还推了什么"浮动，用帧数当等待条件
    // 会假红（上一版测试就是这么假红的）。2026-10-06 起主机重连不再向客户端重放
    // peer-joined（mp 客户端没有那条分支），等待写法不变，判据仍落在"这一帧到了没有"。
    const down = await waitFor(client, (f) => f.t === 'enc' && f.sessionId === paired.sessionId)
    assert.equal(down.ciphertext, 'AAECAwQFBgcICQoLDA0ODw==')
  } finally {
    await server.kill()
  }
})

/**
 * 计数器快照必须**进日志**，不是只有 `/healthz`。
 *
 * 判据的来源是一条真实查不下去的账：`droppedFrames` 这类是"自启动累计"，进程一换就归零，
 * 而中继又不为每一次丢帧写日志（那是刷屏），于是"昨天那段时间丢了多少"以前问不出来
 * （伞仓 HANDOFF §3.3）。这一条钉的就是"它从此在 journalctl 里可查"。
 * 字段必须与 `/healthz` 同源（复用 `health()`）——两边各列一遍迟早分叉。
 */
test('计数器按 countersLogMs 抄进日志：累计值从此有历史，且与 /healthz 同一组字段', async () => {
  // 清扫 50ms 一轮、快照 400ms 一条，跑 1.2s：**不节流**的话这里会有二十来条。
  const server = await boot({ DRC_SWEEP_MS: '50', DRC_COUNTERS_LOG_MS: '400' })
  try {
    await sleep(1200)
    const snaps = server.lines.map((line) => JSON.parse(line)).filter((r) => r.msg === 'counters')
    assert.ok(snaps.length >= 2, `400ms 一抄的周期在 1.2s 里至少该出两条，实际 ${snaps.length} 条`)
    assert.ok(
      snaps.length <= 6,
      `一个周期抄出 ${snaps.length} 条：节流没生效（清扫周期是 50ms，不节流就是二十来条），日志会被它刷满`,
    )
    for (const key of [
      'ok',
      'version',
      'uptimeSec',
      'hosts',
      'clients',
      'conversations',
      'pendingPairs',
      'droppedFrames',
      'slowConsumers',
      'rejectedPairs',
      'lastPingAgo',
      'shuttingDown',
    ]) {
      assert.ok(key in snaps[0], `快照里少了 ${key}：这一行必须能顶替当时没人 curl 的 /healthz`)
    }
    // 累计值只许不减（它减了就是"抄错了对象"或者进程被换过）。
    for (const key of ['droppedFrames', 'slowConsumers', 'rejectedPairs', 'uptimeSec']) {
      for (let i = 1; i < snaps.length; i++) {
        assert.ok(snaps[i][key] >= snaps[i - 1][key], `${key} 在两条快照之间变小了：累计计数不许倒退`)
      }
    }
    // 这一行会长期留在服务器日志里，所以它一个字都不许带上凭据。
    const dumped = JSON.stringify(snaps)
    assert.equal(/hostToken|"token"|psk|secret/i.test(dumped), false, '计数器快照里出现了凭据形态的字段')
  } finally {
    await server.kill()
  }
})

test('默认上限 1MB：图片附件那一跳的余量（wire 1.3.0 起一条 prompt 可带 4 张 jpeg）', async () => {
  const server = await boot() // 不带 env = 吃默认值
  try {
    const peer = connect(server.url)
    await peer.opened
    peer.send({ t: 'hello', role: 'client', clientId: 'big-2' })
    await waitFrames(peer, 1)
    // 900KB：一张压过的 jpeg（base64 之后）完全放得下——不许切
    peer.ws.send(JSON.stringify({ t: 'ping', ts: 'x'.repeat(900 * 1024) }))
    const survived = await Promise.race([
      peer.closed.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('open'), 400)),
    ])
    assert.equal(survived, 'open', '900KB 的帧被切了：默认上限不是 1MB，或者被别的原因调小了')
    // 1.2MB：超过默认上限，照旧 1009
    peer.ws.send(JSON.stringify({ t: 'ping', ts: 'x'.repeat(1200 * 1024) }))
    const verdict = await peer.closed
    assert.equal(verdict.code, 1009)
  } finally {
    await server.kill()
  }
})
