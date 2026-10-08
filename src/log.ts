/**
 * log — 一行一条 JSON 的结构化日志。
 *
 * 为什么自写 ~40 行而不是引 pino（实测决定，不是口味）：
 * pino 默认起 `thread-stream` 工作线程（实测进程线程数 11 vs 裸 node 7），
 * 生产依赖闭包 13 个包；而服务器侧已有 systemd-journald 负责收集与轮转
 * （`StandardOutput=journal` + `SyslogIdentifier`）。为一个 500 行的中继
 * 增加常驻线程与 13 个包，换不到任何东西。
 * 取证 `docs/legacy-spec/open-source-options.md` §A.5.2、§C。
 *
 * **零知识是在类型层面兜住的**：字段值只允许 `string | number | boolean`。
 * 想把一个载荷对象、一段会话标题或一条模型输出塞进日志行，编译器就不同意——
 * 这比"记得脱敏"可靠。旧实现收集了 stdout 行却没有任何断言用它们，
 * 本次由 `tests/hardening.test.mjs` 补上：日志里出现业务明文即为失败。
 */
import { type LogLevel, levelWeight } from './config.js'

/** 允许出现在日志行里的值类型。没有 object/array，所以没有"顺手把载荷打出来"这条路。 */
export type LogValue = string | number | boolean

export interface LogFields {
  [key: string]: LogValue | undefined
}

export interface LogRecord {
  ts: string
  level: LogLevel
  msg: string
  [key: string]: LogValue | undefined
}

/** 需要占位的敏感字段一律用它，别把值传进日志调用。 */
export const REDACTED = '<redacted>'

/**
 * 日志里单个字符串值（含 `msg`）的最长字符数。超出就截断并加 `…` 标记。
 *
 * 为什么**每个**字符串值都必须过这一道（2026-10-06 实测）：出站日志进的是
 * systemd-journald，而它按**条数**限流、不按字节。于是"对端自报的字段"是一条
 * 免费的日志放大器——实测 20 帧带 400 KiB `clientMeta.platform` 的 `hello`
 * 就写出 8.19 MB 日志 / 1.2s，单行 409 KB；一条 409 KB 的行和一条 40 字节的行
 * 占的是同一个 journald 配额，磁盘与限流窗口一起被吃掉。
 *
 * 256 是"够排障、不够灌水"的折中：日志里合法出现的就只有 id / 计数 / 配对码占位 /
 * 角色名，它们全都远短于这个数；协议侧再补 `clientMeta` 的 max(128) 之后，
 * 这里只作为**结构性**上限兜住"未来某个新字段又没设上限"。
 */
export const MAX_LOG_VALUE_CHARS = 256

function clampText(value: string): string {
  return value.length <= MAX_LOG_VALUE_CHARS ? value : `${value.slice(0, MAX_LOG_VALUE_CHARS)}…`
}

export class Log {
  private readonly threshold: number

  constructor(
    level: LogLevel,
    private readonly write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
  ) {
    this.threshold = levelWeight(level)
  }

  log(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (levelWeight(level) < this.threshold) return
    // 值一律过 clampText（上限见 MAX_LOG_VALUE_CHARS）。脱敏仍然是**调用方**的纪律
    // （`REDACTED` 占位、info 级不打配对码）——截断只治"长度"，不替脱敏负责，
    // 两条纪律各管各的，谁都不能因此省掉。
    const record: LogRecord = { ts: new Date().toISOString(), level, msg: clampText(msg) }
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      record[key] = typeof value === 'string' ? clampText(value) : value
    }
    this.write(JSON.stringify(record))
  }

  debug(msg: string, fields?: LogFields): void {
    this.log('debug', msg, fields)
  }

  info(msg: string, fields?: LogFields): void {
    this.log('info', msg, fields)
  }

  warn(msg: string, fields?: LogFields): void {
    this.log('warn', msg, fields)
  }

  error(msg: string, fields?: LogFields): void {
    this.log('error', msg, fields)
  }
}
