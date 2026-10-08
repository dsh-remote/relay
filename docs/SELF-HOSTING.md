# 自建中继服务部署指南

`dsh-remote-server` 是一个单进程、纯内存的零知识 WebSocket 中继。运行时只有 `ws`，
而**生产入口只有一个文件**：`dist/bundle/main.js`。

每节末尾标注了取证状态：

| 标注           | 含义                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| **[已验证]**   | 在生产实例 `wss://drc.provid.cc` 或仓库测试里跑过（出处写在该条目里）   |
| **[本次实测]** | 写这份文档时在本机（macOS / Node v22.23.3）跑过的命令，逐条贴了原文输出 |
| **[未实测]**   | 与当前代码一致、但没有任何实例或测试跑过它。照做之前请自己验一遍        |

---

## 1. 生产入口：一个文件

```sh
pnpm build
# → dist/bundle/main.js
```

**没有 npm 安装这条路**：`dsh-remote-server` 这个包名属于另一个无关项目（`bondzhu` /
`MRZHUH/dsh-remote-server`，一个走 SSH 执行命令的工具），本仓 2026-10-03 起明确**不发 npm**。
要装就取 GitHub Release 上那个 `dsh-remote-relay.mjs`（先 `shasum -c SHA256SUMS`），或者自己
`pnpm build`。产物第一行带 `#!/usr/bin/env node`，所以下面 scp 那条也可以写成
`install -m 755 ... && ./relay.mjs`；`node relay.mjs` 同样对。

这条 `build` 做两件事（`package.json`）：`tsc -p tsconfig.json`（类型检查 + `dist/src/**`）
与 `node scripts/bundle-relay.mjs`（esbuild 打成单文件）。

打包结果（事实，出处 `scripts/bundle-relay.mjs`）：

- **`ws` 与协议层全部内联**，端点 `import` 的 `dsh-remote-wire/frames`、`outbound`、`ids`
  都在产物里；只有 `bufferutil` / `utf-8-validate` 这两个**可选**原生加速模块留在外面，缺了照常跑。
- 产物是 ESM，所以头部补了一句真 `createRequire`（内联进来的 CJS 模块有 `require(...)`，
  esbuild 默认会把它们换成运行期抛错的兜底函数）。
- **包版本以 esbuild `define` 注入**成 `__DRC_VERSION__`。为什么必须注入而不是运行时读
  `package.json`：生产部署就是"scp 一个 `main.js` 到 `/opt/.../server/`"，文件旁边没有
  `package.json`，靠文件探针读版本的两条相对路径都会落空，`/healthz` 的 `version` 静默退化成
  `0.0.0` —— 而运维恰恰靠这个字段判断线上跑的是哪一版。

于是部署退化成**拷一个文件 + 一个 env 文件**：

```sh
scp dist/bundle/main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
scp deploy/systemd/dsh-remote-control.service root@HOST:/etc/systemd/system/
```

不需要 `npm install`、不需要 `node_modules`，也就没有"服务器上的依赖树和 CI 不一样"这一类故障。
这三条断言（空目录能起、`/healthz` 的 `version` 必须等于包版本、SIGTERM 必须 exit 0）由
`tests/bundle.test.mjs` 锁住，CI 的 `relay-smoke` 作业在 **Node 20** 上从空目录真起一次
（`.github/workflows/ci.yml`）。 **[已验证]**

产物里不含任何密码学实现（`xsalsa20` / `secretbox` / `tweetnacl` 都搜不到）——同一份测试断言它，
这是"结构性零知识"的机械防线：中继不是"不去解密"，是**没有可解密的代码**。 **[已验证]**

> Node 要求：`engines.node >= 20`（产物 target `node20`）。生产实例是 Alibaba Cloud Linux 4
> 自带的 Node 22。 **[已验证]**

---

## 2. 环境变量

权威来源是 `src/config.ts`，逐条抄自代码。**没有 `DRC_HOST_TOKEN` 服务拒绝启动**
（stderr 打 `[drc-relay] error: DRC_HOST_TOKEN is required (...)`，exit 1）。

| 变量                          | 必填 | 默认                | 单位   | 说明                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ---- | ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DRC_HOST_TOKEN`              | ✅   | —                   | —      | host 出站认证凭据。`openssl rand -hex 32` 生成；短于 24 字符只告警不阻止。**与主机插件那一份必须逐字一致**                                                                                                                                                                               |
| `DRC_PORT`                    |      | `8787`              | 端口号 | 监听端口。`0` 合法 = 让系统分配（测试与容器发布端口用）。越界（非 0-65535 整数）直接拒绝启动                                                                                                                                                                                             |
| `DRC_BIND`                    |      | `127.0.0.1`         | IP     | 绑定地址。默认只绑回环：TLS 由反代终止，中继没理由出现在局域网里。**只有自己就是边缘（容器直接发布端口、无同机反代）时才设 `0.0.0.0`**                                                                                                                                                   |
| `DRC_PUBLIC_URL`              |      | **空字符串**        | URL    | `/api/info` 返回的对外地址。公网填 `wss://你的域名`                                                                                                                                                                                                                                      |
| `DRC_PAIR_TTL_MS`             |      | `120000`            | 毫秒   | 配对码的**服务端权威**寿命。生产实例实际用 `90000`；建议公网收紧到 60s。主机必须按 `pair-ready.ttlMs` 改写本地过期时间                                                                                                                                                                   |
| `DRC_LOG_LEVEL`               |      | `info`              | 枚举   | `debug` / `info` / `warn` / `error` / `silent`。**区分大小写**，写 `INFO` 会拒绝启动                                                                                                                                                                                                     |
| `DRC_MAX_MSG_BYTES`           |      | `1048576`（1 MiB）  | 字节   | 单帧上限（喂给 `ws` 的 `maxPayload`），超过直接 1009 断开。**不要往小调**：低于 256 KiB 会把大的流式 delta 硬切断，表现是"输出说到一半就重连"（图片附件上线时从 256 KiB 提到 1 MiB）                                                                                                     |
| `DRC_MAX_CONNS`               |      | `200`               | 连接数 | 并发连接上限，超出的新连接立刻 1013 `server_busy`                                                                                                                                                                                                                                        |
| `DRC_MAX_FRAMES_PER_SEC`      |      | `500`               | 帧/秒  | 单连接帧速率（固定窗口，每秒重置）。超限时窗口内回一次 `error{rate_limited}`，**累计 3 次违规** → 1008 断开                                                                                                                                                                              |
| `DRC_HOST_AUTH_MAX_ATTEMPTS`  |      | `5`                 | 次     | 单连接允许的 host 认证失败次数，用尽 → 4001 `too_many_auth_attempts`                                                                                                                                                                                                                     |
| `DRC_PAIR_ATTEMPTS_PER_CONN`  |      | `5`                 | 次     | 单连接允许的配对码错误次数，用尽 → 4008 `too_many_pair_attempts`。**成功一次就清零**                                                                                                                                                                                                     |
| `DRC_PAIR_GLOBAL_PER_SEC`     |      | `20`                | 次/秒  | 全局配对尝试配额。6 位码只有 10⁶ 空间，这一条是唯一的暴力枚举防线                                                                                                                                                                                                                        |
| `DRC_MAX_PENDING_PAIRS`       |      | `1000`              | 条     | 待配对表上限，防无界增长；装满后新码得到 `error{pair_table_full}`（已存在的 token 允许覆盖）                                                                                                                                                                                             |
| `DRC_CONV_IDLE_TTL_MS`        |      | `604800000`（7 天） | 毫秒   | 会话空闲多久后被回收。续用不是无限期                                                                                                                                                                                                                                                     |
| `DRC_CONV_EMPTY_TTL_MS`       |      | `1800000`（30 分）  | 毫秒   | **空会话**回收：最后一个客户端离开后，一条没有任何成员的空会话挂多久被删。与上面那条是两件事——socket 断开（`clientGone`）**不会**起这个表，护的是"小程序退后台再回来不用重扫"（D3）                                                                                                      |
| `DRC_HOST_GRACE_MS`           |      | `120000`（120 秒）  | 毫秒   | 主机 socket 断开后多久才通知客户端"主机已离开"。没有它，一次网络抖动就会让手机丢掉配对                                                                                                                                                                                                   |
| `DRC_SWEEP_MS`                |      | `5000`              | 毫秒   | **表清扫**周期：过期配对码清理、慢消费者判定、host 宽限期到期、会话空闲回收、空会话回收五件事挂在它上面。**保活 ping 不在这里**（见下面两行）；调小只为排错（e2e 用 `1000`）                                                                                                             |
| `DRC_COUNTERS_LOG_MS`         |      | `60000`（60 秒）    | 毫秒   | 把 `/healthz` 那组计数器按周期抄进日志（`msg:"counters"`）。`droppedFrames` 这类是**自启动累计**、进程一换就归零，不抄进日志就没法回答"昨天那段时间丢了多少"                                                                                                                             |
| `DRC_PING_INTERVAL_MS`        |      | `60000`（60 秒）    | 毫秒   | 一条连接两次被 ping 之间的目标间隔。**代价**：静默死掉（无 FIN/RST）的半开对端要约 **2 倍**这个时间才被回收，槽位回收变慢就在这里调小                                                                                                                                                    |
| `DRC_PING_TICK_MS`            |      | `1000`              | 毫秒   | ping 轮转步长，每 tick 只 ping `pingIntervalMs / pingTickMs` 分之一的那一桶。桶数 = 两者的商（默认 60 桶）                                                                                                                                                                               |
| `DRC_MAX_BUFFERED_BYTES`      |      | `1048576`（1 MiB）  | 字节   | 慢消费者阈值：对端发送缓冲区**连续**超限达到**本角色的窗口**才 1008 `slow_consumer` 断开（主机 `DRC_SLOW_CONSUMER_HOST_MS` 10 秒 / 客户端 `DRC_SLOW_CONSUMER_CLIENT_MS` 45 秒），而不是无限堆积把中继内存吃掉。判定由 `DRC_SWEEP_MS` 那一轮**定时驱动**——静默的慢对端同样会被评估        |
| `DRC_SLOW_CONSUMER_HOST_MS`   |      | `10000`（10 秒）    | 毫秒   | **主机**侧慢消费者窗口。窗口短：主机卡住就是所有人卡住，没有"断开即重连"的对端行为要迁就                                                                                                                                                                                                 |
| `DRC_SLOW_CONSUMER_CLIENT_MS` |      | `45000`（45 秒）    | 毫秒   | **客户端**侧慢消费者窗口。**必须大于对端自己的重连周期**（小程序 `CONNECT_TIMEOUT_MS` 12s + `RECONNECT_MAX_MS` 30s + 抖动 ≈ 42.5s → 取 45s）：窗口落进周期内，手机每次刚回来就又被踢，会形成永不升级的 ~11s 重连循环（`tests/limits.test.mjs` 直接读对端源码的常量锁这条）。调小只为测试 |
| `DRC_PAIR_STATUS`             |      | 关闭                | —      | 设为 `1` **或** `true` 才启用 `/api/pair-status`（默认关闭，见下）                                                                                                                                                                                                                       |
| `DRC_PAIR_STATUS_PER_SEC`     |      | `5`                 | 次/秒  | `/api/pair-status` 的配额（只在上面那条开启时生效）。这是一条**无认证**的"这个 6 位码在不在"判定接口，10⁶ 的码空间不设配额就是一台免费枚举机；超配额回 `429` 并记 `pair-status budget exhausted`。真正的边界仍应由反代限流兜住                                                           |
| `DRC_STATE_FILE`              |      | 空（关闭）          | 路径   | 会话表落盘路径。**默认关闭 = 纯内存模式**（与 1.0.6 之前逐字一致，重启丢配对）。标准生产值 `DRC_STATE_FILE=/var/lib/dsh-remote-control/state.json`；相对路径按进程 cwd 解析，systemd 下就是单元的 `WorkingDirectory`                                                                     |
| `DRC_STATE_SAVE_MS`           |      | `60000`（60 秒）    | 毫秒   | 周期性补写状态文件的间隔，只为刷新 `lastActivityAt`（它每帧都在变，跟着写就是每帧一次 fsync）。结构性变更（建会话/删会话）本来就会立刻落盘，不靠这一条                                                                                                                                   |

数值型变量走同一条校验（`integer()`）：**必须是正整数**，`0`、负数、`abc`、小数一律拒绝启动
（`DRC_PORT` 例外，`0` 合法）。这是相对最初实现的行为变化：旧代码是 `Number(env.X || 默认)`，
写坏了静默退回默认值；现在 env 文件里的一个拼写错误会让服务**根本起不来**（`[drc-relay] error:
DRC_XXX 必须是正整数，收到 "..."`）。无值守场景里这是好事，但要知道它现在会响。 **[已验证]**

### 2.1 三个变量改名了（迁移风险）

默认值逐项继承旧值，但下面三个**换了名字**。旧名字在新代码里**没有任何读取点**：
写了不报错、不告警、不生效——**静默按新默认值跑**。这是迁移最容易漏的一条：
你以为把上限收紧了，其实它回到了默认值，而且日志里一个字都不会提。

| 旧名                            | 新名                         | 默认值 | 含义没变的部分                      |
| ------------------------------- | ---------------------------- | ------ | ----------------------------------- |
| `DRC_MAX_AUTH_ATTEMPTS`         | `DRC_HOST_AUTH_MAX_ATTEMPTS` | `5`    | 单连接 host 认证失败次数，用尽 4001 |
| `DRC_MAX_PAIR_ATTEMPTS`         | `DRC_PAIR_ATTEMPTS_PER_CONN` | `5`    | 单连接配对码错误次数，用尽 4008     |
| `DRC_MAX_PAIR_ATTEMPTS_PER_SEC` | `DRC_PAIR_GLOBAL_PER_SEC`    | `20`   | 全局配对尝试配额（每秒）            |

迁移检查（把服务器 env 文件里的旧名揪出来，只读不改）：

```sh
grep -nE 'DRC_(MAX_AUTH_ATTEMPTS|MAX_PAIR_ATTEMPTS|MAX_PAIR_ATTEMPTS_PER_SEC)\b' /etc/dsh-remote-control.env
```

命中就得改名，然后 `systemctl restart dsh-remote-control`。

### 2.2 另外两处默认值/语义变化

| 项                     | 旧                      | 新           | 影响                                                                                   |
| ---------------------- | ----------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `DRC_PUBLIC_URL` 默认  | `ws://127.0.0.1:<port>` | `''`（空）   | `/api/info` 现在返回 `{"publicUrl":"","protocol":1}`。想让端点读到地址就**必须显式设** |
| `DRC_LOG_LEVEL` 大小写 | `.toLowerCase()` 后接受 | 精确匹配枚举 | `INFO` / `Warn` 之类现在拒绝启动                                                       |

`DRC_PAIR_STATUS` 是放宽：`1` 与 `true` 都算开。

### 2.3 关于 `/api/pair-status`

**默认 404。** 它是一个无需认证、直接回答「配对码 N 是否有效」的接口，等于给 6 位码空间
装了个现成的扫描 oracle。小程序客户端并不用它（配对走 `pair-begin-client`），所以默认关闭；
确需调试时设 `DRC_PAIR_STATUS=1`，**用完关掉**。这条默认值有测试锁住
（`tests/relay.test.mjs`）。 **[已验证]**

---

## 3. 直接跑（本地）

推荐用仓库里的脚本，它把 token 从本机 DSH profile 的 patch 里读出来（主机插件与中继必须同一份
凭据，手工同步两次就会有一边改了另一边没改，表现是"永远 `bad_token`"）：

```sh
./scripts/relay-start.sh              # 127.0.0.1:8787，跑 tsc 产物 dist/src/main.js
DRC_PORT=9000 ./scripts/relay-start.sh
./scripts/relay-start.sh --bundle     # 跑单文件产物，与生产形态完全一致
```

脚本行为（照 `scripts/relay-start.sh` 的实现）：优先用环境变量 `DRC_HOST_TOKEN`，没有才从
`${DSH_PROFILE:-~/.dsh/profiles/desktop}/cordis.patch.yml` 里抓 `hostToken:` 那一行（只打印前
4 位，完整值不外泄）；两处都没有就报错退出，不会起来一个"没人能连上"的进程。缺产物时提示先跑
`pnpm build`。它固定导出 `DRC_BIND=127.0.0.1`、`DRC_LOG_LEVEL=debug`、`DRC_PAIR_TTL_MS=120000`
（都可被同名环境变量覆盖）。

`--bundle` 与默认的差别只在**跑哪个产物**：`dist/src/main.js` 那一份还需要 `node_modules`
才能解析 `dsh-remote-wire`（只在开发工作区里跑得起来，仓库内的单测也用它）；
`dist/bundle/main.js` 才是生产形态。 **[已验证：脚本源码 + `tests/bundle.test.mjs`]**

手工起（不依赖脚本）：

```sh
DRC_HOST_TOKEN=$(openssl rand -hex 32) DRC_PORT=8787 node dist/bundle/main.js
```

验证（输出是**本次实测**的原文，取自一个 `DRC_PORT=0` 的产物实例；命令按 8787 写，字段一致）：

```sh
curl -s http://127.0.0.1:8787/healthz
# {"ok":true,"version":"2.0.15","uptimeSec":4,"hosts":1,"clients":0,"conversations":1,"pendingPairs":0,"droppedFrames":0,"slowConsumers":0,"rejectedPairs":0,"shutdownForced":0,"persistence":"on","stateRestored":1,"stateSavedAtSec":4,"stateWrites":12,"stateWriteFailures":0,"lastPingAgo":1,"shuttingDown":false}
curl -s http://127.0.0.1:8787/api/info
# {"publicUrl":"","protocol":1}
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8787/api/pair-status?token=123456'
# 404
```

拷到空目录里起（证明它真的自包含）：

```sh
mkdir -p /tmp/drc-smoke && cp dist/bundle/main.js /tmp/drc-smoke/relay.mjs
cd /tmp/drc-smoke
DRC_HOST_TOKEN=smoke-token-0123456789abcdef DRC_PORT=0 node relay.mjs
# {"ts":"...","level":"info","msg":"relay listening","port":65258,"bind":"127.0.0.1","publicUrl":"","version":"1.0.6"}
```

`DRC_PORT=0` 时系统分配端口，真实端口就在上面这行启动日志的 `port` 字段里（别猜端口）。
`Ctrl-C`（SIGINT）或 `kill -TERM` 停机，退出码 0。 **[本次实测]**

---

## 4. `/healthz` 与运维契约

```sh
curl -s http://127.0.0.1:8787/healthz
```

| 字段                 | 类型   | 是否运维契约 | 含义                                                                                                                                                                                                |
| -------------------- | ------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                 | bool   | ✅ **契约**  | `!shuttingDown`。停机中变 `false`                                                                                                                                                                   |
| `version`            | string | ✅ **契约**  | 包版本。**必须是真实版本号，出现 `0.0.0` 说明部署的不是打包产物**（define 没进去）——`tests/bundle.test.mjs` 与 CI `relay-smoke` 都断言它等于包版本                                                  |
| `uptimeSec`          | number | ✅ 契约      | 进程已运行秒数                                                                                                                                                                                      |
| `hosts`              | number | ✅ 契约      | 当前在册主机数                                                                                                                                                                                      |
| `clients`            | number | ✅ 契约      | 当前在册客户端数                                                                                                                                                                                    |
| `conversations`      | number | ✅ 契约      | 活跃会话（配对通道）数                                                                                                                                                                              |
| `pendingPairs`       | number | ✅ 契约      | 待配对表条数。**注意**：已用过的码在 TTL 窗口内仍留在表里（为的是给出 `already_used` 而不是 `invalid_or_expired`），所以这个数会短暂高于你的直觉                                                    |
| `droppedFrames`      | number | ✅ 契约      | 累计：中继**收下但没有收件人**的帧数（会话还在、主机不在或没有观众）。**不含**被拒的路由（`unknown_session`/`not_member` 会回错误给发送方，不是静默丢弃）；慢消费者另有 `slowConsumers`（只增不减） |
| `slowConsumers`      | number | ✅ 契约      | 累计：被以 1008 `slow_consumer` 断开的对端数（只增不减）                                                                                                                                            |
| `rejectedPairs`      | number | ✅ 契约      | 累计：被拒的配对请求数（只增不减）                                                                                                                                                                  |
| `persistence`        | string | ✅ 契约      | 落盘开关：`on` = 配了 `DRC_STATE_FILE`，`off` = 纯内存模式。**刻意不暴露文件路径**（`/healthz` 公网可达，绝对路径对探测者有用、对排障没用）                                                         |
| `stateRestored`      | number | ✅ 契约      | 启动时从状态文件恢复的会话数（`off` 时恒 0）                                                                                                                                                        |
| `stateSavedAtSec`    | number | ✅ 契约      | **秒**。距上一次成功写盘多久；`-1` = 本进程还没写过盘                                                                                                                                               |
| `stateWrites`        | number | ✅ 契约      | 累计：本进程成功写盘次数（只增不减）                                                                                                                                                                |
| `stateWriteFailures` | number | ✅ 契约      | 累计：本进程写盘失败次数（只增不减，写失败只记日志不致命）                                                                                                                                          |
| `lastPingAgo`        | number | ✅ 契约      | **秒**。距上一次保活 ping 扫描多久；`-1` = 还没扫过。单位是秒不是毫秒，看指标时别按 ms 判                                                                                                           |
| `shutdownForced`     | number | ✅ 契约      | 累计：5 秒兜底强退的次数。**注意它结构上永远读到 0**（加一之后紧接着就是 `exit(0)`，没人来得及 curl）——要分辨"排空 vs 强退"请看 §9.1 的那两行 warn 日志                                             |
| `shuttingDown`       | bool   | ✅ 契约      | 收到 SIGTERM/SIGINT 后置位                                                                                                                                                                          |
| `protocolSelf`       | number | ✅ 契约      | 本中继实现的协议版本（= `PROTOCOL_VERSION`）。收到超出 `[protocolMin, protocolSelf]` 的 `hello` 会被拒（`unsupported_protocol`）                                                                    |
| `protocolMin`        | number | ✅ 契约      | 本中继能接受的**最低**对端协议版本。低于它按"太旧"拒；**等于 1** 时表示任何现存版本都能连（加性演进）                                                                                               |
| `peerProtocolMin`    | number | ✅ 契约      | 当前已连上对端报的**最小**协议版本；`-1` = 现在没有对端。**这一项是排查"某个客户端连不上"的第一站**                                                                                                 |
| `peerProtocolMax`    | number | ✅ 契约      | 当前已连上对端报的**最大**协议版本；`-1` = 现在没有对端。出现比 `protocolSelf` 更大的值说明有对端在说本中继听不懂的版本（那一次握手就会被拒，所以它不该出现在这里）                                 |
| `peersNoProtocol`    | number | ✅ 契约      | 已连上但**没报**协议版本的对端数（规范 V1 的老端点，例如旧版本小程序）。它们**照常放行**——这个数只是观测，不是错误                                                                                  |

这 23 个字段就是运维契约；前三类是**瞬时快照**（会上下浮动），`droppedFrames`/`slowConsumers`/
`rejectedPairs`/`shutdownForced`/`stateWrites`/`stateWriteFailures` 是**累计计数**（只增不减），混在一起会让"手机不更新"这类排查分不清
"现在是空的"和"一直送不出去"。 **[已验证：`curl` 实测响应 + 代码 `health()`]**

> **协议版本那五项为什么要有**（2026-10-07）：`hello.protocol` 这个字段从第一天就在线上，
> 而**在此之前没有任何一端校验过它**——中继照常回 `hello-ok`，两端都不看。
> 于是协议不兼容的现场表现是"连上了、界面正常、什么都不发生"，没有一层会报错。
> 现在中继在 `handleFrame` 最前面设了闸（判定委托协议层的 `negotiateProtocol`，
> 中继自己不写版本区间），并在 `/healthz` 报出对端的版本跨度。
>
> `peersNoProtocol` 值得单独说一句：它**不是**故障。规范 V1 规定"对端不报就按 1 处理"，
> 而今天的小程序恒发 1；一个只接老版本的真机环境里这个数会长期大于 0，
> 属正常。它与 `peerProtocolMin` 分开报，正是为了让人能区分"老版本"与"版本对不上"。

> 本节此前写作"八个字段"并断言 `lastPingAgo`/`droppedFrames`/`slowConsumers` **不存在**——
> 那是在 C0 压测装置拿这三类字段做过采样之后被推翻的：响应里一直都有，
> 而且 `tests/relay.test.mjs` 早就在读 `droppedFrames`/`slowConsumers`/`rejectedPairs`。
> 告警可以写在它们身上。

`/healthz`、`/api/info`、`/api/pair-status` 之外的路径一律 404 + `{"error":"not_found"}`。

`ok` 适合做存活探针，但要清楚：停机时 `http.close()` 会**立刻关掉监听套接字**，
探针更常见的表现是连不上（ECONNREFUSED），而不是拿到一个 `ok:false` 的响应
（`shuttingDown:true` 只在已经建立的连接上读得到）。按"连不上=正在重启"来写探针。 **[未实测]**

### 4.1 容量基线（实测：挂着不动的连接）

`scripts/loadtest-conns.mjs` 起一个本地中继（跑的就是上面那个单文件产物），开 N 条
只走完 `hello`/`hello-ok` 然后不发任何业务帧的 ws，每 5 s 从**进程外部**采一轮：

```sh
pnpm build
node scripts/loadtest-conns.mjs --n=10000 --seconds=30
# CSV 与中继日志落在 data/loadtest/（已 gitignore）
```

2026-10-03 在 macOS / node v22.23.3 / 8 逻辑核 / 16 GB 上实测（空载 RSS ≈ 57 MB）：

| N（连接数） | 建连用时 | RSS/连接  | fd/连接 | ping 帧/秒 | 出站（WS 帧层） | `/healthz` p50 | 单轮最长阻塞 | 平均 CPU     |
| ----------- | -------- | --------- | ------- | ---------- | --------------- | -------------- | ------------ | ------------ |
| 1 000       | 0.1 s    | **11 KB** | 1       | 197        | 0.78 KB/s       | 1 ms           | 6 ms         | ≈0.01 核     |
| 5 000       | 0.4 s    | **8 KB**  | 1       | 985        | 2.0 KB/s        | 1 ms           | 41 ms        | 0.02 核      |
| 10 000      | 0.7 s    | **7 KB**  | 1       | 1 960      | 3.9 KB/s        | 1 ms           | **96 ms**    | 0.02–0.07 核 |

读这几行时要带着的四条边界：

1. **"单轮最长阻塞"是 sweep 的代价，用 `/healthz` 应答延迟做代理**——sweep 里那两次全表遍历
   是同步的，它跑多久 HTTP 应答就被堵多久。10k 时探针看到过 96 ms 的停顿（p50 仍是 1 ms，
   也就是"每 5 s 堵一下"而不是"一直慢"）。**这一项随 N 近似线性**（6 → 41 → 96 ms）。
2. **带宽在这里量不出来**。所有连接走 loopback：没有以太网成帧、MTU 16 384，
   所以数出来的是 **WS 帧层的 2 B/ping**（服务端→客户端的 ping 不掩码、无载荷）。
   真链路上每条 ping 还要吃 ~42 B 的 IP+TCP 头，外加对端一个 ~54–64 B 的 ACK，
   于是 10k/5 s ≈ 2 000 次/秒 ≈ **下行 0.67 Mbps、上下行合计约 1.7 Mbps 的纯保活开销**——
   这句是**解析式，不是实测**，换到真实网卡上必须重测。
3. **ping 是"一轮全表一次打完"的**：10 000 个 ping 帧整整齐齐落在同一个 5.1 s 窗口里。
   这就是把心跳分桶的动机——不是省字节，是**别把 2 000 次写挤在同一瞬间**。
4. **这批数只覆盖"挂着不动"**。业务帧路径（`JSON.parse` + zod 校验 + 成员判定 + 路由 +
   fanout）一条都没走，所以 `DRC_MAX_FRAMES_PER_SEC` 与全局预算那类阈值
   **不能从这张表推**，得另做一轮带流量的测量。

**拆心跳分桶（C1）前后的同一档对比**——10k 连接、同一台机器、同一份产物：

| 指标                       | 全表每 5 s ping 一次 | 分桶后（60 s / 1 s） |
| -------------------------- | -------------------- | -------------------- |
| ping 帧/秒（合计）         | 1 960                | **167**              |
| 单个 5 s 窗口里的 ping 数  | 10 000（全表一起发） | ≈833（摊到 60 个桶） |
| `/healthz` p50 / p95 / max | 1 / 41 / **96 ms**   | 1 / 5 / **7 ms**     |
| 出站（WS 帧层）            | 3.9 KB/s             | 0.33 KB/s            |
| 平均 CPU                   | 0.02–0.07 核         | 0.02 核              |

**真正被治住的是第 3 行**：sweep 里那一次全表 ping 会把事件循环堵到 96 ms，
期间所有在途的流式帧都得排队；分桶之后最坏 7 ms。省下的带宽（第 1、4 行）是顺带的。

**这条改动买到的东西要付钱**：判活从"最坏 2×`sweepMs`（10 s）"变成
"最坏约 2×`pingIntervalMs`（默认 121 s）"。半开对端（没有 FIN/RST 的那种）
占着 `DRC_MAX_CONNS` 的槽位会占到这个时长；在意就把 `DRC_PING_INTERVAL_MS` 调小。
`tests/heartbeat.test.mjs` 的第 4 条把这两个界都钉住了——它同时防"悄悄退化"和"悄悄改掉"。

对照生产默认值：`DRC_MAX_CONNS=200` 时按 7–11 KB/连接算，路由表本身只占约 1.4–2.2 MB——
**内存不是这个中继的约束项**。那个默认卡的是"单进程 2 vCPU 上的转发算力"，不是内存。

---

## 5. 日志

**一行一个 JSON**（NDJSON），字段固定 `{ts, level, msg, ...}`，写到 stdout，
由 journald / launchd / Docker 负责收集与轮转。中继刻意不引 pino（`src/log.ts` 的注释记录了
实测理由：pino 默认起 `thread-stream` 工作线程、生产依赖闭包 13 个包）。

等级权重（`src/config.ts`）：`debug=10` `info=20` `warn=30` `error=40` `silent=99`。
一条日志**只有权重大于等于阈值才写出**，所以 `DRC_LOG_LEVEL=warn` 时你看不见 `info` 行
（`paired`、`host online` 这些都会消失，只剩告警）。被级别过滤掉的行**根本不会被构造**，
不是"生成了再丢掉"。

**`level` 与 `msg` 是运维契约**：`msg` 是稳定的英文字面量（告警规则、`journalctl` 的 grep、
日志管道的字段解析都靠它），不要按人话去改写它。字段的值只允许 `string | number | boolean`
（类型层面兜住，编译器不允许把载荷对象、会话标题或模型输出塞进日志行），
`tests/hardening.test.mjs` 还有一条断言：日志行里出现业务明文或长 base64 串即为失败。 **[已验证]**

```json
{"ts":"2026-10-02T08:55:58.511Z","level":"info","msg":"relay listening","port":65258,"bind":"127.0.0.1","publicUrl":"","version":"1.0.6"}
{"ts":"2026-10-02T08:56:50.016Z","level":"info","msg":"shutting down","signal":"SIGTERM"}
{"ts":"...","level":"warn","msg":"host auth failed","attempts":1}
{"ts":"...","level":"info","msg":"paired","sessionId":"c_9f3c…","hostId":"desktop-1","clientId":"wx-1"}
```

### 5.1 值得盯的行

| `msg`                                                                    | `level`  | 含义 / 该怎么反应                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay listening`                                                        | info     | 启动成功。`port`/`bind`/`version` 三个字段就是"线上到底是哪版、在听哪个地址"的答案                                                                                                                                                          |
| `host auth failed`                                                       | warn     | 有端点拿错 token 在试。**同一连接连续 5 次会 4001 断开，但断开这一步没有独立的告警行**——只有 `attempts` 一路涨到 5 然后连接消失。看到 `attempts:4` 就该怀疑 token 漂移                                                                      |
| `frame flood disconnected`                                               | warn     | 单连接帧速率违规累计 3 次，已 1008 断开                                                                                                                                                                                                     |
| `pair budget exhausted (global)`                                         | warn     | **全局配对配额打满**（`DRC_PAIR_GLOBAL_PER_SEC`）。字段里的 `reason:"rate_limited"` 是我们的真实原因，见 §5.2                                                                                                                               |
| `pair-status budget exhausted`                                           | warn     | `/api/pair-status` 的配额打满（`DRC_PAIR_STATUS_PER_SEC`），该请求已回 **429**。注意到它说明有人在对 6 位码空间做枚举                                                                                                                       |
| `http request failed` / `http client error` / `websocket upgrade failed` | warn     | HTTP 面的畸形请求（含畸形 `Host`、坏请求行）。**只记日志、只回 400/500，进程不受影响**——这三条连同固定 URL base 就是本轮修掉的那个未认证 DoS                                                                                                |
| `pair failed`                                                            | **info** | 配对码错。**这一行是 info 级**，字段 `attemptsLeft` 递减到 0 时该连接被 4008 断开——而断开本身没有 warn 行。只盯 `-p warning` 会漏掉配对码爆破                                                                                               |
| `heartbeat timeout`                                                      | warn     | 对端上一轮 WS 层 ping 没回 pong，已 `terminate()`                                                                                                                                                                                           |
| `slow consumer disconnected`                                             | warn     | 缓冲区**连续**超 `DRC_MAX_BUFFERED_BYTES` 达**本角色的窗口**（主机 `DRC_SLOW_CONSUMER_HOST_MS` 10 秒 / 客户端 `DRC_SLOW_CONSUMER_CLIENT_MS` 45 秒），1008 `slow_consumer` 断开。字段 `buffered` 是当时的字节数                              |
| `pair table full`                                                        | warn     | 待配对表打满（`DRC_MAX_PENDING_PAIRS`）                                                                                                                                                                                                     |
| `enc from non-member`                                                    | warn     | 有非会话成员往某条通道灌密文（拒绝）。可能是抢注，也可能是主机重连后的孤儿 socket                                                                                                                                                           |
| `client replaced by newer socket`                                        | warn     | 同 `clientId` 的旧连接被顶掉。同一台手机反复出现说明它在掉线重连                                                                                                                                                                            |
| `socket error` / `send failed`                                           | warn     | 底层 socket 异常，多数是网络抖动，成串出现才值得查                                                                                                                                                                                          |
| `frame handler threw`                                                    | error    | 处理某一帧时抛异常，已回 `error{internal}`。带 `t` 字段，说明是哪类帧                                                                                                                                                                       |
| `uncaught exception` / `unhandled rejection`                             | error    | 进程随即 **exit 1**，交给 `Restart=always` 拉起                                                                                                                                                                                             |
| `shutting down`                                                          | info     | 收到 SIGTERM/SIGINT。`signal` 字段告诉你来源                                                                                                                                                                                                |
| `shutdown timed out, forcing exit`                                       | warn     | 5 秒没排干净，强退（退出码仍是 0）。偶发无妨，频繁出现说明有连接卡在 draining（2.x 起对端 1.5 秒不关就会被 `terminate()`，所以频繁出现要查是谁不回应关闭握手）。紧跟着的 `shutdown forced` 会补写一次状态文件，并带出 `shutdownForced` 计数 |
| `host offline (grace started)`                                           | info     | 主机 socket 掉了，宽限期 `DRC_HOST_GRACE_MS` 开始计时。**这条不该当告警用**：主机自己会重连                                                                                                                                                 |
| `host grace expired`                                                     | info     | 宽限期到点仍没回来，已向该主机的所有客户端发 `peer-left`。手机上会提示重新配对                                                                                                                                                              |
| `host online` / `client online` / `paired`                               | info     | 正常流水。`paired` 给出 `sessionId`/`hostId`/`clientId` 三元组，是"这台手机连的是这台主机"的唯一权威记录                                                                                                                                    |
| `pair token issued`                                                      | info     | 主机发布了一张码，字段 `token:"<redacted>"`。**info 级不落完整配对码**。要看到真正的码得开 `debug`                                                                                                                                          |
| `conversation voided by host` / `conversations dropped at host resync`   | info     | 主机自己声明某条会话它不再持有密钥，或 `resync` 时没被列出而被删掉                                                                                                                                                                          |
| `conversation idle-dropped`                                              | info     | 空闲超过 `DRC_CONV_IDLE_TTL_MS` 被回收。客户端下次发帧会撞上 `unknown_session`                                                                                                                                                              |
| `conversation empty-dropped`                                             | info     | 最后一个客户端离开后空过 `DRC_CONV_EMPTY_TTL_MS` 被回收。**socket 断开不起这个表**（护 D3 免扫码），只有 `leave`/重新配对摘清成员才起                                                                                                       |
| `pair tokens expired`                                                    | debug    | 清扫周期清掉的过期/已用码条数                                                                                                                                                                                                               |

### 5.2 限速时"线上说法"与"日志说法"不一致（必须知道）

全局配对配额打满时：

- **发给对端的**是 `pair-fail{reason:"invalid_or_expired"}`；
- **日志里**是 `warn pair budget exhausted (global) {reason:"rate_limited"}`。

这不是 bug，是刻意的（冻结消费面）：小程序 `translatePairFail` 只认
`invalid_or_expired` / `already_used` / `host_offline` / `bad_token` 四个 reason，
多一个就会把英文字面量弹到用户脸上。所以内部原因只进日志，线上只说"这张码现在配不上"。

**排查含义**：用户报"码输不进去、提示无效或已过期"，而你在日志里看见
`pair budget exhausted (global)`，那是**限速**（配额或按 IP 的攻击流量），不是码写错了。
反过来，日志里是成串的 `pair failed {reason:"invalid_or_expired"}` 才是真的码不对/过期。
这条有测试锁住（`tests/hardening.test.mjs`）。 **[已验证]**

### 5.3 journald 侧的过滤

`deploy/systemd/dsh-remote-control.service` 用 `StandardOutput=journal` +
`SyslogIdentifier=dsh-remote-control`，所以：

```sh
journalctl -u dsh-remote-control -f                 # 跟流
journalctl -u dsh-remote-control --since -1h | grep '"level":"warn"'
# 摊平成三列看（`fromjson?` 会跳过 stderr 那些非 JSON 行，比如启动失败的那两行）
journalctl -u dsh-remote-control -o cat | jq -Rr 'fromjson? | "\(.ts) \(.level) \(.msg)"'
```

`journalctl -p warning` 是常见的运维入口，但要留个心眼：中继写到 stdout 的 JSON
**不带 `<34>` 这类 syslog 级别前缀**，systemd 也没设 `SyslogLevelPrefix`，因此这些行进
journal 时优先级一律是 `info`(6)。按 `-p warning` 过滤 journald 优先级，很可能一条都出不来
—— 真正可靠的是按 JSON 里的 `level` 字段过滤（上面第二条命令）。这一点**没有在生产实例上
实测过**，只做成了"照代码推断"，落地前请先在目标机上验一次再写进告警规则。 **[未实测]**

---

## 6. 中继重启之后会发生什么

路由表（`hosts` / `clients` / `conversations` / `pendingPairs` 四张表）默认**全在内存、刻意不持久化**：
PSK 与配对关系落盘只会扩大泄露面。**例外**：配了 `DRC_STATE_FILE` 时会话表（`conversations`）
落盘、重启恢复（其余三张表仍在内存；见 CHANGELOG 1.0.6）。因此：

- 重启即清空（**未配落盘时**）：`/healthz` 的四个计数全部归零，旧 `convId` 在新表里不存在。
  配了落盘时恢复出来的会话继续可用，`stateRestored` 即恢复条数。
- 主机与手机都靠各自的退避重连（指数退避 1s→30s 加抖动），**不需要人工干预**。
- 客户端拿旧 `convId` 发帧 → 撞上 `error{code:"unknown_session"}`，中继给手机侧的这条 error
  自带中文（帧里的字面量是 `会话已失效，请重新扫码配对`），手机上显示的是
  **「会话已失效，请重新配对」**，并停在需要输码的界面等你。
- 手机上如果弹出来的是**英文错误码本身**（`bad_token`、`bad_role`、`need_host`、`bad_pair`
  这四个没有中文映射），那是走到了 `message || code` 这条兜底路——说明问题在握手或帧形状上，
  不是"会话没了"。`CLIENT_ERROR_TEXT`（`src/server.ts`）覆盖的十个 code 才有中文。
- 停机过程中：新连接立刻 1013 `server_shutdown`、HTTP upgrade 返回 503，
  已连着的对端收到 `1001 server_shutdown`（客户端会马上重连，而不是等 TCP 超时）。

这条行为有端到端用例锁住：真起中继进程、真发 SIGTERM、真在**同一个端口**起重启后的第二个实例，
然后断言 `error.code === 'unknown_session'`（逐字）、手机进入 `needs-pair`、`convId` 被清空、
新中继 `conversations === 0`、两次停机都 **exit 0**。 **[已验证]**

三种"断开"在运维上要分得清：

| 场景                                               | 会话                                                                                          | 手机端                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **(a) 只有手机断开**（切后台、杀进程、网络抖一下） | **留着**。手机用同一个 `clientId` 重连即自动重新挂上                                          | **不需要重新扫码**。旧实现是"回前台就得重新扫码"，本次重写修掉了这个体验问题 |
| **(b) 中继重启**                                   | 未配落盘时全丢（内存态）；配了 `DRC_STATE_FILE` 时会话表恢复                                  | 中文提示"会话已失效，请重新配对"（仅会话真丢了时）                           |
| **(c) 主机重启**                                   | 主机手里的 PSK 随进程消失，它重连后发 `resync` 声明自己还持有哪些会话，中继据此删掉没被列出的 | 撞 `unknown_session` 或收 `peer-left`，两种都有中文提示。**不许静默黑洞**    |

顺带一条容易误判的：会话还在而主机暂时不在（宽限期内）时，中继回的是
`error{host_unavailable}`（手机显示"主机暂时不在线，请稍后重试"），
**绝不能**是 `unknown_session` —— 后者会让手机丢掉配对。所以"提示重新配对"和"稍后重试"
在手机上就是两句话，别把它们当成同一个故障。

### 6.1 内存态的其它几条运维要点

- **同 `hostId` 重连会顶掉旧连接**：旧 socket 收到自定义关闭码 **4000 `replaced_by_newer_socket`**。
  主机的重连策略靠它区分"我被更新的一个实例顶了"——如果日志里反复出现
  `host online {replaced:1}`，说明有两份主机在抢同一个 `hostId`。
- **主机重连后不会向客户端重放 `peer-joined`**（2026-10-06 删掉了那条重放）：随仓发布的
  mp 客户端 `_onFrame` 里**没有** `peer-joined` 分支（落 `default` 静默忽略），而且那条帧
  当时还把 `hostId` 塞进了 `clientId` 字段。客户端续用旧 `convId` 真正靠的是
  `hello-ok` → `cmd.list_sessions`，与"主机这条 socket 什么时候回来"无关。
- **每个清扫周期（`DRC_SWEEP_MS`）做五件事**：清过期/已用的配对码 → **慢消费者判定**
  （对每个 `OPEN` 连接读 `bufferedAmount`，连续超限达本角色窗口就 1008 断开——它是**定时
  驱动**的，静默的对端同样会被评估）→ 判 host 宽限期是否到期 → 回收空闲超过
  `DRC_CONV_IDLE_TTL_MS` 的会话 → 回收**最后一个客户端离开后**空过
  `DRC_CONV_EMPTY_TTL_MS` 的空会话（`msg:"conversation empty-dropped"`）。
- **保活 ping 不挂在清扫上**：它是独立定时器（步长 `DRC_PING_TICK_MS`，默认 1 秒一轮），
  每轮只 ping 一个桶，桶数 = `DRC_PING_INTERVAL_MS / DRC_PING_TICK_MS`（默认 60 桶），
  于是一条连接两次被 ping 的间隔稳定等于 `DRC_PING_INTERVAL_MS`（默认 60 秒）。
  `alive` 是"上一轮有没有回 pong"的单轮标志，所以半开对端（没有 FIN/RST）要轮到**两次**
  才被发现：最坏判死 ≈ **2×`DRC_PING_INTERVAL_MS`**（默认约 121 秒，**不是** 2×`DRC_SWEEP_MS`）。
  真机上的常规断开走 `close`/`error` 事件，不受这个时间影响；在意槽位回收速度就调小
  `DRC_PING_INTERVAL_MS`。保活**只走 WS 层 ping**（主机与小程序都不发应用层心跳）。
- **每 `DRC_COUNTERS_LOG_MS` 抄一次计数器进日志**（`msg:"counters"`，字段与 `/healthz` 同源，
  由同一个 `health()` 产出）。为什么要有这一条：`droppedFrames` / `slowConsumers` /
  `rejectedPairs` 是**自启动累计**，`/healthz` 只在当前进程里有值，重启即归零；而中继
  **不为每一次丢帧写日志**（那是刷屏，四处计数点里有两处注释就写着"它在日志里不留痕，
  只能靠这个计数被发现"）。两件事加起来，"昨天那段时间丢了多少帧"以前问不出来。
  现在可以直接问 journalctl（差值就是那段时间的增量）：
  ```sh
  journalctl -u dsh-remote-control -o cat --since "24 hours ago" \
    | grep '"msg":"counters"' | tail -5
  ```
  ⚠️ 这一行**不含任何凭据**（有测试钉住：`hostToken` / `token` / `psk` / `secret` 一个都不许出现），
  因为它会长期留在服务器日志里。
- **客户端断开不删会话**，成员表里的 `clientId` 也留着：手机重连时用同一个 `clientId`
  注册即自动重新挂上。真正的回收只由空闲 TTL / 主机宽限期到期 / 主机主动作废三条路触发。
- **反代层还要做的**：按 IP 的连接数与请求速率限制（§7.1）、TLS 终止。中继看不到真实客户端 IP。

---

## 7. HTTPS / WSS 反向代理

中继自己**不终止 TLS**。小程序真机只允许 `wss://`，所以公网部署必须有反代。
仓库里的 `deploy/nginx/drc.conf` 是**正在生产使用的配置**，不是示例，改它之前先读它的注释。 **[已验证]**

拓扑：`drc.example.com --wss--> nginx(TLS) --ws--> 127.0.0.1:8787`。

### 7.1 nginx（生产用的就是这一份）

```sh
scp deploy/nginx/drc.conf root@HOST:/etc/nginx/conf.d/drc.conf
ssh root@HOST 'nginx -t && systemctl enable --now nginx'
```

要点（`deploy/nginx/drc.conf` 逐条对应）：

- **按 IP 限流做在反代**：`limit_req_zone $binary_remote_addr zone=drc:10m rate=20r/s`、
  `limit_conn_zone $binary_remote_addr zone=drc_conn:10m`，location 内
  `limit_req zone=drc burst=40 nodelay` + `limit_conn drc_conn 8`。
  中继只有全局与单连接两级配额，**看不到真实客户端 IP**，所以这一层必须由反代做
  （把爆破概率再压一两个数量级的关键一环）。
- WS 升级三件套 `proxy_http_version 1.1` + `Upgrade`/`Connection $connection_upgrade`
  （`map` 在 http 层，conf.d 正好被 include 在 http 块内，所以这份文件里可以直接写），
  并透传 `Host` / `X-Real-IP` / `X-Forwarded-For` / `X-Forwarded-Proto`。
- 长连接：`proxy_read_timeout 3600s`、`proxy_send_timeout 3600s`、`proxy_buffering off`。
- TLS：`listen 443 ssl` + `http2 on`、`TLSv1.2/1.3`、`ssl_prefer_server_ciphers off`、
  session cache `shared:SSL:10m`/1d、HSTS `max-age=31536000`、`X-Content-Type-Options nosniff`；
  80 端口只做 301 跳转。
- 独立日志：`/var/log/nginx/drc.access.log`、`/var/log/nginx/drc.error.log`。
- `proxy_pass` 写死了 `http://127.0.0.1:8787`：**改了 `DRC_PORT` 就要同时改这里**，
  否则 nginx 200 而中继在别的端口上没人理。

证书（生产用 acme.sh + 阿里云 DNS-01，不需要占用 80 端口）：

```sh
acme.sh --issue --dns dns_ali -d drc.example.com --server letsencrypt
acme.sh --install-cert -d drc.example.com \
  --key-file       /etc/nginx/ssl/drc.example.com.key \
  --fullchain-file /etc/nginx/ssl/drc.example.com.crt \
  --reloadcmd      "systemctl reload nginx"
```

路径要与 `drc.conf` 里的 `ssl_certificate*` 对上。 **[已验证：`deploy/README.md`]**

### 7.2 Caddy（最省事，但本仓库没用过）

```caddyfile
drc.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

自动签发证书，WebSocket 升级透明转发。客户端用 `wss://drc.example.com`，
并设 `DRC_PUBLIC_URL=wss://drc.example.com`。 **[未实测]**

### 7.3 然后

```sh
DRC_PUBLIC_URL=wss://你的域名      # env 文件里，改完 restart
curl -s https://你的域名/api/info  # 应当回显这个地址
```

别忘了客户端侧：域名必须加进微信后台的 **socket 合法域名**白名单，否则真机连不上。

---

## 8. 常驻

### 8.1 systemd（Linux，生产用的就是这一份）

`deploy/systemd/dsh-remote-control.service` 的关键行：

```ini
WorkingDirectory=/opt/dsh-remote-control/server
EnvironmentFile=/etc/dsh-remote-control.env
ExecStart=/usr/bin/node /opt/dsh-remote-control/server/relay.mjs
Restart=always
RestartSec=3
TimeoutStopSec=15
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dsh-remote-control
```

注意 `ExecStart` 是**绝对路径指向那一个文件**——单元旁边没有 `node_modules`，也不需要有。
单元里**没有** `DRC_BIND`，所以走代码默认 `127.0.0.1:8787`。
沙箱：`NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=strict` + `ReadWritePaths=/opt/dsh-remote-control`、
`ProtectHome`、`ProtectKernelTunables/Modules/ControlGroups`、
`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`、`MemoryMax=512M`。
**换部署目录时 `ReadWritePaths` 要一起改**。 `TimeoutStopSec=15` 是刻意留的余量：代码自己
5 秒兜底强退，systemd 不该比它先动手。 **[已验证：`deploy/systemd/dsh-remote-control.service`]**

```sh
# 本机：把单元与产物推上去
scp dist/bundle/main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
scp deploy/systemd/dsh-remote-control.service root@HOST:/etc/systemd/system/

# 服务器上（或由本机 ssh 执行）
systemctl daemon-reload
systemctl enable --now dsh-remote-control
systemctl status dsh-remote-control
journalctl -u dsh-remote-control -f
```

env 文件（与主机插件那份 token 必须逐字一致）：

```sh
cat > /etc/dsh-remote-control.env <<'EOF'
DRC_HOST_TOKEN=<openssl rand -hex 32 的输出>
DRC_PORT=8787
DRC_PUBLIC_URL=wss://drc.example.com
DRC_PAIR_TTL_MS=90000
DRC_LOG_LEVEL=info
EOF
chmod 600 /etc/dsh-remote-control.env
systemctl restart dsh-remote-control
```

### 8.2 launchd（macOS）

launchd 没有 `EnvironmentFile`，凭据得写在 plist 或包装脚本里。把产物放在固定路径
（`node` 那行换成 `which node` 的实际路径，Apple Silicon 上通常是
`/opt/homebrew/bin/node`），然后 `~/Library/LaunchAgents/com.dsh.remote-control.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.remote-control</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/dsh-remote-control/relay.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DRC_PORT</key><string>8787</string>
    <key>DRC_PUBLIC_URL</key><string>wss://drc.example.com</string>
    <key>DRC_HOST_TOKEN</key><string>REPLACE_ME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/dsh-rc-relay.log</string>
  <key>StandardErrorPath</key><string>/tmp/dsh-rc-relay.err</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.dsh.remote-control.plist
```

常驻退化成"一个文件、一条命令、没有依赖安装步骤"。 **[未实测]**

### 8.3 Docker（生产用的就是这一份）

仓库里**有** Dockerfile 与 compose：`deploy/docker/`。形态与裸机 systemd **同形**——
同一个单文件产物、同一套 `DRC_*`、同一个 `/healthz`；变的只有「谁负责把它拉起来」。

完整步骤、镜像源受限时的三条路、切回 systemd 的步骤，都在
[`../deploy/docker/README.md`](../deploy/docker/README.md)。这里只写三件**必须自己记住**的事：

| 项           | 值                                         | 不这么做会怎样                                                                                                                                                 |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DRC_BIND`   | 镜像里已经是 `0.0.0.0`，compose 里显式写死 | 容器内绑 `127.0.0.1` → `-p` 发布成功但**外面连不上**                                                                                                           |
| 端口发布     | `127.0.0.1:8787:8787`（只到回环）          | 绑 `0.0.0.0:8787` → 8787 直接暴露公网，绕过 nginx 的按 IP 限流                                                                                                 |
| `/data` 属主 | `10001:10001`                              | 状态写不进去。**2.x 起启动那一刻就会记一条 `state file is not writable` 的 error**；1.x 时代只能等每 60 秒一条的 `state file write failed`，而配对表面完全正常 |

第三条是容器化给 §0.1 那个老坑**新增的一个成因**（忘了挂卷、属主不对）。
默认用具名卷就是为了绕开它：Docker 用镜像里 `/data` 的属主初始化具名卷，于是
`docker compose up` 开箱即用。生产为了落在 `/var/lib` 下改用宿主机路径，那就得 chown。

**nginx 一行都不用改**：端口只发布到宿主机回环，`/etc/nginx/conf.d/drc.conf` 的
`proxy_pass http://127.0.0.1:8787` 原样继续工作，TLS 仍由 nginx 终止。
换 systemd 与换容器**别同时开**（同一个端口只能有一个进程在听）。

## 9. 优雅停机与暴露面

`SIGTERM` / `SIGINT` 之后（`src/main.ts` + `server.close()`）：

1. 置 `shuttingDown`：新 WebSocket 连接直接 1013 `server_shutdown`，HTTP upgrade 回 503；
2. 停止清扫定时器；
3. 给所有已连接 socket 发 `1001 server_shutdown`，然后**等对端走完关闭握手**，
   最多 1.5 秒（`DRAIN_MS`）；仍未走的直接 `terminate()`。
4. 关闭 HTTP 监听，等它的 `close` 回调 → **exit 0**；5 秒没走完就强退，**仍是 exit 0**。

第 3 条那 1.5 秒不是锦上添花（2026-10-07 补）。**升级过的 WebSocket socket 由对端决定何时
消失**：手机进电梯、切 4G、主机休眠时它既不发 FIN 也不回关闭帧，于是 `http.close()` 的回调
**永不触发**，每一次这样的停机都走满 5 秒兜底。反过来，空闲的 keep-alive **HTTP** 连接**不阻塞**
`close()`（Node ≥19 自己关）——所以"被拖住"的只有 WS 侧，这也解释了为什么改造前它只在有手机
连着的时候出现。兜底 `terminate()` 之后，TCP 层直接断、状态随之收敛。

顺带修好一句**名不副实的注释**："排空之后再写一次盘"。旧写法里那次写盘发生在
`http.close()` 的回调里，而那与 ws 的 `close` 回调谁先跑取决于 Node 内部的监听器注册序——
多数时候成立、偶尔不成立。现在 `drain()` 保证所有 close 回调都跑完再写。

未捕获异常（`uncaughtException` 事件）与未处理的 rejection 走另一条路：记一行 error 日志后
**exit 1**，把重启交给 `Restart=always` / `restart: unless-stopped`——无值守进程里"活着但坏了"
比"死了被拉起来"更糟。 **[已验证：`tests/hardening.test.mjs` 断言对端收到 1001 且进程 exit 0；
`tests/bundle.test.mjs` 断言产物 SIGTERM exit 0]**

### 9.1 `/healthz` 的停机语义与 `shutdownForced` 的真相

**停机中 `/healthz` 回 503**（2026-10-07 改）。改造前无论 `ok` 是 true 还是 false 都回 200，
于是任何只看状态码的观测面（Docker HEALTHCHECK、负载均衡器、k8s probe、`curl --fail`）
都会在**正在关闭**的进程上读到 200，继续往一个不再接受 upgrade 的实例上送流量。
状态码本来就是这件事的表达方式；`ok` 字段留给人去读。

**`shutdownForced` 这个字段结构上永远是 0**，请不要拿它当判据（2026-10-07 订正）。
它只在 `forceShutdown()` 里加一，而那个函数紧接着就是 `process.exit(0)`——没人来得及 curl。
真正能事后分辨"排空成功 vs 强退"的出口是**那两行日志**：

```
{"msg":"shutdown timed out, forcing exit","level":"warn"}
{"msg":"shutdown forced","level":"warn","shutdownForced":1}
```

告警规则应当基于这两行，不是基于 `/healthz`。

暴露面：

- 只需要放行 **一个端口**（默认 8787），而且它应当**只对回环开放**：公网走 443。
  生产安全组只放 `22 / 80 / 443`，8787 不对公网。 **[已验证：`deploy/README.md`]**
- 同一个端口上既有 HTTP（`/healthz`、`/api/info`；`/api/pair-status` 默认 404）也有 WebSocket
  （**路径不设限**，根路径与 `/ws` 之类都能升级——收窄会把已发布的地址全部弄断）。
- 把 `/healthz` 暴露到公网是安全的（只有计数），但 `/api/info` 会泄露对外地址，无所谓就别单独暴露。
- **不要**把明文 `ws://` 直挂公网就跑：小程序真机不允许，而且配对码与密文在链路上可见。

---

## 10. 升级与回滚

### 10.1 升级（三条命令）

```sh
pnpm build
scp dist/bundle/main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
ssh root@HOST 'systemctl restart dsh-remote-control'
curl -s https://drc.example.com/healthz       # version 必须是新版本，不是 0.0.0
```

`relay.mjs` 旁边没有 `package.json`，也没有 `node_modules`：**升级就是替换一个文件**。
未配 `DRC_STATE_FILE` 落盘时重启会丢掉全部配对关系（§6），所以挑一个没人正在用手机的时刻；主机与手机会各自重连回来。

### 10.2 回滚必须**成对**：中继产物 + 主机插件产物

**不能只回滚中继一边**，因为两侧握手是双向不兼容的（帧名与 `psk` 字段在两代之间都动过）：

| 组合             | 结果                                                           | 为什么                                                                                                                        |
| ---------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 新 host + 旧中继 | **配对永远不成功**                                             | 新 host 发的 `pair-begin` **不带 `psk`**（PSK 从不上网），旧中继要求 `psk` 字段，缺了即 `error{bad_pair}`                     |
| 旧 host + 新中继 | **静默不上线**：插件的 `relay` 一直停在 `connecting`，也不报错 | 握手那一帧在新一代换了名字，新中继的判别联合里没有旧帧名 → 回 `error{unknown_frame}` → 旧插件把它丢掉，于是永远等不到注册成功 |

关于"zod 默认 strip 多余字段"要说准：它只保证**字段级**的向前兼容——旧 host 的
`pair-begin{psk}` 确实能被新中继解析（多余的 `psk` 键被剥掉，不报错）。但它救不了
**帧名级**的断掉：握手那一帧换了名字，所以"旧 host + 新中继 兼容"在实践中不成立。
这一条是读代码 + 复核记录得出的，**没有真的把旧产物起来做过双向对拍**，属于[未实测]；
但结论可以照用，因为回滚两侧成对走本来就不需要依赖它。

小程序侧不受影响：`mp/` 冻结，它只发 `hello` / `pair-begin-client` / `enc` 三种控制帧
（两代中继都认），**回滚不涉及小程序发版**。

### 10.3 回滚步骤

先把每次上线的两个产物按版本号存下来：

```sh
# 升级前，先备份现网正在跑的两个文件
mkdir -p ~/drc-backup
ssh root@HOST 'cp /opt/dsh-remote-control/server/relay.mjs /opt/dsh-remote-control/server/relay.mjs.prev'
cp ~/.dsh/profiles/desktop/node_modules/dsh-remote-control/index.js ~/drc-backup/plugin-index.js.prev
```

回滚 = 两份一起退：

```sh
# 1) 中继
scp <上一版>/relay.mjs root@HOST:/opt/dsh-remote-control/server/relay.mjs
ssh root@HOST 'systemctl restart dsh-remote-control'
curl -s https://drc.example.com/healthz       # version 回到上一版

# 2) 主机插件：装回上一版单文件，然后重启 DSH
cp ~/drc-backup/plugin-index.js.prev ~/.dsh/profiles/desktop/node_modules/dsh-remote-control/index.js
osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 6; open -a "DeepSeek Harness"
```

只退一边会留下上表里的某一行：只退中继 = 配对永远不成功；只退插件 = 主机静默不上线。
两种都比"照着清单多按一次"贵得多，所以两份必须一起动。

> 用 `cp` 直接换 `index.js` 时，同目录那份由安装脚本生成的 `package.json`
> 里写的还是新版本号——顺手改回去，否则状态快照与宿主日志会报一个对不上的版本。

### 10.4 回滚之后的验收

别只 `curl /healthz`：那只证明进程活着。回滚验收要**做一次真配对**：出码 → 手机扫码 →
手机上出现会话列表 → `/healthz` 的 `hosts`、`clients`、`conversations` 各加 1 →
发一条指令拿到流式回复。 **[未实测]**

---

## 11. 哪些已在生产实例上验证过

生产实例（`deploy/README.md`）：

| 项          | 值                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------- |
| 公网入口    | `wss://drc.provid.cc`                                                                         |
| 服务器      | 阿里云 cn-shanghai / Alibaba Cloud Linux 4（Node 22）                                         |
| 中继        | `/opt/dsh-remote-control/server/relay.mjs` —— **就是当前这条打包路径产出的自包含单文件**      |
| 反代 / 证书 | nginx + `/etc/nginx/conf.d/drc.conf`；Let's Encrypt（acme.sh + 阿里云 DNS-01，ECC，自动续期） |
| 绑定        | 中继只听 `127.0.0.1:8787`，公网只暴露 80/443                                                  |
| 密钥        | `/etc/dsh-remote-control.env`（600）                                                          |

**已验证**：单文件产物在生产上跑着（`/healthz` 计数与 `version` 对得上）、nginx 那份配置、
systemd 那份单元、优雅停机与重启后 `unknown_session` 的行为（测试层）。

**没有实测、只是照代码写的**：Caddy 反代、launchd 常驻、Docker 部署、
`journalctl -p warning` 的实际过滤效果（§5.3）、停机窗口的探针行为（§4）、
双向兼容矩阵的真实对拍（§10.2）、回滚后的真配对验收（§10.4）。

---

## 12. 一页速查

```sh
# 构建 / 部署
pnpm build
scp dist/bundle/main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
ssh root@HOST 'systemctl restart dsh-remote-control'

# 看它活着没 / 跑的是哪版
curl -s https://drc.example.com/healthz
journalctl -u dsh-remote-control -o cat | grep '"level":"warn"'

# 本机起一个（开发）
./scripts/relay-start.sh --bundle

# 取证
pnpm typecheck && pnpm test
```

> `DRC_HOST_TOKEN` 与主机插件那份必须逐字一致；`~/.dsh/profiles/desktop/cordis.patch.yml`
> 里就有主机那份，**不要**把它拷进任何仓库、文档、测试或日志。
