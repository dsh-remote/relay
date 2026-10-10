# @dsh-remote/relay

DSH Remote Control 的**零知识 WebSocket 中继**：在宿主插件与已配对的手机之间转发**密封记录**，
只认帧名 / 会话 id / 能力协商，**从不解析载荷**——密文对它就是一个 base64 字符串。

生产形态是**单文件产物** `dist/bundle/main.js`（`ws` / `zod` / 协议层全部内联，运行时零依赖）；
部署只有两种：拷这个单文件 + 起进程（systemd / docker / nginx 配方见下），或从源码构建。

## 自托管

完整配方（环境变量表、systemd / docker / nginx、排错、升级与回滚）见
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md)。最速验证：

```sh
DRC_HOST_TOKEN=<与主机插件一致> node dist/bundle/main.js
curl -s http://127.0.0.1:8787/healthz
```

### 常用配置

| 变量                          | 必填 | 默认        | 说明                                                                                             |
| ----------------------------- | ---- | ----------- | ------------------------------------------------------------------------------------------------ |
| `DRC_HOST_TOKEN`              | ✅   | —           | 主机出站认证凭据。`openssl rand -hex 32` 生成。**与主机插件那份必须逐字一致**                    |
| `DRC_PORT`                    |      | `8787`      | 监听端口。`0` = 让系统分配（测试与容器用）                                                       |
| `DRC_BIND`                    |      | `127.0.0.1` | 绑定地址。默认只绑回环：TLS 由反代终止。**只有自己就是边缘（容器直接发布端口）时才设 `0.0.0.0`** |
| `DRC_PUBLIC_URL`              |      | 空          | `/api/info` 返回的对外地址。公网填 `wss://你的域名`                                              |
| `DRC_LOG_LEVEL`               |      | `info`      | `debug` / `info` / `warn` / `error` / `silent`。**区分大小写**                                   |
| `DRC_PAIR_TTL_MS`             |      | `120000`    | 配对码的**服务端权威**寿命（毫秒）                                                               |
| `DRC_STATE_FILE`              |      | 空（关闭）  | 会话表落盘路径。默认关闭 = 纯内存；配上后启动先读它、会话表有增删时写回                          |
| `DRC_STATE_SAVE_MS`           |      | `60000`     | 周期补写状态文件的间隔（只为刷新 `lastActivityAt`）                                              |
| `DRC_MAX_BUFFERED_BYTES`      |      | `1048576`   | 慢消费者阈值：发送缓冲区**连续**超限达**本角色窗口**才 1008 断开                                 |
| `DRC_SLOW_CONSUMER_HOST_MS`   |      | `10000`     | **主机**侧慢消费者窗口（毫秒）。主机卡住就是所有人卡住，所以窗口短                               |
| `DRC_SLOW_CONSUMER_CLIENT_MS` |      | `45000`     | **客户端**侧慢消费者窗口（毫秒）。**必须大于手机自己的重连周期**（≈42.5 秒）                     |

### 端点

| 路径                   | 说明                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`         | 运维契约（**二十三个字段**）：`ok` / `version` / `uptimeSec` / `hosts` / `clients` / `conversations` / `pendingPairs` / `droppedFrames` / `slowConsumers` / `rejectedPairs` / `shutdownForced` / `persistence` / `stateRestored` / `stateSavedAtSec` / `stateWrites` / `stateWriteFailures` / `lastPingAgo` / `shuttingDown` / `protocolSelf` / `protocolMin` / `peerProtocolMin` / `peerProtocolMax` / `peersNoProtocol` |
| `GET /api/info`        | `{"publicUrl","protocol"}`                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/pair-status` | **默认 404**。无需认证地回答"配对码 N 是否有效"等于给 6 位码空间装了扫描 oracle；确需调试时 `DRC_PAIR_STATUS=1`，用完关掉                                                                                                                                                                                                                                                                                                 |
| WebSocket              | 路径不设限，任意路径都能升级                                                                                                                                                                                                                                                                                                                                                                                              |

落盘五字段（`persistence` / `stateRestored` / `stateSavedAtSec` / `stateWrites` /
`stateWriteFailures`）是"还在落盘"的唯一读数——换机器先看 `stateWriteFailures`，不是 0 就是没在写。

## 开发

```sh
pnpm install
pnpm build        # tsc + 单文件打包
pnpm test         # tsc + 打包 + node --test（含产物级判据）
```

## 红线

- **不 import 载荷**：依赖图里只有协议层的 `frames` / `ids` / `negotiate` / `outbound`；
  构建产物里不许出现任何密码学实现——`tests/bundle.test.mjs` 直接读产物断言。
- 路由表是**内存的**：重启即全部作废（客户端会看到 `unknown_session`），这是设计不是缺陷。
- 日志永不落载荷、落完整配对码、落 hostToken（有判据锁住）。
- **本包不发 npm**：`private: true`，发布流程里不许出现发包步骤与 id-token（有判据）。

## 许可

MIT
