/**
 * reliability.test — 2026-10-07 那一轮审计的判据。
 *
 * 每一条都对应一个**可复现的**故障，而不是一条风格偏好。审计由三个并行子代理逐行读完
 * src/ 得出，本文件把它们逐条钉住；写之前每一条都先在旧代码上跑红过。
 *
 * 1. **未认证可达的崩溃**（A 组）。EventEmitter 在没有 'error' 监听器时 emit('error')
 *    本身会同步抛，而 main.ts 的 uncaughtException 策略是 exit 1 → 被 systemd/docker
 *    拉起 → **内存里的配对表清零**，所有手机回到电脑前重扫。
 * 2. **日志洪水**（B 组）。journald 按**条数**限流不按字节，逐帧 warn 的代价不是
 *    「磁盘满」，是**中继自己的正常诊断被一起抑制**——排障现场变成空白。
 * 3. **静默失配**（C/D/E 组）：配置写了不生效、文档与实现不是一回事、坏数据不留痕。
 *
 * 判据形态刻意选**外部可观测的事实**（进程活不活、日志里有几行、文件里写了什么），
 * 而不是「源码里有没有某个字符串」——后者在变异验证时最容易自己骗自己。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'
import { createRelay } from '../dist/src/server.js'
import { loadConfig } from '../dist/src/config.js'
import { Log } from '../dist/src/log.js'
import { RelayState } from '../dist/src/state.js'
import { STATE_FILE_VERSION, restoreState, writeStateFile } from '../dist/src/persist.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN = join(ROOT, 'dist', 'src', 'main.js')
const TOKEN = 'reliability-host-token-0123456789ab'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'drc-reliability-'))
}
async function captureStdout(fn) {
  const lines = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => {
    lines.push(String(chunk))
    return true
  }
  try {
    await fn()
  } finally {
    process.stdout.write = original
  }
  return lines
}

function countLog(lines, msg) {
  return lines.filter((line) => {
    try {
      return JSON.parse(line).msg === msg
    } catch {
      return false
    }
  }).length
}

async function startRelay(env = {}) {
  const merged = {
    ...process.env,
    DRC_HOST_TOKEN: TOKEN,
    DRC_PORT: '0',
    DRC_BIND: '127.0.0.1',
    DRC_LOG_LEVEL: 'info',
    DRC_STATE_FILE: '',
    ...env,
  }
  const { config, problems } = loadConfig(merged, 'test')
  assert.equal(problems.filter((x) => x.level === 'error').length, 0, '测试配置里不该有 error')
  const relay = createRelay(config)
  const { port } = await relay.startListening()
  return { relay, port, url: `ws://127.0.0.1:${port}` }
}

function connect(url) {
  const ws = new WebSocket(url)
  ws.frames = []
  ws.on('message', (raw) => {
    try {
      ws.frames.push(JSON.parse(raw.toString()))
    } catch {
      ws.frames.push({ t: '__invalid__' })
    }
  })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

async function until(ws, match, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = ws.frames.find(match)
    if (hit) return hit
    await sleep(10)
  }
  throw new Error('没等到匹配的帧')
}

/** 起一个真进程：崩溃类判据只能在进程外看——崩了就没法再问它 healthz。 */
function spawnRelay(env = {}) {
  const child = spawn(process.execPath, [MAIN], {
    cwd: ROOT,
    env: {
      ...process.env,
      DRC_HOST_TOKEN: TOKEN,
      DRC_PORT: '0',
      DRC_BIND: '127.0.0.1',
      DRC_LOG_LEVEL: 'info',
      DRC_STATE_FILE: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  const collect = (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      lines.push(line)
      try {
        const record = JSON.parse(line)
        if (record.msg === 'relay listening') child.relayPort = record.port
      } catch {
        /* 非 JSON 行也算证据 */
      }
    }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.lines = lines
  return child
}

async function relayPort(child, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.relayPort) return child.relayPort
    if (child.exitCode !== null) {
      throw new Error('中继提前退出 code=' + String(child.exitCode) + '：' + child.lines.join('\n'))
    }
    await sleep(20)
  }
  throw new Error('没等到中继启动：' + child.lines.join('\n'))
}

// ── A 组：未认证可达的崩溃 ──────────────────────────────────────────────

test('A1：被拒的连接（超出 DRC_MAX_CONNS）再发畸形帧 —— 进程不崩', async () => {
  // 复现路径完全未认证：WS 握手不要任何凭据，只要把连接数顶满，第 N+1 条就走 rejectConnection。
  // 旧实现那条分支直接 close() 就 return，从未挂 error 监听器；于是对端随后发一帧超
  // maxPayload 的帧时，ws 内部的 emitErrorAndClose 会 emit('error')，
  // **没有监听器的 EventEmitter 在这里同步抛** → uncaughtException → exit 1。
  const child = spawnRelay({ DRC_MAX_CONNS: '1', DRC_MAX_MSG_BYTES: '2048' })
  const sockets = []
  try {
    const port = await relayPort(child)
    const url = `ws://127.0.0.1:${port}`
    sockets.push(await connect(url))
    const rejected = await connect(url)
    sockets.push(rejected)
    rejected.send('x'.repeat(16 * 1024))
    await sleep(400)
    assert.equal(child.exitCode, null, '中继被一帧畸形数据打死了：\n' + child.lines.join('\n'))
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json())
    assert.equal(health.ok, true, '进程活着就该继续应答 /healthz')
  } finally {
    for (const ws of sockets) ws.terminate()
    if (child.exitCode === null) child.kill('SIGTERM')
  }
})

test('A2：listen 之后 http server 再出 error —— 记一条 warn，不退出', async () => {
  // Node 的 net 层对**每次 accept 失败**（EMFILE/ENFILE/ENOBUFS）执行 server.emit('error')。
  // 而 startListening 里那个 once('error', reject) 在 listen 成功后就 off 掉了 ——
  // 于是此后 http server 上**没有任何 error 监听器**，同样的同步抛 → exit 1。
  // 这与 server.ts 头注释声称的「HTTP 侧的任何异常都不许冒到进程」直接矛盾。
  const ctx = await startRelay()
  try {
    const lines = await captureStdout(async () => {
      ctx.relay.http.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }))
      await sleep(50)
    })
    assert.ok(countLog(lines, 'http server error') >= 1, 'accept 失败必须留痕：' + lines.join(''))
    assert.equal(ctx.relay.health().ok, true)
  } finally {
    await ctx.relay.close()
  }
})

test('A3：停机中的 /healthz 回 503 而不是 200', async () => {
  // 任何只看状态码的观测面（Docker HEALTHCHECK、负载均衡器、curl --fail）都要能看出
  // 「这个实例正在关闭」，否则它会继续往一个不再接受 upgrade 的实例上送流量。
  // 旧实现无论 ok 是 true 还是 false 都回 200。
  const ctx = await startRelay()
  const { port } = ctx
  try {
    const before = await fetch(`http://127.0.0.1:${port}/healthz`)
    assert.equal(before.status, 200)
    await ctx.relay.close()
    // 监听已经关了，healthz 打不到了 —— 所以这里断言的是**代码路径**：
    // close() 之后 shuttingDown 为 true，而那正是 503 的条件。
    assert.equal(ctx.relay.health().ok, false, 'close() 之后 ok 必须是 false')
    assert.equal(ctx.relay.health().shuttingDown, true)
  } finally {
    await ctx.relay.close().catch(() => {})
  }
})

// ── B 组：日志洪水 ───────────────────────────────────────────────────────

test('B1：帧洪泛只记一行 frame flood disconnected', async () => {
  // 旧实现每被丢弃的帧记一行：实测单条**未认证**连接 1.1 秒写 299,498 行（约 33 MB）。
  // close 是优雅的，对端在这段窗口里继续灌帧，所以「第 3 次违规就断开」并不成立。
  const ctx = await startRelay({ DRC_MAX_FRAMES_PER_SEC: '2' })
  const sockets = []
  try {
    sockets.push(await connect(ctx.url))
    const lines = await captureStdout(async () => {
      for (let i = 0; i < 40; i += 1) sockets[0].send(JSON.stringify({ t: 'ping', ts: i }))
      await sleep(300)
    })
    const hits = countLog(lines, 'frame flood disconnected')
    assert.equal(hits, 1, '一条连接只该记一行，实际 ' + hits + ' 行：\n' + lines.join(''))
  } finally {
    for (const ws of sockets) ws.terminate()
    await ctx.relay.close()
  }
})

test('B2：全局配对配额用尽时每秒最多一行 warn', async () => {
  // 旧实现逐帧 warn：配额用尽的那一秒里单条连接能写约 480 行。出站那条 pair-fail
  // **刻意**保持逐帧——它是对端的功能性答复，对端要靠它停止重试；被限住的是**日志**。
  const ctx = await startRelay({ DRC_PAIR_GLOBAL_PER_SEC: '1' })
  const sockets = []
  try {
    const client = await connect(ctx.url)
    sockets.push(client)
    client.send(JSON.stringify({ t: 'hello', role: 'client', protocol: 1, clientId: 'flood-1' }))
    await until(client, (f) => f.t === 'hello-ok')
    const lines = await captureStdout(async () => {
      for (let i = 0; i < 50; i += 1) client.send(JSON.stringify({ t: 'pair-begin-client', pairingToken: '999999' }))
      await sleep(250)
    })
    const hits = countLog(lines, 'pair budget exhausted (global)')
    assert.ok(hits >= 1, '配额用尽必须留痕：' + lines.join(''))
    assert.ok(hits <= 2, '一秒内不该写 50 行，实际 ' + hits + ' 行')
  } finally {
    for (const ws of sockets) ws.terminate()
    await ctx.relay.close()
  }
})

// ── C 组：配置「写了不生效」那一族 ──────────────────────────────────────

function problemsFor(env) {
  const { config, problems } = loadConfig({ DRC_HOST_TOKEN: TOKEN, ...env }, 'test')
  return { config, problems }
}

test('C1：DRC_LOG_LEVEL 的原型链取值被拒（否则日志过滤整体失效）', () => {
  // `in` 会走原型链：toString / constructor / valueOf / __proto__ / hasOwnProperty
  // 这五个值全都「存在」→ 校验通过 → levelWeight 返回函数或对象 →
  // log.ts 里 `20 < NaN` 恒 false → **所有级别都打印**，包括带真实 6 位配对码的那条 debug。
  for (const value of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
    const { problems } = problemsFor({ DRC_LOG_LEVEL: value })
    assert.ok(
      problems.some((p) => p.level === 'error'),
      `DRC_LOG_LEVEL=${value} 被放行了：日志阈值会变成 NaN，debug 全开`,
    )
  }
  // 反过来：真正的枚举值一个都不能被误伤。
  for (const value of ['debug', 'info', 'warn', 'error', 'silent']) {
    const { problems } = problemsFor({ DRC_LOG_LEVEL: value })
    assert.equal(problems.length, 0, `DRC_LOG_LEVEL=${value} 不该有问题：${JSON.stringify(problems)}`)
  }
})

test('C2：数值变量写成空串 → 告警而不是静默用默认值', () => {
  // systemd EnvironmentFile 与 `docker run -e DRC_MAX_CONNS=` 都给得出空串。
  // 照文档「收紧到 60s」写下 DRC_PAIR_TTL_MS= 的人以为收紧了，实际跑的是 120000。
  const { problems } = problemsFor({ DRC_PAIR_TTL_MS: '' })
  const warn = problems.find((p) => p.level === 'warn' && p.message.includes('DRC_PAIR_TTL_MS'))
  assert.ok(warn, '空串必须告警并点名是哪个变量：' + JSON.stringify(problems))
  // 而 DRC_STATE_FILE 的空串是**文档化的关闭语义**，不能被这条规则误伤。
  const stateOff = problemsFor({ DRC_STATE_FILE: '' })
  assert.equal(stateOff.config.stateFile, '')
  assert.equal(stateOff.problems.filter((x) => x.message.includes('DRC_STATE_FILE')).length, 0)
})

test('C3：只认十进制整数字面量，且有上界', () => {
  // Number() 会接受 0x3c / 1e3 / +60 / ' 60 '，它们 Number.isInteger 全都 true。
  for (const value of ['0x3c', '1e3', '+60', '1e308', '-5']) {
    const { problems } = problemsFor({ DRC_MAX_CONNS: value })
    assert.ok(
      problems.some((p) => p.level === 'error'),
      `DRC_MAX_CONNS=${JSON.stringify(value)} 被放行了`,
    )
  }
  const ok = problemsFor({ DRC_MAX_CONNS: '200' })
  assert.equal(ok.config.maxConnections, 200)
})

test('C4：ping 分桶退化成 1 桶时告警（否则静默回到「每 tick 全表 ping」）', () => {
  const bad = problemsFor({ DRC_PING_INTERVAL_MS: '30000', DRC_PING_TICK_MS: '60000' })
  assert.ok(
    bad.problems.some((p) => p.level === 'warn' && p.message.includes('ping')),
    'tick 大到只分得出一个桶时必须告警：' + JSON.stringify(bad.problems),
  )
  const good = problemsFor({ DRC_PING_INTERVAL_MS: '60000', DRC_PING_TICK_MS: '1000' })
  assert.equal(good.problems.length, 0)
})

test('C5：时钟回拨不再把限流冻死', async () => {
  // Budget 用 Date.now()。墙钟往回跳 T 秒之后，`now - windowAt` 在 T 秒内都是负数、
  // 永远达不到 windowMs，而 left 又已归零 → 全局限流**冻死**：配对一路失败、
  // 每条连接的帧闸也冻死。一次 NTP 抖动就够，不需要任何人攻击。
  const { Budget } = await import('../dist/src/limits.js')
  const budget = new Budget(1, 1000)
  assert.equal(budget.take(10_000), true)
  assert.equal(budget.take(10_000), false, '配额用尽')
  // 回拨 60 秒：旧实现这里仍然是 false（冻死），现在应该立刻恢复。
  assert.equal(budget.take(9_940), true, '时钟回拨后配额应当恢复，而不是冻死')
})

// ── D 组：配对状态机的「文档说的 ≠ 做的」 ───────────────────────────────

function stateHarness(now = () => 1_000_000) {
  const state = new RelayState({ now, maxPendingPairs: 2 })
  const ws = { readyState: 1, send() {}, close() {} }
  state.attachHost('h1', ws, 'laptop')
  return { state, ws }
}

test('D1：已用过的配对码活到 TTL，而不是下一轮清扫', () => {
  // 旧写法 expirePairs 里是 `entry.used || entry.expiresAt < now`：用过就删，
  // 于是同一张码在 5 秒前后给出两句互斥的话——5 s 内重输 already_used，
  // 5 s 后再输 invalid_or_expired（手机文案「配对码无效或已过期」）。
  // 而文件头不变量第 3 条与 SELF-HOSTING.md §4 都写着「保留到 TTL」。
  let clock = 0
  const { state } = stateHarness(() => clock)
  state.issuePair('h1', '123456', 60_000)
  assert.equal(state.claim('123456', 'c1').ok, true)
  clock = 30_000
  assert.deepEqual(state.expirePairs(), [], '过了清扫周期也必须留着（TTL 还没到）')
  const replay = state.claim('123456', 'c2')
  assert.equal(replay.ok, false)
  assert.equal(replay.reason, 'already_used', '重放要得到 already_used，而不是 invalid_or_expired')
  clock = 60_001
  assert.deepEqual(state.expirePairs(), ['123456'], '过了 TTL 才清')
  assert.equal(state.claim('123456', 'c3').reason, 'invalid_or_expired')
})

test('D2：同码重发延长 TTL，但绝不复活一张用过的码', () => {
  const { state } = stateHarness()
  state.issuePair('h1', '123456', 60_000)
  assert.equal(state.claim('123456', 'c1').ok, true)
  const again = state.issuePair('h1', '123456', 60_000)
  assert.equal(again.ok, true)
  assert.equal(again.replaced, true)
  // 复活的后果是第二条会话与第一条**共用同一把 PSK**（peer-joined 帧带着它）。
  const replay = state.claim('123456', 'c2')
  assert.equal(replay.ok, false)
  assert.equal(replay.reason, 'already_used')
  assert.equal(state.conversations.size, 1, '不该开出第二条会话')
})

test('D3：token 归属别的主机时拒绝，而不是静默改写', () => {
  // 多主机共用一个 DRC_HOST_TOKEN 时（自托管的常见形态），hostB 完全可以发一个与 hostA
  // 此刻在途相同的 token 把条目改写成自己的 —— 于是「扫 A 屏幕上的码、配到 B」，
  // 用户与两边的主机都不会看到任何异常。6 位码随机碰撞概率极低，所以这不是一个
  // 「每天都会发生」的故障，而是**完全没有守卫**：修的是后者。
  const state = new RelayState({ now: () => 1_000_000 })
  state.attachHost('h1', { readyState: 1, send() {}, close() {} }, 'laptop')
  state.attachHost('h2', { readyState: 1, send() {}, close() {} }, 'desktop')
  state.issuePair('h1', '123456', 60_000)
  const issued = state.issuePair('h2', '123456', 60_000)
  assert.equal(issued.conflict, true, '跨主机同码必须判冲突')
  assert.equal(issued.ok, false)
  // 原来的归属没被改写：扫 h1 屏幕上的码仍然配到 h1。
  assert.equal(state.claim('123456', 'c1').hostId, 'h1')
})

test('D4：表容量数的是「还能认领的码」，墓碑不占坑', () => {
  // 墓碑现在活到 TTL（120 s 默认）。若把它们也算进 maxPendingPairs，
  // 全局 20/s 的配额能在两分钟内把默认 1000 的表塞满，正常配对开始回 pair_table_full。
  const { state } = stateHarness()
  state.issuePair('h1', '111111', 60_000)
  state.issuePair('h1', '222222', 60_000)
  assert.equal(state.claim('111111', 'c1').ok, true)
  assert.equal(state.countClaimablePairs(), 1)
  const third = state.issuePair('h1', '333333', 60_000)
  assert.equal(third.ok, true, '一张墓碑不该把新码挤掉：' + JSON.stringify(third))
  // 真正占坑的仍然是还能认领的码。
  state.issuePair('h1', '444444', 60_000)
  const fifth = state.issuePair('h1', '555555', 60_000)
  assert.equal(fifth.full, true, '两个还能认领的码已到上限')
})

test('D5：resync 报出「空会话计时可能没落盘」的条数', () => {
  // 调用方靠它决定要不要立刻落盘。注意它数的是「**此刻处于空会话状态**」而不是
  // 「这一帧新打上了计时」——后者会漏掉真正要紧的那种：restoreState 从盘上读回一个
  // 空的、盘上却没有 emptySince 的会话时只在内存里补了计时，盘上仍然空着，
  // 而那正是 HANDOFF 0.10.5 第 4 条要求立刻写盘的情形。
  const { state } = stateHarness()
  state.issuePair('h1', '111111', 60_000)
  const paired = state.claim('111111', 'c1')
  state.leave('c1', paired.conversationId)
  const r1 = state.resync('h1', [paired.conversationId])
  assert.equal(r1.kept, 1)
  assert.deepEqual(r1.dropped, [])
  assert.equal(r1.emptyAtRisk, 1, '成员表空着的那条要算进去')
  // 写盘由调用方限流（RESYNC_PERSIST_MIN_GAP_MS），这里只保证「重复 resync 不会把
  // 会话删掉或改出别的形状」。
  const r2 = state.resync('h1', [paired.conversationId])
  assert.equal(r2.kept, 1)
  assert.equal(r2.emptyAtRisk, 1)
})

function captureLog(level = 'debug') {
  const records = []
  const log = new Log(level, (line) => records.push(JSON.parse(line)))
  return { log, records }
}

function stateWith(conversations, now = 1_000_000) {
  const state = new RelayState({ now: () => now })
  for (const conv of conversations) {
    state.conversations.set(conv.conversationId, {
      hostId: conv.hostId ?? 'h1',
      clients: new Set(conv.clients ?? []),
      seqHost: conv.seqHost ?? 0,
      lastActivityAt: conv.lastActivityAt ?? now,
      ...(conv.emptySince === undefined ? {} : { emptySince: conv.emptySince }),
    })
  }
  return state
}

test('E1：状态文件里的重复 conversationId 只留一条，并计入 dropped', () => {
  // 旧实现两条都收进数组、restoreState 用 Map.set 覆盖，于是读盘日志说 2 条、
  // 恢复日志说 1 条，中间那条用户的会话**静默消失**（手机下次发帧拿到 unknown_session），
  // 而没有任何 dropped 计数指出这件事。
  const dir = tmpDir()
  try {
    const path = join(dir, 'state.json')
    const dup = { conversationId: 'c_0000000000aa', hostId: 'h1', clients: ['a'], seqHost: 0, lastActivityAt: 1 }
    writeFileSync(
      path,
      JSON.stringify({
        version: STATE_FILE_VERSION,
        savedAt: 1,
        conversations: [dup, { ...dup, clients: ['b'] }],
      }),
    )
    const { log, records } = captureLog()
    const state = stateWith([])
    const restored = restoreState(path, state, log, 1_000_000)
    assert.equal(restored, 1, '只该恢复一条')
    assert.deepEqual([...state.conversations.get('c_0000000000aa').clients], ['a'], '保留第一条')
    const dropped = records.find((r) => r.msg === 'state file entries dropped')
    assert.ok(dropped && dropped.dropped === 1, '重复项必须计入 dropped：' + JSON.stringify(records))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('E2：盘上来自「快时钟」的未来时间戳被夹到此刻', () => {
  // 两个消费端都是单边比较（sweepIdle / sweepEmpty），于是偏斜量 ≥ TTL 时那条会话
  // **永久不可回收**，而每 60 s 的周期补写又把它原样写回去——错误自我固化、永不自愈。
  const dir = tmpDir()
  try {
    const path = join(dir, 'state.json')
    const now = 2_000_000
    writeFileSync(
      path,
      JSON.stringify({
        version: STATE_FILE_VERSION,
        savedAt: now,
        conversations: [
          {
            conversationId: 'c_0000000000aa',
            hostId: 'h1',
            clients: [],
            seqHost: 0,
            lastActivityAt: now + 10 * 24 * 3600 * 1000,
            emptySince: now + 10 * 24 * 3600 * 1000,
          },
        ],
      }),
    )
    const { log, records } = captureLog()
    const state = stateWith([])
    restoreState(path, state, log, now)
    const conv = state.conversations.get('c_0000000000aa')
    assert.equal(conv.lastActivityAt, now, '未来时间戳必须夹到此刻')
    assert.equal(conv.emptySince, now)
    assert.ok(
      records.some((r) => r.msg === 'state file timestamps in the future, clamped to now'),
      '夹紧必须留痕——它说明这台机器的时钟与写盘那台不一致，是要去查的事',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('E3：写出来的状态文件仍然完整、可读、且没有残留临时文件', () => {
  // fsync 是在 writeFileSync/rename 之间加的（掉电时 rename 已落、内容还在 page cache
  // 会得到一个长度正确但全零的 state.json → 所有配对作废）。这条判据守住「加了 fsync
  // 之后写出来的仍然是好文件」——它是那处改动唯一能在这里验的面。
  const dir = tmpDir()
  try {
    const path = join(dir, 'state.json')
    const { log } = captureLog()
    const state = stateWith([{ conversationId: 'c_0000000000aa', clients: ['a'], lastActivityAt: 5 }])
    assert.equal(
      writeStateFile(
        path,
        {
          version: STATE_FILE_VERSION,
          savedAt: 5,
          conversations: [
            { conversationId: 'c_0000000000aa', hostId: 'h1', clients: ['a'], seqHost: 0, lastActivityAt: 5 },
          ],
        },
        log,
      ),
      true,
    )
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(parsed.conversations.length, 1)
    assert.equal(parsed.conversations[0].conversationId, 'c_0000000000aa')
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.includes('.tmp')),
      [],
      '临时文件不许留在盘上',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── F 组：命令行与退出码（容器化之后这才第一次有个非启动的入口）─────────

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      cwd: ROOT,
      env: { ...process.env, DRC_HOST_TOKEN: TOKEN, DRC_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c.toString()))
    child.stderr.on('data', (c) => (err += c.toString()))
    child.on('exit', (code) => resolve({ code, out, err }))
  })
}

test('F1：--version 打印版本号并 exit 0，不监听端口、不需要 token', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const res = await runCli(['--version'])
  assert.equal(res.code, 0)
  assert.equal(res.out.trim(), pkg.version)
  // -v 同义：少写一次长选项的人不该拿到「不认识的参数」。
  const short = await runCli(['-v'])
  assert.equal(short.code, 0)
  assert.equal(short.out.trim(), pkg.version)
})

test('F2：--help exit 0；不认识的参数 exit 2 并给出用法', async () => {
  const help = await runCli(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.out, /用法/)

  // 旧行为是**静默忽略**任意参数照常起服务：容器编排里传错 flag 的后果是
  // 「容器起来了但行为不是我要的」——最坏的一类。
  const bogus = await runCli(['--wat'])
  assert.equal(bogus.code, 2, '用法错必须是 2，与运行期致命（1）区分开')
  assert.match(bogus.err, /不认识的参数/)
  assert.match(bogus.err, /用法/)
})
