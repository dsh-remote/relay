/**
 * child-harness —— 测试装置里**收场子进程**的共用写法。
 *
 * ## 为什么要有这个文件（2026-10-08，Linux 腿实测抓出来的）
 *
 * `relay/tests/doctor.test.mjs` 有一次在 Linux 上把**整套 `pnpm gates` 挂死**：
 * 它的 `startRelay()` 在等端口时报错时 reject，而那个 reject 发生在
 * `await startRelay(...)` 这一层——**`t.after(() => relay.stop())` 还没被注册**，
 * 于是子进程成了没人管的孤儿。
 *
 * 而孤儿的 stdio 管子一直开着 ⇒ 父进程的**事件循环永远排不空** ⇒
 * `node --test` 不退出 ⇒ `report-gates.mjs` 的 `spawnSync` 也不返回
 * （它还没有 timeout，于是是"永久等待"）。
 *
 * 症状与其它任何一种失败都不一样：**最后一行日志之后再无输出**。
 *
 * ## 三条纪律（每一条对应上面那个坑的一个环节）
 *
 * 1. **启动失败也要收场**：失败路径自己 `SIGKILL`，不要指望 `after` 钩子。
 * 2. **等待必须有上限**：无界的 `await once('exit')` 等于把"失败"变成"挂住"。
 * 3. **兜底要升级**：先 `SIGTERM`（让它走优雅停机），超时就 `SIGKILL`。
 *
 * ⚠️ 为什么不直接写个 `raceWithTimeout` 就够：还要覆盖"**根本没注册收场**"那一路，
 * 那是 `after` 钩子管不到的（见上面第 1 条）。
 */
import { setTimeout as sleep } from 'node:timers/promises'

/** 默认的优雅停机预算：比中继自己的 5 秒兜底短，比一次本地 exit 宽裕。 */
const DEFAULT_GRACE_MS = 3000

/**
 * 等子进程退出，**最多等 `timeoutMs`**。
 * @returns {number|string} 退出码；超时返回 `'timeout'`（调用方要能分辨，那是"挂住"而不是"退出"）
 */
export async function waitExit(child, { timeoutMs = DEFAULT_GRACE_MS } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    sleep(timeoutMs).then(() => 'timeout'),
  ])
}

/**
 * 收场：先 `SIGTERM`，超预算就 `SIGKILL`。**幂等**（已经在退出了就直接返回）。
 *
 * @returns {number|string} 退出码，或 `'timeout'`（连 SIGKILL 都没在预算内退出——极罕见，
 *   但它必须是个可判的值，而不是让调用方永远等下去）
 */
export async function stopChild(child, { graceMs = DEFAULT_GRACE_MS } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  child.kill('SIGTERM')
  const first = await Promise.race([exited, sleep(graceMs).then(() => 'timeout')])
  if (first !== 'timeout') return first
  // 升级：SIGKILL 在所有平台都生效（win32 上 Node 把它映射成 TerminateProcess）
  child.kill('SIGKILL')
  return Promise.race([exited, sleep(graceMs).then(() => 'timeout')])
}

/**
 * **启动失败路径**上的收场：立刻硬杀，不做任何等待。
 *
 * 为什么不是 `stopChild`：那一条是给"正常跑完、现在要收工"用的；
 * 而失败路径上我们**不等它优雅停机**——它可能正因为启动失败而卡在某个系统调用里
 * （Linux 上实测过：卡住的进程连 SIGTERM 都不动），等它只是把"红"变成"挂"。
 */
export function killChildNow(child) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经没了 */
    }
  }
}
