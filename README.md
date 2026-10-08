# @dsh-remote/relay

DSH Remote Control 的**零知识 WebSocket 中继**：在宿主插件与已配对的手机之间转发**密封记录**，
只认帧名 / 会话 id / 能力协商，**从不解析载荷**——密文对它就是一个 base64 字符串。

生产形态是**单文件产物** `dist/bundle/main.js`（`ws` / `zod` / 协议层全部内联，运行时零依赖）；
部署只有两种：拷这个单文件 + 起进程（systemd / docker / launchd 配方见下），或从源码构建。

## 自托管

完整配方（环境变量表、systemd / docker / nginx、排错、升级与回滚）见
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md)。最速验证：

```sh
DRC_HOST_TOKEN=<与主机插件一致> node dist/bundle/main.js
curl -s http://127.0.0.1:8787/healthz
```

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

## 许可

MIT
