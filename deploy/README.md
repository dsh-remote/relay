# 部署记录与复用步骤

本目录是**实际生产部署**的配置，不是示例。

## 当前部署

| 形态     | **Docker**（`deploy/docker/compose.yaml`；2026-10-07 从 systemd 切过来，nginx 不动）   |
| 项       | 值                                                                                     |
| -------- | -------------------------------------------------------------------------------------- |
| 公网入口 | `wss://drc.provid.cc`                                                                  |
| 中继     | 镜像 `dsh-remote-relay`（里面是**一个自包含单文件**），compose 服务 `relay`。systemd 单元 `dsh-remote-control.service` 仍保留可用，**二选一** |
| 反向代理 | nginx，`/etc/nginx/conf.d/drc.conf`                                                    |
| 证书     | Let's Encrypt（acme.sh + 阿里云 DNS-01），ECC，自动续期                                 |
| 绑定     | 中继只监听 `127.0.0.1:8787`，公网只暴露 80/443                                          |
| 密钥     | `/etc/dsh-remote-control.env`（600），同一份 token 也写在主机插件的 profile 配置里      |

中继现在部署的是 `pnpm build` 打出来的 `dist/bundle/main.js`
（`ws` 与协议层都内联进去了，`bufferutil`/`utf-8-validate` 是可选原生加速、缺了照常跑）。
于是生产只有"拷一个文件 + 一个 env 文件"，没有 `npm install`，也就没有
"服务器上的依赖树和 CI 不一样"这一类故障。

> 完整的环境变量表、日志契约、重启语义、升级回滚见 [`../docs/SELF-HOSTING.md`](../docs/SELF-HOSTING.md)。

## 从零复现

### 1. 服务器准备

```sh
dnf install -y nodejs nginx           # Alibaba Cloud Linux 4 自带 node 22
mkdir -p /opt/dsh-remote-control/server /etc/nginx/ssl
```

### 2. 部署中继（Docker）

> 生产现在跑的是容器，完整步骤在 [`docker/README.md`](docker/README.md)（含镜像源拉不到时的三条路）。 下面这份是**裸机 systemd** 那条路，仍然可用，但两条**别同时开**——同一个端口只能有一个进程在听。

#### 2b. 裸机 systemd


```sh
# 本地先构建产物
pnpm install && pnpm build

scp dist/bundle/main.js            root@HOST:/opt/dsh-remote-control/server/relay.mjs
scp deploy/systemd/*.service       root@HOST:/etc/systemd/system/

# token：与主机插件那份必须逐字一致
cat > /etc/dsh-remote-control.env <<'EOF'
DRC_HOST_TOKEN=<openssl rand -hex 32 的输出>
DRC_PORT=8787
DRC_PUBLIC_URL=wss://drc.provid.cc
DRC_PAIR_TTL_MS=90000
DRC_LOG_LEVEL=info
# 会话表落盘（默认关闭 = 纯内存模式，重启丢配对；配上之后会话表重启恢复，见 CHANGELOG 1.0.6）
# 标准生产值（相对路径按 systemd WorkingDirectory 解析）：
# DRC_STATE_FILE=/var/lib/dsh-remote-control/state.json
EOF
chmod 600 /etc/dsh-remote-control.env

systemctl daemon-reload && systemctl enable --now dsh-remote-control
curl -s http://127.0.0.1:8787/healthz      # version 必须是包的 version，不是 0.0.0
```

### 3. DNS 证书（DNS-01，不需要占用 80 端口）

acme.sh 已保存阿里云 DNS 凭证，所以换域名只需一条命令：

```sh
acme.sh --issue --dns dns_ali -d drc.provid.cc --server letsencrypt
acme.sh --install-cert -d drc.provid.cc \
  --key-file       /etc/nginx/ssl/drc.provid.cc.key \
  --fullchain-file /etc/nginx/ssl/drc.provid.cc.crt \
  --reloadcmd      "systemctl reload nginx"
```

### 4. nginx

```sh
scp deploy/nginx/drc.conf root@HOST:/etc/nginx/conf.d/drc.conf
ssh root@HOST 'nginx -t && systemctl enable --now nginx'
```

`drc.conf` 里包含**按 IP 限流**（`limit_req` 20r/s、`limit_conn` 8）——中继本身
只有全局和单连接配额，看不到真实客户端 IP，所以这一层必须由反代来做。

### 5. 验证

```sh
curl -s https://drc.provid.cc/healthz
```

`/healthz` 的 `version` 必须等于包版本。真要端到端验一遍，得在这台机器之外跑一次真配对
（出码 → 手机扫码 → 发指令拿到流式回复），见 `../docs/SELF-HOSTING.md` §10.4。

## 运维

```sh
systemctl status dsh-remote-control
journalctl -u dsh-remote-control -f                                  # 一行一个 JSON
journalctl -u dsh-remote-control -o cat | grep '"level":"warn"'      # 按 JSON 里的 level 过滤
curl -s https://drc.provid.cc/healthz
tail -f /var/log/nginx/drc.access.log
```

> 别用 `journalctl -p warning`：中继写到 stdout 的 JSON 不带 syslog 级别前缀，这些行进
> journal 时优先级一律是 `info`，按优先级过滤很可能一条都出不来。按 JSON 里的 `level` 过滤。

改中继代码后：

```sh
pnpm build
scp dist/bundle/main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
ssh root@HOST 'systemctl restart dsh-remote-control'
```

中继默认是纯内存的，未配 `DRC_STATE_FILE` 落盘时重启会丢掉配对关系：客户端拿旧 convId 发帧会撞上
`error{unknown_session}`，手机上就是中文的"会话已失效，请重新配对"。

## 安全组

```
TCP  22, 80, 443   0.0.0.0/0   Accept
```

8787 **不要**对公网开放 —— 中继只绑 `127.0.0.1`，nginx 在同一台机器上转发。
