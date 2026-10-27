/**
 * notify — 微信订阅消息发送器（2026-10-27）。
 *
 * ## 它做什么
 *
 * 审批/提问挂起超过 3 分钟、而**手机不在线**时，发一条**不含内容**的微信服务通知，
 * 让用户知道"电脑那边卡着等你"。方案见 `docs/PLAN-WECHAT-NOTIFY.md`。
 *
 * ## 隐私边界（本文件最重要的一段）
 *
 * 通知里**只有通用文案 + 时间**：没有 action、没有 reason、没有问题正文、
 * 没有命令、没有会话标题。模板的"申请备注"那一格也只放固定文案。
 *
 * ⇒ 为什么模板正文由**中继**填、而不是由主机带上来：主机知道"这次要跑的
 *   工具是什么"，让主机填那一格就等于把内容塞进通知 —— 而通知会出现在
 *   锁屏上。所以协议帧里只有元数据（哪张卡、什么时候挂起的），正文是中继的常量。
 *
 * ## openid 的处置
 *
 * **只存内存**（`clientId → openid`）：中继重启即丢，手机下次开页重新登记。
 * 不落盘、不进 status、不出 healthz、不写日志。
 *
 * ## 额度与频控（防轰炸的四道闸）
 *
 * | 闸 | 值 | 为什么 |
 * | --- | --- | --- |
 * | 每张卡 | 1 条，永不重发 | 同一张卡重复通知 = 用户被反复戳 |
 * | 订阅额度 | 每个 openid 3 条 | 微信的一次性订阅 = 一次授权一条 |
 * | 冷却 | 10 分钟 | 连续挂起多张卡时不该连着响 |
 * | 每小时 / 每天 | 3 条 / 10 条 | 平台侧还有自己的风控，我们先自己收着 |
 */
import type { NotifyItem } from '@dsh-remote/protocol/frames'
import type { Log } from './log.js'
import type { WechatTokenFetch, WechatTokenProvider } from './wechat-token.js'

/** 微信接口地址（常量而不是配置：换域名不是运维旋钮）。 */
const SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session'
const SEND_URL = 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send'

/**
 * 每个 openid 最多攒几条订阅额度。
 *
 * 微信的**一次性订阅**是"一次授权 = 一条消息" ⇒ 额度用完就没有下一次了。
 * 3 是计划里定的值（`docs/PLAN-WECHAT-NOTIFY.md` §13 记着"是否改成 5 待定"）。
 */
export const NOTIFY_QUOTA_MAX = 3
/** 同一用户两次通知之间的冷却（毫秒）。 */
export const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000
/** 每小时最多几条。 */
export const NOTIFY_PER_HOUR = 3
/** 每天最多几条。 */
export const NOTIFY_PER_DAY = 10

/** 订阅消息的模板字段上限（微信的 thing 类字段是 20 字符）。 */
const TEMPLATE_VALUE_MAX = 20

/** 落地页：单条待办进 chat（带 `id=`），多条进会话列表。 */
const CHAT_PAGE = 'pages/chat/chat'
const SESSIONS_PAGE = 'pages/sessions/sessions'

export interface NotifyOptions {
  appId: string
  secret: string
  /** 订阅消息模板 id。**空串 = 不启用**（此时中继不声明 `notify.v1`）。 */
  templateId: string
  /** 通知打开哪一版小程序（`miniprogram_state`）。 */
  envVersion: string
  /** 与小程序码签发**共用**的 token 缓存（见 wechat-token.ts 的文件头）。 */
  tokens: WechatTokenProvider
  /** 注入点：测试用假 fetch，生产用全局 fetch。 */
  fetch?: WechatTokenFetch
  now?: () => number
  log: Log
  /** 这个会话的成员（clientId 列表）。 */
  membersOf(conversationId: string): string[]
}

export type RegisterOutcome =
  { ok: true; quota: number } | { ok: false; reason: 'not_enabled' | 'code_rejected' | 'no_openid' | 'network' }

export type NotifyOutcome =
  { ok: true; sent: number; skipped: string[] } | { ok: false; reason: 'not_enabled' | 'no_member' | 'failed' }

export interface Notifier {
  /** 配齐了吗（appid+secret+模板）。没配时中继**不声明** `notify.v1`。 */
  readonly enabled: boolean
  /** client → 登记 openid（换一次 code）；`subscribed=true` 时额度 +1。 */
  register(clientId: string, code: string, subscribed: boolean): Promise<RegisterOutcome>
  /** 主机请求发通知：按会话成员找 openid，逐个发。 */
  notify(args: { hostId: string; conversationId: string; items: readonly NotifyItem[] }): Promise<NotifyOutcome>
  /** 某个 clientId 此刻的额度（诊断用；**不含 openid**）。 */
  quotaOf(clientId: string): number
}

/** 一个用户的额度与频控账。 */
interface UserState {
  openid: string
  /** 剩余订阅额度（微信的一次性订阅 = 一次授权一条）。 */
  quota: number
  /** 已发出的时刻（滑动窗口用）。 */
  sentAt: number[]
}

/**
 * 模板正文。**全是常量** —— 主机带不进来任何内容（见文件头的隐私边界）。
 *
 * `thing` 类字段微信限 20 字符 ⇒ 每一格都短于它。
 */
function templateData(items: readonly NotifyItem[]): Record<string, { value: string }> {
  const first = items[0]
  if (first === undefined) throw new Error('templateData 需要至少一条')
  const earliest = items.reduce((min, item) => (item.askedAt < min ? item.askedAt : min), first.askedAt)
  const when = formatChinaTime(earliest)
  if (items.length === 1) {
    const approval = first.kind === 'approval'
    return {
      thing9: { value: approval ? 'DSH 权限审批' : 'DSH 提问' },
      thing10: { value: approval ? '工具调用' : '提问' },
      thing3: { value: approval ? '有审批等待处理' : '有问题等待回答' },
      time67: { value: when },
    }
  }
  return {
    thing9: { value: `DSH 有 ${items.length} 项待处理` },
    thing10: { value: '审批/提问' },
    thing3: { value: '打开小程序查看' },
    time67: { value: when },
  }
}

/**
 * ISO 时刻 → `YYYY-MM-DD HH:mm:ss`（**东八区**）。
 *
 * 为什么固定东八区而不是服务器本地时区：通知是给中国用户看的，
 * 而部署机可能在 UTC —— 那种情况下用户会看到差 8 小时的时间。
 * 而"落地的时刻"来自**主机的 epoch**，与时区无关，转成东八区就是用户本地时间。
 */
export function formatChinaTime(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const shifted = new Date(ms + 8 * 3600 * 1000)
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  )
}

/**
 * 落地页路径。
 *
 * ⚠️ chat 页只认 `options.id`（不是 `sessionId`）—— 写成 `sessionId` 会打开一个
 * 什么会话都没有的空页（计划 §2.3 与 §10.7 都点了这一条）。
 */
export function notifyPage(items: readonly NotifyItem[]): string {
  if (items.length === 1) {
    const first = items[0]
    return first === undefined ? SESSIONS_PAGE : `${CHAT_PAGE}?id=${encodeURIComponent(first.sessionId)}`
  }
  return SESSIONS_PAGE
}

export function createNotifier(options: NotifyOptions): Notifier {
  const templateId = options.templateId.trim()
  const envVersion = options.envVersion.trim() || 'release'
  const doFetch: WechatTokenFetch = options.fetch ?? ((...args) => fetch(...args))
  const now = options.now ?? (() => Date.now())
  const log = options.log

  /** clientId → 账。**只存内存**：中继重启即丢（手机下次开页重新登记）。 */
  const users = new Map<string, UserState>()
  /** openid → clientId（发通知时反查）。 */
  const clientByOpenid = new Map<string, string>()
  /**
   * 已发过的卡：`hostId:requestId`。
   *
   * ⚠️ 主机侧也有一层"这张卡通知过了"的标记，但那是**主机进程内**的
   * （主机重启就没了）⇒ 中继这一层是跨主机重启的第二道闸。
   */
  const sent = new Set<string>()

  const enabled = options.appId.trim() !== '' && options.secret.trim() !== '' && templateId !== ''

  async function exchangeCode(code: string): Promise<string | undefined> {
    const url =
      `${SESSION_URL}?appid=${encodeURIComponent(options.appId.trim())}` +
      `&secret=${encodeURIComponent(options.secret.trim())}` +
      `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
    const body = (await (await doFetch(url)).json()) as { openid?: string; errcode?: number; errmsg?: string }
    // ⚠️ **不记 openid、不记 code、不记 errmsg 全文**（errmsg 可能带参数回显）。
    if (typeof body.openid !== 'string' || body.openid === '') return undefined
    return body.openid
  }

  async function sendOne(user: UserState, items: readonly NotifyItem[]): Promise<{ ok: boolean; errcode?: number }> {
    const page = notifyPage(items)
    const body = {
      touser: user.openid,
      template_id: templateId,
      page,
      data: templateData(items),
      miniprogram_state: envVersion,
      lang: 'zh_CN',
    }
    const attempt = async (accessToken: string): Promise<{ ok: boolean; errcode?: number }> => {
      const response = await doFetch(`${SEND_URL}?access_token=${encodeURIComponent(accessToken)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const parsed = (await response.json()) as { errcode?: number }
      if (typeof parsed.errcode === 'number' && parsed.errcode !== 0) return { ok: false, errcode: parsed.errcode }
      return { ok: true }
    }
    let accessToken = await options.tokens.get()
    let result = await attempt(accessToken)
    // 40001/42001 = token 失效。**只重试一次**（重取 token 会打死别处的旧 token）。
    if (!result.ok && (result.errcode === 40001 || result.errcode === 42001)) {
      accessToken = await options.tokens.refresh()
      result = await attempt(accessToken)
    }
    return result
  }

  /** 频控判定（**不消耗**任何东西）：冷却 / 每小时 / 每天。 */
  function rateLimited(user: UserState, at: number): boolean {
    const recent = user.sentAt.filter((t) => at - t < 24 * 3600 * 1000)
    if (recent.length >= NOTIFY_PER_DAY) return true
    const hour = recent.filter((t) => at - t < 3600 * 1000)
    if (hour.length >= NOTIFY_PER_HOUR) return true
    const last = recent[recent.length - 1]
    if (last !== undefined && at - last < NOTIFY_COOLDOWN_MS) return true
    return false
  }

  return {
    enabled,

    async register(clientId: string, code: string, subscribed: boolean): Promise<RegisterOutcome> {
      if (!enabled) return { ok: false, reason: 'not_enabled' }
      let openid: string | undefined
      try {
        openid = await exchangeCode(code)
      } catch {
        log.warn('notify register failed', { clientId, reason: 'network' })
        return { ok: false, reason: 'network' }
      }
      if (openid === undefined) {
        log.warn('notify register failed', { clientId, reason: 'code_rejected' })
        return { ok: false, reason: 'code_rejected' }
      }
      const existing = users.get(clientId)
      if (existing !== undefined && existing.openid === openid) {
        // 同一个 openid 重复登记：**不重复加分**（否则用户多开两次页面就能刷额度）。
        if (subscribed && existing.quota < NOTIFY_QUOTA_MAX) existing.quota += 1
        log.info('notify registered', { clientId, quota: existing.quota, added: subscribed ? 1 : 0 })
        return { ok: true, quota: existing.quota }
      }
      const quota = subscribed ? 1 : 0
      users.set(clientId, { openid, quota, sentAt: existing?.sentAt ?? [] })
      clientByOpenid.set(openid, clientId)
      log.info('notify registered', { clientId, quota, added: subscribed ? 1 : 0 })
      return { ok: true, quota }
    },

    quotaOf(clientId: string): number {
      return users.get(clientId)?.quota ?? 0
    },

    async notify(args: {
      hostId: string
      conversationId: string
      items: readonly NotifyItem[]
    }): Promise<NotifyOutcome> {
      if (!enabled) return { ok: false, reason: 'not_enabled' }
      const members = options.membersOf(args.conversationId)
      if (members.length === 0) return { ok: false, reason: 'no_member' }

      // ① 去重：**同一张卡只发一次**。跨主机重启也拦得住。
      const fresh = args.items.filter((item) => {
        const key = `${args.hostId}:${item.requestId}`
        if (sent.has(key)) return false
        sent.add(key)
        return true
      })
      if (fresh.length === 0) {
        log.info('notify skipped', { conversationId: args.conversationId, reason: 'already_sent' })
        return { ok: true, sent: 0, skipped: ['already_sent'] }
      }

      const at = now()
      const skipped: string[] = []
      let sentCount = 0
      for (const clientId of members) {
        const user = users.get(clientId)
        if (user === undefined) {
          skipped.push('no_openid')
          continue
        }
        if (user.quota <= 0) {
          skipped.push('no_quota')
          continue
        }
        if (rateLimited(user, at)) {
          skipped.push('rate_limited')
          continue
        }
        let result: { ok: boolean; errcode?: number }
        try {
          result = await sendOne(user, fresh)
        } catch (e) {
          // 网络错误：**最多重试一次**（在 sendOne 里已经处理了 token 失效那支；
          // 这里是真·网络异常 ⇒ 重试一次，再失败就放弃）。
          log.warn('notify send failed', { clientId, conversationId: args.conversationId, reason: 'network' })
          try {
            result = await sendOne(user, fresh)
          } catch {
            skipped.push('network')
            continue
          }
        }
        if (!result.ok) {
          // 43101 = 用户拒收/订阅已用尽 ⇒ **额度清零**（再发也是白发）。
          if (result.errcode === 43101) user.quota = 0
          log.warn('notify send rejected', {
            clientId,
            conversationId: args.conversationId,
            errcode: result.errcode ?? -1,
          })
          skipped.push('rejected')
          continue
        }
        user.quota -= 1
        user.sentAt.push(at)
        sentCount += 1
        log.info('notify sent', { clientId, conversationId: args.conversationId, count: fresh.length })
      }
      if (sentCount === 0) {
        return { ok: true, sent: 0, skipped }
      }
      return { ok: true, sent: sentCount, skipped }
    },
  }
}

/** 模板值的长度闸（thing 类字段 ≤ 20 字符）。给判据用。 */
export function templateValueTooLong(value: string): boolean {
  return value.length > TEMPLATE_VALUE_MAX
}
