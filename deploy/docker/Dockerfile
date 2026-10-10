# dsh-remote-relay —— 中继的容器形态。
#
# ## 这份 Dockerfile 刻意很短，因为它要成立的前提是上游已经打过包
#
# 中继的分发形态是**一个自包含单文件**（pnpm build 产出的 dist/bundle/main.js：ws / zod /
# 协议层全内联，运行时依赖为空，tests/bundle.test.mjs 有产物级断言）。于是镜像只有两个阶段：
#
#   build   —— 装依赖、打包，**只为了产出那一个文件**；
#   runtime —— 只 COPY 那一个文件，没有 node_modules、没有 npm install。
#
# 这条"运行时零依赖"不是省事，是**故障类别的消除**：镜像里不可能出现"服务器上的依赖树和
# CI 不一样"，也不可能出现某个传递依赖换个 Node 小版本就变行为这一类只在生产才显形的问题。
# 可选原生加速（bufferutil / utf-8-validate）在 bundle 里是 external、且 ws 对它们是
# try/catch，缺了照常跑纯 JS —— 与裸机部署同形。
#
# ## 版本号在镜像里有三份，且互为对账
#
#   1. 产物内（esbuild define 注入）→ /healthz 的 version 字段，**运维唯一认的**；
#   2. OCI 标签 org.opencontainers.image.version → docker inspect / SBOM 看得到；
#   3. 镜像标签 dsh-remote-relay:<version> → 部署脚本与人看的。
#
# 构建阶段末尾那条断言（产物里必须找得到包版本）让 1 与 2 不会各说各话：版本号打错时
# **构建就失败**，而不是等上线后靠 /healthz 才发现。
#
# ## 两条 FROM 为什么写死而不是用 ARG
#
# 早期版本写成 ARG NODE_IMAGE=… + FROM ${NODE_IMAGE}，那份在 BuildKit（Docker 23+ 默认）下
# 没问题，但在**只有 legacy builder** 的机器上直接构建失败（NotFound: content digest）。
# 换镜像源这件事有更标准的做法，见下面「拉不到 Docker Hub 怎么办」，所以这里不为了一个
# 方便性参数牺牲可构建性。tests/docker.test.mjs 会钉住两条 FROM 指向同一个镜像。
#
# ## 拉不到 Docker Hub 怎么办（生产那台机器就是拉不到的）
#
# 与其把某个第三方镜像站硬写进 FROM（那是把供应链交给一个别人随时可能下线或被投毒的域名），
# 不如让 FROM 保持标准写法，可达性交給环境去解决：
#
#   1) 配 daemon 级镜像加速（/etc/docker/daemon.json 的 registry-mirrors），**推荐**；
#   2) 或从可达的镜像站拉一份再本地打标签：docker pull <mirror>/library/node:22-alpine
#      后 docker tag 成 node:22-alpine —— docker build 在本地有这个名字时不会再解析远端；
#   3) 或在能上网的机器上 build，再 docker save | docker load 搬过去
#      （deploy/docker/README.md 有完整的离线步骤；生产那次就是这么发的）。
#
# Node 22 与 CI、与 HANDOFF 的工具链口径一致（pnpm 11 要求 >= 22.13）。
FROM node:22-alpine AS build
WORKDIR /src

# 先只拷锁文件再装：pnpm 的安装缓存按 lockfile 命中，改 src 不必重装依赖树。
# --frozen-lockfile 是刻意的——镜像里装的必须与提交的 lockfile 逐位一致，
# "构建时顺手升了某个传递依赖"这类漂移正是要消掉的。
#
# ## v3 单仓：这里的 COPY 必须带 packages/ 前缀（2026-10-08 修）
#
# v2 时这个仓是**独立仓**，build 上下文（compose 的 `context: ../..`）就是本仓根，
# 所以 `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./` 拷的是"本包 + 本包锁"。
# v3 变成 monorepo 后，同一行拷的是 **monorepo 根**的三个文件——而根 package.json 里
# 没有 relay 的依赖，于是 pnpm 报的错是「lockfile 里有 ^22.9.0、manifest 要 ^26.6.3」
# 这类**看起来毫不相关**的 mismatch（真实原因：那份 package.json 不是这个包的）。
#
# 症状与判据：`docker compose build` 失败，而 `pnpm install` 在本机完全正常。
# 所以下面显式列出三个路径，让"上下文是单仓根"这件事变成 Dockerfile 自己保证的。
# ⚠️ 下面几行的行尾**不许带注释** —— Dockerfile 会把 `#` 之后的内容也当成拷贝路径
# （报错形态：`"/需要它要解": not found`，看起来像文件不存在，其��是把注释当路径了）。
# 要说明就写在上一行。
COPY pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
# monorepo 根清单：pnpm 需要它来解 workspace（里面没有 relay 的依赖，只负责解析结构）
COPY package.json ./
#
# ⚠️ **pnpm-workspace.yaml 声明的每一个包都要有 package.json 在场**，少一个都不行。
# 缺的那几个不会报"文件不存在"，而是报 `specifiers in the lockfile don't match`，
# 并把**缺的包的依赖名**列出来（第一次栽在这里：漏了 plugin/client/e2e，于是报错说
# 「lockfile 有 ^22.9.0、manifest 要 ^26.6.3」——那是 plugin 的 @types/node，
# 与 relay 一点关系都没有 ⇒ 看起来像 lockfile 坏了，其��是清单没拷全）。
# 镜像只需要 relay + protocol 的源码，但**清单必须全在场**，否则 pnpm 在 install 阶段就退出了。
COPY packages/relay/package.json ./packages/relay/
COPY packages/protocol/package.json ./packages/protocol/
#
# ⚠️ **不需要**把 workspace 里其他包（plugin / client / e2e）的 package.json 也拷进来。
# 我一度以为"声明的包必须清单齐备"，为此加了三条 COPY —— 那三条**无效**：
# 删掉之后 `pnpm install --frozen-lockfile` 照样通过（2026-10-08 在服务器上实测过：
# 只放 protocol + relay 两份清单，frozen 检查顺利过，只在下一步因缺 protocol 的
# tsconfig 而失败）。pnpm 只校验**它要解析的那些 importer**。
#
# 那次「lockfile 有 ^22.9.0、manifest 要 ^26.6.3」的 mismatch 真相不是"清单没拷全"，
# 而是**根 package.json 被污染**：上传源码时用 `tar xzf`，relay 的 package.json
# 覆盖到了仓库根，于是 pnpm 拿 relay 的依赖去比根的 lock ⇒ 报出 relay 的依赖名。
# ⇒ **报错指错地方时，先怀疑"文件被覆盖"，别急着加 COPY。**
#
# protocol 的 src + tsconfig 必须在 install **之前**进来：
# 它的 `prepare: tsc -p tsconfig.json` 是 install 生命周期的一环，
# 顺序写反的报错是 `TS5058: path does not exist`，出现在 install 阶段。
COPY packages/protocol/tsconfig.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
RUN corepack enable && pnpm install --frozen-lockfile

COPY packages/relay/tsconfig.json ./packages/relay/
COPY packages/relay/src ./packages/relay/src
COPY packages/relay/scripts ./packages/relay/scripts
# protocol 必须**先构建**：它是 workspace 依赖，`pnpm install` 只软链它的 package.json，
# 而 bundle 脚本按 node_modules 解析 ⇒ 拿到的必须是 `dist/src/**`（main 字段指向那里）。
# 少这一步的报错形态是 esbuild 找不到 `@dsh-remote/protocol/dist/src/index.js`。
RUN pnpm --filter @dsh-remote/protocol build
# 在 relay 包目录里构建：它的 tsconfig 与 bundle 脚本都以包根为基准
WORKDIR /src/packages/relay
RUN pnpm build

# 产物级断言。两条取自 tests/bundle.test.mjs 的同款断言，写在这里是因为
# **镜像构建不该依赖 CI 跑过了**：本机或临时机器上 docker build 时 CI 并不在场。
#   - shebang 在第一行：chmod +x 之后能直接 ./relay.mjs 起；
#   - 包版本真的进了产物：否则 /healthz 的 version 会是 0.0.0，而运维正是靠它
#     判断线上跑的是哪一版（那就成了"看起来正常、其实根本判不出来"）。
RUN set -e; head -1 dist/bundle/main.js | grep -q '^#!/usr/bin/env node'; node -e 'const {readFileSync}=require("node:fs");const v=JSON.parse(readFileSync("package.json","utf8")).version;const b=readFileSync("dist/bundle/main.js","utf8");if(!b.includes(JSON.stringify(v)))throw new Error("产物里没有包版本 "+v);console.log("[docker] bundle ok, version "+v)'

# ── 阶段 2：运行 ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

ARG DRC_VERSION=0.0.0
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="dsh-remote-relay" org.opencontainers.image.description="Zero-knowledge WebSocket relay for DSH Remote Control" org.opencontainers.image.source="https://github.com/providcc/dsh-remote-server" org.opencontainers.image.licenses="MIT" org.opencontainers.image.version="${DRC_VERSION}" org.opencontainers.image.revision="${VCS_REF}"

WORKDIR /app
COPY --from=build /src/packages/relay/dist/bundle/main.js /app/relay.mjs

# 只有这两个。**故意不设 DRC_STATE_FILE**：镜像里的默认值要与裸机（systemd 单元）一致——
# 不配就是纯内存、配了才落盘。落盘路径属于"部署形态"而不是"程序形态"，它与卷是一对，
# 所以由 compose 显式配在一起（compose.yaml 里 env 与 volume 并排）。这样
# "docker run 一个裸镜像"与"systemd 跑同一个文件"语义相同，也避免了"忘了挂卷 →
# 状态写进容器可写层 → 重建即丢"这条静默失败。
#
# DRC_BIND=0.0.0.0 不能省：代码默认只绑 127.0.0.1，容器里那样绑等于"-p 发布了没人监听"。
# 公网面仍然是宿主机 nginx 的 443，因为 compose 只把端口发布到**回环**。
ENV DRC_PORT=8787 DRC_BIND=0.0.0.0

# 非 root。uid/gid 写死成 10001，于是状态目录的属主在容器与裸机两套部署形态之间是同一组
# 数字，切换时只需要一次 chown（deploy/docker/README.md 第 3 节）。
RUN addgroup -g 10001 -S drc && adduser -u 10001 -S -G drc -h /app drc && mkdir -p /data && chown 10001:10001 /data
USER 10001:10001

EXPOSE 8787
STOPSIGNAL SIGTERM

# 健康检查用 node 自己发请求，不装 curl/wget——运行阶段本来就只有 node，为一个探针多装一个
# 二进制不值得，而且它会是这个镜像里唯一一个外部依赖。
# 判 j.ok === true 而不是只看 HTTP 200：停机过程中 /healthz 明确回 ok:false 且状态码 503，
# 那一刻容器应当立刻变成 unhealthy，而不是继续被当成健康的。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e 'fetch("http://127.0.0.1:"+(process.env.DRC_PORT||8787)+"/healthz").then(r=>r.json()).then(j=>process.exit(j.ok===true?0:1)).catch(()=>process.exit(1))'

# ENTRYPOINT 固定、参数透传：docker run … dsh-remote-relay --version 就能问出镜像里是哪一版，
# 不必为此起一个会监听端口的进程。
ENTRYPOINT ["node", "/app/relay.mjs"]
