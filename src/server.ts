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
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { type EndpointFrame, type ErrorCode, type RelayFrame, type StatusDigest } from '@dsh-remote/protocol/frames'
import { newHostId } from '@dsh-remote/protocol/ids'
import { negotiateProtocol, PROTOCOL_VERSION } from '@dsh-remote/protocol/negotiate'
import { CAPABILITY_NOTIFY, RELAY_CAPABILITIES } from '@dsh-remote/protocol/registry'
import { createMpCodeIssuer } from './mpcode.js'
import { createNotifier } from './notify.js'
import { createWechatTokenProvider } from './wechat-token.js'
import { createHttpRoutes } from './http-routes.js'
import { createSweep } from './sweep.js'
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
  pairRequest,
  paired as pairedFrameOf,
  peerJoinedForHost,
  peerLeft as peerLeftFrame,
  pong as pongFrameOf,
  resumeGap as resumeGapFrameOf,
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

/**
 * 真实来源 IP（埋点归因，2026-10-23）。
 *
 * 生产在 nginx 后面（`proxy_set_header X-Real-IP / X-Forwarded-For` 已配），
 * socket 地址恒为回环 ⇒ 必须取头。取不到头就退回 socket 地址（裸跑/自托管常态）。
 * ⚠️ 这是**日志字段**，不做安全判定（限流/封禁在 nginx 与 fail2ban 层）：
 * 头可伪造，别拿它当信任根。
 */
export function clientIpOf(headers: Record<string, string | string[] | undefined>, socketAddr?: string): string {
  const xff = headers['x-forwarded-for']
  const first = (Array.isArray(xff) ? xff[0] : xff) ?? ''
  const fromXff = first.split(',')[0]?.trim()
  if (fromXff) return fromXff
  const real = headers['x-real-ip']
  const fromReal = (Array.isArray(real) ? real[0] : real)?.trim()
  if (fromReal) return fromReal
  return socketAddr ?? 'unknown'
}

interface Peer {
  ws: WebSocket
  /**
   * 对端真实来源 IP（建连时抓一次；nginx 后面取 `X-Forwarded-For` 首项，见 `clientIpOf`）。
   * 埋点归因（PLAN-smooth-78-92 P0-2 + 2026-10-23 丰富埋点）：配对/上线/掉线日志都带它，
   * 只进日志，不进协议帧。
   */
  ip: string
  /** 建连时刻：断开日志用它算本连接存活时长（`onlineMs`，顺畅率"闪断"判据的数据源）。 */
  connectedAt: number
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
  /**
   * "这条连接上已经报过一次 unknown_session"（2026-10-26 补）。
   *
   * 为什么要有这道闩锁：`unknown_session` 是**逐帧**判定（手机拿着一个已死的 convId
   * 再发一帧就撞一次），而它是"用户被迫重扫"的**唯一**直接信号 —— 不记它，
   * 线上就数不出"有多少次用户被迫重新扫码"。但一个拿着死 convId 的对端可以
   * 连打几百帧 ⇒ 与 `notedNonMember` 同一条纪律：**只记一次**。
   */
  notedUnknownSession: boolean
  /** 配对表满的告警只记一次（逐帧判定，见 handlePairBegin）。 */
  notedPairTableFull: boolean
  /** 同上：全局配对配额用尽那条 warn，每秒最多一行（0 = 还没记过）。 */
  pairBudgetWarnedAt: number
  /** 同上：会话表满那条 warn（D6），每秒最多一行（0 = 还没记过）。 */
  tableFullWarnedAt: number
  alive: boolean
  /**
   * 这条连接属于哪个 ping 桶（见 sweepPingBucket）。建连时按轮转序号取模分配，
   * **之后不再变**——所以一个对端两次被 ping 的间隔稳定等于 pingIntervalMs。
   */
  pingBucket: number
}

export interface RelayHandle {
  http: Server
  wss: WebSocketServer
  state: RelayState
  log: Log
  health(): Record<string, string | number | boolean | Record<string, number>>
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

/**
 * 结构性变更的落盘合并窗口（D6）。见 `markStateChanged` 的注释。
 *
 * 200 ms 的取舍：写盘从"每秒最多 20 次"压到"每秒 5 次"（全局配对配额的量级），
 * 而崩溃时最多丢 200 ms 的变更。停机路径不等这个窗口。
 */
const PERSIST_COALESCE_MS = 200

export function createRelay(config: RelayConfig): RelayHandle {
  const log = new Log(config.logLevel)
  const state = new RelayState({
    maxPendingPairs: config.maxPendingPairs,
    // D6：会话表上界（缺了它，每次认领的同步整表写就成了无界的成本放大）。
    maxConversations: config.maxConversations,
  })
  const startedAt = Date.now()

  /**
   * 微信 access_token 的**唯一**缓存（2026-10-27）。
   *
   * 小程序码签发与订阅消息发送**共用它** —— 微信的 token 是单例，
   * 两处各自缓存会互相打死（详见 `wechat-token.ts` 的文件头）。
   */
  const wechatTokens = createWechatTokenProvider({ appId: config.mpAppId, secret: config.mpSecret })

  /**
   * 订阅消息发送器（2026-10-27）。
   *
   * **没配模板 id ⇒ 不启用** ⇒ 中继不声明 `notify.v1`、不下发 `hello-ok.notify`
   * ⇒ 小程序不显示那个开关（按声明开）。
   */
  const notifier = createNotifier({
    appId: config.mpAppId,
    secret: config.mpSecret,
    templateId: config.mpApprovalTemplateId,
    envVersion: config.mpEnv,
    tokens: wechatTokens,
    log,
    membersOf: (conversationId: string) => [...(state.conversations.get(conversationId)?.clients ?? [])],
  })

  const pairBudget = new Budget(config.pairGlobalBudgetPerSec)
  /** `/api/pair-status` 的独立配额：它走 HTTP、无认证，和配对帧不是同一条入口。 */
  const pairStatusBudget = new Budget(config.pairStatusBudgetPerSec)
  const peers = new WeakMap<WebSocket, Peer>()
  let shuttingDown = false
  let sweepTimer: NodeJS.Timeout | undefined
  let pingTimer: NodeJS.Timeout | undefined
  /**
   * 结构性变更的**待写标记**与合并窗口定时器（D6 的第二条，2026-10-13）。
   *
   * 为什么要有：`markStateChanged()` 原来每次都**同步**写整张会话表，而它的调用点里
   * 包含"每次成功认领"——那张表当时没有上界，于是单次写盘的成本随表线性增长
   * （实测 5 000 条 8.5 ms、5 万条 45 ms、20 万条 159 ms）。配对本身被全局配额
   * 20/s 限着，可 5 万条时仍是 20 × 45 ms = 900 ms/秒 = **90% 的事件循环**。
   *
   * 窗口取 200 ms：结构性变更仍然在"下一次事件循环的空隙"里落盘（高��路径上把写盘
   * 从每秒 20 次压到 5 次 ⇒ 同样 5 万条时降到约 4%），代价是**崩溃最多丢 200 ms 的变更**。
   * 停机路径不等这个窗口：`close()` / `forceShutdown()` 直接 `persistNow()`，
   * 而 `persistNow()` 自己会清掉待写标记与定时器 ⇒ 不会重复写、也不会漏写。
   */
  let persistPending = false
  let persistTimer: NodeJS.Timeout | undefined
  let lastPingAt = 0
  /** 上一次把计数器抄进日志的时刻（0 = 还没抄过，所以启动后第一轮就抄）。 */
  let lastCountersAt = 0

  /**
   * 签一枚新的 host token。
   *
   * 长度 48 位十六进制 —— 与 env 那枚的口径一致（`openssl rand -hex 24`）。
   * `tokenMatches` 是**定长比较**：长度变了不会报错、只会让已装机的主机静默连不上，
   * 所以这里必须对齐 `HOST_TOKEN_RE`（`persist.ts` 读盘时按同一个正则筛）。
   */

  /**
   * 这枚令牌能不能代表 `hostId` 连上来。
   *
   * 两条来源，任一命中即可（全是定长比较，别把长度或时序泄露出去）：
   *
   * ① **该 hostId 自己那枚** —— `POST /api/claim-token` 领来的（2026-10-11 起的模型）。
   * ② **env 里的 `DRC_HOST_TOKEN`** —— 运维引导凭据。它**永不参与轮换**，所以
   *    "任何陌生人 POST 一次就能把合法主机永久踢下线"这条没了。
   *
   * ⚠️ 这里**没有**"未绑定槽位"那条兼容路径了（2026-10-11 晚，用户裁决不做老客户端兼容）：
   * 它的令牌对任意 hostId 都算数，等于给"冒充任何主机"留了一把万能钥匙，
   * 而认领接口是**无认证**的。现在认领必须带 hostId（见 `handleClaimToken`）。
   *
   * 成功时打一个"刚用过"的时间戳：裁剪令牌表时按它排序，先丢的永远是没人用的占位条目
   * （签得早但一直在用的机器不该被丢，丢了它要靠自愈才回得来）。
   */
  function hostTokenAccepted(hostId: string, got: string | undefined): boolean {
    if (!got) return false
    const perHost = state.hostTokens.get(hostId)
    if (perHost && tokenMatches(perHost.token, got)) {
      state.markHostTokenUsed(hostId, Date.now())
      return true
    }
    return config.hostToken !== '' && tokenMatches(config.hostToken, got)
  }

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
    /**
     * 直接写盘的那几条路（启动、停机、`flushPendingPersist`）都收口到这里，
     * 所以"待写"状态必须在这里清掉——否则停机已经写完了，那个 200 ms 的定时器
     * 还会再写一次（多一次全表写），而 `close()` 里"排空后再写一次"的语义也会被稀释。
     */
    persistPending = false
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer)
      persistTimer = undefined
    }
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
   * 会话表发生**结构性**变化后**请求**一次落盘（建/删会话、成员表变动、令牌签发）。
   *
   * ## 为什么是"请求"而不是"立刻写"（D6，2026-10-13）
   *
   * 它原来每次都同步写整张表。2026-10-07 那轮只把 `resync` 那条路改成按语义分（结构性写、
   * 只刷 `lastActivityAt` 的交给周期补写），**配对那条路留着立刻写**，理由写在当时那段
   * 注释里：「一次落盘换一次扫码，这个代价比什么都划算」，而它的前提是
   * 「配对表的规模有界（拓扑恒 1:1，会话数 ≈ 配对过的客户端数）」。
   *
   * ⚠️ **那个前提在 2026-10-13 被证伪**：`clientId` 由客户端自选，只有**并发**连接数有界，
   * 时间维度上没有上界；认领接口又是无认证的（谁都能领一枚令牌）⇒ 一台主机按全局配额
   * 20 次/秒 churn 配对，约 42 分钟堆到 5 万条，此后单次写 45 ms × 20 = 90% 事件循环
   * ⇒ 心跳判定停摆、所有对端被一起踢掉。
   *
   * ⇒ 现在两条一起上：① 会话表有上界（`RelayConfig.maxConversations`，满了先回收已空的）；
   *   ② 这一条改成 200 ms 合并窗口（写盘从每秒 20 次压到 5 次，同样 5 万条时约 4%）。
   * 代价写清了：**崩溃最多丢 200 ms 的变更**（用户在手机上重新扫一次码），
   * 停机路径不等这个窗口（`close()` / `forceShutdown()` 直接 `persistNow()`）。
   *
   * ## 为什么删除路径仍然必须走它（纪律第 3 条，没有被合并窗口削弱）
   *
   * 只在"建"的时候写，删掉的会话会永远留在盘上，重启时又被读回来——**已作废的会话被复活**，
   * 而主机那边的 `resync` 还要再花一轮才清掉。合并窗口只推迟 200 ms，不取消这一次写。
   *
   * 为什么只盯结构性变化、不盯每一帧：`lastActivityAt` 每转发一帧就更新，跟着它写就是
   * 每帧一次 fsync——那不是持久化，那是自造 DoS。保鲜交给 `maybePersistPeriodic`。
   */
  function markStateChanged(): void {
    if (!persistence.enabled) return
    persistPending = true
    if (persistTimer !== undefined) return
    persistTimer = setTimeout(() => {
      persistTimer = undefined
      flushPendingPersist()
    }, PERSIST_COALESCE_MS)
    // unref 与"停机集中撤销"成对：它不该拖住进程退出，而 close() 里 persistNow()
    // 会把它清掉（见上面 persistNow 的注释）。
    persistTimer.unref?.()
  }

  /** 把待写的变更立刻落盘（合并窗口到期、或停机路径已经写过之后不需要调）。 */
  function flushPendingPersist(): void {
    if (!persistPending) return
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
   *   ⚠️ P1-3（2026-10-22）之后这个数**不再等于"丢了"**：run 输出帧即使没有收件人也照常
   *   入环、手机重连时补投（`RUN_OUTPUT` 分流）。"此刻还有多少可补"看 `replayRing*` 两个读数；
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
    // 补差量落在保留窗口之外（规范 §10.7 S4）。文案要说清**发生了什么 + 该做什么**：
    // 只说"取不到历史"的话，用户会去点"加载更早"（那是另一个方向），而正确动作是
    // 由客户端改拉历史——那句提示是给客户端看的，而它最终会被转述成人话。
    history_window_exceeded: '断线时间太长，中间那段已经补不回来了，正在重新拉取',
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

  /**
   * hello-ok 给客户端的可选下发面（M2/M-C）：**有摘要才带摘要**。
   *
   * 摘要在会话条目上（主机登记的"最后已知"，`summary` 帧），这里在握手时
   * 回放给重连的手机 —— 清过存储的手机也拿得到"最后已知状态"（REVIEW §5.1 的
   * 手机侧措辞面）。没挂会话（新手机）或没摘要（老主机/还没推过）⇒ 什么都不带，
   * 老端点对多出来的键零感知（zod strip / 旧 switch 直接忽略）。
   */
  function helloExtrasForClient(clientId: string): {
    summary?: StatusDigest
    capabilities?: readonly string[]
    notify?: { templateId: string }
  } {
    const conversationId = state.conversationOfClient(clientId)
    const summary = conversationId ? state.conversations.get(conversationId)?.summary : undefined
    // 通知面（2026-10-27）：**只有 notifier 启用时才声明** ——
    // 声明了却发不出去比不声明更坏（用户看到开关、点了没反应）。
    const notifyEnabled = notifier.enabled
    return {
      ...(summary === undefined ? {} : { summary }),
      ...(notifyEnabled ? { capabilities: [...RELAY_CAPABILITIES, CAPABILITY_NOTIFY] } : {}),
      ...(notifyEnabled ? { notify: { templateId: config.mpApprovalTemplateId } } : {}),
    }
  }

  function handleHello(peer: Peer, frame: Extract<EndpointFrame, { t: 'hello' }>): void {
    if (frame.role === 'host') {
      // hostId 要**先**算出来：按 hostId 一机一枚之后，它是查令牌的键。
      const hostId = frame.hostId?.trim() || newHostId()
      if (!config.hostToken && state.hostTokens.size === 0) {
        sendError(peer, 'internal', 'relay has no host token configured')
        peer.ws.close(1011)
        return
      }
      if (!hostTokenAccepted(hostId, frame.token)) {
        peer.authAttempts += 1
        // 只记"第几次失败"与来源 IP，绝不记token 的任何片段。
        // IP 是 P0-2（2026-10-22）加的：没有它这行只能说"有人试错"，有了它才
        // 知道是哪台机器（今天 39 次全 attempts:1，但归因缺 remote IP）。
        log.warn('host auth failed', { attempts: peer.authAttempts, ip: peer.ip })
        sendError(peer, 'bad_token')
        if (peer.authAttempts >= config.maxHostAuthAttempts) peer.ws.close(4001, 'too_many_auth_attempts')
        return
      }
      releaseIdentityFor(peer, { role: 'host', id: hostId })
      const { replaced } = state.attachHost(hostId, peer.ws, frame.label ?? '', frame.softwareVersion)
      peer.role = 'host'
      peer.hostId = hostId
      sendToPeer(peer, helloOkForHost(hostId, frame.protocol))
      log.info('host online', { hostId, label: frame.label ?? '', replaced: replaced ? 1 : 0, ip: peer.ip })
      // 软件版本（2026-10-23 起**无条件记**——用户裁决"不用做开关，丰富埋点，只做在我们自己的 relay 上"）：
      // 只在对端**主动送来**时记（`hello.softwareVersion` 默认不带，端点不送就永远没有这条），
      // 零知识边界不变：版本是端点自报的元数据，不是内容。有它排查"两端版本不配套"比
      // `already_used` 这种间接症状直接得多。
      if (frame.softwareVersion) {
        log.info('host software version', { hostId, version: frame.softwareVersion, ip: peer.ip })
      }
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
      const { replaced } = state.attachClient(clientId, peer.ws, frame.softwareVersion)
      peer.role = 'client'
      peer.clientId = clientId
      if (replaced) {
        // 复核 R3：同 clientId 的旧连接必须被顶掉，否则真手机的 socket 还"开着"
        // 却再也收不到路由，而且因为它不觉得断开，也不会重连。
        log.warn('client replaced by newer socket', { clientId })
        replaced.close(CLOSE_REPLACED, 'replaced_by_newer_socket')
      }
      sendToPeer(peer, helloOkForClient(clientId, frame.protocol, helloExtrasForClient(clientId)))
      // P1-3 断线补帧：回放紧跟 hello-ok，且整段（进表→回放）都在 hello 这一次
      // **同步**处理里 —— 回放帧先于任何 live 帧到达这个 socket，顺序由构造保证
      // （独立 resume 帧做不到这一点，见 frames.ts 的 `helloFrame.resume` 注释）。
      if (frame.resume) replayToClient(peer, clientId, frame.resume)
      log.info('client online', { clientId, platform: frame.clientMeta?.platform, ip: peer.ip })
      // 软件版本（2026-10-23 起无条件记，同主机那一支的注释）。
      if (frame.softwareVersion) {
        log.info('client software version', { clientId, version: frame.softwareVersion, ip: peer.ip })
      }
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
    // clientPub 一并交下去：它是幂等档的判别子（同一把公钥再来才是重试，见 state.claim）。
    const claimed = state.claim(frame.pairingToken, peer.clientId, frame.clientPub)
    if (!claimed.ok) {
      /**
       * ⚠️ **内部原因不许原样出网**（D6）。`pair-fail` 的 reason 是**冻结消费面**
       * （协议 `pairFail()` 的类型 + 小程序 `translatePairFail` 都只认那四个）⇒
       * 新的内部原因 `table_full` 必须在这里映射掉，否则 TypeScript 就会挡住它——
       * 这正是我们要的强制点：映射必须是**显式**的一次判断，而不是"以后再说"。
       *
       * 映射到 `invalid_or_expired` 是有意的"善意的谎"：那四个里只有它对用户成立
       * （"这张码现在配不上"）。真正的table_full 进日志，也进 `/healthz` 的计数。
       *
       * ⚠️ 而它**不计入** `peer.pairAttempts`：那是"这张码不对"（用户或输入的问题），
       * 计满 5 次会把这台手机踢下线（4008）。表满是**服务端**状态，踢对端既解决不了
       * 问题、又惩罚了恰好在这时配对的合法用户。速率由全局配对配额（20/s）管着。
       */
      const wireReason = claimed.reason === 'table_full' ? 'invalid_or_expired' : claimed.reason
      if (claimed.reason === 'table_full') {
        counters.rejectedPairs += 1
        const now = Date.now()
        if (now - peer.tableFullWarnedAt >= 1000) {
          peer.tableFullWarnedAt = now
          log.warn('conversation table full, refusing new pairings (D6)', {
            clientId: peer.clientId,
            conversations: state.conversations.size,
            max: config.maxConversations,
          })
        }
        sendToPeer(peer, pairFailFrameOf(wireReason, frame.pairingToken))
        return
      }
      peer.pairAttempts += 1
      counters.rejectedPairs += 1
      sendToPeer(peer, pairFailFrameOf(wireReason, frame.pairingToken))
      log.info('pair failed', {
        clientId: peer.clientId,
        reason: claimed.reason,
        attemptsLeft: Math.max(0, config.maxPairAttemptsPerConn - peer.pairAttempts),
        ip: peer.ip,
      })
      if (peer.pairAttempts >= config.maxPairAttemptsPerConn) {
        peer.ws.close(4008, 'too_many_pair_attempts')
      }
      return
    }
    peer.pairAttempts = 0
    /**
     * **幂等重认领档**（2026-10-24）：同一个 clientId 拿自己烧掉的码再来。
     * 只回 `paired`（sessionId + hostId，都不是秘密）——**绝不重发 pair-grant**
     * （psk 只随第一次的 clientPub 送过，重发给新公钥就是给冒名者开后门），
     * 也不重发 peerJoined（D3 断连成员留着，主机那边一直认得它）。
     * 这是掐死旧小程序客户端"重认领 → already_used → 断线 → 重连"死循环的那一下：
     * 客户端拿到 `paired` 就把脏 token 清了，循环熄火。
     */
    if (claimed.idempotent) {
      sendToPeer(peer, pairedFrameOf(claimed.conversationId, claimed.hostId))
      log.info('pair claim replayed (idempotent)', {
        clientId: peer.clientId,
        sessionId: claimed.conversationId,
        hostId: claimed.hostId,
      })
      return
    }
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
    /**
     * 小程序码路线（2026-10-21）：手机拿不到 psk（scene 装不下），它带来一枚一次性公钥，
     * 由主机在用户比对确认码后把 psk 加密送回。中继只把公钥**原样搬运**给主机。
     *
     * 不带 `clientPub` 的是 3.2 之前的小程序（那时 psk 在码里）⇒ 这一段整体不执行。
     * 现在两端同版本发布，这只是一条防御分支，不是兼容层。
     */
    if (frame.clientPub !== undefined) {
      const hostPeer = peerOfHost(claimed.hostId)
      if (hostPeer !== undefined) {
        sendToPeer(hostPeer, pairRequest(frame.pairingToken, frame.clientPub, claimed.conversationId, claimed.hostId))
      }
    }
    // 配对是**运行期唯一的会话创建点**（第二个入口是启动读回），所以它是落盘的关键时刻：
    // 这一次不写，下一次落盘之前中继重启，这条刚建立的配对就随内存一起没了。
    // 一次落盘换一次扫码，这个代价比什么都划算。
    markStateChanged()
    log.info('paired', {
      sessionId: claimed.conversationId,
      hostId: claimed.hostId,
      clientId: peer.clientId,
      // 埋点（2026-10-23）：码从签发到被认领等了多久 + 来源 IP。
      latencyMs: claimed.latencyMs,
      ip: peer.ip,
      ...(claimed.detached.length > 0 ? { detachedFrom: claimed.detached.length } : {}),
    })
  }

  function peerOfHost(hostId: string): Peer | undefined {
    const entry = state.hosts.get(hostId)
    return entry ? peers.get(entry.ws as unknown as WebSocket) : undefined
  }

  // ── 数据面 ──────────────────────────────────────────────────────────

  /**
   * P1-3：按 `hello.resume` 从环形缓冲补投断线期间的下行帧（§10.8）。
   *
   * - 补得出来 ⇒ 逐帧按原 seq 发 `enc`（客户端不重排：本函数在 hello 的同步处理里
   *   跑完，帧序 = seq 序）；
   * - 补不出来 ⇒ **只**回 `resume-gap{reason}`，绝不悄悄少发几帧（P3，与 §10.7 S5
   *   同一条纪律：客户端把"少给几条"当成补齐了，那段永远补不回来）；
   * - 会话不存在 / 不是成员 ⇒ **什么都不发**：那条路已经有 `unknown_session`
   *   （客户端下次发帧自然撞上，F5 唯一清配对信号）。多一个出口只会多一类
   *   "两条路说法不一致"的故障（`resyncFrame` 注释里的同一条纪律）。
   */
  function replayToClient(peer: Peer, clientId: string, resume: { sessionId: string; fromSeq: number }): void {
    const rejected = state.routeFrom(resume.sessionId, peer.ws, 'client')
    if (rejected) {
      // 只记一次级别的低噪日志：这条不是错误（旧 convId 的重连会稳定走到这里），
      // 但"没补帧"在排障时是必须看得见的事实。
      log.info('resume skipped', { clientId, sessionId: resume.sessionId, reason: rejected })
      return
    }
    const conv = state.conversations.get(resume.sessionId)
    if (!conv) return // routeFrom 刚验过成员资格；竞态里被删了就当没东西可补
    const result = state.replay.replay(resume.sessionId, resume.fromSeq, conv.seqHost)
    if (!result.ok) {
      sendToPeer(peer, resumeGapFrameOf(resume.sessionId, result.reason))
      log.info('resume gap', {
        clientId,
        sessionId: resume.sessionId,
        reason: result.reason,
        fromSeq: resume.fromSeq,
        seqHost: conv.seqHost,
      })
      return
    }
    for (const entry of result.frames) {
      sendToPeer(peer, encToClient(resume.sessionId, entry.seq, entry.ciphertext))
    }
    if (result.frames.length > 0) {
      log.info('resume replayed', {
        clientId,
        sessionId: resume.sessionId,
        count: result.frames.length,
        fromSeq: resume.fromSeq,
      })
    }
  }

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
      /**
       * `unknown_session` = **用户被迫重扫**的那一下（2026-10-26 补）。
       *
       * 客户端收到它会 `_forgetPairing()` 并提示"会话已失效，请重新配对" ——
       * 也就是"用着用着断了、只能回到电脑前重扫"的第一号现场。
       * 此前中继**一条都不记**：那个数字只能从"手机说它断了"倒推，
       * 而线上没有第二个来源 ⇒ 它**数不出来**。
       *
       * 与 `not_member` 同纪律：逐帧判定 ⇒ 只记一次（一个拿着死 convId 的对端
       * 能连打几百帧）。
       */
      if (rejected === 'unknown_session' && !peer.notedUnknownSession) {
        peer.notedUnknownSession = true
        log.info('unknown session', {
          sessionId: frame.sessionId,
          clientId: peer.clientId,
          role: peer.role,
        })
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
      // 上行帧记账（埋点 2026-10-23）：送达主机才计（`host_unavailable` 那条路在上面就 return 了）。
      state.countUplink(frame.sessionId)
      return
    }
    // 下行：中继重新编号（客户端不信 seq 的单调性，但编号让审计与合并可写）。
    const seq = state.nextHostSequence(frame.sessionId)
    // 入环在**分配点**、在投递之前：断线期间没人收也照存（那正是要补的那几帧），
    // 而且与 seq 分配同生共死 ⇒ 环内区间连续（`ReplayBuffer.replay` 的覆盖判定靠它）。
    if (seq !== undefined) state.replay.push(frame.sessionId, seq, frame.ciphertext)
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
      // 上行记账：批量帧一帧装多条，这里按**帧**计一条（与 seqHost 的"条"口径不同，
      // 排查时看的是"手机发了几次"，批量与否是实现细节）。
      state.countUplink(frame.sessionId)
      return
    }
    // 下行批量帧由中继逐条编号（客户端只看 ciphertext，但编号让"帧数不膨胀、顺序不乱"
    // 这类审计断言可写）。编号失败说明会话在飞行中被删了——那这一批就不该再发出去。
    if (clients.length === 0) counters.droppedFrames += 1
    const items: Array<{ seq: number; ciphertext: string }> = []
    for (const item of frame.items) {
      const seq = state.nextHostSequence(frame.sessionId)
      if (seq === undefined) return
      // 同 forwardEnc：分配点入环。⚠️ 后半段因会话被删而放弃发送时，前面已分配的
      // 几条**也要留在环里**——编号已被消耗，环里留洞会让 replay() 把洞当成"补上了"。
      state.replay.push(frame.sessionId, seq, item.ciphertext)
      items.push({ seq, ciphertext: item.ciphertext })
    }
    for (const sock of clients) sendTo(sock, encBatchToClient(frame.sessionId, items))
  }

  let lastResyncPersistAt = 0

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
      /**
       * 主机 → 中继 → 手机：psk 的密文（2026-10-21）。
       *
       * **只有主机能发**；中继按 `sessionId` 找会话成员，把帧原样转过去。
       * 它不解析 `wrappedPsk`，也没有能解开的密钥 —— 零知识的前提不变。
       */
      case 'pair-grant': {
        if (peer.role !== 'host' || !peer.hostId) {
          sendError(peer, 'need_host')
          return
        }
        const conv = state.conversations.get(frame.sessionId)
        if (conv === undefined) {
          // 会话已被回收（主机掉线/超时）：这张密文无处可送，直接丢弃。
          // 不报错给主机——它此刻也没法补救，报错只会在日志里制造噪音。
          log.info('pair-grant dropped, unknown session', { sessionId: frame.sessionId })
          return
        }
        for (const clientId of conv.clients) {
          const clientPeer = state.clients.get(clientId)
          const socket = clientPeer?.ws
          if (socket !== undefined) sendTo(socket, frame)
        }
        return
      }
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
            // ⚠️ **hostId 是这条日志的"谁"**（2026-10-26 补）：原来只有 sessionId
            // 与客户端数，于是"93 次作废"只能靠时间线反推是哪台主机（本次分析里
            // 78/93 靠"上线后 120 秒内"猜出来）⇒ 归因永远是猜的。
            hostId: peer.hostId,
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
          /**
           * 客户端**主动离开**一条会话（2026-10-26 补）。
           *
           * 为什么必须记：主机收到 `peer-left(unpaired)` 会**作废**这条会话
           * （见 plugin/transport/relay.ts）⇒ 中继侧随后就有一条
           * "conversation voided by host"。**只看那一条会得出相反的结论**：
           * "主机把会话作废了，用户被迫重扫" —— 而真相常常是"**用户自己解的配**"，
           * 作废只是收尾。⇒ 这条把"谁先动的手"记下来，两者才能分开。
           */
          log.info('session left by client', {
            sessionId: frame.sessionId,
            clientId: peer.clientId,
            hostId: state.conversations.get(frame.sessionId)?.hostId,
          })
          // 成员表变了（少一个人），且可能顺带打上了空会话回收计时——两者都要落盘。
          markStateChanged()
        }
        return
      }
      case 'summary': {
        /**
         * 状态摘要登记（M2，REVIEW-offline-continuity §5.1）。
         *
         * 零知识切分的"状态可留存"面：主机登记一份**状态类**快照（时刻/布尔/整数，
         * `statusDigest` strict 把关），中继存进会话条目并落盘，回头供手机读
         * "最后已知"（下发面在 M-C：hello-ok 附加）。
         *
         * **host-only**：摘要的可信度完全建立在"只有主机能写"上 —— 手机冒充写
         * 摘要就是伪造"最后已知"（判据 e2e/relay-summary-audit ④）。
         * 会话对不上只静默丢：那是主机的旧账（会话已被回收），resync 那条路
         * 本来就会收它，这里再回错误反而会和 unknown_session 的消费语义打架
         *（那个码是给客户端"清配对"用的，对主机说没有任何可执行动作）。
         */
        if (peer.role !== 'host' || !peer.hostId) {
          sendError(peer, 'need_host')
          return
        }
        const conv = state.conversations.get(frame.sessionId)
        if (!conv || conv.hostId !== peer.hostId) return
        conv.summary = frame.summary
        markStateChanged()
        return
      }
      /**
       * 订阅消息：登记订阅（2026-10-27）。
       *
       * **仅 client 可发**。`code` 是 `wx.login` 的一次性 code，中继拿它换 openid。
       * ⚠️ **不记 code、不记 openid**（notifier 内部已经保证）。
       * ⚠️ 失败**只记日志、不回错误**（计划 §4.1）：换不到 openid 对用户没有
       *   可执行动作，回一个错误只会让小程序弹一句"失败"，而那对"没授权"没用。
       */
      case 'notify-register': {
        if (peer.role !== 'client' || !peer.clientId) {
          sendError(peer, 'need_client')
          return
        }
        if (!notifier.enabled) {
          // 中继没启用通知面（没配模板 id）⇒ 静默忽略，不给用户一个假错误。
          log.debug('notify register ignored: notifier disabled', { clientId: peer.clientId })
          return
        }
        void notifier.register(peer.clientId, frame.code, frame.subscribed === true).catch((e: unknown) => {
          log.warn('notify register failed', {
            clientId: peer.clientId,
            message: String((e as Error)?.message ?? e),
          })
        })
        return
      }
      /**
       * 订阅消息：主机请求发通知（2026-10-27）。
       *
       * **仅 host 可发**，且**会话必须属于这台主机** —— 否则任意一台主机都能
       * 让中继给别人的手机发通知（那是**骚扰**面，不只是"多发一条"）。
       *
       * ⚠️ 会话对不上**静默丢**（与 `summary` 那条同款纪律）：对主机说
       *   `unknown_session` 没有可执行动作，而回错误会和它的消费语义打架。
       * ⚠️ **不回执**（计划 §4.2）：v1 不做"发送失败重试"，主机那边靠自己的
       *   "这张卡通知过了"标记去重。
       */
      case 'notify-approval': {
        if (peer.role !== 'host' || !peer.hostId) {
          sendError(peer, 'need_host')
          return
        }
        const conv = state.conversations.get(frame.conversationId)
        if (!conv || conv.hostId !== peer.hostId) {
          log.warn('notify approval ignored: conversation not owned by this host', {
            hostId: peer.hostId,
            conversationId: frame.conversationId,
          })
          return
        }
        if (!notifier.enabled) {
          log.debug('notify approval ignored: notifier disabled', { hostId: peer.hostId })
          return
        }
        void notifier
          .notify({
            hostId: peer.hostId,
            conversationId: frame.conversationId,
            items: frame.items,
          })
          .catch((e: unknown) => {
            log.warn('notify approval failed', {
              hostId: peer.hostId,
              conversationId: frame.conversationId,
              message: String((e as Error)?.message ?? e),
            })
          })
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

  function onConnection(ws: WebSocket, ip: string): void {
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
      ip,
      connectedAt: Date.now(),
      role: 'unknown',
      rate: new FrameRateGate(config.maxFramesPerSec),
      authAttempts: 0,
      pairAttempts: 0,
      // 下面三条"只记一次"闩锁：限流与限配是**逐帧**触发的，日志与出站帧若也逐帧，
      // 一条未认证连接就能把 journald 的条数额度吃干净（见各自注释）。
      notedFrameFlood: false,
      notedNonMember: false,
      notedUnknownSession: false,
      notedPairTableFull: false,
      pairBudgetWarnedAt: 0,
      tableFullWarnedAt: 0,
      backpressure: new BackpressureGate(),
      alive: true,
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
      // 必须从桶里摘掉：Set 不摘就永远留着这条 Peer，ping 会继续朝一个已关闭的
      // socket 发（terminate 过的 ws 再 ping 是抛错被吞掉的），而且 maxConnections
      // 是按 wss.clients 算的，桶这边就会和闸门慢慢对不上。
      bucketAt(peer.pingBucket).delete(peer)
      if (peer.role === 'client' && peer.clientId) {
        for (const notice of state.clientGone(peer.clientId, ws)) {
          sendTo(state.hostSocket(notice.conversationId), peerLeftFrame(notice.conversationId, notice.clientId))
        }
        // 埋点（2026-10-23）：ip + 本连接存活时长——"1–5 秒闪断"这条顺畅率判据靠它。
        log.info('client disconnected', {
          clientId: peer.clientId,
          ip: peer.ip,
          onlineMs: Date.now() - peer.connectedAt,
        })
      }
      if (peer.role === 'host' && peer.hostId) {
        // 只有"这个 socket 仍是该主机的活连接"才打离线标记；重连时新 socket 已先注册。
        if (state.hostGone(peer.hostId, ws)) {
          log.info('host offline (grace started)', {
            hostId: peer.hostId,
            ip: peer.ip,
            onlineMs: Date.now() - peer.connectedAt,
          })
        }
      }
    })
    ws.on('error', (e: Error) => log.warn('socket error', { message: String(e?.message ?? e) }))
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

  // ── 清扫与保活（v5 R3b 抽出 → `sweep.ts`）──────────────────────────
  const sweepMod = createSweep({
    config,
    state,
    log,
    health: () => health(),
    forEachPeer: (fn) => forEachPeer(fn as never),
    nextPingBucket: () => {
      currentPingBucket = (currentPingBucket + 1) % pingBucketCount
      return bucketAt(currentPingBucket) as never
    },
    noteBackpressure: (peer, now) => noteBackpressure(peer as never, now),
    markStateChanged,
    persistNow,
    persistence,
    WS_OPEN,
  })
  const sweep = sweepMod.sweep
  const sweepPingBucket = sweepMod.sweepPingBucket

  // ── HTTP（v5 R3 抽出 → `http-routes.ts`）────────────────────────────
  const mpCodes = createMpCodeIssuer({
    appId: config.mpAppId,
    secret: config.mpSecret,
    envVersion: config.mpEnv,
    // 与订阅消息**共用**同一个 token 缓存（微信的 token 是单例）。
    tokens: wechatTokens,
  })
  const { handler: httpHandler, health } = createHttpRoutes({
    config,
    state,
    log,
    markStateChanged,
    mpCodes,
    pairStatusBudget,
    persistence,
    getShuttingDown: () => shuttingDown,
    startedAt,
    getLastPingAt: () => sweepMod.getLastPingAt(),
    getCounters: () => counters,
  })

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
  // 埋点归因取真实来源 IP（XFF/X-Real-IP，nginx 后面才有意义）；只进日志不做安全判定。
  // 限频（claim）那条路**刻意仍用 socket 地址**：那里是安全判定，头可伪造，不许信。
  wss.on('connection', (ws, req) => onConnection(ws, clientIpOf(req.headers, req.socket.remoteAddress ?? 'unknown')))

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
   * 光看退出码分不出这两种停机。
   *
   * ⚠️ 但要说清这个计数**能活多久**：`lifecycle.ts` 的兜底路径调完这里就 `exit(0)`，
   * 而 `/healthz` 只有进程活着才答得上 ⇒ **进程退出后它读不到**。
   * ⇒ 事后真正留得下来的是**代码里紧接着那条 `log.warn('shutdown forced' …)`**
   * （journald / `docker logs`）。这个计数的真实读者是：① 判据（exit 被注入成记录器，
   * 进程还活着）；② 有调用方接了停机出口却不真的退出进程的那种嵌入场景。
   * 把它说成"运维事后唯一能分辨的出口"是**不实**的——那样会让人去 /healthz 找一个
   * 已经不在了的进程（2026-10-12 review 订正）。
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
