# Changelog

## 3.0.0（开发中）

- v3：四端合并进 `dsh-remote-v3` 单仓开发；仓库与包名由 `dsh-remote-server` 迁到 **`@dsh-remote/relay`**，
  仓库改到 [`dsh-remote/dsh-remote-relay`](https://github.com/dsh-remote/dsh-remote-relay)。
- **优雅停机变成可显式调用的出口**（`src/lifecycle.ts`）：v2 的 `shutdown` 是 `main()` 里的闭包、
  只注册给两个信号 ⇒ Windows 服务停止 = 硬杀，排空与兜底落盘一次都不跑。现在幂等、
  `close()` 自己失败也补写一次盘。信号只是**触发源之一**。
- **Windows 服务配方**（`deploy/windows/drc-relay-install.cmd`，NSSM）：v2 只有 systemd 与容器两条路。
  它把 `AppStopMethodConsole` 设成先发 Ctrl+C——那 15 秒里优雅停机才跑得起来。
- **一条诊断命令** `scripts/relay-doctor.mjs`：读 `/healthz` 二十三个字段给结论 + 下一步，
  非 0 退出码可被监控判。**只读白名单**：响应里混进来的凭据字段不出现
  （判据用一个故意混进凭据的假响应验证）。
- 脚本去 shell 化：`relay-start.sh` → `.mjs`（`grep -oE` 那段变成可单测的纯函数 `readHostToken`）。
- 新错误码 `history_window_exceeded` 的中文文案。
- 判据 197 → 214。

2.0.21 及更早的完整历史见旧仓 [`providcc/dsh-remote-server`](https://github.com/providcc/dsh-remote-server) 的 CHANGELOG。
