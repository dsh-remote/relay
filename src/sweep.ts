/**
 * sweep —— 清扫与保活（v5 R3b 从 `server.ts` 抽出）。
 *
 * 三件事挂在同一个 `sweepMs` 轮次上（**周期不能跟着心跳变长**，理由见 sweep 的注释）：
 * 表项生命周期（过期码 / 挂起 / 空闲 / 空会话）、慢消费者判定、计数器抄日志；
 * 另有一条分桶保活 ping（治 10k 连接的 ping 突发）。
 *
 * ⚠️ **行为零变化**：判据一片未动照样全绿。
 */
import type { RelayConfig } from './config.js'
import type { RelayState } from './state.js'
import type { Log } from './log.js'

export interface SweepDeps {
  config: RelayConfig
  state: RelayState
  log: Log
  health: () => Record<string, string | number | boolean | Record<string, number>>
  forEachPeer(fn: (ws: { readyState: number }, peer: unknown) => void): void
  /** 推进保活桶游标并交出这一桶的对端（桶表住连接域，见 server 的 `bucketAt`）。 */
  nextPingBucket(): Iterable<{
    alive: boolean
    clientId: string
    hostId: string
    ws: { ping(): void; terminate(): void }
  }>
  noteBackpressure(peer: unknown, now: number): void
  markStateChanged(): void
  persistNow(): void
  persistence: { enabled: boolean; savedAt: number }
  WS_OPEN: number
}

export function createSweep(deps: SweepDeps): {
  sweep: () => void
  sweepPingBucket: () => void
  maybePersistPeriodic: () => void
  getLastPingAt: () => number
} {
  /** 保活/计数的两个节拍游标（原来住 server 的闭包里，跟着搬过来）。 */
  const pingState = { lastPingAt: 0 }
  const countersState = { last: 0 }
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
    const expired = deps.state.expirePairs()
    if (expired.length > 0) deps.log.debug('pair tokens expired', { count: expired.length })
    // 慢消费者判定：**定时驱动**，不看这一轮有没有入站帧（见 noteBackpressure 的注释）。
    // 只对 OPEN 的连接读 bufferedAmount——已关闭的连接读它是无意义的。
    const backpressureAt = Date.now()
    deps.forEachPeer((ws, peer) => {
      if (ws.readyState === deps.WS_OPEN) deps.noteBackpressure(peer, backpressureAt)
    })
    /**
     * D6（2026-10-23 改语义，用户裁决「挂起、回来可恢复」）：宽限期到期 = **挂起**。
     *
     * 旧写法在这里删会话 + 给客户端发 `peer-left` —— 而手机收到 `peer-left` 就
     * `_forgetPairing()` ⇒ 被迫重新扫码（实测：一条 219 帧的会话，宽限一过就没）。
     * 现在只记一笔日志：会话、密钥、成员表、补帧环**全留着**，主机回来自动恢复
     * （`attachHost` 清离线标记），手机全程不用动。最终 GC 交给 `sweepEmpty`（30 分钟）
     * 与 `sweepIdle`（7 天）两条既有规则。
     *
     * ⚠️ 曾经这里发 `peer-left`，还有一条 N² 回归（外层内层同名 ⇒ 每个成员收 N 条）。
     * 现在这条路上一条帧都不发 ⇒ 那类回归在这条路上无从发生；"每个成员恰好一条"的
     * 不变量改由**主动作废**那条路（`dropConversation` 的调用方）承担。
     */
    for (const hostId of deps.state.suspendExpiredHosts(deps.config.hostGraceMs)) {
      deps.log.info('host suspended by grace (sessions kept, recoverable)', { hostId })
    }
    const idleDropped = deps.state.sweepIdle(deps.config.conversationIdleTtlMs)
    for (const conversationId of idleDropped) {
      deps.log.info('conversation idle-dropped', { sessionId: conversationId })
    }
    // P2-⑤：只剩主机、没有客户端的会话，最后一个客户端走后 emptyTtl 就回收。
    // 不发任何帧给谁：这条路上"还有客户端"这件事已经不成立（有客户端也不会进这里），
    // 而主机侧会话本来就与中继这张表各自独立（resync 会重新声明）。
    const emptyDropped = deps.state.sweepEmpty(deps.config.conversationEmptyTtlMs)
    for (const conversationId of emptyDropped) {
      deps.log.info('conversation empty-dropped', { sessionId: conversationId })
    }
    // 回收同步删盘（纪律第 3 条）：空会话回收与空闲剪枝都是"永久删除"，不同步的话
    // 重启会把它们读回来复活。三条删除路径共用这一次落盘——它们本来就同属一轮清扫，
    // 一轮写一次，而不是删几个就写几次。
    // 挂起不动表 ⇒ 不需要落盘；只有真删了的那两条要（否则重启会把它们读回来复活）。
    if (idleDropped.length > 0 || emptyDropped.length > 0) deps.markStateChanged()
    else maybePersistPeriodic()
    // 计数器快照借这一轮的节拍，但它**不是**表项生命周期的一部分（见 logCountersIfDue 的注释）。
    logCountersIfDue()
  }

  /**
   * 周期性补写，只为刷新 `lastActivityAt`（见 deps.config.ts 里 `stateSaveMs` 的注释）。
   *
   * 挂在 sweep 这一轮上而不是另开定时器：sweep 本来就每 `sweepMs` 醒一次，
   * 再加一个定时器只是多一条要维护的生命周期。
   */
  function maybePersistPeriodic(): void {
    if (!deps.persistence.enabled) return
    const now = Date.now()
    if (now - deps.persistence.savedAt < deps.config.stateSaveMs) return
    deps.persistNow()
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
   * 字段直接复用 `deps.health()`，不在这里第二处列一遍——两处各写迟早分叉，
   * 而分叉之后"日志说的"和"`/healthz` 说的"就成了一套罗夏测试。
   */
  function logCountersIfDue(): void {
    const now = Date.now()
    if (now - countersState.last < deps.config.countersLogMs) return
    countersState.last = now
    /**
     * health 里有**嵌套计数表**（hostVersions/clientVersions），而 `LogValue` 刻意
     * 只收标量（"没有 object/array ⇒ 没有顺手把载荷打出来"那条零知识防线）——
     * 不为两个计数表破防线，压成短串再进日志。
     */
    const flat: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(deps.health())) {
      flat[key] = typeof value === 'object' ? JSON.stringify(value) : value
    }
    deps.log.info('counters', flat)
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
    // 桶的推进与取用在 server 的连接域里（`pingBuckets` 与生命周期共享）；
    // 这里只要"下一个桶"（deps 推进游标并交出这一桶的对端）。
    for (const peer of deps.nextPingBucket()) {
      if (!peer.alive) {
        deps.log.warn('heartbeat timeout', { clientId: peer.clientId, hostId: peer.hostId })
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
    pingState.lastPingAt = Date.now()
  }

  return { sweep, sweepPingBucket, maybePersistPeriodic, getLastPingAt: () => pingState.lastPingAt }
}
