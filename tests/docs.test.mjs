/**
 * docs.test — 文档与实现的对齐判据（1.0.6 的卖点就是"文档说的就是实现做的"）。
 *
 * 为什么这些也要有判据：这一轮审计里文档侧的每一条错都不是"文笔问题"，而是
 * 运维照着它做会做错的那类错——配置表漏了两个已实现的变量、慢消费者窗口写成
 * 一刀切的 10 秒、"清扫每轮给所有 socket 发 ping"与分桶实现相反、
 * `droppedFrames` 的定义与计数点不符、以及一条客户端根本不消费的重放被写成机制。
 * 光靠"下次记得改"是挡不住它们的，所以这里用跨文件的机械判据钉住：
 * 代码里的常量/配置项/`health()` 字段 → 文档里必须有一致的表述。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createRelay } from '../dist/src/server.js'
import { loadConfig } from '../dist/src/config.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8')

const CONFIG = read('src/config.ts')
const LIMITS = read('src/limits.ts')
const SERVER = read('src/server.ts')
const STATE = read('src/state.ts')
const DOC = read('docs/SELF-HOSTING.md')
const README = read('README.md')

/** 配置表里的一行（`| \`NAME\` | …`）。 */
const tableRow = (text, name) => new RegExp(`^\\|\\s*\`${name}\`\\s*\\|`, 'm').test(text)

test('文档配置表覆盖 config.ts 读的每一个 DRC_* 变量（漏一个，运维就不知道它能调）', () => {
  const names = [...new Set([...CONFIG.matchAll(/env\.(DRC_[A-Z0-9_]+)/g)].map((m) => m[1]))].sort()
  assert.ok(names.length > 20, `从 config.ts 里没抽到几个变量名，判据自己坏了：${names.length}`)
  const missing = names.filter((name) => !DOC.includes(`\`${name}\``))
  assert.deepEqual(missing, [], `docs/SELF-HOSTING.md 里没有这些配置项：${missing.join(', ')}`)
  const notInTable = names.filter((name) => !tableRow(DOC, name))
  assert.deepEqual(notInTable, [], `这些变量没进配置表（只在正文里提过）：${notInTable.join(', ')}`)
})

test('慢消费者：文档写的是"按角色给窗口"，且秒数与 limits.ts 的常量一致', () => {
  const seconds = (name) => {
    const raw = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(LIMITS)
    assert.ok(raw, `limits.ts 里找不到 ${name}`)
    return Number(raw[1].replace(/_/g, '')) / 1000
  }
  const host = seconds('HOST_SLOW_CONSUMER_MS')
  const client = seconds('CLIENT_SLOW_CONSUMER_MS')
  assert.notEqual(host, client, '两个窗口本来就该不同：主机 10s / 客户端 45s')

  for (const [name, value] of [
    ['DRC_SLOW_CONSUMER_HOST_MS', host],
    ['DRC_SLOW_CONSUMER_CLIENT_MS', client],
  ]) {
    const row = new RegExp(`^\\|\\s*\`${name}\`.*$`, 'm').exec(DOC)?.[0] ?? ''
    assert.match(row, new RegExp(`${value} 秒`), `${name} 那一行没写清窗口是 ${value} 秒：${row}`)
    assert.ok(tableRow(README, name), `README 的常用配置表也漏了 ${name}`)
  }

  // 旧的"一刀切 10 秒"措辞必须消失：那条只对主机成立。
  const bufferedRow = /^\|\s*`DRC_MAX_BUFFERED_BYTES`.*$/m.exec(DOC)?.[0] ?? ''
  assert.ok(
    !/持续超限 \*\*10 秒\*\*/.test(bufferedRow),
    `DRC_MAX_BUFFERED_BYTES 又写成了一刀切的 10 秒：${bufferedRow}`,
  )
  assert.match(bufferedRow, /DRC_SLOW_CONSUMER_HOST_MS/, '阈值行必须指向按角色给的窗口')
  assert.match(bufferedRow, /DRC_SLOW_CONSUMER_CLIENT_MS/)
})

test('保活 ping：判死代价写的是 2×pingInterval，且清扫清单包含慢消费者判定', () => {
  const ops = DOC.slice(DOC.indexOf('### 6.1'))
  assert.match(ops, /2×`DRC_PING_INTERVAL_MS`/, '半开对端的判死代价必须写成 2×DRC_PING_INTERVAL_MS（默认约 121 秒）')
  assert.ok(!/2×5 秒判死/.test(ops), '旧说法"默认最坏约 2×5 秒判死"与分桶实现矛盾，不能回来')
  // 清扫那一条必须同时说到：ping 不在清扫上、慢消费者判定在清扫上。
  const sweepBullet = /- \*\*每个清扫周期[\s\S]*?(?=\n- )/.exec(ops)?.[0] ?? ''
  assert.match(sweepBullet, /慢消费者判定/, '清扫清单漏了挂在它上面的慢消费者判定')
  assert.ok(!/给所有 socket 发 WS 层 ping/.test(sweepBullet), '清扫不再"给所有 socket 发 ping"：那是分桶之前的实现')
  assert.match(ops, /DRC_PING_TICK_MS/, 'ping 的独立节奏（tick + 桶轮转）要写明')
})

test('droppedFrames 的定义与计数点一致：收下但没有收件人（不是"缓冲区超限被丢"）', () => {
  const row = /^\|\s*`droppedFrames`.*$/m.exec(DOC)?.[0] ?? ''
  assert.ok(row, 'healthz 字段表里没有 droppedFrames')
  assert.ok(!/缓冲区超限/.test(row), `droppedFrames 又写成了慢消费者那一类：${row}`)
  assert.match(row, /收件人/, '定义必须是"收下但没有收件人的帧"')
  assert.match(row, /slowConsumers/, '要指向真正管慢消费者的那个字段，别让两件事混在一个数里')
})

test('peer-joined 重放已删除：文档写的是 hello-ok → cmd.list_sessions 这条路', () => {
  const ops = DOC.slice(DOC.indexOf('### 6.1'))
  assert.ok(!/重放给已连接的客户端/.test(ops), '文档仍在描述已删除的 peer-joined 重放')
  assert.match(ops, /cmd\.list_sessions/, '要说清客户端续用旧 convId 的真正路径')
  // 代码侧同步钉一下：handleHello 里不许再出现 peer-joined（防"文档改了代码没改"的反向漂移）。
  // 先剥掉注释——解释"为什么删掉它"的注释里当然会提到这个名字。
  const handleHello = (/function handleHello[\s\S]*?\n  }\n/.exec(SERVER)?.[0] ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.ok(handleHello.length > 100, '从 server.ts 里抽不出 handleHello，判据自己坏了')
  assert.ok(!/peer-joined/.test(handleHello), 'handleHello 里又出现了 peer-joined 重放')
})

test('state.ts 的文件头注释与落盘实现一致（不再宣称"不持久化是有意设计"）', () => {
  const header = STATE.slice(0, STATE.indexOf('*/'))
  assert.ok(!/不持久化是有意设计/.test(header), '文件头仍写着"不持久化是有意设计"，与 1.0.6 的落盘实现矛盾')
  assert.ok(!/\*\*全在内存\*\*/.test(header), '文件头仍把"全在内存"当作无条件的结论')
  assert.match(header, /DRC_STATE_FILE/, '要说清哪张表在什么条件下落盘')
  assert.match(header, /pendingPairs/, '要说清另外三张表为什么永远只在内存里')
})

test('/healthz 的每一个字段都在文档的表里（新增字段不许只活在代码里）', () => {
  const { config } = loadConfig({ DRC_HOST_TOKEN: 'docs-alignment-token-0123456789' }, 'test')
  const relay = createRelay(config)
  const keys = Object.keys(relay.health())
  assert.ok(keys.includes('shutdownForced'), 'health() 少了兜底停机计数')
  const missing = keys.filter((key) => !tableRow(DOC, key))
  assert.deepEqual(missing, [], `docs/SELF-HOSTING.md 的 /healthz 字段表缺：${missing.join(', ')}`)
  for (const key of keys) {
    assert.ok(README.includes(key), `README 的端点表没提到 ${key}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 错误码中文文案：协议层的每个 ErrorCode 都必须有一句中文（2026-10-07）
//
// ## 为什么这是判据而不是一次补字
//
// `CLIENT_ERROR_TEXT` 是**手抄**的 `Partial<Record<ErrorCode, string>>` ——
// "Partial" 意味着**漏一个编译期不报错**。而漏掉的后果正好落在最需要它的人身上：
// `unsupported_protocol`（协议版本对不上）触发时，用户看到的是
// 客户端那句 `f.message || f.code` 里的**英文码**，40 字宽的 toast，
// 既看不懂也不知道下一步该做什么（升级谁？重扫？换中继？）。
//
// 这与"文档漂了"是同一族，但更硬：文档错了运维能发现，手机上弹一句英文没人能查。
// 所以做成**双向**判据：协议层加一个码 → 这张表必须补；这张表多一个码 → 协议层必须有它。
// 双向的意义是让两种错都变红（单向的话，加码不补文案仍然全绿）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 只可能发给 **host** 的错误码 —— 它们**不该**出现在客户端文案表里。
 *
 * 判据是"调用点前面有角色守卫"，逐条核实过（这是这张表**刻意不全**的依据，
 * 而不是"漏了几个"的借口）。往里加这些码会让那张表看起来覆盖了全部而实际不是。
 */
const HOST_ONLY_CODES = ['bad_role', 'bad_token', 'need_host', 'bad_pair']

test('只可能发给 host 的错误码不会出现在客户端文案表里（那张表只管人会看到的）', () => {
  const table = CLIENT_ERROR_TEXT_OF(SERVER)
  const leaked = HOST_ONLY_CODES.filter((c) => table[c])
  assert.deepEqual(
    leaked,
    [],
    `这些码只发给主机插件（调用点前面有 ${HOST_ONLY_CODES.join('/')} 的角色守卫），` +
      '却写进了客户端文案表：会让那张表看起来"每个码都有中文"而实际不是。',
  )
})

test('每个"人会看到"的错误码都有一句中文文案（漏一个编译期不报错）', () => {
  // `Partial<Record<ErrorCode, string>>` 里的 Partial 意味着**漏一个编译期不报错**。
  // 而漏掉的后果正好落在最需要它的人身上：`unsupported_protocol`（协议版本对不上）
  // 触发时，用户看到的是客户端那句 `f.message || f.code` 里的**英文码**——
  // 既看不懂也不知道下一步该做什么（升级谁？重扫？换中继？）。
  //
  // 这与"文档漂了"是同一族但更硬：文档错了运维能发现，手机上弹一句英文没人能查。
  const { errorCodes } = wireFrames()
  const table = CLIENT_ERROR_TEXT_OF(SERVER)
  // 集合来自**协议层的事实**减去"只发给 host 的"，而不是手抄一份清单 ——
  // 手抄的话协议层加一个码，这��条判据仍会绿（那正是它要防的那种失效）。
  const missing = errorCodes.filter((code) => !HOST_ONLY_CODES.includes(code) && !table[code])
  assert.deepEqual(
    missing,
    [],
    `这些错误码没有中文文案：${missing.join(', ')}。用户在手机上会看到英文码——` +
      '既看不懂也不知道下一步做什么。而 `CLIENT_ERROR_TEXT` 的类型是 Partial，漏一个编译期不报错。',
  )
})

test('CLIENT_ERROR_TEXT 里没有协议层不存在的码（反向：多写一个同样是漂移）', () => {
  const { errorCodes } = wireFrames()
  const table = CLIENT_ERROR_TEXT_OF(SERVER)
  const extra = Object.keys(table).filter((code) => !errorCodes.includes(code))
  assert.deepEqual(
    extra,
    [],
    `这张表里有协议层不存在的码：${extra.join(', ')}。它永远不会被触发，` +
      '而"看起来有覆盖"会让人以为这一类已经处理过了。',
  )
})

test('每句文案都真的是中文（不能是英文码或空串充数）', () => {
  const table = CLIENT_ERROR_TEXT_OF(SERVER)
  for (const [code, text] of Object.entries(table)) {
    assert.ok(
      typeof text === 'string' && text.trim().length > 0,
      `${code} 的文案是空的 —— 空串与缺项在客户端表现一样（都回落到英文码）`,
    )
    // 至少要有一个 CJK 字符；纯 ASCII 的串在这一族里通常是"抄了 key 忘了填"
    assert.match(text, /[\u4e00-\u9fff]/, `${code} 的文案没有中文：${JSON.stringify(text)}`)
  }
})

test('错误码 → 文案 → 实际发出的帧，三者一致（钉住"文案真的到得了手机"）', () => {
  // 前两条验的是"表里有"，这条验的是"表真的被用上了"。
  //
  // 口径在 2026-10-07 变过一次，值得记下来：原判据钉的是
  //   `message ?? (peer?.role === 'client' ? CLIENT_ERROR_TEXT[code] : undefined)`
  // 即"显式传入的 message 优先"。那是**错的口径**——客户端的处理是
  // `f.message || f.code`，所以中继随手传一句英文技术细节
  // （`frame "hello" has an invalid shape`）就会**顶掉**整张中文表，
  // 用户在手机上看到的是一句英文。
  //
  // 改成"client 一律中文、host 才拿细节"之后，上面那条正则就红了 ——
  // 这正是判据该有的反应：它逼我把口径想清楚，而不是让实现迁就一条过时断言。
  // 现在钉的是**两件事**：① 中文表对非 host 角色无条件生效；
  // ② 技术细节走日志而不是帧（`log.debug('frame rejected', …)`）。
  const picksChineseForNonHost = /const toClient = peer\?\.role !== 'host'/.test(SERVER)
  assert.ok(
    picksChineseForNonHost,
    'sendError 里取文案的判据变了 —— 这条钉的是「非 host 角色一律拿中文表那句」' +
      '（hello 之前 role 还是 unknown，用 === "client" 判会漏成英文，那是修过的缺陷）。' +
      '改动之前先确认新的分支也满足上面那两条。',
  )
  assert.match(
    SERVER,
    /log\.debug\('frame rejected'/,
    '技术细节没有落到日志里 —— 分流之后 host 侧与日志都拿不到原文，那条坏帧就真的没人能查了',
  )
  // 反向：host 侧必须仍然拿得到细节（插件日志与 status.json 排障靠它）
  assert.match(
    SERVER,
    /const base = toClient \? CLIENT_ERROR_TEXT\[code\] : message/,
    'host 侧不再收到技术细节了 —— 分流的另一半丢了（细节要留给排障，不是全丢掉）',
  )
  // 帧名两边都要给：它对排障有用，对用户也有用（判断"是不是我版本太老"）。
  // 走 userHint 而不是 message —— 后者是英文技术细节，会顶掉中文表。
  assert.match(
    SERVER,
    /const text = toClient && userHint \? `\$\{base \?\? ''\}（\$\{userHint\}）` : base/,
    'userHint 没有被拼进客户端文案 —— "是哪条帧坏了"对用户也是有用信息，不该只留在日志里',
  )
})

/** 从真实产物里取协议层的 errorCodes（不是 src —— 测 src 测的是另一个东西）。 */
let _wire
function wireFrames() {
  if (!_wire)
    _wire = createRequire(new URL('../dist/src/server.js', import.meta.url).pathname)('@dsh-remote/protocol/frames')
  return _wire
}

/**
 * 从 `src/server.ts` 里把 `CLIENT_ERROR_TEXT` 那张表**抠出来**。
 *
 * 为什么读源码而不 import：`CLIENT_ERROR_TEXT` 是模块内的局部 const，没有导出
 * （而导出它只为测试会改变生产模块的面—— 那是另一种取舍）。
 * 抠文本 + 逐条断言，比 import 更能容忍重构（表挪个位置都不必改判据），
 * 而且它测的正是"这张表还写着什么"。
 */
function CLIENT_ERROR_TEXT_OF(src) {
  const start = src.indexOf('CLIENT_ERROR_TEXT')
  assert.notEqual(start, -1, 'src/server.ts 里找不到 CLIENT_ERROR_TEXT')
  const open = src.indexOf('{', start)
  const close = src.indexOf('}', open)
  const body = src.slice(open + 1, close)
  const out = {}
  for (const m of body.matchAll(/(\w+)\s*:\s*'([^']*)'/g)) out[m[1]] = m[2]
  return out
}
