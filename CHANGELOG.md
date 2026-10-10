# Changelog

## 3.1.0

> 四个包（`protocol` / `relay` / `plugin` / `client`）一起 bump 到 `3.1.0`。

**本包第一次发到 npm。** 此前是 `private: true`，理由记在
`tests/bundle.test.mjs` 里：**包名撞墙** —— `dsh-remote-server` 在 npm 上属于另一个无关项目
（一个"在 DSH 会话里 @ 服务器走 SSH 执行命令"的工具）。

⚠️ **那条理由已经不成立**：它拦的是**未加 scope 的老名字**。包名早已迁到 `@dsh-remote/relay`，
而这个名字在 npm 上是空的。判定依据是可复查的：`npm view @dsh-remote/relay` → 404；
`npm view dsh-remote-server` → `0.2.1-alpha.1`。

- **`private: true` 去掉**，补 `publishConfig`（`access: public` + `provenance: true`）。
- **补 `files` 白名单** ⇒ 打包从 **50 个文件降到 12 个**：`.github/`、`tests/`、`scripts/`、
  `src/` 不再进包。发的是产物 + 自托管配方 + 许可证与安全说明。
- **`main` 与 `bin` 都指向自包含单文件产物** `dist/bundle/main.js` ⇒ `npx @dsh-remote/relay` 可用。
- **`release.yml` 合并**：原来只管挂单文件产物，现在一条流水线走完
  校验 → 发 npm → 验 provenance → 建 GitHub Release（并把单文件产物挂上去）。
  分成两条 workflow 的方案被放弃了 —— 权限面（`id-token: write`）聚在一处更好审。
- 判据 `tests/bundle.test.mjs` 从「**钉住不发**」改写成「**钉住分发形状**」：
  该发的进白名单、该不发的（源码/测试/CI）不许混进来、`NODE_AUTH_TOKEN` 必须显式清空。

- **发布链路换成 npm Trusted Publishing（OIDC）**：新增 `.github/workflows/release.yml`，
  打 `v*` tag 即发。没有 `NPM_TOKEN`、没有长期凭据 —— GitHub 签一个 OIDC token，npm 核对
  「这次运行确实是本仓、本工作流」之后发一个短时发布 token。
  `publishConfig.provenance` 随之打开 ⇒ **从这一版起 npm 上有供应链溯源**（v3.0.x 各版都没有）。
- **修 `repository` / `homepage` / `bugs`**：一直指向 `dsh-remote/dsh-remote-<包名>`（**不存在**），
  实际仓名是 `dsh-remote/<包名>` ⇒ npm 包页的仓库链接此前是 404。

## 3.0.0

> ⚠️ **3.0.0 没有发到 npm** —— 本包当时是 `private: true`，**3.1.0 才是第一个 npm 版本**。
> 3.0.0 的产物形态是"自包含单文件 + 部署配方"，随 GitHub Release 分发。

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
