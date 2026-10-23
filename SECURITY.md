# Security Policy

## 报告漏洞

用本仓 GitHub 的私密渠道：**Security → Report a vulnerability**（`/security/advisories/new`）。
不要在公开 issue 里贴可利用细节。

## 本仓的范围

- 负责：WebSocket 路由与鉴权（`hostToken`）、配对码表（TTL / 一次性 / 限流）、
  帧分级与体积闸（`ws.maxPayload`）、慢消费者处置、日志的凭据卫生。
- 不负责：载荷内容——**结构上看不见**；密码学在中继的依赖图上不可达（有产物级判据）。

## 零知识（可核对的说法）

- 构建产物 `dist/bundle/main.js` 里**没有**任何密码学实现：`tests/bundle.test.mjs`
  直接读产物，对 `xsalsa20` / `secretbox` / `tweetnacl` 等标记逐条断言。
- 日志约定：只记 id / 计数 / reason；配对码与 `hostToken` 永不整值落日志（有判据）。
- 部署加固（TLS 由反代终止、绑定与防火墙、状态/凭据文件权限）见 `docs/SELF-HOSTING.md`。
