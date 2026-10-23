/**
 * http-routes —— 中继的 HTTP 面（v5 R3 从 `server.ts` 抽出）。
 *
 * `/healthz`（健康与运维读数）、`/code`（小程序码 + 死码拒渲染 + 配额）、
 * `/api/*`（claim-token / info / pair-status）全在这一个 handler 里。
 * 无认证面的纪律见各分支内的注释（哪些能说、哪些必须配额、哪些刻意不说）。
 *
 * ⚠️ **行为零变化**（R3 纪律）：判据一片未动照样全绿。
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PROTOCOL_VERSION } from '@dsh-remote/protocol/negotiate'
import type { RelayConfig } from './config.js'
import type { RelayState } from './state.js'
import type { Budget } from './limits.js'
import type { Log } from './log.js'
import type { MpCodeIssuer } from './mpcode.js'

/** 认领限频表的容量上限：满了就丢最旧的一批（`Map` 保持插入顺序）。 */
const CLAIM_TRACK_MAX = 10_000

/**
 * 认领时 `hostId` 的形状与上限。
 *
 * 为什么要在门口卡：`hostId` 会变成令牌表的**键**，也会被写进状态文件；
 * 字符集限制成 URL 安全的那几个是为了排障时能直接贴进日志与 `curl`。
 * 与 `persist.ts` 的 `MAX_HOST_ID_LEN` **必须一致**——两处口径不同会让
 * "落盘后被静默丢掉"变成一台主机永久连不上。
 */
const MAX_HOST_ID_LEN = 200
const HOST_ID_RE = /^[A-Za-z0-9._:-]+$/

export interface HttpRoutesDeps {
  config: RelayConfig
  state: RelayState
  log: Log
  markStateChanged(): void
  mpCodes: MpCodeIssuer
  pairStatusBudget: Budget
  persistence: { enabled: boolean; restored: number; savedAt: number; writes: number; failures: number }
  getShuttingDown(): boolean
  startedAt: number
  getLastPingAt(): number
  getCounters(): Record<string, number>
}

export function createHttpRoutes(deps: HttpRoutesDeps): {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  health: () => Record<string, string | number | boolean | Record<string, number>>
} {
  /** 认领限频表：IP → 上次认领时刻。有界（见下方裁剪），不是无限增长的字典。 */
  const lastClaimAt = new Map<string, number>()

  function newHostToken(): string {
    return randomBytes(24).toString('hex')
  }

  /**
   * 认领限频表的裁剪（满了丢最老的 1 条）。
   *
   * ⚠️ 它挡不住"换源 IP 的分布式刷" —— 那要在运维侧解决（这台中继给谁用）。
   */
  function rememberClaim(ip: string, now: number): void {
    lastClaimAt.set(ip, now)
    if (lastClaimAt.size <= CLAIM_TRACK_MAX) return
    // `Map` 按插入顺序迭代 ⇒ 丢最老的一批就是先到的那些
    const drop = lastClaimAt.size - CLAIM_TRACK_MAX
    let i = 0
    for (const key of lastClaimAt.keys()) {
      lastClaimAt.delete(key)
      if (++i >= drop) break
    }
  }

  // ── HTTP ────────────────────────────────────────────────────────────

  function health(): Record<string, string | number | boolean | Record<string, number>> {
    return {
      ok: !deps.getShuttingDown(),
      version: deps.config.version,
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      // 瞬时快照（会上下浮动）与累计计数（只增不减）分开：混在一起会让
      // "手机不更新"这类排查分不清"现在是空的"和"一直送不出去"。
      ...deps.state.counts(),
      ...deps.getCounters(),
      // P1-3 的**可补面**（2026-10-22）：`droppedFrames` 里没有收件人的那部分，run 输出帧
      // 现在多数进了环并在重连时补投。这两个读数回答"此刻环里还剩多少、挂在几条会话上"
      // （瞬时值，会随补投/淘汰浮动）；历史累计仍看 `droppedFrames`。
      replayRingConversations: deps.state.replay.size(),
      replayRingFrames: deps.state.replay.frameCount(),
      // 落盘的可观测面。**刻意不暴露文件路径**：`/healthz` 是公网可达的，
      // 而一个绝对路径对排障没用、对探测者有用（告诉它这台机器上有什么、装在哪）。
      // 运维要知道路径看环境变量就够了。
      persistence: deps.persistence.enabled ? 'on' : 'off',
      stateRestored: deps.persistence.restored,
      stateSavedAtSec: deps.persistence.savedAt === 0 ? -1 : Math.round((Date.now() - deps.persistence.savedAt) / 1000),
      stateWrites: deps.persistence.writes,
      stateWriteFailures: deps.persistence.failures,
      lastPingAgo: deps.getLastPingAt() === 0 ? -1 : Math.round((Date.now() - deps.getLastPingAt()) / 1000),
      shuttingDown: deps.getShuttingDown(),
      // 本端说的协议版本（单版本制：它是一个常量，但排障时要能一眼看到"这一个中继
      // 说的是哪一版"——版本对不上的现场表现是"连上了、什么都不发生"，没有任何一层会报错）。
      protocolSelf: PROTOCOL_VERSION,
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
  /** 体超限的哨兵：调用方据此回 413（`instanceof` 判不出跨模块的同类错误，用 `code`）。 */
  const BODY_TOO_LARGE = 'body_too_large'

  /**
   * 读一个**有上限**的请求体。
   *
   * 上限不是可选项：这是**无认证**接口，不限的话一个陌生人一次 POST 就能把内存喂满。
   * 超限 ⇒ 抛 `{code: BODY_TOO_LARGE}` 交给调用方回 413，并且**立刻 `pause()`**
   * （不再读、也不再往数组里堆）。
   *
   * ⚠️ 这里**刻意不 `destroy()`**（2026-10-11 修）：原来那一版在 `data` 回调里
   * 先 `reject` 再同步 `destroy()`，于是调用方拿到拒绝去写 413/500 时 socket 已经没了
   * ——实测客户端看到的是 `fetch failed / UND_ERR_SOCKET`（连接被重置），
   * **一个状态码都收不到**，而注释里写着"超限立刻回 413"。少读一个体不是错，
   * 让对方看不见为什么被拒才是错。半读的连接交给 `Connection: close` 收场。
   * 空体是合法的（3.1.2 的插件就不带体），返回 `''`。
   */
  function readBody(req: IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) {
          req.pause()
          reject(Object.assign(new Error(BODY_TOO_LARGE), { code: BODY_TOO_LARGE }))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  /** 认领请求体的上限：`{hostId, token}` 两三个字段，1024 字节绰绰有余。 */
  const CLAIM_BODY_MAX_BYTES = 1024

  /**
   * `POST /api/claim-token` —— 领一枚 host token。
   *
   * ## **必须**带 `hostId`（2026-10-11 晚，用户裁决不做老客户端兼容）
   *
   * 带 `{hostId}`：给这一台机器签一枚，**只顶掉它自己旧的那一枚**
   * （`deps.state.issueHostToken`）。这就是"后面的顶掉前面的"——别的主机那枚不受影响。
   *
   * 不带 hostId（或体不是 JSON）⇒ **400 `host_id_required`**。中间那版把它签进
   * "未绑定槽位"，而那枚令牌**对任意 hostId 都算数** ⇒ 任何人领一枚就能冒充任何主机
   * 把真主机顶掉。这条接口是**无认证**的，那把万能钥匙必须拿掉；
   * 老插件从此领不到令牌，这是裁决里接受的代价。
   *
   * ## 闸门（旧版四道，一道都没减；3.1.3 又加了一道）
   *
   * ① 只收 POST；② 停机中不受理；③ 同 IP 限频 4 秒（`DRC_CLAIM_MIN_INTERVAL_MS`）；
   * ④ 限频表有界（`CLAIM_TRACK_MAX`）；⑤ **令牌表有界**（`DRC_MAX_HOST_TOKENS`，3.1.3 加）。
   * ⚠️ 这段注释曾写成"三道闸"：把 ④ 数漏了，而它正是"限频表不能变成无界字典"那一条。
   * 数的口径以这一行枚举为准，别在别处再写一个数字（`deploy/README.md` 与 `README.md`
   * 的表格各写了一种数法，那两处是历史口径）。
   * 「认领即作废上一枚」那道**不再存在**：它被"按 hostId 一机一枚"取代了（见上）。
   * **任何人都能领一枚**这条没变：
   * 这台中继会替陌生人中继流量（读不到内容，载荷密封），总量控制在运维侧。
   * 但**"随便 POST 一次就把合法主机永久踢下线"这条没有了**：认领动不了 env 那枚，
   * 也动不了别人的 hostId 那枚；而被顶掉的那台**会自愈**（3.1.4 起，插件侧收到
   * `bad_token` 就带自己的 hostId 重新认领 —— 见 `packages/plugin/src/index.ts`）。
   */
  async function handleClaimToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end(JSON.stringify({ error: 'use POST' }))
      return
    }
    if (deps.getShuttingDown()) {
      res.statusCode = 503
      res.end(JSON.stringify({ error: 'shutting_down' }))
      return
    }
    const now = Date.now()
    // 限频：同一 IP 两次认领至少隔 CLAIM_MIN_INTERVAL_MS。
    // ⚠️ 这挡不住分布式刷（换源 IP），它只挡"脚本连打"这一种。
    // 真正的总量控制在运维侧（谁在用这台中继、要不要开认领）。
    // ⚠️ 打点在**读体之前**：读体是异步的，两个并发请求会一起穿过那道判断。
    const ip = req.socket.remoteAddress ?? 'unknown'
    const last = lastClaimAt.get(ip) ?? 0
    // 4000（默认）= 每人每分钟最多 15 枚。它挡的是"脚本连打"与误触重复点击；
    // ⚠️ **挡不住换源 IP 的分布式刷** —— 那要在运维侧解决（这台中继给谁用）。
    // 值来自配置：`DRC_CLAIM_MIN_INTERVAL_MS=0` 表示关掉（测试与内网自用）。
    if (now - last < deps.config.claimMinIntervalMs) {
      res.statusCode = 429
      res.end(JSON.stringify({ error: 'too_soon', retryAfterMs: deps.config.claimMinIntervalMs - (now - last) }))
      return
    }
    rememberClaim(ip, now)

    let body: Record<string, unknown> = {}
    let raw: string
    try {
      raw = await readBody(req, CLAIM_BODY_MAX_BYTES)
    } catch (error) {
      /**
       * 体超限 ⇒ **413 + 关连接**。
       *
       * 为什么不能让它冒到外面那层 catch（那里回 500）：这不是"服务端出错"，
       * 而是"你发的东西太大"，两者在排错时是相反的结论。而 `Connection: close`
       * 是因为体还没读完（`readBody` 只 `pause()` 了），复用这条连接会有半个体
       * 留在缓冲区里污染下一次请求。
       */
      if ((error as { code?: unknown } | null)?.code === BODY_TOO_LARGE) {
        res.statusCode = 413
        res.setHeader('connection', 'close')
        res.end(JSON.stringify({ error: 'body_too_large', limitBytes: CLAIM_BODY_MAX_BYTES }))
        return
      }
      throw error
    }
    if (raw.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>
        }
      } catch {
        // 体不是 JSON ⇒ 下面按"没带 hostId"报 400。**不再有宽松的兼容路径**：
        // 那条路会把令牌签进"未绑定槽位"，而它是一把能冒充任何主机的万能钥匙。
      }
    }
    const rawHostId = typeof body.hostId === 'string' ? body.hostId.trim() : ''
    if (rawHostId === '') {
      /**
       * **认领必须带 hostId**（2026-10-11 晚，用户裁决不做老客户端兼容）。
       *
       * 不带 hostId 的认领原来落到"未绑定槽位"，而那枚令牌**对任意 hostId 都算数**
       * —— 等于任何人领一枚就能冒充任何主机（把真主机顶掉）。这条接口是**无认证**的，
       * 所以那把万能钥匙必须拿掉。老版本的插件（不带体）从此领不到令牌，
       * 那正是裁决里接受的代价。
       */
      res.statusCode = 400
      res.end(
        JSON.stringify({
          error: 'host_id_required',
          hint: 'POST {"hostId":"<本机身份>"} —— 2026-10-11 起令牌按 hostId 一机一枚，没有身份就不签',
        }),
      )
      return
    }
    if (rawHostId.length > MAX_HOST_ID_LEN || !HOST_ID_RE.test(rawHostId)) {
      res.statusCode = 400
      res.end(
        JSON.stringify({ error: 'bad_host_id', hint: `hostId 最多 ${MAX_HOST_ID_LEN} 字符，只允许字母数字与 ._:-` }),
      )
      return
    }

    const token = newHostToken()
    deps.state.issueHostToken(rawHostId, token, now)
    // 令牌表有界：超出就按"最近用过"从旧到新丢（先丢没人用的占位条目）。
    const pruned = deps.state.pruneHostTokens(deps.config.maxHostTokens)
    if (pruned > 0) deps.log.warn('host tokens pruned', { dropped: pruned, kept: deps.state.hostTokens.size })
    // 结构性变更 ⇒ 立刻落盘（与建/删会话同一条纪律）：不落盘的话中继一重启，
    // 这些令牌就全没了，而主机侧一旦有令牌就不再认领（要靠 3.1.4 起的那条自愈才回得来）。
    deps.markStateChanged()
    deps.log.info('host token claimed', { ip, hostId: rawHostId, hostTokens: deps.state.hostTokens.size })
    res.end(JSON.stringify({ token, hostId: rawHostId, rotatedAt: new Date(now).toISOString() }))
  }

  /**
   * HTTP 面。**async**：`/code` 要等微信接口（2026-10-21 加）。
   * 同步分支不受影响；异步分支自己 try/catch，不留悬空 rejection。
   */
  async function httpHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://relay.invalid')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (url.pathname === '/healthz') {
        // 停机中回 **503**（2026-10-07 改）。理由：`ok:false` 这个字段在改造前是
        // `/healthz` 唯一的停机信号，于是任何只看状态码的观测面（Docker HEALTHCHECK、
        // 负载均衡器、k8s probe、`curl --fail`）都会在**正在关闭**的进程上读到 200，
        // 继续往一个不再接受 upgrade 的实例上送流量。状态码本来就是这件事的表达方式，
        // 字段留给人去读。
        if (deps.getShuttingDown()) res.statusCode = 503
        res.end(JSON.stringify(health()))
        return
      }
      /**
       * **认领一枚 host token**。
       *
       * ## 它为什么存在（2026-10-11 起）
       *
       * 目标形态是「装完就能用」：用户 `npm i` 之后**什么都不用配**。
       * 而 token 是主机与中继之间的共享密钥 —— 之前只能由用户把它写进
       * `cordis.patch.yml`，于是"装完不能用"变成了默认结局。
       *
       * ## 为什么它**不能**是"谁来问都给 token"
       *
       * 中继是公网服务。一个无认证的取值接口 = **token 公开**，
       * 那比明文写在 `0600` 文件里**更差**（后者只在你机器上，前者全网可取）。
       * 拿到 token 的人能冒充主机接入，还能发一个与你"在途相同"的配对 token
       * 把条目改写成自己的 —— 用户扫的是 A 的码、配到的是 B，而两边都不报错
       * （见 `src/deps.state.ts` 里关于共享 token 的那段注释）。
       *
       * ⇒ 所以这里是**认领**而不是**索取**：领到的是**一枚新签的** token。
       * 攻击者能领到自己的那枚（那本来就是给他用的），**拿不到你的**。
       *
       * ## ⚠️ 2026-10-11 改了什么（这一段是被一次真实事故逼出来的）
       *
       * 旧模型是「**全局单令牌 + 认领即轮换**」：任何一台机器认领，
       * 都会把**所有**主机的令牌当场作废。而主机侧"盘上有 token 就不再认领"
       * ⇒ 被顶掉的那台**不会自愈**、永久连不上。
       * 那一天本机被另外三台机器各顶掉一次（nginx 访问日志里三个公网 IP，
       * UA 都是 `node`），而这条接口是**无认证**的 ⇒ 那个模型下
       * "任何能 POST 它的人都能把合法主机永久踢下线"。
       *
       * 现在：认领**必须**带 `{hostId}`（不带 ⇒ 400 `host_id_required`），
       * 它只顶掉**这台机器自己**旧的那一枚；env 那枚**永不参与轮换**；
       * 而被顶掉的那台**会自愈**（3.1.4 起，插件侧见到 `bad_token` 就带自己的
       * hostId 重新认领并重连）。细节见 `handleClaimToken` 与 `deps.state.ts` 的 `HostTokenEntry`。
       *
       * ## 滥用面（这条接口的真实成本，必须写明）
       *
       * 任何人都能领一枚 ⇒ 这台中继会**替陌生人中继流量**。他们读不到别人的内容
       * （载荷密封、中继零知识），但能消耗带宽与配对表容量。
       * ⇒ 闸门是给它加的，不是装饰：限频、停机中不受理、限频表有界、令牌表有界
       *   （逐条枚举见 `handleClaimToken` 那段，这里不再写数字以免两处漂移）。
       */
      if (url.pathname === '/api/claim-token') {
        // 这条要读请求体（`{hostId}`），所以是异步的；异常一律在这里收干净，
        // 绝不让它冒到进程（与 httpHandler 同一条纪律，P0-1）。
        void handleClaimToken(req, res).catch((e: unknown) => {
          deps.log.warn('claim handler failed', { error: String(e) })
          if (!res.headersSent) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: 'internal' }))
          }
        })
        return
      }
      if (url.pathname === '/code') {
        /**
         * `GET /code?token=999999` —— 把这张配对码变成一张微信小程序码（JPEG）。
         *
         * 无认证是**有意**的：手机扫的码必须能被微信打开，而主机拿到 token 就能取图；
         * token 本身已经是一次性凭据（6 位、分钟级 TTL、认领即焚）。真正的越权面是
         * "拿别人的 token 取图" —— 那和"拿到别人的 token"等价，没有额外损失。
         */
        if (!deps.mpCodes.enabled) {
          res.statusCode = 501
          res.end(JSON.stringify({ error: 'mp_not_configured' }))
          return
        }
        const token = url.searchParams.get('token') ?? ''
        if (!/^\d{6}$/.test(token)) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'bad_token' }))
          return
        }
        /**
         * **限流必须在判定之前**（2026-10-23 评审补）：404/410/200 的三态让 `/code`
         * 成了 6 位码空间的**判定 oracle**（哪几个数字是活码一眼可辨）——那正是
         * `/api/pair-status` 默认关闭、且必须带配额的理由。这里与它**共用同一只 Budget**
         * （同一类"无认证的 6 位码探测"，一个旋钮管完），耗尽回 429 并记 warn
         * （探测/压测会在日志里留痕）。不设限流的话，枚举机可以全速刷 HTTP 找活码。
         * 正常用量（主机每次出码取一张图）远低于 5/s。
         */
        if (!deps.pairStatusBudget.take(Date.now())) {
          deps.log.warn('pair-status budget exhausted', { reason: 'rate_limited', via: '/code' })
          res.statusCode = 429
          res.end(JSON.stringify({ error: 'rate_limited' }))
          return
        }
        /**
         * **死码不画**（2026-10-23 用户裁决：「`/code` 拒渲染死码，改」）。
         *
         * 原来对任何 6 位数字都画图 —— 已被认领的、已过期的、甚至**压根没签发过的**
         * （键盘敲一个也画）。结果是屏幕上有一张"看起来正常"的小程序码，扫了必失败
         * （`already_used` / `invalid_or_expired`），用户以为是小程序的问题。
         * 判据与 `claim()` 同一套（`pairCodeState` 的四态），**不许多一种、不许少一种**。
         *
         * 形状：`used` / `expired` → **410 Gone**（曾经有效、现在不作数）；
         * `unknown` → **404**（从来不在）；活码照旧 200 image/jpeg。
         * 插件那侧 `codeFor` 取不到回 `null` → 503 `mp_code_unavailable`，
         * pill 把那一格空着并说明原因（`shell/mp-code.ts`）——比画一张死码诚实。
         */
        const codeState = deps.state.pairCodeState(token)
        if (codeState !== 'claimable') {
          res.statusCode = codeState === 'unknown' ? 404 : 410
          res.end(
            JSON.stringify({
              error: codeState === 'used' ? 'code_used' : codeState === 'expired' ? 'code_expired' : 'code_unknown',
            }),
          )
          return
        }
        try {
          const bytes = await deps.mpCodes.codeFor(token)
          res.statusCode = 200
          res.setHeader('content-type', 'image/jpeg')
          // 同一条码在 TTL 内不该被缓存：重新发码后旧图必须立刻失效。
          res.setHeader('cache-control', 'no-store')
          res.end(Buffer.from(bytes))
        } catch (error) {
          deps.log.warn('mp code generation failed', {
            error: String((error as Error)?.message ?? error).slice(0, 160),
          })
          res.statusCode = 502
          res.end(JSON.stringify({ error: 'mp_code_failed' }))
        }
        return
      }
      if (url.pathname === '/api/info') {
        // `PROTOCOL_VERSION` 而不是字面量 `1`：这条是无认证接口，
        // 写死的版本号会在协议升版时静默变成一句谎话（小程序拿它判"能不能连"）。
        res.end(JSON.stringify({ publicUrl: deps.config.publicUrl, protocol: PROTOCOL_VERSION }))
        return
      }
      if (url.pathname === '/api/pair-status') {
        // 默认 404：开等于给 6 位码空间装了个免认证的判定 oracle。
        if (!deps.config.pairStatusEnabled) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'not_found' }))
          return
        }
        // 开了之后也必须限流（P2）：这是一条**无认证**的 "这个码在不在" 判定接口，
        // 10^6 的码空间不设配额就是一台免费的枚举机。配额用与配对同一只 Budget，
        // 用尽回 429 并记 warn——warn 是刻意的，压测/探测会在这里留下痕迹。
        if (!deps.pairStatusBudget.take(Date.now())) {
          deps.log.warn('pair-status budget exhausted', { reason: 'rate_limited' })
          res.statusCode = 429
          res.end(JSON.stringify({ error: 'rate_limited' }))
          return
        }
        const token = url.searchParams.get('token') ?? ''
        const entry = deps.state.pendingPairs.get(token)
        res.end(JSON.stringify({ ok: !!entry && !entry.used && entry.expiresAt >= Date.now() }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not_found' }))
    } catch (e) {
      deps.log.warn('http request failed', { message: String((e as Error)?.message ?? e) })
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

  /**
   * 小程序码签发器（2026-10-21）。凭据缺失时 `enabled=false`，`GET /code` 回 501。
   *
   * ⚠️ 3.2 起这里**没有回落**：以前插件会退回本机渲染的 `dshr:` 码（码里带 PSK），
   * 那是"能配但把密钥摊在屏幕上"的第二条路，用户两次投诉的都是它。自部署想用手机，
   * 就得自己去小程序后台申请 appid/secret 并配到这台中继上——这是刻意的前置条件。
   */
  return { handler: httpHandler, health }
}
