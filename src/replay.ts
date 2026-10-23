/**
 * replay — per-会话下行帧环形缓冲（P1-3 断线补帧，2026-10-22）。
 *
 * ## 它解决什么
 *
 * 客户端断线期间主机还在输出：delta 分片、todo 刷新、run_state 跳变都**不进历史**
 * （§10.7 的 `since` 游标只管消息/步骤级条目），错过了就永远没了——现场症状是
 * "转圈后内容跳变"。中继在转发 host→client 的 `enc`/`enc-batch` 时把每一帧
 * 按自己的编号（`seqHost`）存一份，客户端重连时在 `hello.resume` 里报
 * "我上次收到这里"，从这里补投。
 *
 * ## 边界（§10.8 P3/P6）
 *
 * - **只补下行**：上行不计 seq、也没有丢失场景（丢了由 cmd 幂等与重试兜底）。
 * - **进程内、有界**：256 帧/会话 + 2 MiB/会话 + 全局 64 MiB。中继重启即丢——
 *   那一段不承诺（今天 `droppedFrames` 里属于重启段的本来就补不回）。
 * - **覆盖不了就明说**：`replay()` 返回 `overflow`/`reset`，由调用方回
 *   `resume-gap`。MUST NOT 少发几帧装作补完（与 §10.7 S5 同一条纪律：
 *   悄悄缺帧是最坏的处理——客户端会以为补齐了，那段**永远补不回来**）。
 *
 * ## 为什么不是存在 `Conversation` 上
 *
 * 落盘字段集是钉死的（persist.ts："落：conversationId / hostId / clients / seqHost /
 * lastActivityAt / emptySince"），环要是挂在会话对象上，哪天 restoreState 忘了
 * 剔掉它就会被序列化进 state.json —— 那正是"本该是进程内的东西长成了持久状态"。
 * 独立一张表、会话删除时一起 `forget`（作废时残留要一起清，本仓栽过两次）。
 */
import { MAX_CIPHERTEXT_BYTES } from '@dsh-remote/protocol/limits'

/** 每会话最多留几帧（计划口径 256）。溢出丢**最旧**的——那是"覆盖不了"的成因之一。 */
export const REPLAY_MAX_FRAMES = 256

/** 每会话的字节预算。附件回传单帧可近 1 MiB，没有这一层 256 帧 ≈ 256 MiB/会话。 */
export const REPLAY_MAX_BYTES_PER_CONV = 2 * 1024 * 1024

/**
 * 全局字节预算。`maxConversations` 默认 5000，逐会话 2 MiB 的理论上限是 10 GiB ——
 * 真实负载远不到（2026-10-22 同时在册 ≤20 条），但"无界"是本仓审计里反复咬人的形状，
 * 所以上限要有、超了就整环丢**最久没推过**的那条会话（丢整环保持其余环的连续性）。
 */
export const REPLAY_MAX_BYTES_TOTAL = 64 * 1024 * 1024

export interface ReplayEntry {
  seq: number
  ciphertext: string
}

export type ReplayResult = { ok: true; frames: ReplayEntry[] } | { ok: false; reason: 'overflow' | 'reset' }

interface Ring {
  /** 按 seq 升序、**连续**（每分配一个 seq 就 push，见 forwardEnc/forwardEncBatch）。 */
  entries: ReplayEntry[]
  bytes: number
  /** 全局淘汰用的 LRU 键：每次 push 自增的逻辑时钟（不挂墙上时钟，免回拨）。 */
  tick: number
}

export class ReplayBuffer {
  private rings = new Map<string, Ring>()
  private totalBytes = 0
  private tick = 0

  /**
   * 存一帧。**在 seq 分配点调用**——包括"批量帧后半段因会话被删而放弃发送"的那些：
   * 编号已经被 `nextHostSequence` 消耗掉，环里留着洞的话 `replay()` 的连续性判断
   * 会把洞当成"已经补上了"，那是最坏的静默缺帧。
   */
  push(conversationId: string, seq: number, ciphertext: string): void {
    // 一条帧再大也过不了 schema（MAX_CIPHERTEXT_BYTES），但这里是"转发路径"——
    // 中继对密文只把关字符集与长度（bad_frame 那两道），仍按实际长度计账。
    const bytes = Math.min(ciphertext.length, MAX_CIPHERTEXT_BYTES)
    let ring = this.rings.get(conversationId)
    if (!ring) {
      ring = { entries: [], bytes: 0, tick: 0 }
      this.rings.set(conversationId, ring)
    }
    ring.entries.push({ seq, ciphertext })
    ring.bytes += bytes
    this.totalBytes += bytes
    this.tick += 1
    ring.tick = this.tick
    // 先按帧数剪（丢最旧），再按会话字节剪。剪最旧 ⇒ 留下的区间仍然连续。
    while (ring.entries.length > REPLAY_MAX_FRAMES) {
      const gone = ring.entries.shift()
      if (!gone) break
      ring.bytes -= Math.min(gone.ciphertext.length, MAX_CIPHERTEXT_BYTES)
      this.totalBytes -= Math.min(gone.ciphertext.length, MAX_CIPHERTEXT_BYTES)
    }
    while (ring.bytes > REPLAY_MAX_BYTES_PER_CONV && ring.entries.length > 1) {
      const gone = ring.entries.shift()
      if (!gone) break
      const g = Math.min(gone.ciphertext.length, MAX_CIPHERTEXT_BYTES)
      ring.bytes -= g
      this.totalBytes -= g
    }
    // 全局预算：丢整环（最久没推过的那条会话）。推不动了就到此为止——
    // 预算再紧也不能把刚 push 进去的这一条丢掉。
    while (this.totalBytes > REPLAY_MAX_BYTES_TOTAL && this.rings.size > 1) {
      let victim: string | null = null
      let victimTick = Infinity
      for (const [id, r] of this.rings) {
        if (id === conversationId) continue
        if (r.tick < victimTick) {
          victimTick = r.tick
          victim = id
        }
      }
      if (victim === null) break
      this.forget(victim)
    }
  }

  /**
   * 补投 `seq > fromSeq` 的存帧。
   *
   * @param seqHost 会话的**权威计数器**（`Conversation.seqHost`）：判断"这段是不是
   *   真的存在过"要用它，环只能证明"我们留住了什么"。中继重启后环空了而计数器
   *   还在（它落盘）——那正是 `overflow` 的一半成因。
   */
  replay(conversationId: string, fromSeq: number, seqHost: number): ReplayResult {
    // 游标跑到了计数器前面：会话被重建过 / state.json 被手改过。两个序号空间
    // 已经对不上，继续回放只会把新旧两代的帧混在一起——明说 reset。
    if (fromSeq > seqHost) return { ok: false, reason: 'reset' }
    // 追平了：一件也不用补（哪怕环是空的——那不是缺帧，是"没有新东西"）。
    if (fromSeq === seqHost) return { ok: true, frames: [] }
    const ring = this.rings.get(conversationId)
    // 环里最旧的一条 = 还能覆盖的下界；空环（重启/整环淘汰）意味着什么都盖不住。
    const oldest = ring?.entries[0]
    const floor = oldest ? oldest.seq : seqHost + 1
    if (fromSeq + 1 < floor) return { ok: false, reason: 'overflow' }
    // 连续性前提（push 在 seq 分配点 + 只剪最旧）下，剩下的必然是 fromSeq+1..seqHost
    // 的一段尾巴。仍然按 seq 过滤一遍——判断依赖"连续"这个前提，过滤才是兑现它。
    const frames = (ring?.entries ?? []).filter((e) => e.seq > fromSeq)
    return { ok: true, frames }
  }

  /** 会话删除时一起清（作废时残留要一起清）。幂等。 */
  forget(conversationId: string): void {
    const ring = this.rings.get(conversationId)
    if (!ring) return
    this.totalBytes -= ring.bytes
    this.rings.delete(conversationId)
  }

  /** 全量清空（`RelayState.reset` 一起清：作废时残留要一起清）。幂等。 */
  clear(): void {
    this.rings.clear()
    this.totalBytes = 0
    // tick 不回拨：LRU 键单调即可，回拨会让"新环比旧环更旧"。
  }

  /** 诊断用：当前留着几条会话的环。 */
  size(): number {
    return this.rings.size
  }

  /** 诊断用：当前环内帧数（全会话合计）。 */
  frameCount(): number {
    let n = 0
    for (const ring of this.rings.values()) n += ring.entries.length
    return n
  }
}
