/**
 * lifecycle — 优雅停机的**可显式调用**出口（A3）。
 *
 * ## 为什么要有它（v2 的洞）
 *
 * v2 的 `shutdown` 是一个闭包，**只在 `main()` 内部注册给 `SIGTERM` / `SIGINT`**。
 * 于是在 **Windows 上服务停止 = 硬杀**：Node 收不到信号投递，
 * 排空（`relay.close()`）与兜底落盘（`forceShutdown()`）**一次都不跑**——
 * 状态文件停在"上一次周期补写"那一刻，正在进行的会话全丢，
 * 而 `/healthz` 里的 `shutdownForced` 永远是 0，运维事后**分辨不出**这是被杀的。
 *
 * 判据（`tests/lifecycle.test.ts`）：调这个出口 ⇒ 状态已落盘 + exit 0。
 *
 * ## 三条纪律
 *
 * 1. **信号只是触发源之一**，不是唯一入口。Windows 服务管理、容器编排的
 *    preStop 钩子、以及运维手工排障都走同一个出口——**只有一条停机路径**，
 *    才谈得上"它一定落盘了"。
 * 2. **只暴露"请求停机"，不暴露"怎么停"**。返回的 promise 由调用方 await 或忽略；
 *    真正的 `process.exit` 仍由本模块决定（调用方不该有机会跳过它）。
 * 3. **幂等**：第二次调用返回第一次的 promise。并发两个停机请求
 *    （信号 + 服务管理同时到）不许跑两遍 close——那会让 drain 计数错乱。
 *
 * ## 为什么不在 `main.ts` 里就地导出
 *
 * 因为 `main()` 一跑就 `await relay.startListening()`，测试没法拿一个不监听端口的
 * 实例来验"停机出口真的会落盘"。独立成文件后，判据可以喂一个假 relay 直接调。
 */
import type { Log } from './log.js'

/** 停机出口需要的最小面（真实 relay 与测试替身共用）。 */
export interface Shutdownable {
  log: Log
  /** 排空：停止接受新连接 → 向对端发 1001 → 等在途结束。 */
  close(): Promise<void>
  /** 兜底：排空超时后仍要把内存表写一次盘。 */
  forceShutdown(): void
}

export interface ShutdownOptions {
  /** 触发源的名字，进日志（`signal:SIGTERM` / `service:stop` / `test`）。 */
  reason: string
  /** 排空兜底超时（毫秒）。默认 5000 —— 与 v2 逐字一致。 */
  timeoutMs?: number
}

/**
 * 造一个停机出口。返回的函数**幂等**，并且总是返回同一个 promise。
 *
 * @param options.exit 真正退出进程的实现。默认 `process.exit`；
 *   **判据注入一个记录器**，否则「排空超时」那条会真的把测试进程带走
 *   （node --test 会在第一条就退出，后面全部不跑——那种绿是假的）。
 */
export function createShutdown(
  relay: Shutdownable,
  options: { exit?: (code: number) => void } = {},
): {
  shutdown: (reason: string, timeoutMs?: number) => Promise<void>
  /** 兜底超时是否触发过（true = 排空没按时完成、被强退）。运维读 `/healthz`。 */
  forced: () => boolean
} {
  let closing = false
  let wasForced = false
  let inflight: Promise<void> | null = null
  const exit = options.exit ?? ((code: number) => process.exit(code))

  const run = (reason: string, timeoutMs: number): Promise<void> => {
    relay.log.info('shutting down', { signal: reason })
    const guard = setTimeout(() => {
      relay.log.warn('shutdown timed out, forcing exit')
      // 兜底路径也要补写一次盘：排空超时说明还有在途连接，但内存表仍是此刻最新的真相，
      // 不写就等于把这次停机期间的变更丢掉。`shutdownForced` 同步进 /healthz——
      // 这条 exit(0) 与"排空成功"同一个码，只有计数能让运维事后分辨。
      wasForced = true
      relay.forceShutdown()
      exit(0)
    }, timeoutMs)
    guard.unref()
    return relay.close().then(
      () => {
        clearTimeout(guard)
        exit(0)
      },
      (error: unknown) => {
        // close() 自己失败：仍然要把盘补上再退（与兜底同一逻辑，只是原因不同）
        clearTimeout(guard)
        wasForced = true
        relay.log.warn('shutdown close failed, forcing exit', {
          message: String((error as Error)?.message ?? error).slice(0, 120),
        })
        relay.forceShutdown()
        exit(0)
      },
    )
  }

  return {
    shutdown(reason: string, timeoutMs = 5000): Promise<void> {
      if (closing && inflight) return inflight
      closing = true
      inflight = run(reason, timeoutMs)
      return inflight
    },
    forced: () => wasForced,
  }
}

/**
 * 把停机出口接到信号上，并返回一个**取消注册**的函数。
 *
 * 独立出来是因为两处要复用：`main.ts` 注册它，判据注册它再取消——
 * 否则测试里注册的处理器会留在进程上，影响后面别的用例（node --test 同进程跑全套）。
 */
export function registerSignalHandlers(shutdown: (reason: string) => Promise<void>): () => void {
  const onTerm = () => void shutdown('signal:SIGTERM')
  const onInt = () => void shutdown('signal:SIGINT')
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  return () => {
    process.off('SIGTERM', onTerm)
    process.off('SIGINT', onInt)
  }
}
