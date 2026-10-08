/**
 * log.test — 日志值的长度上限（P1-3）。
 *
 * 需求来源是一条实测可复现的放大链：对端自报的字段（`clientMeta.platform`）在
 * `hello` 里是**无上限**的（协议侧上限由 Lead 补），而中继会把它写进日志；
 * 出站日志进的是 systemd-journald，**按条数限流、不按字节**。于是 20 帧带
 * 400 KiB platform 的 hello 就写出 8.19 MB 日志 / 1.2s，单行 409 KB——
 * 一条 409 KB 的日志行和一条 40 字节的行占的是同一个 journald 配额。
 *
 * 这个文件锁两件事：
 * 1. 单个字符串值（字段与 `msg`）有硬上限，超出截断并带 `…` 标记；
 * 2. 截断**只治长度**，不改类型、不动数字/布尔，也不替调用方的脱敏负责
 *    （`REDACTED` 占位仍然逐字保留）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Log, MAX_LOG_VALUE_CHARS, REDACTED } from '../dist/src/log.js'

function capture(level = 'debug') {
  const lines = []
  const log = new Log(level, (line) => lines.push(line))
  return { log, lines }
}

test('超长字符串值被截断：400 KiB 的字段写出来仍是有界的短行', () => {
  const { log, lines } = capture()
  const huge = 'x'.repeat(400 * 1024)
  log.info('client online', { clientId: 'inst-1', platform: huge })
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.platform.length, MAX_LOG_VALUE_CHARS + 1, '截断后必须只剩上限 + 一个省略号')
  assert.ok(record.platform.endsWith('…'), '截断必须留一个可见标记，别让人以为原值就这么长')
  // 整行长度才是 journald 看到的那个数：上限必须把它钉在同一个量级上，
  // 而不是"值截断了但 JSON 转义/msg 又把它放回去"。
  assert.ok(lines[0].length < 1024, `单行仍需有界（实际 ${lines[0].length} 字节）`)
})

test('msg 与字段值走同一条上限；短值、数字、布尔一律不碰', () => {
  const { log, lines } = capture()
  log.warn('y'.repeat(5000), { n: 42, ok: true, short: 'z'.repeat(10), nada: undefined })
  const record = JSON.parse(lines[0])
  assert.equal(record.msg.length, MAX_LOG_VALUE_CHARS + 1)
  assert.ok(record.msg.endsWith('…'))
  assert.equal(record.short, 'z'.repeat(10), '没超上限的值必须逐字保留')
  assert.equal(record.n, 42)
  assert.equal(record.ok, true)
  assert.equal('nada' in record, false, 'undefined 字段照旧不出现')
})

test('截断不替脱敏负责：REDACTED 占位与"不打完整配对码"的纪律原样保留', () => {
  const { log, lines } = capture()
  log.info('pair token issued', { token: REDACTED, ttlMs: 120_000 })
  const record = JSON.parse(lines[0])
  assert.equal(record.token, '<redacted>', '脱敏是调用方的纪律，截断这一层不许把它抹掉或改写')
  assert.equal(record.ttlMs, 120_000)
})
