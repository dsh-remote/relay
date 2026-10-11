# Changelog

## 3.1.3

> 四个包一起 bump 到 `3.1.3`。**这一版修的是 3.1.2 那个认领接口的模型缺陷** ——
> 它是被一次真实事故逼出来的，不是理论推演。

**host token 从「全局单令牌 + 认领即轮换」改成「按 hostId 一机一枚」。**

### 事故现场（2026-10-11，一天之内）

本机（`112.48.57.86`）被**另外三台机器**各顶掉一次 —— nginx 访问日志里的客户端 IP
是 `63.178.90.28`（14:34）、`218.86.249.169`（15:43）、`172.172.119.98`（16:57），
两条 `POST /api/claim-token` 的 UA 都是 `node`（= 别的机器上的插件）。

旧模型下每一次认领都会把**所有人的**令牌作废，而主机侧"盘上有 token 就不再认领"
⇒ 被顶掉的那台**不会自愈**、永久连不上（pill 上就是"连接中 / 主机还没连上中继"）。
更糟的是这条接口**无认证**：任何能 POST 它的人都能把合法主机永久踢下线。

### 改法

- **带 `{hostId}` 认领**：只顶掉**这台机器自己**旧的那一枚（"后面的顶掉前面的"），
  别人的那枚不受影响。`hostId` 形状在门口卡住（≤200 字符、URL 安全字符集），
  不合法回 400 `bad_host_id`。
- **不带 `hostId`**（3.1.2 及更早的插件）：落到**未绑定槽位**，语义与旧版逐字一致
  （认领即作废上一枚）。老客户端因此不会被打断，而它顶掉的也只是同一个槽位里的那枚
  —— 按 hostId 签发的令牌不受影响。
- **`DRC_HOST_TOKEN` 永不参与轮换**：它是运维引导凭据，认领动不了它。
- **令牌随 `DRC_STATE_FILE` 落盘**：中继重启后按 hostId 的那枚仍然有效
  （旧模型下重启会回到 env 那枚，把认领过的主机全部搁死）。
- **令牌表有界**：`DRC_MAX_HOST_TOKENS`（默认 500），超限按"**先丢签了没人用的**、
  同一档再按最近活动从旧到新"。用过的一枚永远不会被丢 —— 丢了它不会自愈。
- **`/healthz` 多一个 `hostTokens`**：只报**条数**，绝不报任何一枚令牌（判据盯着这条）。
- `DRC_CLAIM_MIN_INTERVAL_MS`（默认 4000）从常量变成配置：`0` = 关掉限频（会 warn），
  只为测试与完全内网自用；判据因此不必靠"等 4 秒"绕过闸。

### 判据

`tests/host-tokens.test.mjs` 九条（真 HTTP + 真 WebSocket 打真中继），每条都带反证：
别人的认领顶不掉我 / 同一台机器再认领只顶掉自己 / 老客户端语义不变且关在槽位里 /
env 那枚认领多少次都还在 / 重启后按 hostId 的那枚仍然有效 / 超限先丢占位条目 /
hostId 形状不合法 400 / `/healthz` 不泄露令牌。另修了两条**假绿**的旧判据
（`claim-token.test.mjs` 的"轮换"拿 429 的空 body 比 undefined；
`hardening.test.mjs` 那条"凭据形态"按**键名**判、误伤了 `hostTokens` 这个**条数**）。

### ⚠️ 回滚代价

旧中继读到新状态文件会忽略 `hostTokens` 字段并在下次落盘时**把它抹掉** ⇒
回滚后所有按 hostId 的令牌失效，而主机侧"有 token 就不再认领"**不会自愈**：
要么把主机上的 `host-token.json` 删掉让它重新认领，要么把中继 env 改回同一枚。
升版本时**不**升 `STATE_FILE_VERSION`（升了旧中继会把整份状态丢掉，连配对一起没）。

## 3.1.2

> 四个包一起 bump 到 `3.1.2`。

**本包唯一的改动：认领 host token 的接口**（`POST /api/claim-token`）。

- 之前 host token 只能由用户写进 patch / 环境变量 ⇒ 插件的"装完就能用"走不通。
- 但**不能做成"谁来问都给 token"**：中继是公网服务，那等于把 token 公开
  （比明文写在 0600 文件里更差）。所以是**认领**：领到的是一枚**新的、只属于这一台机器的**
  token，且**旧的那枚当场作废**（"随时换 token"因此不需要另开接口）。
- 四道闸（各有判据）：同 IP 限频 4 秒 / **只收 POST**（GET 在浏览器地址栏一发就能领走一枚）/
  停机中不受理（503）/ 限频表**有界**（10000 条，满了丢最旧）。
- ⚠️ **滥用面写在代码注释里**：限频挡得住脚本连打，**挡不住换源 IP 的分布式刷**——
  这台中继会替陌生人中继流量（读不到内容，但吃带宽与配对表容量）。要收口子得在运维侧决定。
- ⚠️ 新 token 长度与 env 那枚对齐（**48 位十六进制**）：`tokenMatches` 是定长比较，
  长度变了不会报错、只会让所有已装机的主机**静默**连不上。
- 顺带把 token 变成可变的：`currentHostToken` 是可变副本，`config.hostToken` 仍是**启动初值**
  ⇒ 重启后没人认领就回到 env 里那枚，**运维改 env 的老路仍然有效**。

⚠️ **尚未部署到 ECS**（`47.100.82.15`）：发插件之前必须先把它发上去。

## 3.1.1

> 四个包一起 bump 到 `3.1.1`。**本包无代码改动**（版本号按约定与 plugin 同号）。
> 实质内容都在 `plugin`：`approvalTimeoutSec` 配置项被删除。

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
