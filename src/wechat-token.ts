/**
 * 微信 access_token 的**唯一**缓存（2026-10-27）。
 *
 * ## 为什么必须是"唯一"
 *
 * 微信的 `cgi-bin/token` 是**单例**：同一个 appid+secret 再取一次，**上一个 token
 * 立刻失效**（40001）。而这台中继上会用到 token 的地方有两处：
 *
 *   · 小程序码签发（`mpcode.ts`）
 *   · 订阅消息发送（`notify.ts`）
 *
 * ⇒ 两处各自缓存 ⇒ 一处刷新就把另一处**正在用**的 token 打死 ⇒ 那条请求以 40001
 *   失败，而它的调用方**不会**再取一次（它以为手里的 token 是好的）。
 *
 * ⇒ 所以 token 缓存必须是**一个对象**、两处共用（装配见 `server.ts`）。
 *
 * ## 重取次数必须有界
 *
 * 只在 40001/42001 时重取**一次**。一个坏掉的 secret 若允许无限重试，
 * 会把微信接口打成热循环 —— 而且**每次重取都会打死别的调用方正在用的 token**。
 */

/**
 * 只用到 fetch 的一小部分。写成结构化类型而不是 `typeof fetch`：
 * 测试里注入的假 fetch 不需要实现 Request/Response 的全部重载。
 */
export type WechatTokenFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ json(): Promise<unknown> }>

/** 微信接口地址（常量而不是配置：换域名不是运维旋钮）。 */
const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token'

/** token 提前 60 秒过期，避免"取到就过期"的边界。 */
const TOKEN_SKEW_MS = 60_000
/** 微信默认 expires_in=7200s；拿不到就按 7000s 保守处理。 */
const DEFAULT_TOKEN_TTL_MS = 7_000_000

export interface WechatTokenProvider {
  /** 拿一个可用的 token（缓存没过期就直接返回，否则取一次）。 */
  get(): Promise<string>
  /** 强制重取一次（40001/42001 时用；**只许用一次**）。 */
  refresh(): Promise<string>
  /** 一共取过几次（诊断用）。 */
  readonly fetches: number
}

interface CachedToken {
  value: string
  expiresAt: number
}

export function createWechatTokenProvider(options: {
  appId: string
  secret: string
  fetch?: WechatTokenFetch
  now?: () => number
}): WechatTokenProvider {
  const appId = options.appId.trim()
  const secret = options.secret.trim()
  const doFetch: WechatTokenFetch = options.fetch ?? ((...args) => fetch(...args))
  const now = options.now ?? (() => Date.now())

  let cached: CachedToken | undefined
  let fetches = 0

  async function fetchToken(): Promise<string> {
    const url = `${TOKEN_URL}?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`
    fetches += 1
    const response = await doFetch(url)
    const body = (await response.json()) as {
      access_token?: string
      expires_in?: number
      errcode?: number
      errmsg?: string
    }
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new Error(`微信 access_token 获取失败：${body.errcode ?? '?'} ${body.errmsg ?? ''}`.trim())
    }
    const ttl =
      typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS
    cached = { value: body.access_token, expiresAt: now() + Math.max(0, ttl - TOKEN_SKEW_MS) }
    return body.access_token
  }

  return {
    get fetches(): number {
      return fetches
    },
    async get(): Promise<string> {
      if (cached !== undefined && cached.expiresAt > now()) return cached.value
      return fetchToken()
    },
    async refresh(): Promise<string> {
      // 强制重取：先丢掉缓存（万一这次失败，旧的也已经不可用了）。
      cached = undefined
      return fetchToken()
    },
  }
}
