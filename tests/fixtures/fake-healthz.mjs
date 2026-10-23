/**
 * 假 /healthz：响应里**故意混入凭据样式的字段**。
 *
 * 今天的真中继没有这些字段，但**这条纪律不能靠"今天恰好没有"维持**：
 * 哪天后端加了 `hostTokenPreview` 之类带凭据的字段，一次整体回显就把它
 * 印到运维的终端、CI 日志与工单截图里。所以 relay-doctor 只读白名单，
 * 而这份脚本用来证明那条白名单真的生效。
 */
import { createServer } from 'node:http'

const SMUGGLED = process.argv[2] ?? 'smuggled-secret'

createServer((_req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(
    JSON.stringify({
      // 白名单内
      ok: true,
      version: '2.0.21',
      uptimeSec: 1,
      hosts: 0,
      clients: 0,
      conversations: 0,
      pendingPairs: 0,
      droppedFrames: 0,
      slowConsumers: 0,
      rejectedPairs: 0,
      shutdownForced: 0,
      persistence: 'off',
      stateWrites: 0,
      stateWriteFailures: 0,
      // 白名单外：下面两个是"万一将来有人加了"的模拟
      hostTokenPreview: SMUGGLED,
      debugDump: SMUGGLED,
    }),
  )
}).listen(0, '127.0.0.1', function onListen() {
  process.stdout.write(`PORT${this.address().port}\n`)
})
