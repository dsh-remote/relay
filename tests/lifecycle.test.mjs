/**
 * lifecycle 的判据 —— A3 的出口。
 *
 * ## 判据要证明什么
 *
 * **「停机」是一个可以被显式调用的动作**，而不是"恰好收到了 SIGTERM"。
 * v2 的 `shutdown` 是 `main()` 里的闭包，只注册给两个信号——于是 Windows 上
 * 服务停止 = 硬杀，排空与兜底落盘一次都不跑，而 `shutdownForced` 永远 0，
 * 运维事后分辨不出"这是被杀的"。
 *
 * 三条判据都是**外部可观测的事实**：
 * 1. 调出口 ⇒ 排空真的跑了（Windows 上那是唯一的路）；
 * 2. exit code 是 0（与"排空成功"同码，靠 `forced()` 区分，不靠猜）；
 * 3. 幂等：并发或重复请求都只跑一次 close。
 *
 * ## ⚠️ 每条用例都注入 exit
 *
 * 不注入的话「排空超时」那条会真的 `process.exit(0)`——node --test 在第一条就退出，
 * 后面全部不跑，而汇总仍可能显示通过。**那种绿是假的**（本项目踩过同族：
 * 「把修复整段删掉它照样绿」）。所以这里一律注入一个记录 exit code 的假实现。
 *
 * ## 本文件是 `.mjs`（不编译）——写纯 JS
 *
 * relay 的 `tsconfig.json` 只 include `src`，所以 `tests/*.test.mjs` 由 node 直接跑。
 * 代价：**不能用 TS 语法**（`type` 导入、类型标注），本文件里一处都没有。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createShutdown, registerSignalHandlers } from '../dist/src/lifecycle.js'

/** 一个可观测的假 relay：close 跑几次、forceShutdown 跑几次、记了哪些日志。 */
function fakeRelay(closeImpl) {
  const calls = { close: 0, force: 0, logs: [] }
  const log = (msg, fields) => calls.logs.push({ msg, fields })
  const relay = {
    log: { info: log, warn: log, error: log },
    close: async () => {
      calls.close += 1
      if (closeImpl) await closeImpl()
    },
    forceShutdown: () => {
      calls.force += 1
    },
  }
  return { relay, calls }
}

test('调停机出口 ⇒ 排空真的跑了、exit 0、且不强制落盘', async () => {
  const { relay, calls } = fakeRelay()
  const exits = []
  const { shutdown, forced } = createShutdown(relay, { exit: (c) => exits.push(c) })
  await shutdown('service:stop')
  assert.equal(calls.close, 1, '排空必须真的跑了：Windows 服务停止时没有信号投递，这条是唯一的路')
  assert.deepEqual(exits, [0], 'exit 码必须是 0：排空成功与被强退同码，靠 forced() 区分')
  assert.equal(calls.force, 0, '排空成功就不该再补一次盘（那是兜底路径）')
  assert.equal(forced(), false, 'forced() 为 false：它是 /healthz 里 shutdownForced 的来源')
})

test('排空超时 ⇒ 强制落盘一次 + forced() 为 true（兜底路径不许跳过）', async () => {
  // close 永不 resolve：这就是"主机卡住"的形状。
  const { relay, calls } = fakeRelay(() => new Promise(() => {}))
  const exits = []
  const { shutdown, forced } = createShutdown(relay, { exit: (c) => exits.push(c) })
  void shutdown('test', 20) // 20ms 兜底，别等真的 5 秒
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(calls.force, 1, '排空没完成就必须补写一次盘：内存表是此刻最新的真相')
  assert.equal(forced(), true, '运维事后靠它分辨这次是被兜底强退的')
  assert.deepEqual(exits, [0], '兜底也是 exit 0 —— 同一个码正是它需要 forced() 的原因')
})

test('close() 自己失败 ⇒ 仍然补写一次盘再退，并留日志', async () => {
  const { relay, calls } = fakeRelay(() => Promise.reject(new Error('drain blew up')))
  const exits = []
  const { shutdown, forced } = createShutdown(relay, { exit: (c) => exits.push(c) })
  await shutdown('test')
  assert.equal(calls.force, 1, 'close 失败时内存表仍是最新真相，必须落盘')
  assert.equal(forced(), true)
  assert.deepEqual(exits, [0])
  assert.ok(
    calls.logs.some((l) => l.msg.includes('close failed')),
    '要留一条日志：运维事后能看出这次是异常停机而不是正常排空',
  )
})

test('幂等：并发两个停机请求只跑一次 close（信号与服务管理可能同时到）', async () => {
  const { relay, calls } = fakeRelay()
  const { shutdown } = createShutdown(relay, { exit: () => {} })
  await Promise.all([shutdown('signal:SIGTERM'), shutdown('service:stop')])
  assert.equal(calls.close, 1, '跑两遍 close 会让 drain 计数错乱')
})

test('第二次调用（顺序而非并发）同样只跑一次', async () => {
  const { relay, calls } = fakeRelay()
  const { shutdown } = createShutdown(relay, { exit: () => {} })
  await shutdown('service:stop')
  await shutdown('service:stop')
  assert.equal(calls.close, 1, '停机是幂等动作：重复请求不该重复排空')
})

test('注册信号处理器后能摘干净（否则判据之间互相污染）', () => {
  const { relay } = fakeRelay()
  const { shutdown } = createShutdown(relay, { exit: () => {} })
  const before = process.listenerCount('SIGTERM')
  const unregister = registerSignalHandlers(shutdown)
  assert.equal(process.listenerCount('SIGTERM'), before + 1, '注册后多一个')
  unregister()
  assert.equal(process.listenerCount('SIGTERM'), before, '取消后回到原样')
})

test('win32：信号不投递，所以必须有不依赖信号的出口', () => {
  // 不测"收不到信号"（那要真发信号，CI 上不可靠），测**结构性事实**：
  // 我们注册了 SIGTERM 处理器，而在 Windows 上服务停止走的是别的东西。
  // 结论因此落在「必须有一个不依赖信号的出口」上——也就是 createShutdown 本身。
  const { relay, calls } = fakeRelay()
  const { shutdown } = createShutdown(relay, { exit: () => {} })
  void shutdown('service:stop')
  assert.equal(calls.close, 1, '不依赖任何信号也能停机：这是 Windows 可部署的前提')
})
