/**
 * config.test — `loadConfig` 的取值与诊断清单（纯函数，不起 socket、不读文件）。
 *
 * 为什么单独一个文件：`loadConfig` 返回 `{config, problems}` 而不是直接
 * `process.exit`，为的就是让这些诊断能被断言——而"启动时会不会把运维做错的那件事说出来"
 * 正是一条行为，不是一个文档承诺。这份清单里每一条 warn 都对应一个**曾经真的会坏**的
 * 配置错误（HANDOFF §0.1 的 EROFS、§0.7 的附件发不出去都是同一类：功能看着正常，
 * 其实某一步根本没生效）。
 *
 * 这里只钉"诊断"这一面；取值本身由 `relay.test.mjs` / `persist.test.mjs` 顺带覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../dist/src/config.js'
import { MAX_CIPHERTEXT_BYTES, MAX_RELAY_MESSAGE_BYTES } from '@dsh-remote/protocol/frames'

const TOKEN = 'config-test-token-0123456789abcdef'
const load = (env = {}) => loadConfig({ DRC_HOST_TOKEN: TOKEN, ...env }, 'test')
const problemsOf = (env) =>
  load(env)
    .problems.filter((p) => p.level === 'warn')
    .map((p) => p.message)

test('默认帧预算与协议层的 MAX_RELAY_MESSAGE_BYTES 同源（两边不同源就是"附件发不出去"那条事故）', () => {
  const { config, problems } = load()
  assert.equal(
    config.maxMessageBytes,
    MAX_RELAY_MESSAGE_BYTES,
    '默认值必须与协议层同源，否则合法大帧会被自家 schema 与自家 ws 互相打架',
  )
  assert.deepEqual(problems, [], '默认配置必须一条告警都没有：默认路径是绝大多数人跑的那条，它不该先学会喊叫')
  // 结构性保证：协议层声明的最大密文 + 信封余量必须装得进中继的 ws.maxPayload。
  assert.ok(
    MAX_CIPHERTEXT_BYTES < MAX_RELAY_MESSAGE_BYTES,
    'MAX_CIPHERTEXT_BYTES 必须留出信封余量，否则"合法帧必然过得了中继"这句就只是估算',
  )
})

test('把帧预算调到协议上限之下时必须告警：那会让合法密文帧被 ws 以 1009 关掉整条连接', () => {
  // 旧实现的默认值就是 256 KiB——这正是"流式输出说到一半就重连"那次事故的配置值。
  const messages = problemsOf({ DRC_MAX_MSG_BYTES: String(256 * 1024) })
  assert.equal(messages.length, 1, `调小帧预算必须被说破，实际 problems：${JSON.stringify(messages)}`)
  assert.match(messages[0], /DRC_MAX_MSG_BYTES/, '告警文案必须点名是哪一个环境变量')
  assert.match(messages[0], /1009/, '告警文案要说清后果是连接被关掉，而不是"帧被拒"')
  assert.match(
    messages[0],
    new RegExp(String(MAX_RELAY_MESSAGE_BYTES)),
    '告警文案要给出建议值，否则运维不知道该改成多少',
  )
})

test('帧预算调大只字不提：协议层仍按自己的上限收，多出来的余量没有坏处', () => {
  assert.deepEqual(
    problemsOf({ DRC_MAX_MSG_BYTES: String(4 * 1024 * 1024) }),
    [],
    '调大是无害的，不该误报——否则这条告警很快就被当成噪音关掉',
  )
})

test('缺 token 是 error、短 token 是 warn：两种诊断不许串味', () => {
  const missing = loadConfig({}, 'test')
  assert.ok(
    missing.problems.some((p) => p.level === 'error' && /DRC_HOST_TOKEN is required/.test(p.message)),
    '缺 token 必须挡启动（CI 里有一条断言这条）',
  )
  assert.equal(
    load({ DRC_HOST_TOKEN: 'short' }).problems.some((p) => p.level === 'error'),
    false,
    '短 token 不该拦启动',
  )
  assert.ok(
    problemsOf({ DRC_HOST_TOKEN: 'short' }).some((m) => /shorter than 24/.test(m)),
    '短 token 必须告警',
  )
})

test('非法的数值/日志级别是 error，且把收到的原值写进消息（照着改才有意义）', () => {
  const bad = loadConfig({ DRC_HOST_TOKEN: TOKEN, DRC_PORT: '70000', DRC_LOG_LEVEL: 'verbose' }, 'test')
  for (const name of ['DRC_PORT', 'DRC_LOG_LEVEL']) {
    assert.ok(
      bad.problems.some((p) => p.level === 'error' && p.message.includes(name)),
      `${name} 的非法取值必须报错并点名`,
    )
  }
  // 端口 0 合法（让系统分配），不能被"正整数"那条误伤。
  assert.equal(load({ DRC_PORT: '0' }).config.port, 0, 'DRC_PORT=0 是"让系统分配"的官方用法')
  assert.equal(load({ DRC_PORT: '' }).config.port, 8787, '空串等于没设，必须走默认值而不是报错')
})

// ── ping 桶数必须**有上界**（2026-10-07 修）──────────────────────────
//
// ## 缺陷形状
//
// `pingBucketCount = max(1, round(pingIntervalMs / pingTickMs))`，而
// `server.ts` 拿它 `Array.from({length: pingBucketCount}, () => new Set())`。
// 原来的校验只管**下界**（`pingBucketCount < 2` 告警），**没有上界**，
// 而 `integer()` 允许 tick=1、interval 到 MAX_SAFE_INTEGER。
//
// 实测：`DRC_PING_TICK_MS=1` + `interval=3600000` → 360 万个 Set，
// createRelay 耗时 486ms、RSS 664MB；`interval=MAX_SAFE_INTEGER` →
// `RangeError: Invalid array length`，而 `loadConfig` 报 **0 条 problem**，
// 异常一路冒到 main.ts 的 fatal 兜底 ⇒ **照文档把 tick 调细就启动即崩**。
//
// 那是"配置看着合法、启动直接挂"的典型形状，而默认值的量级（60000/5000 = 12 桶）
// 离危险区有两个数量级，所以它躲过了所有既有用例。

test('ping 桶数有上界：tick 调细到 1ms 必须夹住并告警，而不是让进程起不来', () => {
  const { config, problems } = load({ DRC_PING_TICK_MS: '1', DRC_PING_INTERVAL_MS: '3600000' })
  const buckets = Math.max(1, Math.round(config.pingIntervalMs / config.pingTickMs))
  assert.ok(
    buckets <= 1024,
    `实得 ${buckets} 个桶：server.ts 会照这个数 Array.from 出同样多个 Set（360 万个 = 664MB RSS）`,
  )
  assert.ok(
    problems.some((p) => /ping 桶|桶数/.test(p.message)),
    '夹回必须**告警**：静默夹回 = 用户以为自己调到了 1ms 精度，实际不是',
  )
})

test('反向判据：极端 interval 也不许让 loadConfig 变成"0 条 problem 的地雷"', () => {
  // 这条是上面那条的**极端形态**：MAX_SAFE_INTEGER / 1 会让
  // `Array.from({length})` 直接抛 RangeError，而异常发生在 createRelay 里，
  // 早就跑完了 loadConfig —— 所以"配置校验通过"与"能启动"是两件事。
  const { problems } = load({ DRC_PING_TICK_MS: '1', DRC_PING_INTERVAL_MS: '9007199254740991' })
  assert.ok(problems.length > 0, '这么离谱的一组值必须至少报一条诊断：0 条 problem 意味着"配置检查通过"，而它随后会崩')
  assert.ok(
    problems.some((p) => p.level === 'error' || p.level === 'warn'),
    '必须落在 error 或 warn 上，不能是 info（info 没人看）',
  )
})

test('反向判据：正常量级不许被这条新判据误伤（默认就该只有 12 个桶）', () => {
  const { config, problems } = load()
  const buckets = Math.max(1, Math.round(config.pingIntervalMs / config.pingTickMs))
  assert.ok(buckets >= 2 && buckets <= 1024, `默认 ${buckets} 个桶：上下界都要留得住它`)
  const bucketProblems = problems.filter((p) => /ping 桶|桶数/.test(p.message))
  assert.equal(bucketProblems.length, 0, `默认配置不该报桶数相关诊断，实际报了：${JSON.stringify(bucketProblems)}`)
})

test('端口也只认十进制字面量（`integer()` 那条纪律不许在 portNumber 上漏网）', () => {
  // `integer()` 的注释明确说「只认十进制字面量」，而 `portNumber` 原来是裸
  // `Number(raw)` —— 于是 `0x22` → 34、`1e3` → 1000、`+8787` → 8787，
  // 三者的 `problems` 都是 0 条（同值喂 `DRC_MAX_CONNS` 则各报 1 条 error）。
  //
  // 严重度低（端口写错会直接 listen 失败、不是静默故障），但它是同一份纪律的
  // 一处漏网，而配置层的价值恰恰在于"一处口径"。
  for (const raw of ['0x22', '1e3', '+8787', '0b101', '8.7e3']) {
    const { problems } = load({ DRC_PORT: raw })
    assert.ok(
      problems.some((p) => p.level === 'error' && p.message.includes('DRC_PORT')),
      `DRC_PORT=${JSON.stringify(raw)} 必须报 error 并点名（它不是十进制字面量）`,
    )
  }
  // 反向判据：正常的十进制写法不许被误伤。
  // ⚠️ 前后空白**是**合法的（`integer()` 那边也 trim，两处同口径）——
  // 第一次写这条判据时我把 `" 8787 "` 同时列进了"非法"与"合法"两半，
  // 于是它红在一个与实现无关的地方，而真正该拦的 0x22 反而没被单独验证。
  for (const [raw, want] of [
    ['0', 0],
    ['8787', 8787],
    [' 8787 ', 8787],
  ]) {
    const { config, problems } = load({ DRC_PORT: raw })
    assert.equal(config.port, want, `DRC_PORT=${JSON.stringify(raw)} 应得 ${want}`)
    assert.equal(problems.filter((p) => p.level === 'error').length, 0, `${raw} 不该报错`)
  }
})
