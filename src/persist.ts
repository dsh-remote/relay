/**
 * persist — 会话表落盘（HANDOFF §1.1 方案 A），**默认关闭**。
 *
 * ## 为什么落（2026-10-06 取证，不是猜的）
 *
 * 线上那晚逐行可查：
 *
 * ```
 * 07:09:01  client disconnected  clientId: muqu1ibj-…
 * 07:09:59  shutting down  SIGTERM
 * 07:10:01  host online                 ← 主机 1 秒内回来
 * 07:11:05  conversations: 0            ← 会话没回来
 * ```
 *
 * 配对关系只存在内存里，中继一重启就全丢，手机必须回到电脑前重新扫码。
 * 这不是某次改坏的，是一直如此——以前没暴露，只因为线上那个进程连着跑了 29.7 小时。
 * 顺带它还卡住了 §1.2「手机切后台再回来不许要求重新扫码」的验收：那条本来就过不了，
 * 中继一重启配对就没了，手机连上来先撞 `unknown_session`。
 *
 * ## 落什么 / 不落什么
 *
 * **落**：conversationId / hostId / clients / seqHost / upCount / lastActivityAt / emptySince。
 * **不落**：
 * - `pendingPairs`——本来就短命（TTL 120 s），而且带一次性语义。落盘等于给一张
 *   已经用过的码留一份可回滚的副本，反倒扩大了"同一张码能被认领两次"的窗口。
 * - `hostOfflineSince`——**刻意不落**，见 `restoreState` 里的注释。
 * - 任何秘密：中继是结构性零知识的，它从来不持有 PSK。会话 id 与 client id 本来就
 *   明文出现在每一帧里，落盘不扩大暴露面（`tests/persist.test.mjs` 有判据钉住这一点）。
 *
 * ## 三条写盘纪律
 *
 * 1. **原子写**：先写同目录临时文件再 `rename`。半截状态文件把中继起挂掉，
 *    比没有文件更糟——`rename` 在同一文件系统内是原子的。
 * 2. **损坏按空启动，绝不拒绝启动**：起不来的中继等于整个产品停摆，而坏文件的唯一
 *    后果是"所有人重新扫一次码"。所以解析失败只记日志（`state file ignored`）。
 * 3. **回收要同步删盘**：内存里删掉的会话若留在盘上，重启就会把已经死掉的会话复活。
 *    调用方在结构性变更（建/删）时立刻落盘，见 `server.ts` 的 `markStateChanged`。
 *
 * 本文件不 import `ws`、不 import `server.ts`，可以纯内存单测。
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { CONVERSATION_ID_PREFIX } from '@dsh-remote/protocol/ids'
import { statusDigest, type StatusDigest } from '@dsh-remote/protocol/frames'
import type { Log } from './log.js'
import type { Conversation, RelayState } from './state.js'

/**
 * 落盘格式版本 —— **只决定我们写出什么**，读的一侧不认它。
 *
 * ⚠️ 2026-10-12 生产事故后改的口径（原来这里写的规则正好相反，是错的）：
 * 这里曾经还有一句"**不认识就整份按空处理**，不为 v1 保留任何读取路径"，
 * 听着严谨，后果是 3.1.3 写出的盘上文件（形状与 v2 **逐字段相同**）在升级那一刻
 * 被整份丢掉：10 枚令牌、3 条配对会话清零，随后空状态还覆盖了盘上文件。
 * 完整的事故与为什么改成"认形状"见 `readStateFile` 里那段注释。
 *
 * ⇒ `version` 是**我们写出的标记**；判断"读得懂读不懂"的是**形状**
 * （`conversations` 逐条过 schema、`hostTokens` 必须是数组）。将来真改了形状，
 * 形状闸会拒，且拒得有痕迹 —— 比一个数字闸可靠。
 *
 * `2` 的含义：`hostTokens` 从"可选"变成**必需字段**（缺它就整份不继承，见读路径）。
 */
export const STATE_FILE_VERSION = 2

export interface PersistedConversation {
  conversationId: string
  hostId: string
  /** 数组而非 Set：JSON 里没有 Set。顺序不影响语义（成员校验是逐个查）。 */
  clients: string[]
  seqHost: number
  /** client→host 帧数（埋点 2026-10-23）。**可选**：老状态文件没有 ⇒ 读回按 0。 */
  upCount?: number
  lastActivityAt: number
  emptySince?: number
  /**
   * 状态摘要（M2，REVIEW §5.1）。**可选**：老状态文件没有 ⇒ 读回不带。
   * 落盘边界是白名单（`statusDigest`，strict）：形状不对的整条丢掉，
   * state.json 不是信任边界（它可能被人手改过）——自由文本键进来就是零知识破口。
   */
  summary?: StatusDigest
}

export interface PersistedHostToken {
  /** 非空 hostId（2026-10-11 晚起没有"未绑定槽位"了，见 `state.ts` 的 `HostTokenEntry`）。 */
  hostId: string
  token: string
  issuedAt: number
  lastUsedAt: number
}

export interface PersistedState {
  version: number
  savedAt: number
  conversations: PersistedConversation[]
  /** 按 hostId 一机一枚的令牌表（v2 起是**必需字段**，见 `STATE_FILE_VERSION`）。 */
  hostTokens: PersistedHostToken[]
}

/** 路由凭证的形状由 `newConversationId()` 定死（`c_` + 12 位 hex）。读进来先按它筛一遍。 */
const CONVERSATION_ID_RE = new RegExp(`^${CONVERSATION_ID_PREFIX}[0-9a-f]{12}$`)

/**
 * 中继签发的 host token 的形状：48 位小写十六进制（`randomBytes(24).toString('hex')`）。
 *
 * 读盘时按它筛：一份被手改坏的令牌表若混进一枚短 token，`tokenMatches` 是**定长比较**
 * ——它不会报错，只会让那台主机静默拿到 `bad_token` 并且**再也不认领**（盘上有令牌），
 * 于是"看起来一切正常、就是连不上"。宁可丢掉这一条并计数。
 */
const HOST_TOKEN_RE = /^[0-9a-f]{48}$/
/** hostId 上限：它会被当作 Map 的键，也是落盘字段。见 `server.ts` 的同名常量。 */
const MAX_HOST_ID_LEN = 200

/** 逐条筛令牌表。与会话表同一套纪律：坏一条丢一条并计数，不整份作废。 */
function sanitizeHostTokens(raw: unknown[]): { hostTokens: PersistedHostToken[]; dropped: number } {
  const hostTokens: PersistedHostToken[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const entry = item as Record<string, unknown>
    if (
      typeof entry.hostId !== 'string' ||
      // ⚠️ **空 hostId 一律丢**（2026-10-11 晚）：那曾是"未绑定槽位"的键，而它的令牌
      // 对任意主机都算数。旧状态文件里可能真有一条这样的记录 —— 读进来就等于把
      // 那把万能钥匙又装回内存，所以在这一层直接筛掉（不是靠 `hostTokenAccepted` 单独兜）。
      entry.hostId === '' ||
      entry.hostId.length > MAX_HOST_ID_LEN ||
      entry.hostId.trim() !== entry.hostId ||
      !isNonEmptyString(entry.token) ||
      !HOST_TOKEN_RE.test(entry.token) ||
      !isTimestamp(entry.issuedAt) ||
      !isTimestamp(entry.lastUsedAt) ||
      seen.has(entry.hostId)
    ) {
      continue
    }
    seen.add(entry.hostId)
    hostTokens.push({
      hostId: entry.hostId,
      token: entry.token,
      issuedAt: entry.issuedAt,
      lastUsedAt: entry.lastUsedAt,
    })
  }
  return { hostTokens, dropped: raw.length - hostTokens.length }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 逐条筛会话。
 *
 * **刻意不是"一条坏就整份作废"**：一份 10 MB 的状态里坏掉 1 行，代价不该是全部手机
 * 重新扫码。逐条丢弃并报出条数，运维一眼能看出是"文件被截断"还是"手改坏了某一行"。
 * 而 JSON 语法 / 顶层形状 / `hostTokens` 缺失这三处是整份作废——它们坏掉意味着我们对
 * 这份文件的理解本身就不成立。（`version` 数字**不作判据**，见 `readStateFile`。）
 */
function sanitize(raw: unknown): { conversations: PersistedConversation[]; dropped: number } {
  if (!Array.isArray(raw)) return { conversations: [], dropped: 0 }
  const conversations: PersistedConversation[] = []
  let dropped = 0
  // 同一个 conversationId 出现两次时，保留**第一条**并把后面的计入 dropped
  // （2026-10-07 审计）。旧实现两条都收进数组、restoreState 用 Map.set 覆盖，于是读盘
  // 日志说「恢复 N 条」、紧接着恢复日志说「N-1 条」，中间那条用户的会话静默消失
  //（手机下次发帧拿到 unknown_session），而**没有任何 dropped 计数**指出这件事。
  // 重复的来源：手改文件，或两个中继实例指向同一个状态文件。
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      dropped += 1
      continue
    }
    const entry = item as Record<string, unknown>
    if (
      !isNonEmptyString(entry.conversationId) ||
      !CONVERSATION_ID_RE.test(entry.conversationId) ||
      seen.has(entry.conversationId) ||
      !isNonEmptyString(entry.hostId) ||
      !Array.isArray(entry.clients) ||
      !entry.clients.every(isNonEmptyString) ||
      !isTimestamp(entry.seqHost) ||
      !Number.isInteger(entry.seqHost) ||
      entry.seqHost < 0 ||
      !isTimestamp(entry.lastActivityAt)
    ) {
      dropped += 1
      continue
    }
    seen.add(entry.conversationId)
    const conversation: PersistedConversation = {
      conversationId: entry.conversationId,
      hostId: entry.hostId,
      clients: [...new Set(entry.clients as string[])],
      seqHost: entry.seqHost,
      lastActivityAt: entry.lastActivityAt,
    }
    // emptySince 可选：缺失的会话按"此刻起算"处理（见 restoreState 的注释）。
    if (isTimestamp(entry.emptySince)) conversation.emptySince = entry.emptySince
    // upCount 可选（2026-10-23 埋点）：老状态文件没有这个键 ⇒ 不写、读回按 0。
    if (typeof entry.upCount === 'number' && Number.isInteger(entry.upCount) && entry.upCount >= 0) {
      conversation.upCount = entry.upCount
    }
    // summary 可选（M2）：**过白名单 schema**（statusDigest，strict）才进内存 ——
    // state.json 不是信任边界（可能被人手改过），带自由文本键/坏类型的整条丢掉，
    // 不是剥键放行：剥键放行会让人以为"那条字段被存住了"，而真相是它已经没了。
    const digest = statusDigest.safeParse(entry.summary)
    if (digest.success) conversation.summary = digest.data
    conversations.push(conversation)
  }
  return { conversations, dropped }
}

/**
 * 读回状态文件。
 *
 * 返回 `undefined` = 没有可用状态（文件不存在 / 读不了 / JSON 语法坏 / 顶层形状坏 /
 * `hostTokens` 缺失或不是数组），调用方按空表启动。**任何一种失败都不抛**——
 * 理由见文件头纪律第 2 条。⚠️ 版本号**不在**这个列表里，见下面那段。
 */
export function readStateFile(path: string, log: Log): PersistedState | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return undefined
    // 读不了（权限、路径是目录……）按空处理，但要留痕——否则"配对总丢"会查无实据。
    log.warn('state file unreadable, starting empty', { path, code: String(code ?? e) })
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    log.warn('state file corrupt (json), starting empty', { path, bytes: text.length })
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn('state file corrupt (shape), starting empty', { path })
    return undefined
  }
  const file = parsed as Record<string, unknown>
  /**
   * ⚠️ **不按 `version` 数字拒收**（2026-10-12 生产事故后改）。
   *
   * ## 原来这里有一道版本闸，它是错的
   *
   * v2 把 `hostTokens` 从"可选"改成"必需"（类型层面），读路径便加了一句
   * `if (file.version !== STATE_FILE_VERSION) return undefined`。
   * 听着严谨，实际后果：**3.1.3 写出的盘上文件与新格式逐字段相同**
   * （`hostTokens` 从 3.1.3 起就在写，形状一点没变），却因为 `version: 1`
   * 被整份丢掉 —— 10 枚 host token、3 条配对会话当场清零，随后落盘又被空状态覆盖。
   * 生产上就是这样红过的：
   *   {"level":"warn","msg":"state file version mismatch, starting empty","found":"1"}
   *
   * ## 为什么"数字对不上"不等于"读不了"
   *
   * 版本号是**我们写出的标记**，不是格式的证明。真正能判断"读得懂读不懂"的是**形状**：
   * `conversations` 逐条过 schema、`hostTokens` 必须是数组 —— 两道闸都在下面，
   * 坏了丢那一条并留痕。
   *
   * ⇒ 数字只决定我们**写出**什么；读的一侧认形状。将来真改了形状
   * （例如 `hostTokens` 变成对象表），形状闸会拒，且拒得有痕迹 ——
   * 比一个"看起来严密、其实把一模一样的数据丢掉"的数字闸可靠。
   */
  const { conversations, dropped } = sanitize(file.conversations)
  if (dropped > 0) log.warn('state file entries dropped', { path, dropped, kept: conversations.length })
  /**
   * `hostTokens` 是**必需字段**：没有它（或不是数组）就不读 ——
   * 那意味着这份文件不是能安全继承的一份（老中继写的、被人改坏的），
   * 而不是"版本旧一点所以让一步"。缺它时当空表并留痕，绝不默默继承一份读不懂的状态。
   */
  if (!Array.isArray(file.hostTokens)) {
    log.warn('state file has no hostTokens array, starting empty', { path })
    return undefined
  }
  const hostTokenResult = sanitizeHostTokens(file.hostTokens)
  if (hostTokenResult.dropped > 0) {
    log.warn('state file host tokens dropped', {
      path,
      dropped: hostTokenResult.dropped,
      kept: hostTokenResult.hostTokens.length,
    })
  }
  log.info('state file loaded', {
    path,
    conversations: conversations.length,
    dropped,
    hostTokens: hostTokenResult.hostTokens.length,
  })
  return {
    version: STATE_FILE_VERSION,
    savedAt: isTimestamp(file.savedAt) ? file.savedAt : 0,
    conversations,
    hostTokens: hostTokenResult.hostTokens,
  }
}

/** 把内存表摊平成落盘形状。**只取白名单字段**（见 PersistedConversation）。 */
export function snapshotState(state: RelayState, now: number): PersistedState {
  const conversations: PersistedConversation[] = []
  for (const [conversationId, conv] of state.conversations) {
    const conversation: PersistedConversation = {
      conversationId,
      hostId: conv.hostId,
      clients: [...conv.clients],
      seqHost: conv.seqHost,
      upCount: conv.upCount,
      lastActivityAt: conv.lastActivityAt,
    }
    if (conv.emptySince !== undefined) conversation.emptySince = conv.emptySince
    // 状态摘要（M2）：只在真的有时写（可选字段，老读方不认识就当没有）。
    if (conv.summary !== undefined) conversation.summary = conv.summary
    conversations.push(conversation)
  }
  const hostTokens: PersistedHostToken[] = []
  for (const [hostId, entry] of state.hostTokens) {
    hostTokens.push({ hostId, token: entry.token, issuedAt: entry.issuedAt, lastUsedAt: entry.lastUsedAt })
  }
  // 空表也照写（v2：字段必需，形状只有一种）。
  return { version: STATE_FILE_VERSION, savedAt: now, conversations, hostTokens }
}

/**
 * 把状态文件读回内存表。返回恢复的会话条数（0 = 没有状态文件 / 读坏了）。
 *
 * ## 为什么 `hostOfflineSince` 刻意**不**恢复（这是本函数最容易写错的一处）
 *
 * 落盘的六个字段里唯独它被丢掉，而这不是遗漏，是**必须**：
 *
 * `hostOfflineSince` 是"主机 socket 掉了，从那一刻起算 `hostGraceMs` 宽限期"的计时基线。
 * 读盘的那一刻进程刚起来，**没有任何主机连着**——`hosts` 表必然是空的。
 * 若把盘上的 `hostOfflineSince` 照搬过来，等于宣称"这台主机从上次落盘那一刻就已经离线"，
 * 于是 `suspendExpiredHosts` 会**从进程启动那刻**开始计时（2026-10-23 起是报「挂起」，不再判死）：一次 130 秒的停机维护
 * （`systemctl stop` → `start`）就能让宽限期当场到期，会话被回收，手机重新扫码——
 * **比不做落盘还糟**，它把一次可预期的重启变成了确定性掉线。
 *
 * 所以恢复出来的会话一律是"主机在场、只是还没连上"。宽限期的计时**只**从
 * `hostGone` 打点的那一刻起算，也就是必须有一个真实的主机 socket 先掉过。
 * 主机随后连上来发 `resync()` 声明它仍持有的会话，那条路上本来就会清掉
 * 主机已经忘记的会话（复核 R1）——所以"读回来但主机不认"这条垃圾路径
 * 有它自己的收敛机制，不需要靠 `hostOfflineSince` 去兜。
 *
 * ## `emptySince` 的两种恢复
 *
 * - 盘上有值：照搬。空会话的回收计时跨重启延续，符合"回收要在内存与盘上同步"的纪律。
 * - 盘上没值但**成员表确实是空的**：`sanitize` 允许 `emptySince` 缺失（它是可选字段），
 *   这时按**此刻**起算——会话已经空了却没人打点的话，它会一直挂到 7 天的空闲 TTL，
 *   正好落在 `sweepIdle` 与 `sweepEmpty` 之间那个没人管的缝里。
 * - 盘上有成员：清掉计时（与 `markEmpty` 的"只要还有成员就撤销"同一条规则）。
 */
export function restoreState(path: string, state: RelayState, log: Log, now: number): number {
  const file = readStateFile(path, log)
  if (!file) return 0
  let clamped = 0
  for (const entry of file.conversations) {
    // **未来时间戳一律夹到此刻**（2026-10-07 审计）。两个消费端都是单边比较：`sweepIdle`
    // 判 `now - lastActivityAt >= ttlMs`、`sweepEmpty` 判 `now - emptySince >= emptyTtlMs`。
    // 于是盘上一个偏快的时钟（RTC 复位、NTP 回调、VM 快照恢复、跨机拷回）写下的时间戳，
    // 在偏斜量 ≥ TTL 时会让那条会话**永久不可回收**：/healthz 的 conversations 只增不减、
    // 空会话回收形同虚设，而更糟的是它每 60 s 又被周期补写**原样写回盘上**——错误自我
    // 固化、永不自愈。空会话 TTL 默认只有 30 分钟，几小时的时钟偏斜就足够触发。
    const lastActivityAt = entry.lastActivityAt > now ? now : entry.lastActivityAt
    const rawEmptySince = entry.emptySince !== undefined && entry.emptySince > now ? now : entry.emptySince
    if (lastActivityAt !== entry.lastActivityAt || rawEmptySince !== entry.emptySince) clamped += 1

    const conv: Conversation = {
      hostId: entry.hostId,
      clients: new Set(entry.clients),
      seqHost: entry.seqHost,
      // 老状态文件（3.2.12 之前）没有 upCount ⇒ 按 0 起步，不报错、不丢会话。
      upCount: entry.upCount ?? 0,
      lastActivityAt,
    }
    conv.emptySince = conv.clients.size === 0 ? (rawEmptySince ?? now) : undefined
    // 状态摘要（M2）：sanitize 已经过了白名单 schema，这里原样接上。
    if (entry.summary !== undefined) conv.summary = entry.summary
    state.conversations.set(entry.conversationId, conv)
  }
  if (clamped > 0) {
    // 留痕而不是静默修正：出现这个数说明**这台机器的时钟与写盘那台不一致**，那是要去查的
    // （一次 NTP 步进、一次 VM 快照恢复），不是中继能自己决定的事。
    log.warn('state file timestamps in the future, clamped to now', { path, clamped })
  }
  /**
   * 令牌表按原样读回。
   *
   * **不夹时间戳**（与会话那几处刻意不同）：`issuedAt` / `lastUsedAt` 只用于诊断与
   * 裁剪顺序，不参与任何"过期"判定——夹了反而会掩盖"这台机器的钟不对"。
   */
  for (const entry of file.hostTokens) {
    state.hostTokens.set(entry.hostId, {
      token: entry.token,
      issuedAt: entry.issuedAt,
      lastUsedAt: entry.lastUsedAt,
    })
  }
  log.info('state restored', {
    path,
    conversations: state.conversations.size,
    hostTokens: state.hostTokens.size,
  })
  return state.conversations.size
}

/**
 * 把一个路径 fsync 到盘上。
 *
 * `strict=false`（目录）时不抛：见调用点的说明，目录 fsync 在个别平台/文件系统上不被
 * 支持，而「没成功」与「没试」在排障时是两回事，所以留一行 debug 痕迹。
 */
function syncPath(target: string, log: Log, strict = true): void {
  let fd: number | undefined
  try {
    /**
     * ⚠️ **优先 `'r+'`，拿不到才退 `'r'`**（2026-10-10 修的真缺陷）。
     *
     * ## 为什么（这是一个"Windows 上落盘整个失效"的缺陷）
     *
     * Windows 上 `fsync` 走的是 `FlushFileBuffers`，而它**要求句柄有写权限**；
     * 只读句柄会失败。POSIX 上只读 fsync 是允许的，所以这个写法在 macOS / Linux
     * 上一路正常 —— 直到四个开源仓的 CI **第一次真的在 `windows-latest` 上跑起来**。
     *
     * 后果不是"少一次 fsync"：`strict=true`（文件那一次）会**抛**，外层 catch
     * 于是 unlink 掉临时文件并 `return false` —— 而 `renameSync` 在 `syncPath` **之后**，
     * 所以 **`state.json` 根本不会被创建**。表现是 `ENOENT`，看起来像"路径配错了"，
     * 其实是"落盘这一步在 Windows 上从来没成功过"（7 条验收判据同时红）。
     *
     * ⇒ 目录那一次 `'r+'` 本来就打不开（目录不能按读写打开），自然退到 `'r'`，
     *   与原来一样是 best-effort（`strict=false`）；文件那一次拿到写权限，
     *   Windows 上才真的能 fsync。
     */
    try {
      fd = openSync(target, 'r+')
    } catch {
      fd = openSync(target, 'r')
    }
    fsyncSync(fd)
  } catch (e) {
    // strict（文件本身）时抛出 → 外层 catch 记 warn 并计一次 stateWriteFailures，
    // 那才是「这次落盘没成功」；目录那一次 best-effort，只留 debug 痕迹。
    if (strict) throw e
    log.debug('directory fsync unsupported, continuing', {
      path: target,
      message: String((e as Error)?.message ?? e),
    })
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * 原子写。
 *
 * 临时文件放在**目标同目录**：`rename` 只在同一文件系统内是原子的，写到 `/tmp`
 * 再搬过来在某些挂载下会退化成 copy（半截文件就此可能）。
 * 返回 false = 写失败（调用方记日志与计数，但**不许**因此让中继退出）。
 */
export function writeStateFile(path: string, snapshot: PersistedState, log: Log): boolean {
  // 同目录的临时名带上 pid：并发两个中继实例指向同一个文件时，后写的临时文件
  // 不会互相踩（踩了也只是丢一次更新，不会读到一个半截文件）。
  const tmp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    // **独占创建**（'wx'）+ 显式 chmod，两件都不能省（P2）：
    // 临时名是固定的 `${path}.${pid}.tmp`，`mode: 0o600` 只在**创建**那一刻生效——
    // 崩溃残留、或那次崩溃的 pid 被系统复用，就会 `writeFileSync` 到一份已存在的
    // 0644 文件上（沿用它的权限），rename 之后最终状态文件也就成了 0644。
    // 先 unlink 掉残留，再以 'wx' 独占创建，最后**显式** chmodSync 0600：
    // 权限从此不取决于"这个 tmp 路径上一次是谁留下的、umask 是多少"。
    try {
      unlinkSync(tmp)
    } catch {
      /* ENOENT 就是我们要的：没有残留 */
    }
    writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(tmp, 0o600)
    // **fsync 之后再 rename**（2026-10-07 审计补，纪律第 1 条的后半段）。
    // 文件头那条「原子写」只对两种读者成立：并发的另一个进程（rename 不会让它看到半截）
    // 与**进程**崩溃。它管不到**掉电**：没有 fsync，rename 可能已落进目录，而 tmp 的内容
    // 还在 page cache 里，回电后得到一个**长度正确、内容全零或半截**的 state.json →
    // 读它走 JSON 解析失败那条路 → 所有配对作废、所有手机回电脑前重扫。而「落盘」这个
    // 特性存在的唯一理由（文件头那 07:09 的日志）恰恰就是消灭这个症状。
    syncPath(tmp, log)
    renameSync(tmp, path)
    // 目录项本身也要落盘：rename 的持久性由**父目录**的 fsync 保证，不是文件的。
    syncPath(dirname(path), log, false)
    return true
  } catch (e) {
    log.warn('state file write failed', { path, message: String((e as Error)?.message ?? e) })
    try {
      // 临时文件不许留在盘上过夜：它是一份没人读的完整状态，运维会以为它才是真相。
      unlinkSync(tmp)
    } catch {
      /* 清理失败不追加日志：它本来就是清理失败，而且抛出去会把整次写盘反转成崩溃 */
    }
    return false
  }
}
