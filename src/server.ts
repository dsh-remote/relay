/**
 * server — 零知识 WebSocket 中继的装配：http + ws + 控制面分发 + 清扫 + 停机。
 *
 * 结构上的零知识由三件事共同保证，缺一不可：
 * 1. 本进程不 import 任何密码学模块（`@dsh-remote/protocol/record`、`tweetnacl` 都不在依赖图里；
 *    `tests/bundle.test.mjs` 会直接断言打出来的单文件里没有 xsalsa20/secretbox 痕迹）；
 * 2. 数据面帧的 `ciphertext` 只被搬运，中继只读它的**字符集**（拒非法 base64）；
 * 3. 日志字段类型只允许标量（见 `log.ts`），控制面里出现的只有 id / 计数 / 配对码 / label。
 *
 * 与旧实现的四条行为差异（全部经用户拍板，docs/DESIGN.md §4、§8）：
 * D1 不接收 PSK、D2 配对码不落 info 日志、D3 客户端断开不删会话、
 * D4 转发前校验发送方是会话成员、D5 `auth` 并入 `hello`、D6 主机断开有宽限期。
 *
 * 落盘（`DRC_STATE_FILE`，HANDOFF §1.1 方案 A）**默认关闭**，启用时只影响会话表：
 * 启动读回（`createRelay` 里、listen 之前）、结构性变更立刻写、清扫周期补写。
 * 它不改变安全模型，也不碰 `hosts` / `clients` / `pendingPairs`——那三张表是活连接与
 * 短命状态，落盘它们只会造出"幽灵对端"。详见 `persist.ts`。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { type EndpointFrame, type ErrorCode, type RelayFrame } from '@dsh-remote/protocol/frames'
import { newHostId } from '@dsh-remote/protocol/ids'
import { negotiateProtocol, MIN_SUPPORTED_PROTOCOL, PROTOCOL_VERSION } from '@dsh-remote/protocol/negotiate'
import { wantsRetryAfter } from '@dsh-remote/protocol/errors'
import {
  encBatchToClient,
  encBatchToRelay,
  encToClient,
  encToRelay,
  helloOkForClient,
  helloOkForHost,
  makeError as makeErrorFrame,
  pairFail as pairFailFrameOf,
  pairReady as pairReadyFrameOf,
  paired as pairedFrameOf,
  peerJoinedForHost,
  peerLeft as peerLeftFrame,
  pong as pongFrameOf,
} from '@dsh-remote/protocol/outbound'
import { classifyEndpointFrameText } from '@dsh-remote/protocol/classify'
import type { RelayConfig } from './config.js'
import { BackpressureGate, Budget, FrameRateGate } from './limits.js'
import { Log, REDACTED } from './log.js'
import { restoreState, snapshotState, writeStateFile } from './persist.js'
import { RelayState, WS_OPEN, type Sock } from './state.js'

/** 保留的自定义关闭码：同 hostId 顶号。客户端的重连策略不认识它，只对主机有意义。 */
const CLOSE_REPLACED = 4000

/**
 * 停机时等对端走完关闭握手的时长（ms），过了就 `terminate()`。
 *
 * 取 1.5 s 的理由：`<main.ts>` 的兜底 guard 是 5 s（`.close()` 返回后主进程才 exit），
 * 排空必须留出余量；而 1.5 s 已经足够一次正常的 TCP 往返 + 小程序的 close 帧应答
 * （实测正常断开在毫秒级）。它远小于 `TimeoutStopSec=15`（systemd 单元）与
 * `stop_grace_period: 15s`（compose），所以容器与 systemd 都不会先动粗。
 */

const DRAIN_MS = 1_500

/**
 * resync 触发的落盘的最小间隔（ms）。
 *
 * resync 是**逐帧**可发的（帧闸 500/s 全放行），而落盘是同步写整张表 —— 实测 5000 条
 * 会话时 2.22 ms/次，一台已认证主机连发就能占满整个事件循环，于是 ping 判定跟着停、
 * 所有对端被 heartbeat timeout terminate。
 *
 * 而**不能**简单地「只在删了会话时才写」：HANDOFF 0.10.5 第 4 条修过的那条是
 * 「resync 给一条空会话打上 emptySince 却不落盘」——重启后 restoreState 按「此刻起算」
 * 补上计时，空会话回收被推迟整整一个 TTL。
 *
 * 于是两者之间取这个间隔：空会话计时的落盘**至多晚 2 秒**，而洪泛下的写盘次数从
 * 「每帧一次」变成「每 2 秒一次」。删会话那条路不受限流——每个会话只会被删一次，
 * 天然有界。
 */
const RESYNC_PERSIST_MIN_GAP_MS = 2_000

interface Peer {
  ws: WebSocket
  role: 'unknown' | 'host' | 'client'
  hostId?: string
  clientId?: string
  rate: FrameRateGate
  authAttempts: number
  /** 本连接上失败的配对尝试次数（用尽即 4008 断开）。成功一次就清零。 */
  pairAttempts: number
  /** 对端 socket 缓冲区持续超限的计时（慢消费者处置）；窗口按角色给，见 noteBackpressure。 */
  backpressure: BackpressureGate
  /**
   * "这条连接上某类逐帧事件**已经记过一次**"的三道闩锁。
   *
   * 为什么需要：限流与限配的判定是**每帧**求值的，而 `ws.close()` 是优雅关闭——
   * 对端还在灌帧的那段窗口里，判定照样每帧成立。旧写法于是让
   * `frame flood disconnected` 变成逐帧日志：实测**单条未认证连接 1.1 秒写
   * 299,498 行**（约 33 MB）。journald 按**条数**限流不按字节，于是中继自己的正常
   * 诊断（`uncaught exception`、`counters`、`slow consumer`）被一起抑制——排障
   * 现场变成空白，而这正是 log.ts 文件头记录的那起事故（8.19 MB / 1.2 s）的同一条
   * 通路，只是从"被认证前"变成"可无限持续"。nginx 挡不住：`limit_req` 计的是
   * HTTP 请求数，升级之后不再计帧。
   *
   * 所以这条纪律是：**判定逐帧，记账只记一次**。
   */
  notedFrameFlood: boolean
  /** 同上：`enc from non-member` 一条连接只记一次。 */
  notedNonMember: boolean
  /** 配对表满的告警只记一次（逐帧判定，见 handlePairBegin）。 */
  notedPairTableFull: boolean
  /** 同上：全局配对配额用尽那条 warn，每秒最多一行（0 = 还没记过）。 */
  pairBudgetWarnedAt: number
  alive: boolean
  /**
   * 这条连接属于哪个 ping 桶（见 sweepPingBucket）。建连时按轮转序号取模分配，
   * **之后不再变**——所以一个对端两次被 ping 的间隔稳定等于 pingIntervalMs。
   */
  pingBucket: number
  /**
   * 对端在 `hello` 里报的协议版本（`undefined` = 没报，按 1 处理，V1）。
   *
   * ⚠️ 它**只喂 `/healthz` 的观测**（`peerProtocolMin` / `peerProtocolMax` /
   * `peersNoProtocol`），**不参与任何判定**——决定"放不放行"的那一次判定发生在
   * `hello` 上，见 `acceptProtocol` 的注释。
   *
   * 曾经这里写着"必须在连接上记，否则业务帧会被当成没报版本"——那是把**没发生的
   * 事**写成了理由：业务帧从来不跑那道闸，所以不存在"被当成 1"这回事。
   */
  protocol?: number
  /**
   * 这条连接**已经往 `peerProtocols` / `peersWithoutProtocol` 里记过一次**没有。
   *
   * 为什么需要它：观测面的计数必须以**连接**为单位（`close` 天然每条连接减一次），
   * 而 `hello` 可以来很多次（re-hello 是设计内行为，见 `releaseIdentityFor`）。
   * 没有这个闩锁时每收一个 `hello` 就 +1，于是 N 次 hello 只抵消 1 次断开，
   * `peerProtocols.size === 0`（"当前没有对端"）这条判据永久失效。
   *
   * 它与 `protocol !== undefined` **不是一回事**：一个**没报版本**的连接
   * `protocol` 恒为 undefined，而它同样要往 `peersWithoutProtocol` 里记一次。
   */
  countedProtocol: boolean
}

export interface RelayHandle {
  http: Server
  wss: WebSocketServer
  state: RelayState
  log: Log
  health(): Record<string, string | number | boolean>
  /** 优雅停机：向所有对端发 1001，等在途连接结束。 */
  close(): Promise<void>
  /** 排空超时后的兜底停机：补写一次盘并把这次"没排空"记进 /healthz。 */
  forceShutdown(): void
  startListening(): Promise<{ port: number; bind: string }>
}

/** 定时安全比较：host token 是唯一凭据，别把长度与时序泄露出去。 */
function tokenMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(got, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function createRelay(config: RelayConfig): RelayHandle {
  const log = new Log(config.logLevel)
  const state = new RelayState({ maxPendingPairs: config.maxPendingPairs })
  const startedAt = Date.now()
  const pairBudget = new Budget(config.pairGlobalBudgetPerSec)
  /** `/api/pair-status` 的独立配额：它走 HTTP、无认证，和配对帧不是同一条入口。 */
  const pairStatusBudget = new Budget(config.pairStatusBudgetPerSec)
  const peers = new WeakMap<WebSocket, Peer>()
  let shuttingDown = false
  let sweepTimer: NodeJS.Timeout | undefined
  let pingTimer: NodeJS.Timeout | undefined
  let lastPingAt = 0
  /** 上一次把计数器抄进日志的时刻（0 = 还没抄过，所以启动后第一轮就抄）。 */
  let lastCountersAt = 0

  // ── 会话表落盘（HANDOFF §1.1 方案 A，DRC_STATE_FILE 未设时整段是死代码）──

  /**
   * 启动时先读回，再 listen。
   *
   * 放在 `createRelay` 里（而不是 `startListening`）是有意的：`main.ts` 的顺序是
   * `createRelay` → `startListening`，所以这里跑的时候**还没有任何 socket 能进来**，
   * 内存表就是干净的读回结果。反过来放在 listen 之后，就有一个真实的竞态——
   * 主机在读盘完成前连上来发 `resync()`，那轮 resync 会按"服务器现有的表"去删，
   * 而此时表还没读回来，于是它把主机刚声明的会话全删了（复核 R1 的老坑）。
   *
   * 读坏了/没有文件都按空启动，绝不拒绝启动（`persist.ts` 的纪律第 2 条）。
   */
  const persistence = { enabled: config.stateFile !== '', restored: 0, savedAt: 0, writes: 0, failures: 0 }
  if (persistence.enabled) {
    persistence.restored = restoreState(config.stateFile, state, log, startedAt)
    /**
     * **启动时立刻写一次**（2026-10-07 补）。
     *
     * 为什么不能只靠周期补写：落盘失效时中继的外部表现是"配对完全正常，只是重启就没"，
     * 而周期补写最早也要等 `DRC_STATE_SAVE_MS`（默认 60 s）才留下第一条痕迹。
     * 这正是 HANDOFF §0.1 那次 EROFS 的形状——`systemctl status` 看不出来、
     * `/healthz` 的 `conversations` 是对的，只有 `stateWriteFailures` 这个字段能指出来，
     * 而它要等一分钟才有第一个非零值。
     *
     * 所以启动就试一次：容器里忘了挂卷/属主不对、systemd 里 StateDirectory 没配，
     * 这两类**部署形态**的失误会在进程起来的那一秒变成一条 **error** 日志，
     * 而不是一分钟里 60 条 warn 里的一条。失败**不**拒绝启动（落盘是增强，中继本身
     * 仍然可用），但它必须是全场最响的一行。
     */
    if (!persistNow()) {
      log.error('state file is not writable — pairing will NOT survive a restart', {
        path: config.stateFile,
        hint: 'check the directory exists and is writable by this process (systemd: StateDirectory=; docker: the /data volume owner)',
      })
    }
  }

  /** 真正写一次盘。返回是否成功——失败只计数，不抛（见 writeStateFile 的注释）。 */
  function persistNow(): boolean {
    if (!persistence.enabled) return false
    const ok = writeStateFile(config.stateFile, snapshotState(state, Date.now()), log)
    if (ok) {
      persistence.writes += 1
      persistence.savedAt = Date.now()
    } else {
      persistence.failures += 1
    }
    return ok
  }

  /**
   * 结构性变更后的落盘**请求**，而不是立刻落盘（2026-10-07 审计修，F6）。
   *
   * 为什么要合并：`markStateChanged()` 原来每次都同步写整个会话表，而它的一个调用点
   * 是 `resync` —— 而 `resync` 是**逐帧**可发的（主机只要连发，帧闸默认 500/s 全放行）。
   * 实测单次写的同步阻塞：10 / 100 / 1000 / 5000 条会话 = 0.20 / 0.27 / 0.59 / 2.22 ms，
   * 乘以 500 帧/秒就是 **10% / 13% / 29% / 111% 的整个事件循环**。事件循环被吃光之后，
   * 所有对端一起遭殃：ping 判定跟着停 → 被 `heartbeat timeout` terminate → 手机
   * 全体看到"连接已断开，正在重连"。一台**已认证**主机就能做到这件事。
   *
   * 合并窗口取 200 ms：结构性变更（建会话/删会话）仍然在"下一次事件循环的空隙"里落盘，
   * 崩溃最多丢 200 ms 的变更；而高频路径上它把写盘次数从"每帧一次"压到"每秒 5 次"。
   * 停机路径（`close()` / `forceShutdown()`）**不等**这个窗口，直接强制写。
   */
  /**
   * 立刻落盘。
   *
   * 这里**刻意不做合并/防抖**（2026-10-07 评估过一轮后否决）：配对那条路的注释写着
   * 「一次落盘换一次扫码，这个代价比什么都划算」，而配对表的规模有界（拓扑恒 1:1，
   * 会话数 ≈ 配对过的客户端数）。实测 5000 条会话时一次同步写 2.22 ms，而配对本身被
   * 全局配额 20/s 限着 → 最坏 4% 的事件循环，可以接受。
   *
   * 真正会被**逐帧**打爆的只有 @@resync@@（帧闸 500/s 全放行，主机连发即可）。
   * 实测 5000 条会话时每帧一次 resync 会让一次写占 **2.22 ms × 500 帧/秒 = 111% 的
   * 整个事件循环**，于是 ping 判定跟着停 → 所有对端被 heartbeat timeout terminate →
   * 手机全体「连接已断开，正在重连」。修法不是给所有写盘加延迟（那会把上面那条
   * 「配对立刻落盘」的保证一起削掉），而是按**语义**分：resync 删了会话、或者给某条
   * 会话打上了空会话回收计时，这两件事才立刻写；只刷新 lastActivityAt 的交给周期补写。
   */

  /**
   * 会话表发生**结构性**变化后立刻落盘（建/删会话、成员表变动）。
   *
   * 为什么只盯结构性变化、不盯每一帧：`lastActivityAt` 每转发一帧就更新，
   * 跟着它写就是每帧一次 fsync——那不是持久化，那是自造 DoS。
   * 它的保鲜交给周期性补写（见 sweep 里的 `maybePersistPeriodic`）。
   *
   * 为什么删除路径必须走它（纪律第 3 条）：只在"建"的时候写，删掉的会话会永远留在盘上，
   * 重启时又被读回来——**已经作废的会话被复活**，而主机那边的 `resync` 还要再花一轮
   * 才把它清掉。这正是验收第 5 条盯的那个失败模式。
   */
  function markStateChanged(): void {
    persistNow()
  }

  /**
   * ping 分桶轮转（C1）。桶数 = 心跳周期 / tick，每 tick 只 ping 一个桶。
   *
   * 为什么必须**建索引**而不是"每 tick 扫一遍全表挑出这一桶"：那样就把每 5 s 一次的
   * 10k 次 ping 换成了每秒 10k 次的**遍历**，扫描量反而涨 5 倍——C0 实测那 96 ms 阻塞
   * 主要来自遍历本身，那样等于没改。
   * 用 Set 而不是数组：`close` 时要按连接摘除，Set 的 delete 是 O(1)。
   */
  // `pingBucketCount` 在 config.ts 里已经夹到 ≤1024 并告警；这里再夹一道是
  // **防御纵深**：`createRelay(config)` 是个导出的函数，测试与将来的嵌入方可以
  // 直接构造一份 config 绕过 `loadConfig`（本仓的测试就这么干）。
  // 而 `Array.from({length: 1e9})` 抛的是 RangeError —— 那会让一个"配置写错"
  // 变成"进程起不来"，而 `main.ts` 只能报一句 fatal。
  // 取值与 config.ts 相同（1024），两处的一致由 `config.test.mjs` 那条判据守住。
  const MAX_PING_BUCKETS = 1024
  const pingBucketCount = Math.min(MAX_PING_BUCKETS, Math.max(1, Math.round(config.pingIntervalMs / config.pingTickMs)))
  const pingBuckets: Array<Set<Peer>> = Array.from({ length: pingBucketCount }, () => new Set<Peer>())
  let nextPingBucket = 0
  let currentPingBucket = 0

  /**
   * 所有索引都由 `% pingBucketCount` 得出，取不到只可能是代码被改错了。
   * 这里**宁可抛**，也不要退回一个临时 Set——那等于悄悄丢桶：那批连接从此不再被 ping，
   * 半开时占着槽位也没人收，而测试里只看得到"心跳好像正常"。
   */
  function bucketAt(index: number): Set<Peer> {
    const bucket = pingBuckets[index]
    if (!bucket) throw new Error(`ping 桶索引越界：${index} / 共 ${pingBucketCount} 桶`)
    return bucket
  }

  /**
   * 诊断计数（复核 A8）。`/healthz` 是运维唯一的观测面，而"帧被丢了""谁把谁踢了"
   * 以前只进日志——线上排"为什么手机不更新"时只能翻 journalctl。
   *
   * 三条都**只增不减**：它们是"自本次启动以来发生过多少次"，不是状态快照，
   * 所以不复用 `state.counts()`（那是瞬时值，会随连接进出上下浮动）。
   * 归零只发生在进程重启，这本身就是有意义的判据（"重启后计数没动"证明症状是存量问题）。
   *
   * - `droppedFrames`：中继**收下却没送出去**的帧（收件人不在），即 R1 那个静默黑洞的可见面。
   *   注意它不含路由被拒（`unknown_session`/`not_member`）——那些会回错误给发送方，不静默。
   * - `slowConsumers`：因发送缓冲超限被 1008 断开的对端。
   * - `rejectedPairs`：中继回过 `pair-fail` 的配对尝试次数（码错/过期/已用过/额度耗尽）。
   * - `shutdownForced`：5 秒兜底强退的次数（正常排空为 0）。兜底与排空成功同码 exit(0)，
   *   退出码分不出这两种停机，这是运维事后唯一能分辨的出口。
   */
  const counters = { droppedFrames: 0, slowConsumers: 0, rejectedPairs: 0, shutdownForced: 0 }

  // ── 发送 ────────────────────────────────────────────────────────────

  function sendTo(sock: Sock | undefined, frame: RelayFrame | Record<string, unknown>): void {
    if (!sock || sock.readyState !== WS_OPEN) return
    try {
      sock.send(JSON.stringify(frame))
    } catch (e) {
      log.warn('send failed', { message: String((e as Error)?.message ?? e) })
    }
  }

  function sendToPeer(peer: Peer | undefined, frame: RelayFrame | Record<string, unknown>): void {
    if (peer) sendTo(peer.ws, frame)
  }

  /**
   * 发给手机侧的**每一条 error 都必须带中文 message**（复核 R2）。
   * 客户端对未知 code 的处理是 `f.message || f.code`，没有 message 就是一条
   * 40 字宽的英文 toast——用户既看不懂也没有下一步。
   *
   * ## 为什么它只列**一部分**错误码（不是漏，是刻意的）
   *
   * 这张表的前提是"发给 client 的"，而有些码**只可能发给 host**：
   * `bad_token` / `need_host` / `bad_pair` / `bad_role` 全部发生在 `peer.role !== 'host'`
   * 或 `peer.role !== 'client'` 的守卫之后（判据 `tests/docs.test.mjs` 里逐条核过
   * 那些守卫），对端是主机插件而不是人 —— 它自己会打日志，给人看的中文没有意义。
   * 强行给它们补文案会让这张表**看起来覆盖了全部**而实际不是。
   *
   * ⚠️ 反过来，`unsupported_protocol` 必须在这张表里：版本闸在 `handleFrame`
   * 最前面，那一刻 `peer.role` 还是 `'unknown'`，而手机会把这句错误直接弹给用户 ——
   * 它属于"人会看到"的那一类，只是恰好在角色还没定的时候就已经要发出去。
   * （`acceptProtocol` 因此显式传了 message，不依赖这张表。）
   */
  const CLIENT_ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
    unknown_session: '会话已失效，请重新扫码配对',
    not_member: '这条指令不属于当前会话，请重新配对',
    host_unavailable: '主机暂时不在线，请稍后重试',
    rate_limited: '操作太快，请稍后再试',
    bad_frame: '有一帧数据不合法，已丢弃',
    bad_json: '收到无法解析的数据，已丢弃',
    unknown_frame: '对端版本不认识这个帧',
    pair_table_full: '配对表已满，请稍后再试',
    need_client: '需要先从手机侧发起配对',
    unsupported_protocol: '中继与手机的协议版本不兼容，请把小程序升级到最新版',
    internal: '中继内部错误',
  }

  function sendError(
    peer: Peer | undefined,
    code: ErrorCode,
    message?: string,
    userHint?: string,
    retryAfterMs?: number,
  ): void {
    // ⚠️ **`message` 只给 host 角色**（2026-10-07 审计补）。它是**技术细节**
    // （`frame "enc" has an invalid shape`、`ciphertext must be standard base64`），
    // 而客户端的处理是 `f.message || f.code` —— 一旦把英文原文发给手机，
    // 它就会**顶掉**下面那张中文表（`message` 优先），用户看到的是一句英文。
    // 而这些帧本不该出现在正常链路上，出现时对用户唯一有用的信息是"这条被丢了"。
    //
    // 修法不是"把细节翻译成中文"（那会造出第二套措辞、且日志里读不到原文），
    // 而是**按角色分流**：host 侧拿原文（插件日志与 status.json 排障靠它），
    // client 侧拿中文表那句。细节另记日志，两边都不丢。
    //
    // ⚠️ 判据是 `role !== 'host'`，**不是** `role === 'client'`：`hello` 之前
    //   role 还是 `'unknown'`，而那一段（JSON 解析失败、帧形状不对）恰恰是最容易
    //   发生、也最该给中文的地方 —— 用 `=== 'client'` 判会让它**漏成英文**，
    //   那正是这条要修的那个缺陷本身（实测：写 `=== 'client'` 时 bad_frame 的
    //   英文原文照旧到了手机上）。
    //
    // ## `userHint`：帧名是**用户也看得懂**的那部分信息
    //
    // "是哪条帧坏了"（`enc` / `peer-left` …）对排障有用，对用户也有用 ——
    // 它能让人判断"是我的小程序版本太老"还是"是网络那一头在发怪东西"。
    // 所以它不走 `message`（那条是英文技术细节），而走 `userHint`：
    // **中文表那句 + 括号里的帧名**，两边都不丢信息。
    // 这个区分不是洁癖：早期版本把 `frame "enc" has an invalid shape` 整句发到手机，
    // 用户看到的是一句英文；现在看到的是「有一帧数据不合法，已丢弃（enc）」。
    const toClient = peer?.role !== 'host'
    const base = toClient ? CLIENT_ERROR_TEXT[code] : message
    const text = toClient && userHint ? `${base ?? ''}（${userHint}）` : base
    if (toClient && message) {
      log.debug('frame rejected', { code, detail: message.slice(0, 120) })
    }
    /**
     * `retryAfterMs` **只给"等一等就好"的码**（2026-10-07 接线，规范 §12.2 E2）。
     *
     * 判据委托协议层（`wantsRetryAfter`），不在这儿再写一张表：哪些码值得带等待提示
     * 是**协议知识**，而"中继愿意等多久"是这边的事实——两者分开，谁都不会漂。
     *
     * 不带它的后果不是"少一个字段"：手机只能盲退避，而盲退避在"被拒 → 立刻重试 →
     * 又被拒"的循环里等于没退（`errors.ts` 的注释把这条写得很清楚）。
     * 反过来，给 `internal` 这种编不出等待时间的码硬塞一个数，比不带更糟——端点会**当真**。
     */
    const hint = wantsRetryAfter(code) ? retryAfterMs : undefined
    sendToPeer(peer, makeErrorFrame(code, text, hint))
  }

  /**
   * 慢消费者：发送缓冲**连续**超限达到**本角色的窗口**才断开，而不是无限堆积把中继内存吃掉。
   *
   * 两个关键点都是 DESIGN-REVIEW 第 11 条读码取证出来的（窗口的推导见 limits.ts）：
   * 1. 判定必须**定时驱动**（由 `sweep()` 调），不能只挂在 `ws.on('message')` 上：
   *    静默的慢客户端从不发帧，挂在入站路径上等于永不评估、缓冲区一直挂着；
   *    而"爱说话"的慢客户端反而被踢——判定挂错了地方，结果刚好是反的。
   * 2. 窗口必须**按角色给**：客户端侧的对端是"断开即重连"且 `onOpen` 会把退避清零，
   *    窗口短于它的重连周期就形成永不升级的 ~11s 抖动；而手机不读关闭码，
   *    用户只看到一句"连接已断开，正在重连…"，永远等不到恢复。
   */
  function noteBackpressure(peer: Peer, now: number): void {
    const buffered = (peer.ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0
    const windowMs = peer.role === 'client' ? config.slowConsumerClientMs : config.slowConsumerHostMs
    const verdict = peer.backpressure.check(buffered, config.maxBufferedBytes, now, windowMs)
    if (!verdict.shouldClose) return
    counters.slowConsumers += 1
    log.warn('slow consumer disconnected', {
      clientId: peer.clientId,
      hostId: peer.hostId,
      role: peer.role,
      buffered,
      overMs: verdict.overMs,
    })
    peer.ws.close(1008, 'slow_consumer')
  }

  // ── 控制面 ──────────────────────────────────────────────────────────

  /**
   * 同一 socket 二次 `hello` 且身份变了：先把上一次登记的键释放掉（P1-2）。
   *
   * 不释放的后果（2026-10-06 实测）：`attachClient` 每次 `set` 一个新键，而 `close`
   * 只按 `peer.clientId`（最后一次的值）调 `clientGone`——旧键**永远**留在
   * `state.clients` 里。于是**未认证**的对端只要在一条连接上连发 N 个不同 clientId 的
   * `hello`，就能让这张 Map 无界增长；`/healthz` 的 `clients` 也永久虚高
   * （实测：单连接 3000 个 clientId → clients:499，socket 关掉后仍是 499）。
   * `attachHost` 形状相同，只是它需要 token（把同样的泄漏留给了一条已认证的连接）。
   *
   * 释放走的就是正常离场的那两条路（`clientGone` / `hostGone`），语义完全一致：
   * 客户端换 id 要向它所在会话的主机发 `peer-left`；主机换 id 会给自己名下的会话
   * 打上宽限期计时——因为这条 socket 确实不再服务于旧身份了。
   */
  function releaseIdentityFor(peer: Peer, next: { role: 'host' | 'client'; id: string }): void {
    const sameIdentity =
      peer.role === next.role && (next.role === 'client' ? peer.clientId === next.id : peer.hostId === next.id)
    if (sameIdentity) return
    if (peer.role === 'client' && peer.clientId) {
      const old = peer.clientId
      for (const notice of state.clientGone(old, peer.ws)) {
        sendTo(state.hostSocket(notice.conversationId), peerLeftFrame(notice.conversationId, notice.clientId))
      }
      /**
       * ⚠️ **再把旧 clientId 从所有会话的成员表里摘掉**（2026-10-07 补）。
       *
       * `clientGone` **刻意不动成员表**——那是 D3 的机制：socket 断开时手机还可能
       * 用同一个 clientId 回来，会员关系必须留着。
       *
       * 但 re-hello 是**换身份**，不是断开：这条 socket 从此不再服务旧身份，
       * 旧 clientId 也**永远不会回来**（新 clientId 已经在另一条会话上了）。
       * 于是"留着成员"那条 D3 理由在这里不成立，而后果是：
       * 实测配对后（成员 `mem0`）连发 4 次换 id 的 hello → 成员恒为 `mem0`、
       * `emptySince` 恒为 undefined ⇒ **`sweepEmpty` 完全失效**（那条 P2-⑤ 默认
       * 30 分钟回收空会话），唯一兜底是 7 天的 `sweepIdle`，`/healthz` 的
       * `conversations` 长期虚高。
       *
       * 上面那段 `server.ts` 的注释说"换 id 要向它所在会话的主机发 `peer-left`"
       * ——通知发了，**成员没摘**，而回收判据读的是成员表。
       *
       * 复用 `leaveAll` 而不是新写一个：它已经带 `markEmpty`，而那正是让
       * `sweepEmpty` 重新开始计时的唯一入口。
       */
      for (const conversationId of state.leaveAll(old)) {
        state.touchConversation(conversationId)
      }
      log.info('client identity released by re-hello', { clientId: old })
    }
    if (peer.role === 'host' && peer.hostId) {
      if (state.hostGone(peer.hostId, peer.ws)) log.info('host identity released by re-hello', { hostId: peer.hostId })
    }
    peer.role = 'unknown'
    peer.clientId = undefined
    peer.hostId = undefined
  }

  function handleHello(peer: Peer, frame: Extract<EndpointFrame, { t: 'hello' }>): void {
    // 版本闸已经放过这一帧（`handleFrame` 最前面），这里**只把版本记在连接上**，
    // 让后续那些不带该字段的帧仍按对端的真实版本判定（见 `Peer.protocol` 的注释）。
    // 记 `frame.protocol` 而不是判定的结果：不报字段的老端点在闸里按 1 处理，
    // 这里也要存成 `undefined` 而不是 1 —— 否则 `/healthz` 会把"没报"说成"报了 1"。
    //
    // ⚠️ 计数**只在第一次 hello 时记**（2026-10-07 修）。re-hello 是设计内行为
    // （换身份，见 releaseIdentityFor），而原来每收一个 `hello` 就 +1、`close` 只 −1
    // —— 于是 N 次 hello 只抵消 1 次，`peerProtocols.size === 0`（"当前没有对端"）
    // 这条判据**永久失效**，未认证对端单连接发 500 个 hello（帧闸 500/s 全放行）
    // 就能把计数推高 500。
    //
    // 正确形状是"**连接**记一次"，而 `close` 天然每条连接只减一次 —— 两边同口径。
    // 版本变了（re-hello 报了另一个 protocol）时先减旧的那个再加新的，那才是
    // "这条连接此刻报的版本"在计数表里的位置。
    if (peer.protocol === undefined && !peer.countedProtocol) {
      peer.countedProtocol = true
      if (frame.protocol === undefined) peersWithoutProtocol++
      else peerProtocols.set(frame.protocol, (peerProtocols.get(frame.protocol) ?? 0) + 1)
    } else if (peer.protocol !== frame.protocol) {
      // 同一条连接换了版本：把旧的那个减掉。
      if (peer.protocol === undefined) peersWithoutProtocol = Math.max(0, peersWithoutProtocol - 1)
      else {
        const left = (peerProtocols.get(peer.protocol) ?? 1) - 1
        if (left > 0) peerProtocols.set(peer.protocol, left)
        else peerProtocols.delete(peer.protocol)
      }
      if (frame.protocol === undefined) peersWithoutProtocol++
      else peerProtocols.set(frame.protocol, (peerProtocols.get(frame.protocol) ?? 0) + 1)
    }
    peer.protocol = frame.protocol
    if (frame.role === 'host') {
      if (!config.hostToken) {
        sendError(peer, 'internal', 'relay has no host token configured')
        peer.ws.close(1011)
        return
      }
      if (!frame.token || !tokenMatches(config.hostToken, frame.token)) {
        peer.authAttempts += 1
        // 只记"第几次失败"，绝不记token 的任何片段。
        log.warn('host auth failed', { attempts: peer.authAttempts })
        sendError(peer, 'bad_token')
        if (peer.authAttempts >= config.maxHostAuthAttempts) peer.ws.close(4001, 'too_many_auth_attempts')
        return
      }
      const hostId = frame.hostId?.trim() || newHostId()
      releaseIdentityFor(peer, { role: 'host', id: hostId })
      const { replaced } = state.attachHost(hostId, peer.ws, frame.label ?? '')
      peer.role = 'host'
      peer.hostId = hostId
      sendToPeer(peer, helloOkForHost(hostId, frame.protocol))
      log.info('host online', { hostId, label: frame.label ?? '', replaced: replaced ? 1 : 0 })
      if (replaced) replaced.close(CLOSE_REPLACED, 'replaced_by_newer_socket')
      // 这里曾经把该主机名下的会话以 `peer-joined` 重放给已连接的客户端（"主机回来了"）。
      // 2026-10-06 删除，理由两条，都是读码取证的：
      // 1. 随仓发布的 mp 客户端 `_onFrame` 里**没有** peer-joined 分支，落进 default 被
      //    静默忽略——中继为一个不存在的消费者维护一条通知路径；
      // 2. 那条帧把 hostId 塞进了 clientId 字段，语义就是错的（peer-joined 是"有人进来"，
      //    这里表达的是"主机回来了"，客户端真按它处理会认错人）。
      // 客户端续用旧 convId 的真正路径是 `hello-ok` → `cmd.list_sessions`，不依赖这条重放。
      return
    }

    if (frame.role === 'client') {
      // 客户端自带 clientId 时**原样保留**：小程序冷启动后仍会用存储里那个 installId，
      // 若这里另发一个，D3 的重挂与 D4 的成员校验会在下次冷启动时永远对不上。
      const clientId = frame.clientId?.trim() || randomUUID()
      releaseIdentityFor(peer, { role: 'client', id: clientId })
      const { replaced } = state.attachClient(clientId, peer.ws)
      peer.role = 'client'
      peer.clientId = clientId
      if (replaced) {
        // 复核 R3：同 clientId 的旧连接必须被顶掉，否则真手机的 socket 还"开着"
        // 却再也收不到路由，而且因为它不觉得断开，也不会重连。
        log.warn('client replaced by newer socket', { clientId })
        replaced.close(CLOSE_REPLACED, 'replaced_by_newer_socket')
      }
      sendToPeer(peer, helloOkForClient(clientId, frame.protocol))
      log.info('client online', { clientId, platform: frame.clientMeta?.platform })
      return
    }
    // 走到这里是不可能的：`helloFrame` 的 role 是 z.enum(['host','client'])，
    // 两个分支都 return 了。以前这里补一条 `sendError(peer, 'bad_role')`，
    // 那是在防自家 schema，不是在防对端。
  }

  function handlePairBegin(peer: Peer, frame: Extract<EndpointFrame, { t: 'pair-begin' }>): void {
    if (peer.role !== 'host' || !peer.hostId) {
      sendError(peer, 'need_host')
      return
    }
    const issued = state.issuePair(peer.hostId, frame.pairingToken, config.pairTtlMs)
    if (!issued.conflict) {
      if (!issued.ok) {
        sendError(peer, 'pair_table_full')
        // ⚠️ **只记一次**（2026-10-07 补，与 notedFrameFlood / notedNonMember 同纪律）。
        // 这条判定是**逐帧**的（表满时每次 issuePair 都回 full），而帧闸 500/s 全放行
        // ⇒ 实测一条已认证主机连发 400 个 pair-begin 就是 **400 行** journald。
        // 而 journald 的条数额度被打满时，中继**自己的**诊断日志会被一起抑制 ——
        // 正是 log.ts 文件头记录的那起事故的同一通路。
        if (!peer.notedPairTableFull) {
          peer.notedPairTableFull = true
          log.warn('pair table full', { hostId: peer.hostId })
        }
        return
      }
    } else {
      // 这个 token 是**另一台主机**发出来的（共享同一个 DRC_HOST_TOKEN 时可能发生）。
      // 旧写法会静默把条目改写成调用方，于是"扫 A 屏幕上的码、配到 B"，
      // 而且用户与两边的主机都不会看到任何异常。现在明确拒绝并留痕。
      log.warn('pair token belongs to another host, refused', {
        hostId: peer.hostId,
        token: REDACTED,
      })
      sendError(peer, 'bad_pair', 'this pairing token was issued by another host')
      return
    }
    // **服务端权威 TTL**：主机必须据此改写本地过期时间（旧实现的第一起事故）。
    sendToPeer(peer, pairReadyFrameOf(frame.pairingToken, config.pairTtlMs))
    // D2：info 级不落完整配对码。需要排错时开 debug。
    log.info('pair token issued', { hostId: peer.hostId, token: REDACTED, ttlMs: config.pairTtlMs })
    log.debug('pair token issued (debug)', { hostId: peer.hostId, pairingToken: frame.pairingToken })
  }

  function handlePairClaim(peer: Peer, frame: Extract<EndpointFrame, { t: 'pair-begin-client' }>): void {
    if (peer.role !== 'client' || !peer.clientId) {
      sendError(peer, 'need_client')
      return
    }
    if (!pairBudget.take(Date.now())) {
      // 手机上 `translatePairFail` 只认四个 reason（F6 的冻结消费面），所以我们不能把
      // 内部原因 `rate_limited` 直接写进 pair-fail —— 那会把英文字面量弹给用户。
      // 对用户有意义且成立的只有"这张码现在配不上"，真正的限速原因进日志给运维。
      counters.rejectedPairs += 1
      sendToPeer(peer, pairFailFrameOf('invalid_or_expired', frame.pairingToken))
      // **每秒最多一行**（见 Peer 上那三道闩锁）。旧写法逐帧记：配额用尽的那一秒里
      // 单条连接能写 ~480 行，200 条连接就是 ~10 万行/秒 —— journald 按条数额度
      // （RateLimitBurst=10000）打满之后，**中继自己的正常诊断日志被一起丢掉**，
      // 而"限配了"这件事恰好是最需要留痕的那一类。
      //
      // 出站那条 pair-fail 仍然是逐帧的：它是给对端的**功能性**答复（对端要靠它
      // 停止重试），不是日志。
      const now = Date.now()
      if (now - peer.pairBudgetWarnedAt >= 1000) {
        peer.pairBudgetWarnedAt = now
        log.warn('pair budget exhausted (global)', { clientId: peer.clientId, reason: 'rate_limited' })
      }
      return
    }
    const claimed = state.claim(frame.pairingToken, peer.clientId)
    if (!claimed.ok) {
      peer.pairAttempts += 1
      counters.rejectedPairs += 1
      sendToPeer(peer, pairFailFrameOf(claimed.reason, frame.pairingToken))
      log.info('pair failed', {
        clientId: peer.clientId,
        reason: claimed.reason,
        attemptsLeft: Math.max(0, config.maxPairAttemptsPerConn - peer.pairAttempts),
      })
      if (peer.pairAttempts >= config.maxPairAttemptsPerConn) {
        peer.ws.close(4008, 'too_many_pair_attempts')
      }
      return
    }
    peer.pairAttempts = 0
    // 同一台手机重配到新会话时，它在旧会话里的成员记录已经被 claim 摘掉了（🟡7）。
    // 这里补上对旧主机的告知：与"客户端显式 session-leave"走同一条通知（`peer-left`），
    // 主机才知道少了这个观众，不必再往那个会话里推。（会话本身仍归主机。）
    for (const old of claimed.detached) {
      // 同样标 unpaired：这台手机已经带着**新**的 convId 走了，旧会话在主机那边
      // 再也不会有人回来，不标的话那条幽灵会一直挂在 pill 上。
      sendTo(state.hostSocket(old), peerLeftFrame(old, peer.clientId, true))
    }
    sendToPeer(peer, pairedFrameOf(claimed.conversationId, claimed.hostId))
    // 发给主机的那一条**必须带 pairingToken**：主机按它取自己那份 PSK（多码并存事故）。
    sendToPeer(peerOfHost(claimed.hostId), peerJoinedForHost(claimed.conversationId, peer.clientId, frame.pairingToken))
    // 配对是**运行期唯一的会话创建点**（第二个入口是启动读回），所以它是落盘的关键时刻：
    // 这一次不写，下一次落盘之前中继重启，这条刚建立的配对就随内存一起没了。
    // 一次落盘换一次扫码，这个代价比什么都划算。
    markStateChanged()
    log.info('paired', {
      sessionId: claimed.conversationId,
      hostId: claimed.hostId,
      clientId: peer.clientId,
      ...(claimed.detached.length > 0 ? { detachedFrom: claimed.detached.length } : {}),
    })
  }

  function peerOfHost(hostId: string): Peer | undefined {
    const entry = state.hosts.get(hostId)
    return entry ? peers.get(entry.ws as unknown as WebSocket) : undefined
  }

  // ── 数据面 ──────────────────────────────────────────────────────────

  function forwardEnc(peer: Peer, frame: Extract<EndpointFrame, { t: 'enc' }>): void {
    const rejected = state.routeFrom(frame.sessionId, peer.ws, peer.role)
    if (rejected) {
      sendError(peer, rejected)
      // 同样只记一次：这条判定是逐帧的，而一个持有（或曾经持有）某个 convId 的
      // 对端可以拿它当探针连打几百帧。
      if (rejected === 'not_member' && !peer.notedNonMember) {
        peer.notedNonMember = true
        log.warn('enc from non-member', { sessionId: frame.sessionId, clientId: peer.clientId, role: peer.role })
      }
      return
    }
    if (peer.role === 'client') {
      // 上行：原样透传给主机，并补上"是哪个客户端"（主机按它做 per-client 回调）。
      const host = state.hostSocket(frame.sessionId)
      if (!host) {
        // 会话还在、主机暂时不在（宽限期内）。这里**绝不能**回 `unknown_session`——
        // 客户端见到它就会丢配对、要求重新扫码，而它只要等主机回来再发一次即可。
        counters.droppedFrames += 1
        sendError(peer, 'host_unavailable')
        return
      }
      // ⚠️ `encToRelay` 的参数表里**没有 clientId**，而这一帧必须带
      // （主机按它做 per-client 回调，见 relay.ts 的 onCommand 第三参）。
      // 协议层的构造器是给**端点**用的——端点发的 enc 帧不带 clientId，
      // 那是中继转发时才补的，属于中继自己的转发语义。所以这里扩一个可选参数：
      // 它在 schema 里本来就是可选字段（`frames.ts` 的 encFrame.clientId），
      // 而"手写 `{t:'enc',…}`"意味着 sessionId/seq/ciphertext 三个字段名
      // 在本文件里又抄了一遍——改字段不会有编译错误。
      sendTo(host, encToRelay(frame.sessionId, frame.seq, frame.ciphertext, peer.clientId))
      state.touchConversation(frame.sessionId)
      return
    }
    // 下行：中继重新编号（客户端不信 seq 的单调性，但编号让审计与合并可写）。
    const seq = state.nextHostSequence(frame.sessionId)
    const sockets = state.clientSockets(frame.sessionId)
    // 会话还在、一个观众都没有：这一帧没有收件人。**必须计数**——R1 的静默黑洞
    // 就是"主机往一个没有钥匙的对端推"，它在日志里不留痕，只能靠这个计数被发现。
    if (sockets.length === 0) counters.droppedFrames += 1
    for (const sock of sockets) {
      if (seq !== undefined) sendTo(sock, encToClient(frame.sessionId, seq, frame.ciphertext))
    }
  }

  function forwardEncBatch(peer: Peer, frame: Extract<EndpointFrame, { t: 'enc-batch' }>): void {
    const rejected = state.routeFrom(frame.sessionId, peer.ws, peer.role)
    if (rejected) {
      sendError(peer, rejected)
      return
    }
    // 小程序逐项只读 `items[i].ciphertext` 并复用外层 sessionId，所以外层必须保持单个。
    const clients = state.clientSockets(frame.sessionId)
    if (peer.role === 'client') {
      const host = state.hostSocket(frame.sessionId)
      if (!host) {
        // 与单帧路径（forwardEnc）**逐条对齐**：会话还在、主机暂时不在时
        // 既要回 `host_unavailable`（客户端才知道"这条没人接、等等再发"），
        // 也**不能** touchConversation——那一帧根本没送到任何人手上，给它续命
        // 等于让一条没人接的会话在空闲 TTL 上永不过期（P2 的不对称缺陷）。
        counters.droppedFrames += 1
        sendError(peer, 'host_unavailable')
        return
      }
      // ⚠️ 批量帧**不带** clientId，而单帧带（`encToRelay` 那条）。这不是漏写：
      // `encBatchFrame` 的 schema 里压根没有 `clientId` 字段（F 契约），
      // 中继要加就得改协议，而批量帧的用途是"一帧装多条正文"，
      // 主机按会话而非按客户端处理它。加字段前先确认主机侧真的需要 per-client 语义。
      sendTo(host, encBatchToRelay(frame.sessionId, frame.items))
      state.touchConversation(frame.sessionId)
      return
    }
    // 下行批量帧由中继逐条编号（客户端只看 ciphertext，但编号让"帧数不膨胀、顺序不乱"
    // 这类审计断言可写）。编号失败说明会话在飞行中被删了——那这一批就不该再发出去。
    if (clients.length === 0) counters.droppedFrames += 1
    const items: Array<{ seq: number; ciphertext: string }> = []
    for (const item of frame.items) {
      const seq = state.nextHostSequence(frame.sessionId)
      if (seq === undefined) return
      items.push({ seq, ciphertext: item.ciphertext })
    }
    for (const sock of clients) sendTo(sock, encBatchToClient(frame.sessionId, items))
  }

  let lastResyncPersistAt = 0
  /**
   * 已连上的对端各自报的协议版本 → **计数**（`/healthz` 的观测面，见 health()）。
   *
   * ## 为什么是 Map<版本, 计数> 而不是 Set<版本>
   *
   * 连接会断开，而两个对端**可以报同一个版本**（现网所有小程序都是 1）。
   * `Set` 只能加不能减 ⇒ 要么在断开时删掉那个版本（于是把仍在连接的另一个对端
   * 也一起抹了，`peerProtocolMin` 忽然变成 -1），要么留着不动（**无界增长** ——
   * 那正是「客户端身份键无界泄漏」那条事故的形状，不能在观测面上重犯）。
   *
   * 所以按版本计数：断开时减一，归零时删键。`peerProtocols.size === 0` 就是
   * "当前没有对端"的判据，语义干净。
   */
  const peerProtocols = new Map<number, number>()
  let peersWithoutProtocol = 0

  /**
   * 协议版本闸（规范 §5.2 V3；GAP-2）。
   *
   * 判定全部委托给协议层的 `negotiateProtocol` —— **中继不自己算版本区间**，
   * 那正是这份改造要消掉的那类重复（同一个数在两处各写一遍，改一处不改另一处）。
   *
   * 为什么值得加：改造之前 `hello.protocol` **从未被读过**，实测一份
   * `protocol: 999` 的 hello 会照常握手成功。于是版本不兼容的现场表现是
   * "连上了、界面正常、什么都不发生"——没有一层会报错，日志里也什么都没有。
   * 把"不兼容"变成一句明说，是这一闸的全部价值。
   *
   * @param peerProtocol 非 `hello` 帧用 `peer` 上记下的那一次（`hello` 只发一次，
   *   之后的帧都靠 peer 记着 —— 不记的话 `ping` 之类会因为"没带版本"而被当 1 处理，
   *   那与对端真实版本无关，是一种更难查的错配）。
   * @returns true = 放行
   */
  function acceptProtocol(peer: Peer, peerProtocol: unknown): boolean {
    const verdict = negotiateProtocol(peerProtocol)
    // `verdict.missing`（V1 老端点没报版本）**不额外记账**：`peer.protocol === undefined`
    // 本身就是那个事实，`/healthz` 的 `peersNoProtocol` 直接数它。曾经另有一个
    // `peer.protocolMissing` 字段专门存它，但它**从来没有被读过**——同一件事的两份
    // 记账迟早会分叉，而这一份连分叉都不会有人发现。
    if (verdict.ok) return true
    // 显式带 message：此刻 `peer.role` 还没设（hello 走这条闸时），所以
    // `CLIENT_ERROR_TEXT` 那张**客户端**表在这里取不到 —— 依赖它就会发出一个空 message，
    // 而客户端的处理是 `f.message || f.code` ⇒ 用户看到一句英文码。
    sendToPeer(peer, makeErrorFrame('unsupported_protocol', verdict.message))
    log.info('handshake rejected', { reason: verdict.reason, peer: String(verdict.peer).slice(0, 16) })
    // 用 1002（协议错误）而不是默认的 1000：这一条**不是**正常关闭，
    // 而是"我们说不了话"。客户端本来也不会因为它报未连接（它只认 hello-ok）。
    peer.ws.close(1002, 'unsupported_protocol')
    return false
  }

  function handleFrame(peer: Peer, frame: EndpointFrame): void {
    switch (frame.t) {
      case 'hello':
        // ⚠️ **协议版本闸在这里**（2026-10-07 补，GAP-2），而它**只挡 `hello`**。
        //
        // 实证（`tests/handshake.test.mjs` 里那条）：改造之前，发一份
        // `hello{protocol: 999}` 会**照常收到 `hello-ok`** —— 中继从头到尾没读过
        // `hello.protocol`。而这正是 `negotiate.ts` 文件头说的"最贵的一类故障"：
        // 版本不兼容表现为"连上了、界面正常、什么都不发生"，没有任何一层会报错。
        //
        // 为什么放在 `case 'hello'` 里、而不是 `handleFrame` 最前面（2026-10-07 订正）：
        // ① **只有 `hello` 带版本字段**，闸放在别处对业务帧毫无作用（`negotiateProtocol(undefined)`
        //    按 1 放行）；
        // ② 一个报 999 的对端**在 `hello` 这一刻就被拒并关掉**（1002），它的业务帧
        //    根本没机会到达——所以"逐帧再判一次"是**多余的**，不是更严；
        // ③ 反过来，把闸放到最前面会让**未认证**的连接拿到 `unsupported_protocol`
        //    这种错误的码（它真正的问题是没握手），排错时指向错的方向。
        // 这里曾经写着"它是所有帧的入口"——那句话描述的是一个**不存在**的行为。
        //
        // `peer.role` 在 hello 这一帧还没设，所以下面 `acceptProtocol` 显式带 message，
        // 不依赖 `CLIENT_ERROR_TEXT` 那张按角色分流的表（见那里的注释）。
        if (!acceptProtocol(peer, frame.protocol)) return
        return handleHello(peer, frame)
      case 'pair-begin':
        return handlePairBegin(peer, frame)
      case 'pair-begin-client':
        return handlePairClaim(peer, frame)
      case 'resync': {
        // 复核 R1：主机(重)启动后声明它还持有密钥的会话。
        // 没列出的会话直接删掉，**但必须告诉那些客户端**（2026-10-07 修，见下）。
        if (peer.role !== 'host' || !peer.hostId) {
          sendError(peer, 'need_host')
          return
        }
        const { kept, dropped, droppedMembers, emptyAtRisk } = state.resync(peer.hostId, frame.sessionIds)
        /**
         * 被删掉的会话要向它的成员发 `peer-left`——与主机宽限期到期（`sweep`）、
         * 主机显式 `session-leave` 这两条路**同一个口径**。
         *
         * 原来这里不发，理由是"客户端下一次发帧会撞 `unknown_session`，照样能拿到中文提示"。
         * 那条出口成立，但它是**被动**的：手机此刻停着不动，界面上一切正常，而它其实
         * 连着一个已经没有钥匙的对端；直到用户某一次点了发送，才在 12 秒后知道。
         * 三条路里只有这一条是哑的，而这条恰恰是主机**重启过**（最常见的那种）会走的。
         *
         * 用 `hostId` 而不是 `clientId` 作 peer-left 的第二个参数：这一路与
         * `session-leave` 的主机分支一致——对手机来说语义都是"主机不要这条会话了"，
         * 而它只按 `sessionId` 过滤（见 mp 的 `_onFrame`）。
         */
        for (const member of droppedMembers) {
          for (const clientId of member.clientIds) {
            sendTo(state.clients.get(clientId)?.ws, peerLeftFrame(member.conversationId, peer.hostId))
          }
        }
        if (dropped.length > 0) {
          const told = droppedMembers.reduce((sum, one) => sum + one.clientIds.length, 0)
          log.info('conversations dropped at host resync', {
            hostId: peer.hostId,
            kept,
            dropped: dropped.length,
            clientsNotified: told,
          })
        }
        // resync 有三种后果，两种要进盘：
        // ① 删会话（dropped）—— 永久删除，不写就会在重启后被复活；
        // ② 给空会话保证回收计时（emptyAtRisk）—— HANDOFF 0.10.5 第 4 条修过的那条：
        //    不写的话盘上会留着一个「还空着、却没开始计时」的会话，重启后 restoreState
        //    按「此刻起算」补上计时，空会话回收被推迟整整一个 TTL；
        // ③ 只刷新 lastActivityAt —— 不写，交给周期性补写（DRC_STATE_SAVE_MS，
        //    它存在的理由就是刷新这一个字段）。
        //
        // ② 要限流而 ① 不要（见 RESYNC_PERSIST_MIN_GAP_MS 的注释）：resync 是**逐帧**
        // 可发的，落盘是同步写整张表，实测 5000 条会话时 2.22 ms/次；主机以帧闸允许的
        // 500 帧/秒连发，删会话那条路天然有界（每个会话只会被删一次），而②没有。
        const now = Date.now()
        if (dropped.length > 0) {
          lastResyncPersistAt = now
          markStateChanged()
        } else if (emptyAtRisk > 0 && now - lastResyncPersistAt >= RESYNC_PERSIST_MIN_GAP_MS) {
          lastResyncPersistAt = now
          markStateChanged()
        }
        return
      }
      case 'enc':
        return forwardEnc(peer, frame)
      case 'enc-batch':
        return forwardEncBatch(peer, frame)
      case 'session-leave': {
        /**
         * 两条完全不同的路，共用一帧（复核 R1）：
         * - 客户端发：它离开这个会话，主机收到 peer-left 只是"少了一个观众"，会话保留；
         * - 主机发：**作废**这个会话。主机重启后密钥没了、或它连续解不开某一会话时走这条。
         *   此时必须向该会话的所有客户端发 peer-left，手机才会中文提示"主机已断开，
         *   请重新配对"并停在这里等用户，而不是继续把密文发给一个没有钥匙的对端
         *   ——那才是真正的静默黑洞。
         */
        if (peer.role === 'host' && peer.hostId) {
          const conv = state.conversations.get(frame.sessionId)
          if (!conv || conv.hostId !== peer.hostId) return
          const dropped = state.dropConversation(frame.sessionId)
          for (const clientId of dropped?.clientIds ?? []) {
            sendTo(state.clients.get(clientId)?.ws, peerLeftFrame(frame.sessionId, peer.hostId))
          }
          log.info('conversation voided by host', {
            sessionId: frame.sessionId,
            clients: (dropped?.clientIds ?? []).length,
          })
          // 主机作废 = 永久删除。不同步删盘的话重启会把它读回来（验收第 5 条）。
          markStateChanged()
          return
        }
        if (!peer.clientId) {
          sendError(peer, 'need_client')
          return
        }
        const removed = state.leave(peer.clientId, frame.sessionId)
        if (removed) {
          // unpaired=true：这一条是**用户主动解的**，不是掉线。
          // mp 的 unpair() 会立刻 _forgetPairing() 清掉 convId，它再也不会回来了，
          // 主机留着这条会话就只剩一条永远清不掉的幽灵，pill 于是永远说「手机离线」
          // （2026-10-05 用户报）。socket 关闭那条路**不带**这个标记 —— 那条是掉线，
          // D3 要求会话留着，回前台还要用同一把钥匙。
          sendTo(state.hostSocket(frame.sessionId), peerLeftFrame(frame.sessionId, peer.clientId, true))
          // 成员表变了（少一个人），且可能顺带打上了空会话回收计时——两者都要落盘。
          markStateChanged()
        }
        return
      }
      case 'ping':
        return sendToPeer(peer, pongFrameOf(frame.ts))
      default:
        return sendError(
          peer,
          'unknown_frame',
          String((frame as { t?: string }).t),
          String((frame as { t?: string }).t),
        )
    }
  }

  // ── 连接生命周期 ────────────────────────────────────────────────────

  /**
   * 拒掉一条连接的统一出口（2026-10-07 审计修，**未认证可达**）。
   *
   * `ws.on('error')` 必须在 close **之前**挂上。早期两条早退分支（停机中 / 超连接数）
   * 直接 `ws.close()` 就 return，从未挂过监听器——而 EventEmitter 没有 `error` 监听器
   * 时，`emit('error')` 本身**同步抛**。于是这样一条连接只要在握手后再发一帧
   * 畸形帧（超 `maxPayload`、RSV 位非零、非法 UTF-8……），ws 内部的
   * `emitErrorAndClose` 就会把整个中继带崩：`uncaughtException` → exit 1 →
   * `Restart=always` 拉起 → **内存里的配对表清零**，所有手机回到电脑前重扫，
   * 而且可以无限重复（它不需要任何凭据，只要先把连接数顶满）。
   *
   * 复现方式与对照组见 `tests/hardening.test.mjs`：同一条畸形帧在正常连接上
   * 只被捕获（已有监听器），在被拒连接上会让进程带着 exit 42 消失。
   */
  function rejectConnection(ws: WebSocket, code: number, reason: string): void {
    ws.on('error', (e: Error) => log.warn('socket error', { message: String(e?.message ?? e) }))
    ws.close(code, reason)
  }

  function onConnection(ws: WebSocket): void {
    if (shuttingDown) {
      rejectConnection(ws, 1013, 'server_shutdown')
      return
    }
    // 计数**必须**是 `wss.clients.size` 本身：这条回调跑的时候 `ws` 已经被
    // `WebSocketServer` 加进 `clients`（ws 在 `completeUpgrade` 里先 `clients.add(ws)`
    // 再回调），旧写法 `+ 1` 把新连接算了两次 → `DRC_MAX_CONNS=3` 实际只收 2 条。
    if (wss.clients.size > config.maxConnections) {
      rejectConnection(ws, 1013, 'server_busy')
      return
    }
    const peer: Peer = {
      ws,
      role: 'unknown',
      rate: new FrameRateGate(config.maxFramesPerSec),
      authAttempts: 0,
      pairAttempts: 0,
      // 下面三条"只记一次"闩锁：限流与限配是**逐帧**触发的，日志与出站帧若也逐帧，
      // 一条未认证连接就能把 journald 的条数额度吃干净（见各自注释）。
      notedFrameFlood: false,
      notedNonMember: false,
      notedPairTableFull: false,
      pairBudgetWarnedAt: 0,
      backpressure: new BackpressureGate(),
      alive: true,
      // 观测面计数的闩锁（见 Peer.countedProtocol）：连接为单位，不是 hello 为单位。
      countedProtocol: false,
      // 轮转序号取模分配：**均匀是刻意的**。哪怕重启风暴里 10k 条连接在几十秒内
      // 全建起来，它们也会摊到所有桶上；若改成"分给下一个将要轮到的桶"，
      // 风暴会把它们全塞进同一两个桶，等于把刚拆掉的突发又造回来（C7 的场景）。
      pingBucket: (nextPingBucket = (nextPingBucket + 1) % pingBucketCount),
    }
    peers.set(ws, peer)
    bucketAt(peer.pingBucket).add(peer)
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      const now = Date.now()
      // 两个判定不共用一个变量名：帧闸那个叫 rateVerdict，帧判定那个叫 verdict。
      // 原来它们都叫 `verdict`，靠 `const` 的块级作用域各自成立——但同一个
      // 回调里两个同名 const 相邻，读的人会以为下面 `!verdict.ok` 判的是帧闸。
      const rateVerdict = peer.rate.check(now)
      if (!rateVerdict.allowed) {
        // 帧闸是**固定 1 秒窗口**（见 FrameRateGate），所以"还要等多久"就是这一秒的余量。
        // 带一个具体的数（而不是让手机自己猜）正是 §12.2 E2 要的：端点据此退避一轮就够，
        // 不必从一个编出来的常数开始试。下限取 1ms——`retryAfterMs` 必须是正整数，
        // 恰好卡在秒边界时 `1000 - (now % 1000)` 会是 1000，不会到 0，但这条夹取是防
        // 将来窗口变短时静默发出 0 或负数（那会让 makeError 直接抛）。
        const retryAfterMs = Math.max(1, 1000 - (now % 1000))
        if (rateVerdict.shouldReport) sendError(peer, 'rate_limited', undefined, undefined, retryAfterMs)
        if (rateVerdict.shouldClose) {
          // 只记一次（见 Peer 上那三道闩锁的注释）：close 是优雅的，对端在这段
          // 窗口里继续灌帧，旧写法每帧一行，实测单连接 1.1s / 29.9 万行。
          if (!peer.notedFrameFlood) {
            peer.notedFrameFlood = true
            log.warn('frame flood disconnected', {
              clientId: peer.clientId,
              hostId: peer.hostId,
              role: peer.role,
              violations: peer.rate.violationCount,
            })
          }
          ws.close(1008, 'rate_limited')
        }
        return
      }
      // 帧必须是文本：小程序把 onMessage 的 data 直接交给 JSON.parse，
      // 收到二进制就是静默丢弃。所以这里必须明确拒绝，并且报得比"JSON 坏了"更准。
      if (isBinary) {
        sendError(peer, 'bad_frame', 'binary frames are not supported')
        return
      }
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : undefined
      if (text === undefined) {
        sendError(peer, 'bad_frame', 'unsupported frame payload type')
        return
      }
      /**
       * **七步分级判定委托协议层**（2026-10-07 接线）。
       *
       * 原来这里是本文件里内联的一整套：自己 `JSON.parse`、手抄一份帧名表、
       * 自己分"名字不认识（unknown_frame）/ 名字对但形状坏（bad_frame）"、
       * 再自己写一遍密文字符集预检。同一份协议知识在本文件里出现了两次
       * （帧名表 + 字符集函数），改协议时要人肉同步两处，而漏掉任何一处都不会编译失败。
       *
       * `classifyEndpointFrameText` 把它们收成**一个返回值**：这里只剩
       * "照 reason 发对应的 error"（映射表写在 classify.ts 的文件头）。
       * 两条配对特例也归它管——`pair-begin-client` 的形状错误必须回
       * `pair-fail{invalid_or_expired}` 而不是 `bad_frame`，因为小程序只认那四个
       * reason 的中文文案（F6），一个 `error{bad_frame}` 对它就是一句看不懂的话。
       */
      const verdict = classifyEndpointFrameText(text)
      if (!verdict.ok) {
        switch (verdict.reason) {
          case 'bad_pair_claim':
            counters.rejectedPairs += 1
            // ⚠️ 这一支**刻意不带 token**：帧形状已经不合法（缺 pairingToken 或
            // 类型不对），所以从它身上读出来的任何 token 都不可信 —— 而
            // 主机侧会拿它去作废那一张码，发错就是误伤一张有效的码。
            // 宁可让主机退回"作废展示中的那张"（它至少知道自己那张是谁）。
            sendToPeer(peer, pairFailFrameOf('invalid_or_expired'))
            return
          case 'bad_pair_begin':
            // 这是**主机**的 bug，说给主机听更准确。
            sendError(peer, 'bad_pair')
            return
          case 'bad_ciphertext':
            // Buffer 对非法 base64 是静默丢弃，所以这层必须在转发前把关。
            sendError(peer, 'bad_frame', 'ciphertext must be standard base64')
            return
          case 'unknown_frame':
            // "对端版本不认识这个帧"。判据是"`t` 是不是协议里已存在的帧名"，
            // 而那张表现在是 registry 的注册表（带编译期断言），不再是本文件的手抄。
            sendError(peer, 'unknown_frame', verdict.frameType, verdict.frameType)
            return
          case 'bad_frame':
            // "名字对、形状坏"。帧名同时给 host（英文细节）与用户（`userHint`）：
            // "是哪条帧坏了"两边都用得上，而英文那句只给 host（见 sendError 的注释）。
            sendError(peer, 'bad_frame', `frame "${verdict.frameType}" has an invalid shape`, verdict.frameType)
            return
          case 'not_object':
          case 'no_frame_type':
            // JSON 解析失败、顶层不是对象、或没有字符串 `t`——对端发的压根不是一帧。
            sendError(peer, 'bad_json')
            return
        }
      }
      const frame = verdict.frame
      try {
        handleFrame(peer, frame)
      } catch (e) {
        log.error('frame handler threw', { t: frame.t, message: String((e as Error)?.message ?? e) })
        sendError(peer, 'internal')
      }
    })
    ws.on('pong', () => {
      peer.alive = true
    })
    ws.on('close', () => {
      peers.delete(ws)
      // 协议版本观测面同步减一（见 peerProtocols 的注释：为什么是计数而不是 Set）。
      // 顺序要紧：先减、后判是否归零删键 —— 反过来会漏掉"最后一个对端断开"这个状态。
      if (peer.protocol === undefined) peersWithoutProtocol = Math.max(0, peersWithoutProtocol - 1)
      else {
        const left = (peerProtocols.get(peer.protocol) ?? 1) - 1
        if (left > 0) peerProtocols.set(peer.protocol, left)
        else peerProtocols.delete(peer.protocol)
      }
      // 必须从桶里摘掉：Set 不摘就永远留着这条 Peer，ping 会继续朝一个已关闭的
      // socket 发（terminate 过的 ws 再 ping 是抛错被吞掉的），而且 maxConnections
      // 是按 wss.clients 算的，桶这边就会和闸门慢慢对不上。
      bucketAt(peer.pingBucket).delete(peer)
      if (peer.role === 'client' && peer.clientId) {
        for (const notice of state.clientGone(peer.clientId, ws)) {
          sendTo(state.hostSocket(notice.conversationId), peerLeftFrame(notice.conversationId, notice.clientId))
        }
        log.info('client disconnected', { clientId: peer.clientId })
      }
      if (peer.role === 'host' && peer.hostId) {
        // 只有"这个 socket 仍是该主机的活连接"才打离线标记；重连时新 socket 已先注册。
        if (state.hostGone(peer.hostId, ws)) log.info('host offline (grace started)', { hostId: peer.hostId })
      }
    })
    ws.on('error', (e: Error) => log.warn('socket error', { message: String(e?.message ?? e) }))
  }

  // ── 清扫与保活 ──────────────────────────────────────────────────────

  /**
   * 表清扫：每 `sweepMs`（默认 5 s）一轮，只做与"表项的生命周期"有关的五件事。
   *
   * **这一条的周期不能跟着心跳一起变长**（C1 最容易做错的地方）：配对码 TTL 120 s 的
   * 失效粒度、慢消费者窗口（主机 10 s / 客户端 45 s）、host 宽限期 120 s、会话空闲剪枝、
   * 空会话回收，全都挂在这个轮次上。把 `DRC_SWEEP_MS` 直接调到 60 s 来"省 ping"会让上面五条
   * 一起退化成 60 s 粒度——所以拆成两条定时任务，而不是调同一个间隔。
   */
  function sweep(): void {
    const expired = state.expirePairs()
    if (expired.length > 0) log.debug('pair tokens expired', { count: expired.length })
    // 慢消费者判定：**定时驱动**，不看这一轮有没有入站帧（见 noteBackpressure 的注释）。
    // 只对 OPEN 的连接读 bufferedAmount——已关闭的连接读它是无意义的。
    const backpressureAt = Date.now()
    forEachPeer((ws, peer) => {
      if (ws.readyState === WS_OPEN) noteBackpressure(peer, backpressureAt)
    })
    // D6：超过宽限期仍没回来的主机，才真正通知它的客户端重配对。
    let droppedByGrace = 0
    for (const dropped of state.expireOfflineHosts(config.hostGraceMs)) {
      // 这里曾经误写成**嵌套两层同一个 clientIds**（外层内层同名），于是每个客户端收到
      // N 条 `peer-left` 而不是 1 条：帧数随成员数平方增长，手机还会把同一次"主机离开"
      // 重复处理。有测试锁住"每个成员恰好一条"。
      for (const clientId of dropped.clientIds) {
        sendTo(state.clients.get(clientId)?.ws, peerLeftFrame(dropped.conversationId, dropped.hostId))
      }
      droppedByGrace += 1
      log.info('host grace expired', { hostId: dropped.hostId, sessions: dropped.conversationId })
    }
    const idleDropped = state.sweepIdle(config.conversationIdleTtlMs)
    for (const conversationId of idleDropped) {
      log.info('conversation idle-dropped', { sessionId: conversationId })
    }
    // P2-⑤：只剩主机、没有客户端的会话，最后一个客户端走后 emptyTtl 就回收。
    // 不发任何帧给谁：这条路上"还有客户端"这件事已经不成立（有客户端也不会进这里），
    // 而主机侧会话本来就与中继这张表各自独立（resync 会重新声明）。
    const emptyDropped = state.sweepEmpty(config.conversationEmptyTtlMs)
    for (const conversationId of emptyDropped) {
      log.info('conversation empty-dropped', { sessionId: conversationId })
    }
    // 回收同步删盘（纪律第 3 条）：空会话回收与空闲剪枝都是"永久删除"，不同步的话
    // 重启会把它们读回来复活。三条删除路径共用这一次落盘——它们本来就同属一轮清扫，
    // 一轮写一次，而不是删几个就写几次。
    if (droppedByGrace > 0 || idleDropped.length > 0 || emptyDropped.length > 0) markStateChanged()
    else maybePersistPeriodic()
    // 计数器快照借这一轮的节拍，但它**不是**表项生命周期的一部分（见 logCountersIfDue 的注释）。
    logCountersIfDue()
  }

  /**
   * 周期性补写，只为刷新 `lastActivityAt`（见 config.ts 里 `stateSaveMs` 的注释）。
   *
   * 挂在 sweep 这一轮上而不是另开定时器：sweep 本来就每 `sweepMs` 醒一次，
   * 再加一个定时器只是多一条要维护的生命周期。
   */
  function maybePersistPeriodic(): void {
    if (!persistence.enabled) return
    const now = Date.now()
    if (now - persistence.savedAt < config.stateSaveMs) return
    persistNow()
  }

  /**
   * 按 `countersLogMs`（默认 60 s）把 `/healthz` 那组数原样抄进日志。
   *
   * 为什么要有这一条：`droppedFrames` / `slowConsumers` / `rejectedPairs` 是**自启动累计**，
   * 只在当前进程的 `/healthz` 里有值，进程一换就归零；而中继本来不为每一次丢帧写日志
   * （四处计数点里有两处注释就写着"它在日志里不留痕，只能靠这个计数被发现"）。
   * 两件事加起来，"昨天那一段时间丢了多少帧"以前**根本问不出来**（伞仓 HANDOFF §3.3）。
   * 抄进日志之后它进 journalctl，成了可查的历史。
   *
   * 字段直接复用 `health()`，不在这里第二处列一遍——两处各写迟早分叉，
   * 而分叉之后"日志说的"和"`/healthz` 说的"就成了一套罗夏测试。
   */
  function logCountersIfDue(): void {
    const now = Date.now()
    if (now - lastCountersAt < config.countersLogMs) return
    lastCountersAt = now
    log.info('counters', health())
  }

  /**
   * 保活 ping：每 `pingTickMs` 只处理一个桶，一圈 `pingBucketCount` 个桶走完就是
   * `pingIntervalMs`。C0 实测：10k 连接在旧的"一轮全表 ping"下，10 000 个 ping 帧
   * 整整齐齐挤在同一个 5 s 窗口里，单轮把事件循环堵住最长 96 ms（p50 仍是 1 ms，
   * 也就是"每 5 s 堵一下"）。分桶要治的就是这一下，**不是**省字节。
   *
   * 判活语义随之变化，而且是变慢的，必须写明白：`alive` 是"上一轮有没有回 pong"的
   * 单轮标志（这个结构没动，只是换了节奏），所以一条**静默死掉**的对端（没有 FIN/RST
   * 的半开 socket）要等它自己轮到两次才被发现——第一次清标志并 ping，第二次才发现没 pong。
   * 最坏因此从 `2×sweepMs`（10 s）变成 `2×pingIntervalMs + pingTickMs`（默认约 121 s）。
   * 真机上的常规断开走 `close`/`error` 事件，不受影响；在意槽位回收速度的运维
   * 可以把 `DRC_PING_INTERVAL_MS` 调小（15 s 时回收最坏 31 s，突发仍是全表的 1/60）。
   * 保活只走 WS 层 ping：主机与小程序都不发应用层 ping，改判应用层心跳会
   * 周期性踢掉空闲客户端（取证 relay-and-wireformat.md §5.4）。
   */
  function sweepPingBucket(): void {
    currentPingBucket = (currentPingBucket + 1) % pingBucketCount
    for (const peer of bucketAt(currentPingBucket)) {
      if (!peer.alive) {
        log.warn('heartbeat timeout', { clientId: peer.clientId, hostId: peer.hostId })
        peer.ws.terminate()
        continue
      }
      peer.alive = false
      try {
        peer.ws.ping()
      } catch {
        /* 已关闭 */
      }
    }
    // `lastPingAgo` 的契约含义不变（"保活机制上次运转是几秒前"），但它的**上界**
    // 从 sweepMs 变成 pingTickMs：现在每秒都在轮一个桶，所以正常值恒为 0~1。
    // 告警规则若写的是 `lastPingAgo > 30`（=保活停了），照旧成立。
    lastPingAt = Date.now()
  }

  /**
   * 遍历当前所有对端。**刻意不复制数组**（C2）：旧写法每轮先摊出一个长度 N 的
   * `[ws, peer]` 数组，10k 连接下就是每轮 10k 个数组槽 + 10k 个元组，全是纯垃圾。
   *
   * 别把它当成"漏了防护"又加回复制——遍历中确实会发生删除，而这里是安全的：
   * - `Set.prototype.forEach` 对"迭代期间删除当前元素"有明确定义的行为（不会漏、不会重）；
   * - 真正的删除发生在 `close` 事件里（`peers.delete` / 桶 `delete`），而 `terminate()`
   *   / `close()` 的事件抛出是**异步**的，不在本次同步遍历窗口内；
   * - 遍历期间新建的连接这一轮访问不到——**这正是我们要的**：它还没走完 `hello`，
   *   拿它判慢消费者是错的。
   */
  function forEachPeer(visit: (ws: WebSocket, peer: Peer) => void): void {
    wss.clients.forEach((ws) => {
      const peer = peers.get(ws)
      if (peer) visit(ws, peer)
    })
  }

  // ── HTTP ────────────────────────────────────────────────────────────

  function health(): Record<string, string | number | boolean> {
    return {
      ok: !shuttingDown,
      version: config.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      // 瞬时快照（会上下浮动）与累计计数（只增不减）分开：混在一起会让
      // "手机不更新"这类排查分不清"现在是空的"和"一直送不出去"。
      ...state.counts(),
      ...counters,
      // 落盘的可观测面。**刻意不暴露文件路径**：`/healthz` 是公网可达的，
      // 而一个绝对路径对排障没用、对探测者有用（告诉它这台机器上有什么、装在哪）。
      // 运维要知道路径看环境变量就够了。
      persistence: persistence.enabled ? 'on' : 'off',
      stateRestored: persistence.restored,
      stateSavedAtSec: persistence.savedAt === 0 ? -1 : Math.round((Date.now() - persistence.savedAt) / 1000),
      stateWrites: persistence.writes,
      stateWriteFailures: persistence.failures,
      lastPingAgo: lastPingAt === 0 ? -1 : Math.round((Date.now() - lastPingAt) / 1000),
      shuttingDown,
      // 协议版本协商的观测面（2026-10-07）。有了版本闸之后，"为什么这个对端连不上"
      // 就成了新的排障问题，而没有这一项时它只能去翻日志。
      //
      // 报的是**对端报的最小/最大版本**与"没报过版本"的连接数，两个方向缺一不可：
      // 只报最大值的话，一个全是老小程序的环境看起来与新版本一样正常。
      protocolSelf: PROTOCOL_VERSION,
      protocolMin: MIN_SUPPORTED_PROTOCOL,
      peerProtocolMin: peerProtocols.size === 0 ? -1 : Math.min(...peerProtocols.keys()),
      peerProtocolMax: peerProtocols.size === 0 ? -1 : Math.max(...peerProtocols.keys()),
      peersNoProtocol: peersWithoutProtocol,
    }
  }

  /**
   * HTTP 面。**整段包在 try/catch 里，且绝不把异常抛给进程**（P0-1）。
   *
   * 为什么这条是 P0：`new URL(req.url, \`http://${req.headers.host}\`)` 里只要
   * `Host` 是 `[`、`x:99999` 这种畸形值，URL 解析就**同步抛** TypeError；它在 request
   * listener 里，Node 不兜底 → 冒到 `main.ts` 的 uncaughtException → `exit(1)`。
   * 一个**未认证**的 HTTP 请求就能把中继打挂（默认绑回环时本机任意进程可打，
   * `DRC_BIND=0.0.0.0` + 容器发布端口时公网直达；systemd `Restart=always` 会把
   * 它变成重启循环，内存里的会话表每次都被清空）。实测：`GET /healthz` + `Host: [`
   * → 无响应、进程 exit 1、日志 `uncaught exception: Invalid URL`。
   *
   * 两道防线：
   * 1. URL 的 base **不用客户端给的 Host**（固定 `http://relay.invalid`），
   *    只从 `req.url` 取 path/query——Host 头对路由本来就没有意义（路径不设限）；
   * 2. 整段 try/catch：真出现别的畸形（例如 absolute-form 里带坏 host 的 req.url）
   *    也只回 500，进程继续服务。
   */
  function httpHandler(req: IncomingMessage, res: ServerResponse): void {
    try {
      const url = new URL(req.url ?? '/', 'http://relay.invalid')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (url.pathname === '/healthz') {
        // 停机中回 **503**（2026-10-07 改）。理由：`ok:false` 这个字段在改造前是
        // `/healthz` 唯一的停机信号，于是任何只看状态码的观测面（Docker HEALTHCHECK、
        // 负载均衡器、k8s probe、`curl --fail`）都会在**正在关闭**的进程上读到 200，
        // 继续往一个不再接受 upgrade 的实例上送流量。状态码本来就是这件事的表达方式，
        // 字段留给人去读。
        if (shuttingDown) res.statusCode = 503
        res.end(JSON.stringify(health()))
        return
      }
      if (url.pathname === '/api/info') {
        // `PROTOCOL_VERSION` 而不是字面量 `1`：这条是无认证接口，
        // 写死的版本号会在协议升版时静默变成一句谎话（小程序拿它判"能不能连"）。
        res.end(JSON.stringify({ publicUrl: config.publicUrl, protocol: PROTOCOL_VERSION }))
        return
      }
      if (url.pathname === '/api/pair-status') {
        // 默认 404：开等于给 6 位码空间装了个免认证的判定 oracle。
        if (!config.pairStatusEnabled) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'not_found' }))
          return
        }
        // 开了之后也必须限流（P2）：这是一条**无认证**的 "这个码在不在" 判定接口，
        // 10^6 的码空间不设配额就是一台免费的枚举机。配额用与配对同一只 Budget，
        // 用尽回 429 并记 warn——warn 是刻意的，压测/探测会在这里留下痕迹。
        if (!pairStatusBudget.take(Date.now())) {
          log.warn('pair-status budget exhausted', { reason: 'rate_limited' })
          res.statusCode = 429
          res.end(JSON.stringify({ error: 'rate_limited' }))
          return
        }
        const token = url.searchParams.get('token') ?? ''
        const entry = state.pendingPairs.get(token)
        res.end(JSON.stringify({ ok: !!entry && !entry.used && entry.expiresAt >= Date.now() }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not_found' }))
    } catch (e) {
      log.warn('http request failed', { message: String((e as Error)?.message ?? e) })
      try {
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
        }
        res.end(JSON.stringify({ error: 'internal' }))
      } catch {
        // 连回一个 500 都失败（对端已经走了）：到此为止，**绝不**再抛。
      }
    }
  }

  const http = createServer(httpHandler)
  /**
   * **常驻**的 'error' 监听器（2026-10-07 审计修）。
   *
   * `startListening` 里那一句 `http.once('error', reject)` 在 listen 成功后就 `off` 了，
   * 于是此后 **http server 上再没有任何 'error' 监听器**——而 EventEmitter 没有
   * 'error' 监听器时 `emit('error')` 会同步抛。Node 的 net 层对**每一次 accept 失败**
   * （EMFILE / ENFILE / ENOBUFS / ENOMEM，并发连接把 fd 打满时就会发生）执行
   * `server.emit('error', err)`，于是：一条 fd 打满的连接洪峰 → 异常冒出 →
   * `main.ts` 的 uncaughtException → exit 1 → `Restart=always` → **内存会话表清零**。
   * 这与本文件头 P0-1 那条纪律（"HTTP 侧的任何异常都不许冒到进程"）是同一条，
   * 旧实现只是漏了 listen 之后的那一半。
   *
   * 为什么记 warn 之后**不**退出：accept 失败是瞬时的（文件描述符会随对端断开释放），
   * 此时退出等于"活着但坏了"的反面 —— 活着且降级，比死了被拉起来好。
   */
  http.on('error', (error) => {
    log.warn('http server error', { message: String((error as Error)?.message ?? error) })
  })
  http.headersTimeout = 30_000
  http.requestTimeout = 30_000
  http.keepAliveTimeout = 15_000
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxMessageBytes,
    // 不发库自带的 ping：保活由 sweep() 显式 ping + pong 判活 + terminate 承担，
    // 这样"上一轮没回 pong"这个判据才在我们手里（取证 relay-and-wireformat.md §5.4）。
  })

  http.on('upgrade', (req, socket, head) => {
    if (shuttingDown) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    try {
      // 路径不设限：已发布的地址里既有根路径也有 /ws 之类，收窄会让老地址全部连不上。
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    } catch (e) {
      // 与 httpHandler 同一条纪律：HTTP 侧的任何异常都不许冒到进程（P0-1）。
      log.warn('websocket upgrade failed', { message: String((e as Error)?.message ?? e) })
      try {
        socket.destroy()
      } catch {
        /* 已经没了 */
      }
    }
  })
  /**
   * 畸形请求行/头（例如 `GET /healthz HTTP/1.1` 配上读不完的头）会让 Node 直接
   * 抛 `clientError`；没有监听者时它的默认处理是写一个 400 然后销毁 socket——
   * 但**有监听者**却不写应答，就会让那条 socket 悬着。这里显式收口：记一条日志、
   * 尽力回 400、销毁，绝不抛。
   */
  http.on('clientError', (error, socket) => {
    log.warn('http client error', { message: String((error as Error)?.message ?? error) })
    if (!socket.writable) {
      socket.destroy()
      return
    }
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    } catch {
      socket.destroy()
    }
  })
  wss.on('connection', (ws) => onConnection(ws))

  /**
   * 排空：等所有对端真的走完关闭握手，最多等 `DRAIN_MS`。
   *
   * 为什么必须显式等，而不是直接 `await http.close()`（2026-10-07 审计）：
   * 升级过的 WebSocket socket 是**由对端决定何时消失**的——手机进电梯、切 4G、
   * 主机休眠时它既不发 FIN 也不回关闭帧。这种 socket 会让 `http.close()` 的回调
   * **永不触发**，于是每一次这样的停机都走满 5 秒兜底（`main.ts` 的 guard），
   * 并留下一条 `shutdown forced`。反过来，空闲的 keep-alive HTTP 连接**不阻塞**
   * `close()`（Node ≥19 自己关），所以"被拖住"的只有 WS 侧——这也解释了为什么
   * 改造前它只在有手机连着的时候出现。
   *
   * 兜底是 `terminate()`：对端不接关闭帧时，TCP 层直接断，状态随之收敛。
   */
  async function drain(): Promise<void> {
    if (wss.clients.size === 0) return
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + DRAIN_MS
      const tick = (): void => {
        if (wss.clients.size === 0 || Date.now() >= deadline) {
          resolve()
          return
        }
        setTimeout(tick, 20).unref?.()
      }
      tick()
    })
  }

  async function close(): Promise<void> {
    if (sweepTimer) clearInterval(sweepTimer)
    if (pingTimer) clearInterval(pingTimer)
    shuttingDown = true
    // 停机前补一次盘：把"关掉之后"这段时间里的活动写进去。
    // 这一写也让"关机前最后状态"与"重启后读到的状态"一致，排障时不必去猜中间发生了什么。
    if (persistence.enabled) persistNow()
    wss.clients.forEach((ws) => ws.close(1001, 'server_shutdown'))
    await drain()
    for (const ws of wss.clients) {
      try {
        ws.terminate()
      } catch {
        /* 已经没了 */
      }
    }
    await new Promise<void>((resolve) => http.close(() => resolve()))
    // **排空之后再写一次**（P2）：第一次写发生在 `ws.close()` 之前，而这之后
    // socket 的 `close` 回调还会改状态（`clientGone` 更新 lastActivityAt、
    // 主机掉线打宽限期计时……）——只写一次的话，盘上永远是"开始停机那一刻"的版本。
    // `drain()` 保证这一次写发生在所有 close 回调之后：旧写法只是"多数时候"成立
    // （http.close 的回调与 ws 的 close 回调谁先跑，取决于 Node 内部的监听器注册序）。
    if (persistence.enabled) persistNow()
  }

  /**
   * 兜底停机（`main.ts` 的 5 秒守卫）：排空没能完成时调它。
   *
   * 补写一次盘——这时内存表就是最新真相，不写等于把这次停机期间的全部变更丢掉。
   * 同时把 `shutdownForced` 记进 `/healthz`：兜底 exit(0) 与"排空成功"同码，
   * 光看退出码分不出这两种停机，计数是运维唯一能事后分辨的出口。
   */
  function forceShutdown(): void {
    counters.shutdownForced += 1
    if (persistence.enabled) persistNow()
    log.warn('shutdown forced', { shutdownForced: counters.shutdownForced })
  }

  function startListening(): Promise<{ port: number; bind: string }> {
    sweepTimer = setInterval(sweep, config.sweepMs)
    sweepTimer.unref()
    pingTimer = setInterval(sweepPingBucket, config.pingTickMs)
    pingTimer.unref()
    return new Promise((resolve, reject) => {
      http.once('error', reject)
      http.listen(config.port, config.bind, () => {
        http.off('error', reject)
        // 传 0 时由系统分配端口——测试要用随机端口，不能猜。
        const actual = http.address()
        const port = typeof actual === 'object' && actual ? actual.port : config.port
        resolve({ port, bind: config.bind })
      })
    })
  }

  return { http, wss, state, log, health, close, forceShutdown, startListening }
}
