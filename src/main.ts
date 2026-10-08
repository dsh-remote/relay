/**
 * main — 中继进程入口。
 *
 * 启动纪律（旧实现用线上运行换来的，逐条保留）：
 * - 没有 `DRC_HOST_TOKEN` 就**拒绝启动**（CI 里专门有一条断言这条）；短于 24 字符只告警。
 * - 只绑 `127.0.0.1`：TLS 由反代终止，中继没理由出现在局域网里。
 * - `SIGTERM`/`SIGINT` → 停止接受新连接 → 向所有对端发 `1001` → 等在途结束 → **exit 0**；
 *   5 秒兜底强退。测试断言 exit 码与对端收到的关闭码。
 * - `uncaughtException` 记账后 exit 1，把重启交给 systemd（`Restart=always`）——
 *   无值守进程里"活着但坏了"比"死了被拉起来"更糟。
 */
import { readFileSync } from 'node:fs'
import { loadConfig, type ConfigProblem } from './config.js'
import { createRelay } from './server.js'

/** 打包时由 `scripts/bundle-relay.mjs` 以 esbuild define 注入；未打包时这个标识符不存在。 */
declare const __DRC_VERSION__: string | undefined

function readVersion(): string {
  // 顺序很重要：**先读编译期注入的值**。生产部署就是 scp 一个 `main.js`，
  // 文件旁边没有 package.json，两条相对路径探针都会落空，`/healthz` 的 version
  // 会变成 `0.0.0`——而运维正是靠这个字段判断线上跑的是哪一版。
  if (typeof __DRC_VERSION__ === 'string' && __DRC_VERSION__) return __DRC_VERSION__
  // 开发态（tsc 产物在 dist/src/）往上两层才是包目录，还能按文件读。
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }
    if (typeof pkg.version === 'string') return pkg.version
  } catch {
    /* 读不到就落回 0.0.0 */
  }
  return '0.0.0'
}

function reportProblems(problems: ConfigProblem[]): boolean {
  let fatal = false
  for (const problem of problems) {
    if (problem.level === 'error') fatal = true
    process.stderr.write(`[drc-relay] ${problem.level}: ${problem.message}\n`)
  }
  return fatal
}

/**
 * 命令行参数。**刻意只有一个退出码表**：0 = 正常（含优雅停机）、1 = 运行期致命、
 * 2 = 命令行用法错。
 *
 * 为什么需要它（2026-10-07 补）：容器化之后，「哪一版在跑」这个问题第一次变得非启动
 * 不可得——镜像里没有 package.json、没有 git、没有别的东西可问。于是
 * `docker run … dsh-remote-relay --version` 是最省事也最不会出错的口子：它不监听端口、
 * 不写状态文件、不需要 token。
 *
 * 旧行为是**静默忽略**任意参数（`node relay.mjs --whatever` 照常起服务），而容器编排里
 * 传错 flag 的后果是「容器起来了但行为不是我要的」——最坏的一类。现在：不认识的参数回
 * 一条用法行并 exit 2。
 */
function parseArgs(argv: readonly string[]): { help: boolean; version: boolean } | { error: string } {
  const out = { help: false, version: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--version' || arg === '-v') out.version = true
    else return { error: `不认识的参数 ${JSON.stringify(arg)}` }
  }
  return out
}

const USAGE = [
  '用法：relay.mjs [--version|-v] [--help|-h]',
  '',
  '  无参数       启动中继（读 DRC_* 环境变量；缺 DRC_HOST_TOKEN 拒绝启动）',
  '  --version    打印版本号并退出 0（不监听端口、不需要 token）',
  '  --help       打印本行并退出 0',
  '',
  '退出码：0 = 正常（含优雅停机）、1 = 运行期致命、2 = 命令行用法错。',
].join('\n')

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2))
  if ('error' in cli) {
    process.stderr.write(`[drc-relay] ${cli.error}\n\n${USAGE}\n`)
    process.exit(2)
  }
  if (cli.help) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }
  const version = readVersion()
  if (cli.version) {
    process.stdout.write(`${version}\n`)
    process.exit(0)
  }
  const { config, problems } = loadConfig(process.env, version)
  if (reportProblems(problems)) {
    process.exit(1)
  }
  const relay = createRelay(config)
  const { port, bind } = await relay.startListening()
  relay.log.info('relay listening', { port, bind, publicUrl: config.publicUrl, version: config.version })

  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    relay.log.info('shutting down', { signal })
    const guard = setTimeout(() => {
      relay.log.warn('shutdown timed out, forcing exit')
      // 兜底路径也要补写一次盘：排空超时说明还有在途连接，但内存表仍是此刻最新的真相，
      // 不写就等于把这次停机期间的变更丢掉。`shutdownForced` 同步进 /healthz——
      // 这条 exit(0) 与"排空成功"同一个码，只有计数能让运维事后分辨。
      relay.forceShutdown()
      process.exit(0)
    }, 5000)
    guard.unref()
    void relay.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('uncaughtException', (error) => {
    relay.log.error('uncaught exception', { message: String(error?.message ?? error) })
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    relay.log.error('unhandled rejection', { message: String((reason as Error)?.message ?? reason) })
    process.exit(1)
  })
}

void main().catch((error: unknown) => {
  process.stderr.write(`[drc-relay] fatal: ${String((error as Error)?.stack ?? error)}\n`)
  process.exit(1)
})
