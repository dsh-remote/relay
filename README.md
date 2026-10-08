# dsh-remote-server

[![CI](https://github.com/providcc/dsh-remote-server/actions/workflows/ci.yml/badge.svg)](https://github.com/providcc/dsh-remote-server/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/providcc/dsh-remote-server.svg)](https://github.com/providcc/dsh-remote-server/releases)
[![Node ≥ 20](https://img.shields.io/badge/Node-%3E%3D%2020-339933.svg)](./docs/SELF-HOSTING.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**DSH Remote Control** 的零知识 WebSocket 中继：在跑 DSH 的桌面主机与已配对的手机之间转发密封记录。
它是一个单进程、纯内存的服务：**产物零运行时依赖**——`ws` 与协议层
（[`dsh-remote-wire`](https://www.npmjs.com/package/dsh-remote-wire)）都被内联进那一个文件，
源码树里它们才是依赖。分发只有两条：GitHub Release 上那个单文件产物（配 `SHA256SUMS`），
或从源码构建。**本仓不发 npm**——`dsh-remote-server` 这个包名属于另一个无关项目
（`bondzhu` / `MRZHUH/dsh-remote-server`，一个"在 DSH 会话里 @ 服务器走 SSH 执行命令"的工具），
所以**别照抄任何 `npm i -g dsh-remote-server`**，那条装到的是别人的东西。

> EN: the zero-knowledge WebSocket relay for DSH Remote Control — a single self-contained
> file (zero runtime dependencies), forwarding only sealed envelopes between your DSH host
> and your paired phone. Self-hostable with one systemd unit.

## 零知识是什么意思

中继看到的每一个载荷都是 `base64(nonce ‖ secretbox)`。它**没有密钥**——不是"我们不去解密"，
而是密钥在协议层的依赖图上就不可达：载荷密钥（PSK）在主机上生成，只经二维码交给手机，
从不上网；中继手里只有主机的注册凭据与一张配对码路由表。

这是**结构性**的：中继的构建产物里搜不到 `xsalsa20` / `secretbox` / `tweetnacl`，
`tests/bundle.test.mjs` 会断言这件事。

```
┌──────────────────┐  wss + host token   ┌────────────────┐  wss + 配对码   ┌────────────────┐
│  DSH 桌面主机      │ ─────────────────▶ │  relay server  │ ◀────────────── │ 微信小程序客户端  │
│  (host plugin)   │   只见密文与 6 位码   │  (本仓)         │                 │  (mp/)          │
└──────────────────┘                     └────────────────┘                 └────────────────┘
```

中继负责：主机认证、配对码的签发与路由、会话成员表、限流与背压、优雅停机。
它不负责：TLS 终止（交给反向代理）、载荷语义、任何密钥。

## 快速开始

要求 **Node.js ≥ 20**（`.nvmrc` 里是 22）。生产入口是**一个自包含单文件**：`dist/bundle/main.js`。

从源码跑：

```sh
pnpm install
pnpm build            # tsc + esbuild → dist/bundle/main.js

DRC_HOST_TOKEN=$(openssl rand -hex 32) DRC_PORT=8787 node dist/bundle/main.js
```

单文件产物把 `ws` 与协议层（`dsh-remote-wire`）全部内联，只有 `bufferutil` /
`utf-8-validate` 这两个**可选**原生加速模块留在外面——缺了照常跑。于是部署退化成
**拷一个文件 + 一个 env 文件**，不需要 `npm install`、不需要 `node_modules`。

验证它起来了（下面的输出取自一个 `DRC_PORT=0` 的产物实例）：

```sh
curl -s http://127.0.0.1:8787/healthz
# {"ok":true,"version":"2.0.15","uptimeSec":4,"hosts":1,"clients":0,"conversations":1,"pendingPairs":0,"droppedFrames":0,"slowConsumers":0,"rejectedPairs":0,"shutdownForced":0,"persistence":"on","stateRestored":1,"stateSavedAtSec":4,"stateWrites":12,"stateWriteFailures":0,"lastPingAgo":1,"shuttingDown":false}

curl -s http://127.0.0.1:8787/api/info
# {"publicUrl":"","protocol":1}
```

拷到空目录里也能起（证明它真的自包含）：

```sh
mkdir -p /tmp/drc-smoke && cp dist/bundle/main.js /tmp/drc-smoke/relay.mjs
cd /tmp/drc-smoke
DRC_HOST_TOKEN=smoke-token-0123456789abcdef DRC_PORT=0 node relay.mjs
# {"ts":"...","level":"info","msg":"relay listening","port":65258,"bind":"127.0.0.1","publicUrl":"","version":"1.0.6"}
```

## 配置

**没有 `DRC_HOST_TOKEN` 服务拒绝启动。** 完整清单、默认值与取证状态见
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) §2；下面是常用的几项：

| 变量                          | 必填 | 默认        | 说明                                                                                                                       |
| ----------------------------- | ---- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DRC_HOST_TOKEN`              | ✅   | —           | 主机出站认证凭据。`openssl rand -hex 32` 生成。**与主机插件那份必须逐字一致**                                              |
| `DRC_PORT`                    |      | `8787`      | 监听端口。`0` = 让系统分配（测试与容器用）                                                                                 |
| `DRC_BIND`                    |      | `127.0.0.1` | 绑定地址。默认只绑回环：TLS 由反代终止。**只有自己就是边缘（容器直接发布端口）时才设 `0.0.0.0`**                           |
| `DRC_PUBLIC_URL`              |      | 空          | `/api/info` 返回的对外地址。公网填 `wss://你的域名`                                                                        |
| `DRC_LOG_LEVEL`               |      | `info`      | `debug` / `info` / `warn` / `error` / `silent`。**区分大小写**，写 `INFO` 会拒绝启动                                       |
| `DRC_PAIR_TTL_MS`             |      | `120000`    | 配对码的**服务端权威**寿命（毫秒）                                                                                         |
| `DRC_STATE_FILE`              |      | 空（关闭）  | 会话表落盘路径。**默认关闭**：不配就与以前逐字一致（配对只存内存，中继重启即丢）。配上之后启动先读它、会话表有增删时写回   |
| `DRC_STATE_SAVE_MS`           |      | `60000`     | 周期性补写状态文件的间隔。只为刷新 `lastActivityAt`——它每帧都在更新，跟着写就是每帧一次 fsync                              |
| `DRC_MAX_BUFFERED_BYTES`      |      | `1048576`   | 慢消费者阈值：发送缓冲区**连续**超限达**本角色窗口**才 1008 断开（见下面两行）                                             |
| `DRC_SLOW_CONSUMER_HOST_MS`   |      | `10000`     | **主机**侧慢消费者窗口（毫秒）。主机卡住就是所有人卡住，所以窗口短                                                         |
| `DRC_SLOW_CONSUMER_CLIENT_MS` |      | `45000`     | **客户端**侧慢消费者窗口（毫秒）。**必须大于手机自己的重连周期**（≈42.5 秒），否则会成为"踢了秒回、回来又被踢"的循环发动机 |

落盘只写 `conversationId` / `hostId` / `clients` / `seqHost` / `lastActivityAt` / `emptySince`，
**不写任何秘密**：中继是结构性零知识的，它从来不持有 PSK；会话 id 与 client id 本来就明文
出现在每一帧里，落盘不扩大暴露面。`pendingPairs` 与 `hostOfflineSince` 也不写——前者带一次性
语义，后者照搬会让一次停机维护当场判死宽限期（见 CHANGELOG 1.0.6）。

数值型变量**必须**是正整数——`0`、负数、`abc`、小数一律拒绝启动（`DRC_PORT` 的 `0` 例外）。
一个拼写错误会让服务根本起不来，无值守场景里这是好事，但要知道它现在会响。

## 端点

| 路径                   | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`         | 运维契约：`ok` / `version` / `uptimeSec` / `hosts` / `clients` / `conversations` / `pendingPairs` / `droppedFrames` / `slowConsumers` / `rejectedPairs` / `shutdownForced` / `persistence` / `stateRestored` / `stateSavedAtSec` / `stateWrites` / `stateWriteFailures` / `lastPingAgo` / `shuttingDown` / `protocolSelf` / `protocolMin` / `peerProtocolMin` / `peerProtocolMax` / `peersNoProtocol` 二十三个字段（后五个是协议版本协商的观测面，见 [SELF-HOSTING.md §4](docs/SELF-HOSTING.md)） |
| `GET /api/info`        | `{"publicUrl","protocol"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/pair-status` | **默认 404**。无需认证地回答"配对码 N 是否有效"，等于给 6 位码空间装了扫描 oracle；确需调试时 `DRC_PAIR_STATUS=1`，用完关掉                                                                                                                                                                                                                                                                                                                                                                       |
| WebSocket              | 路径不设限，任意路径都能升级                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

`/healthz` 的 `version` 必须是真实版本号——出现 `0.0.0` 说明部署的不是打包产物。

## 部署

产物是**一个文件**（`dist/bundle/main.js`，`ws`/协议层全内联、运行时零依赖），怎么托管它有三条路：

| 形态       | 怎么跑                                                          | 用在哪                       |
| ---------- | --------------------------------------------------------------- | ---------------------------- |
| **Docker** | `docker compose -f deploy/docker/compose.yaml up -d --build`    | **生产实例现在跑的就是这条** |
| systemd    | `install -m0755` 那个 `.mjs` + `systemctl start`                | 不装 Docker 的机器           |
| 单文件     | GitHub Release 上挂的那一个 `.mjs`，`node relay.mjs` 就算起来了 | 临时验证                     |

三条路**同形**：同一个产物、同一套 `DRC_*`、同一个 `/healthz`；变的只有「谁负责把它拉起来」。
本仓不发 npm（原因见顶部）。

`deploy/` 里是**正在生产使用**的配置，不是示例：

- `deploy/docker/` —— Dockerfile + compose + 容器化部署指南（含镜像源拉不到时的三条路）
- `deploy/nginx/drc.conf` —— 反向代理（TLS 终止 + 按 IP 限流 + WS 升级）
- `deploy/systemd/dsh-remote-control.service` —— Linux 常驻单元（与容器二选一）
- `deploy/README.md` —— 从零复现步骤

中继**不终止 TLS**。小程序真机只允许 `wss://`，所以公网部署必须有反向代理。
完整指南（环境变量全表、日志契约、重启语义、journald 与 docker logs 过滤、systemd/launchd/Docker、
升级回滚）见 [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md)。

### 命令行

```sh
node relay.mjs              # 启动（读 DRC_*；缺 DRC_HOST_TOKEN 拒绝启动）
node relay.mjs --version    # 打印版本号，exit 0，不监听端口、不需要 token
node relay.mjs --help       # 用法
```

退出码：**0** 正常（含优雅停机）/ **1** 运行期致命 / **2** 命令行用法错。
2 单独分出来是因为容器编排里传错 flag 的表现是「容器起来了但行为不是我要的」——
旧行为是静默忽略任意参数。

## 开发

```sh
pnpm install
pnpm typecheck        # tsc --noEmit
pnpm test             # tsc + bundle + node --test tests/*.test.mjs
pnpm format:check     # prettier --check
./scripts/relay-start.sh --bundle   # 本地起一个，token 复用 DSH profile 里那一份
```

日志是**一行一个 JSON**（NDJSON），写到 stdout，由 journald / Docker 收集。
`level` 与 `msg` 是运维契约：告警规则与 grep 都靠它们，不要改写。

## 安全

威胁模型、加固清单与漏洞报告方式见 [`SECURITY.md`](./SECURITY.md)。
**请不要为安全报告开公开 issue。**

## 许可

[MIT](./LICENSE) © providcc
