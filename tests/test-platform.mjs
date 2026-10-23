/**
 * test-platform —— relay 测试装置的平台化辅助。
 *
 * 与 `packages/plugin/tests/test-platform.ts` 同一套约定（那边有更长的说明）。
 * relay 的测试是 `.mjs`，所以这里是 JS 版。
 *
 * ## 为什么 relay 也需要它（2026-10-10）
 *
 * 四个开源仓的 CI **第一次真的在 `windows-latest` 上跑起来**时，relay 红了 10 条。
 * 其中一类是**平台事实**，不是缺陷：
 *
 * | 类别 | 在 Windows 上 |
 * |---|---|
 * | POSIX 权限位（`0o600` / `chmod`） | 不成立：`chmod` 只切只读位，`statSync().mode & 0o777` 无意义 |
 * | `SIGTERM` 的优雅停机语义 | **不存在**：Node 在 win32 上把它映射成 `TerminateProcess`，进程被**硬杀**，对端收到 1006 而不是 1001 |
 *
 * 后一类 relay 自己早就知道（`lifecycle.test.mjs` 有一条
 * 「win32：信号不投递，所以必须有不依赖信号的出口」），只是那两条判据没跟上。
 *
 * ⚠️ **skip 必须带原因**（V3-PLAN A5）：否则 CI 变绿时没人知道它其实没测 ——
 * 而"看起来测过"比"明摆着没测"更坏。
 */

/** 这个平台上「POSIX 权限位」这套语义成立吗？ */
export function hasPosixModes(platform = process.platform) {
  return platform !== 'win32'
}

/** 给 node:test 的 `skip` 选项：只在 win32 上跳过，原因写进测试输出。 */
export function skipUnlessPosix(platform = process.platform) {
  return {
    skip: hasPosixModes(platform)
      ? false
      : 'win32 没有 POSIX 权限位：chmod 只切只读位，0o600 / mode & 0o777 类断言不成立',
  }
}

/**
 * 只在**信号真的会被投递**的平台上跑。
 *
 * Windows 上 `child.kill('SIGTERM')` 与 `SIGKILL` 都落到 `TerminateProcess` ——
 * 进程**没有机会**走优雅停机，于是"对端收到 1001"与"进程 exit 0"两条都不成立。
 * 这不是 relay 的实现问题（`createShutdown` 本身平台无关，有单独判据），
 * 而是**Windows 没有信号**这个事实。
 */
export function skipUnlessSignals(platform = process.platform) {
  return {
    skip:
      hasPosixModes(platform) === false
        ? 'win32 没有可投递的信号：SIGTERM/SIGKILL 都被映射成 TerminateProcess，' +
          '进程被硬杀 ⇒ "优雅停机 / 对端收到 1001" 在这个平台上不成立（relay 的非信号出口另有判据）'
        : false,
  }
}
