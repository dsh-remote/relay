/**
 * feedback — 反馈存储（2026-10-26）。
 *
 * ## 这是什么
 *
 * 一条**明文**的用户意见，从小程序一路存到运维能读的地方。
 * 协议层的三帧（`feedback` / `feedback-poll` / `feedback-list`）在
 * `protocol/frames.ts` 里定义；这里管的是**存**。
 *
 * ## 为什么单独一个文件（而不是塞进 state.json）
 *
 * `state.json` 是**会话表**：它有严格的形状闸（`persist.ts` 的 `sanitize`），
 * 读路径按"形状"而不是版本号判断能不能继承（2026-10-12 事故之后定的纪律）。
 * 把一份**自由文本**塞进去会污染那条纪律 —— 而自由文本的形状闸远比会话表复杂
 * （它必须是 strict、必须限长、必须能被"坏一条丢一条"地筛）。
 *
 * ⇒ 另起一个文件 `feedback.json`：**独立失败域**。它坏了（或被人手改坏了），
 *   会话表照常恢复；它丢了，反馈丢几条，用户的会话一点事没有。
 *
 * ## 谁有资格提（2026-10-26 产品裁决）
 *
 * **只有配对成功的人才有权限提反馈。** 判据在调用点（server.ts）：中继查
 * "这个 clientId 是不是某条活跃会话的成员" —— 那需要真走过一次扫码 + SAS 确认，
 * 不是自报能伪造的（clientId 本身是自报的，见 handleHello 的客户端分支）。
 *
 * 本模块**不**重复那个判定：它只管存与取。判定在 server.ts（那里有会话表），
 * 存储层不该自己再实现一遍"配对"的定义。
 *
 * ## 限频（因为客户端**无鉴权**）
 *
 * 配对这道门已经把刷屏成本抬到"先配一台主机"，但那不够：一个人可以配一次然后狂发。
 * 所以这里是**双闸**：每个 clientId 每小时 N 条、每个 IP 每小时 M 条，
 * 再加一条全局条数上限（满了丢最旧的）。闸门用尽**出声**（返回 rate_limited），
 * 不静默丢 —— 静默丢会让用户以为提交成功了。
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
import { FEEDBACK_SLA_HOURS, type FeedbackItem } from '@dsh-remote/protocol/frames'
import type { Log } from './log.js'

/** 落盘格式版本（**只决定我们写出什么**；读的一侧认形状，同 persist.ts 的纪律）。 */
export const FEEDBACK_FILE_VERSION = 1

/** 一条反馈在存储层的完整样子（比协议层的 `FeedbackItem` 多两个运维字段）。 */
export interface FeedbackEntry {
  id: string
  /** 提交者的 clientId（中继侧的事实，不是自报字段——它由中继自己记账）。 */
  clientId: string
  /** 提交来源 IP（运维归因用；同一 clientId 换 IP 会被这条闸抓到）。 */
  ip: string
  text: string
  contact?: string
  at: number
  status: 'open' | 'replied'
  reply?: string
  repliedAt?: number
}

export type AddResult =
  | { ok: true; entry: FeedbackEntry }
  | { ok: false; reason: 'duplicate' | 'rate_limited_client' | 'rate_limited_ip' | 'full' }

export interface FeedbackStoreOptions {
  /** 落盘路径（空串 = 只在内存里，不落盘）。 */
  path: string
  /** 全局条数上限。满了丢**最旧**的（反馈的价值随时间衰减）。 */
  maxEntries: number
  /** 每个 clientId 每小时最多几条。 */
  perClientPerHour: number
  /** 每个 IP 每小时最多几条。 */
  perIpPerHour: number
  log: Log
}

/** 限频表里记的时刻（epoch ms）。空表 = 还没限过。 */
interface RateWindow {
  stamps: number[]
}

/**
 * 一小时的窗口（毫秒）。
 *
 * 用**滑动窗口**而不是"整点重置"：整点重置会让窗口边界上的用户一分钟内
 * 发掉两份配额（59:59 发 5 条、00:01 再发 5 条）。滑动窗口把这口缝堵上。
 */
const HOUR_MS = 3_600_000

export class FeedbackStore {
  private readonly entries: FeedbackEntry[] = []
  private readonly byId = new Map<string, FeedbackEntry>()
  private readonly clientWindows = new Map<string, RateWindow>()
  private readonly ipWindows = new Map<string, RateWindow>()
  private readonly opts: FeedbackStoreOptions
  private savedAt = 0

  constructor(opts: FeedbackStoreOptions) {
    this.opts = opts
  }

  /** 落盘路径（空 = 不落盘）。 */
  get path(): string {
    return this.opts.path
  }

  /** 当前条数。 */
  get size(): number {
    return this.entries.length
  }

  /**
   * 读回落盘文件。返回恢复的条数。
   *
   * 坏文件**不抛**：读不了就当空（与 persist.ts 同一条纪律 —— 起不来的中继
   * 等于整个产品停摆，而坏文件的唯一后果是"丢几条反馈"）。
   */
  load(): number {
    if (this.opts.path === '') return 0
    let text: string
    try {
      text = readFileSync(this.opts.path, 'utf8')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return 0
      this.opts.log.warn('feedback file unreadable, starting empty', { path: this.opts.path, code: String(code ?? e) })
      return 0
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.opts.log.warn('feedback file corrupt (json), starting empty', { path: this.opts.path })
      return 0
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.opts.log.warn('feedback file corrupt (shape), starting empty', { path: this.opts.path })
      return 0
    }
    const file = parsed as Record<string, unknown>
    if (!Array.isArray(file.entries)) {
      this.opts.log.warn('feedback file has no entries array, starting empty', { path: this.opts.path })
      return 0
    }
    let kept = 0
    let dropped = 0
    for (const item of file.entries) {
      const entry = sanitizeEntry(item)
      if (entry === undefined) {
        dropped += 1
        continue
      }
      if (this.byId.has(entry.id)) {
        dropped += 1
        continue
      }
      this.push(entry)
      kept += 1
    }
    if (dropped > 0) {
      this.opts.log.warn('feedback entries dropped', { path: this.opts.path, dropped, kept })
    }
    this.opts.log.info('feedback file loaded', { path: this.opts.path, entries: kept, dropped })
    return kept
  }

  /**
   * 收一条反馈。
   *
   * `id` 是**幂等键**：同 id 再来一次只当重发（返回 duplicate，不改内容）——
   * 小程序在网络抖动时会重发同一条，重发不该变成两条反馈。
   */
  add(clientId: string, ip: string, input: { id: string; text: string; contact?: string }, now: number): AddResult {
    if (this.byId.has(input.id)) return { ok: false, reason: 'duplicate' }
    // ⚠️ **先判后占**：两道闸都过了才消耗配额。
    // 否则一次被拒的提交（IP 那道没过）也会吃掉客户端自己的额度 ——
    // 用户会发现自己"什么都没提交成，额度却用完了"，而额度是用来看得见的。
    if (!this.canTake(this.clientWindows, clientId, now, this.opts.perClientPerHour)) {
      return { ok: false, reason: 'rate_limited_client' }
    }
    if (!this.canTake(this.ipWindows, ip, now, this.opts.perIpPerHour)) {
      return { ok: false, reason: 'rate_limited_ip' }
    }
    this.takeSlot(this.clientWindows, clientId, now, this.opts.perClientPerHour)
    this.takeSlot(this.ipWindows, ip, now, this.opts.perIpPerHour)
    const entry: FeedbackEntry = {
      id: input.id,
      clientId,
      ip,
      text: input.text,
      at: now,
      status: 'open',
    }
    if (input.contact !== undefined && input.contact !== '') entry.contact = input.contact
    this.push(entry)
    this.save()
    return { ok: true, entry }
  }

  /** 某个 clientId 自己的反馈（**协议形状**，不含 clientId/ip ——那两个是运维字段）。 */
  listFor(clientId: string): FeedbackItem[] {
    const out: FeedbackItem[] = []
    for (const entry of this.entries) {
      if (entry.clientId !== clientId) continue
      out.push(toItem(entry))
    }
    // 新的在前（用户最关心刚提的那条）。
    out.reverse()
    return out.slice(0, 200)
  }

  /** 全部（运维面，带 clientId/ip）。 */
  listAll(): FeedbackEntry[] {
    return [...this.entries].reverse()
  }

  /** 找一条（运维面）。 */
  get(id: string): FeedbackEntry | undefined {
    return this.byId.get(id)
  }

  /**
   * 回一条。返回 false = 没有这条 id。
   *
   * 回复**不覆盖**原话（用户能看见自己说了什么），只是把 `status` 推进到 `replied`。
   */
  reply(id: string, text: string, now: number): boolean {
    const entry = this.byId.get(id)
    if (entry === undefined) return false
    entry.status = 'replied'
    entry.reply = text
    entry.repliedAt = now
    this.save()
    return true
  }

  /** 未回条数与逾期条数（**SLA 口径**：承诺 24 小时内回复，超了就是逾期）。 */
  slaCounts(now: number): { open: number; overdue: number; slaHours: number } {
    const deadline = FEEDBACK_SLA_HOURS * HOUR_MS
    let open = 0
    let overdue = 0
    for (const entry of this.entries) {
      if (entry.status !== 'open') continue
      open += 1
      if (now - entry.at > deadline) overdue += 1
    }
    return { open, overdue, slaHours: FEEDBACK_SLA_HOURS }
  }

  /**
   * 落盘。原子写（tmp → fsync → rename → 目录 fsync），权限 0600。
   *
   * 与 `persist.ts` 的 `writeStateFile` 同一套纪律（那里有每一条的理由）：
   * 临时文件必须在**同目录**（rename 只在同一文件系统内原子）、必须 `wx` 独占创建
   * 再显式 chmod（`mode` 只在创建那一刻生效，崩溃残留 + pid 复用会绕过它）、
   * 失败**不许抛**（一次写盘失败不该把中继带崩）。
   */
  save(): boolean {
    if (this.opts.path === '') return false
    const tmp = `${this.opts.path}.${process.pid}.tmp`
    const payload = JSON.stringify({
      version: FEEDBACK_FILE_VERSION,
      savedAt: Date.now(),
      entries: this.entries,
    })
    try {
      mkdirSync(dirname(this.opts.path), { recursive: true })
      try {
        unlinkSync(tmp)
      } catch {
        /* ENOENT 就是我们要的：没有残留 */
      }
      writeFileSync(tmp, `${payload}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      chmodSync(tmp, 0o600)
      syncPath(tmp, this.opts.log, true)
      renameSync(tmp, this.opts.path)
      syncPath(dirname(this.opts.path), this.opts.log, false)
      this.savedAt = Date.now()
      return true
    } catch (e) {
      this.opts.log.warn('feedback file write failed', {
        path: this.opts.path,
        message: String((e as Error)?.message ?? e),
      })
      try {
        unlinkSync(tmp)
      } catch {
        /* 清理失败不追加日志 */
      }
      return false
    }
  }

  /** 内部：追加 + 索引 + 上限裁剪。 */
  private push(entry: FeedbackEntry): void {
    this.entries.push(entry)
    this.byId.set(entry.id, entry)
    while (this.entries.length > this.opts.maxEntries) {
      const dropped = this.entries.shift()
      if (dropped !== undefined) this.byId.delete(dropped.id)
    }
  }

  /** 限频判定（**不消耗**配额）。 */
  private canTake(table: Map<string, RateWindow>, key: string, now: number, limit: number): boolean {
    const window = table.get(key)
    if (window === undefined) return true
    return window.stamps.filter((t) => now - t < HOUR_MS).length < limit
  }

  /** 消耗一格配额。 */
  private takeSlot(table: Map<string, RateWindow>, key: string, now: number, limit: number): void {
    const window = table.get(key) ?? { stamps: [] }
    window.stamps = window.stamps.filter((t) => now - t < HOUR_MS)
    window.stamps.push(now)
    table.set(key, window)
    // 表有界：过期的键清掉（否则每个新 clientId 都会在表里留一辈子）。
    if (table.size > 10_000) {
      for (const [k, w] of table) {
        if (w.stamps.every((t) => now - t >= HOUR_MS)) table.delete(k)
        if (table.size <= 10_000) break
      }
    }
  }
}

/** 协议形状（**不含** clientId/ip —— 那两个是运维字段，不进小程序）。 */
function toItem(entry: FeedbackEntry): FeedbackItem {
  const item: FeedbackItem = {
    id: entry.id,
    text: entry.text,
    at: entry.at,
    status: entry.status,
  }
  if (entry.contact !== undefined) item.contact = entry.contact
  if (entry.reply !== undefined) item.reply = entry.reply
  if (entry.repliedAt !== undefined) item.repliedAt = entry.repliedAt
  return item
}

/**
 * 逐条筛落盘条目。**坏一条丢一条**，不整份作废（与 persist.ts 同一条纪律）。
 *
 * 反馈文件不是信任边界（可能被人手改过）：字段类型不对、长度离谱的整条丢掉，
 * 而不是"剥掉坏字段放行" —— 剥掉放行会让人以为"那条反馈存住了"，而真相是它已经没了。
 */
function sanitizeEntry(item: unknown): FeedbackEntry | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const raw = item as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id === '' || raw.id.length > 128) return undefined
  if (typeof raw.clientId !== 'string' || raw.clientId === '' || raw.clientId.length > 200) return undefined
  if (typeof raw.ip !== 'string' || raw.ip.length > 64) return undefined
  if (typeof raw.text !== 'string' || raw.text === '' || raw.text.length > 2000) return undefined
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at < 0) return undefined
  if (raw.status !== 'open' && raw.status !== 'replied') return undefined
  if (raw.contact !== undefined && (typeof raw.contact !== 'string' || raw.contact.length > 120)) return undefined
  if (
    raw.reply !== undefined &&
    (typeof raw.raw !== 'string' || typeof raw.reply !== 'string' || raw.reply.length > 2000)
  ) {
    return undefined
  }
  if (raw.repliedAt !== undefined && (typeof raw.repliedAt !== 'number' || !Number.isFinite(raw.repliedAt))) {
    return undefined
  }
  const entry: FeedbackEntry = {
    id: raw.id,
    clientId: raw.clientId,
    ip: raw.ip,
    text: raw.text,
    at: raw.at,
    status: raw.status,
  }
  if (typeof raw.contact === 'string') entry.contact = raw.contact
  if (typeof raw.reply === 'string') entry.reply = raw.reply
  if (typeof raw.repliedAt === 'number') entry.repliedAt = raw.repliedAt
  return entry
}

/**
 * 把一个路径 fsync 到盘上。
 *
 * 与 persist.ts 的 `syncPath` 同款：先 `'r+'`（Windows 的 FlushFileBuffers 要求写权限），
 * 拿不到再退 `'r'`；目录那一次是 best-effort（`strict=false`）。
 */
function syncPath(target: string, log: Log, strict = true): void {
  let fd: number | undefined
  try {
    try {
      fd = openSync(target, 'r+')
    } catch {
      fd = openSync(target, 'r')
    }
    fsyncSync(fd)
  } catch (e) {
    if (strict) throw e
    log.debug('directory fsync unsupported, continuing', {
      path: target,
      message: String((e as Error)?.message ?? e),
    })
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
