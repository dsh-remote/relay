/**
 * 小程序码签发（2026-10-21）。
 *
 * 主机屏幕上那张码从哪来：**中继**。原因见 `docs/PAIRING-ONE-CODE.md` —— 个人主体
 * 拿不到「扫普通链接二维码」，只剩小程序码这一条路；而生成小程序码必须持有
 * appid+secret，那两样东西不能进插件包（进包=公开且不可吊销）。
 *
 * 三条纪律：
 * 1. **scene 只放 token**（≤32 字符）。psk 不进码 —— 它由主机在用户比对确认码后单独交接。
 * 2. **access_token 是全局单例**：同 appid+secret 再换一次会让旧 token 立刻失效（40001）。
 *    所以这里自己缓存，并且只在 40001/42001 时重取一次 —— 重取次数必须有界，
 *    否则一个坏掉的 secret 会把微信接口打成热循环。
 * 3. **按 token 缓存图片**：同一张配对码在它的 TTL 内被请求多次（页面轮询、重绘）是常态，
 *    每次都调微信既慢又吃配额（10 万/天）。
 */
import { createWechatTokenProvider, type WechatTokenProvider } from './wechat-token.js'

/**
 * 只用到 fetch 的一小部分。写成结构化类型而不是 `typeof fetch`：
 * 测试里注入的假 fetch 不需要实现 Request/Response 的全部重载。
 */
type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>

/** 微信接口地址（常量而不是配置：换域名不是运维旋钮）。 */
const CODE_URL = 'https://api.weixin.qq.com/wxa/getwxacodeunlimit'

/** 小程序里的落地页。**不带前导斜杠**，且必须是已发布版本里存在的页面。 */
const LANDING_PAGE = 'pages/sessions/sessions'

/**
 * 码要打开哪一版小程序。**默认正式版**（微信接口的默认值），排错/灰度时用 trial 或 develop。
 *
 * 为什么必须可配：`getwxacodeunlimit` 的 `env_version` 默认 `release` —— 也就是说
 * **码永远打开线上正式版**。3.2 的新配对流程（scene 只有 6 位码、密钥靠 SAS 后送回）
 * 如果只在体验版/开发版里，用户扫出来的却是老的正式版：界面能进去，配对必失败，
 * 而两边代码看起来都对。真机现场就是"能扫进去、就是配不上"。
 */
export type MpEnvVersion = 'release' | 'trial' | 'develop'

const ENV_VERSIONS: readonly MpEnvVersion[] = ['release', 'trial', 'develop']

/** 认不出来的值一律按正式版处理（不抛：这不该让整个中继起不来）。 */
export function normalizeEnvVersion(value: string | undefined): MpEnvVersion {
  const normalized = (value ?? '').trim().toLowerCase()
  return (ENV_VERSIONS as readonly string[]).includes(normalized) ? (normalized as MpEnvVersion) : 'release'
}

export interface MpCodeIssuerOptions {
  appId: string
  secret: string
  /** 码打开哪一版（`DRC_MP_ENV`）。缺省 = 正式版。 */
  envVersion?: string
  /** 注入点：测试用假 fetch，生产用全局 fetch。 */
  fetch?: FetchLike
  now?: () => number
  /**
   * **共用**的 access_token 缓存（2026-10-27）。
   *
   * 缺省时自己建一个（单包自用）；中继装配时会把**同一个**实例传给
   * 订阅消息发送器 —— 微信的 token 是单例，两处各自缓存会互相打死
   * （详见 `wechat-token.ts` 的文件头）。
   */
  tokens?: WechatTokenProvider
}

export interface MpCodeIssuer {
  /** 这张配对码对应的微信小程序码（JPEG 字节）。失败时抛错，调用方回 502。 */
  codeFor(pairingToken: string): Promise<Uint8Array>
  /** 是否配置了凭据。没配时路由直接 501，不尝试调用。 */
  readonly enabled: boolean
}

/**
 * 建一个签发器。**凭据缺失时 `enabled=false`**，`codeFor` 直接抛 —— 让上层用 501 回答，
 * 而不是拿空 appid 去调微信、把错误码转成一个看不懂的 502。
 */
export function createMpCodeIssuer(options: MpCodeIssuerOptions): MpCodeIssuer {
  const appId = options.appId.trim()
  const secret = options.secret.trim()
  const envVersion = normalizeEnvVersion(options.envVersion)
  const doFetch: FetchLike = options.fetch ?? ((...args) => fetch(...args))
  const now = options.now ?? (() => Date.now())

  /** token → 图片 + 过期时刻。键是配对码（一次性），量级等于同时在等的配对。 */
  const images = new Map<string, { bytes: Uint8Array; expiresAt: number }>()
  /** 图片缓存留一小时（配对码 TTL 是分钟级，没必要更久）。 */
  const IMAGE_TTL_MS = 3_600_000

  /**
   * access_token 缓存。**与订阅消息发送器共用同一个**（见 `MpCodeIssuerOptions.tokens`）。
   */
  const tokens: WechatTokenProvider =
    options.tokens ?? createWechatTokenProvider({ appId, secret, fetch: doFetch, now })

  async function requestCode(accessToken: string, pairingToken: string): Promise<Uint8Array | { errcode: number }> {
    const response = await doFetch(`${CODE_URL}?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scene: pairingToken,
        page: LANDING_PAGE,
        /**
         * `check_path: false`（默认 true）：true 时 `page` 必须是**已发布版本里存在**的页面。
         * 3.2 的首页路径没变，但排错期（`env_version=trial/develop`）里那份页面可能还没发布，
         * 开着它就会得到 41030 invalid page —— 而症状只是"码生成失败"，看不出是版本的事。
         */
        check_path: false,
        env_version: envVersion,
      }),
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    // 成功时是图片（JPEG，FF D8 开头）；失败时同样是 200，body 是 JSON。
    if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return bytes
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { errcode?: number }
      return { errcode: typeof parsed.errcode === 'number' ? parsed.errcode : -1 }
    } catch {
      return { errcode: -1 }
    }
  }

  return {
    enabled: appId !== '' && secret !== '',
    async codeFor(pairingToken: string): Promise<Uint8Array> {
      if (appId === '' || secret === '') throw new Error('未配置 DRC_MP_APPID / DRC_MP_SECRET')
      const hit = images.get(pairingToken)
      if (hit !== undefined && hit.expiresAt > now()) return hit.bytes

      let accessToken = await tokens.get()
      let result = await requestCode(accessToken, pairingToken)
      /** 40001/42001 = token 失效。**只重取一次**：再失败就是凭据问题，重试没有意义。 */
      if (!(result instanceof Uint8Array) && (result.errcode === 40001 || result.errcode === 42001)) {
        accessToken = await tokens.refresh()
        result = await requestCode(accessToken, pairingToken)
      }
      if (!(result instanceof Uint8Array)) {
        throw new Error(`小程序码生成失败：errcode=${result.errcode}`)
      }
      images.set(pairingToken, { bytes: result, expiresAt: now() + IMAGE_TTL_MS })
      // 顺手清掉过期项：表的大小等于"最近一小时内出现过的配对码"，不会无限长。
      if (images.size > 512) {
        for (const [key, value] of images) if (value.expiresAt <= now()) images.delete(key)
      }
      return result
    },
  }
}
