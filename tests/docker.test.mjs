/**
 * docker.test — 容器产物的判据。
 *
 * ## 为什么容器文件也要有判据
 *
 * deploy/docker/ 里的三个文件**不在 tsc 的编译面里，也不在任何一次启动路径上**：
 * 它们只在"有人真的要部署"时才被读到。所以它们的失效形态与其他代码不同 ——
 * 不是抛异常，而是**部署出来的东西不对，而没人发现**：
 *
 * - HEALTHCHECK 被删 → 容器永远 healthy，停机中的实例照样被派发流量；
 * - USER 被删 → 容器以 root 跑，而加固项（read_only / cap_drop）看起来还在；
 * - DRC_BIND 被删 → 容器起来、端口也发布了，**外面连不上**（代码默认绑 127.0.0.1）；
 * - 端口发布从回环改成 0.0.0.0 → 8787 直接暴露公网，绕过 nginx 的按 IP 限流；
 * - DRC_STATE_FILE 与卷配错一边 → 状态写在容器可写层，`docker compose down` 即丢。
 *
 * 这五条里前四条是"照抄时容易丢的一行"，第五条是"配错了没人提醒"。判据因此逐条钉住
 * **文本事实**（这份文件里必须写着什么），而不是"跑一次容器看看" —— 后者在没装 Docker
 * 的机器上直接不可用，而这正是最需要这道闸的场景。
 *
 * 有两条判据在装了 docker 的机器上会**额外**做真事（跳过而不是假装通过）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const DOCKERFILE = read('deploy/docker/Dockerfile')
const COMPOSE = read('deploy/docker/compose.yaml')
const IGNORE = read('.dockerignore')
const GUIDE = read('deploy/docker/README.md')

test('Dockerfile：两条 FROM 指向同一个镜像（ARG 版本在 legacy builder 上构建失败）', () => {
  const froms = [...DOCKERFILE.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1])
  assert.equal(froms.length, 2, `应当正好两个阶段，实际 ${JSON.stringify(froms)}`)
  assert.equal(froms[0], froms[1], `两个阶段的 base image 必须一致：${JSON.stringify(froms)}`)
  assert.match(froms[0], /node:22/, 'Node 22 与 CI、与 HANDOFF 的工具链口径一致')
  // 这条是踩过的：ARG NODE_IMAGE + FROM ${NODE_IMAGE} 在只有 legacy builder 的机器上
  // 直接构建失败（NotFound: content digest），所以刻意不用 ARG。
  assert.doesNotMatch(DOCKERFILE, /^ARG NODE_IMAGE/m, 'ARG 版的 FROM 在 legacy builder 上构建不了')
})

test('Dockerfile：运行阶段以非 root 身份跑', () => {
  assert.match(DOCKERFILE, /^USER 10001:10001$/m, '必须是非 root，且 uid/gid 写死（与 systemd 形态取同一组数字）')
  assert.match(DOCKERFILE, /adduser -u 10001/, '镜像里要有这个用户，否则 USER 指向一个不存在的账号')
})

test('Dockerfile：HEALTHCHECK 在，且判的是 ok 字段而不是 HTTP 200', () => {
  const line = /^HEALTHCHECK .*$/m.exec(DOCKERFILE)?.[0] ?? ''
  assert.ok(line, '没有 HEALTHCHECK：容器状态会永远是 healthy，停机中的实例照样被派发流量')
  assert.match(line, /j\.ok===true/, '要判 /healthz 的 ok 字段：停机中它明确回 503 + ok:false')
  assert.doesNotMatch(line, /curl|wget/, '运行阶段本来就只有 node，不为一个探针多装二进制')
})

test('Dockerfile：运行时零依赖（runtime 阶段只有那一个产物文件）', () => {
  const runtime = DOCKERFILE.split('AS runtime')[1] ?? ''
  assert.match(runtime, /COPY --from=build .*dist\/bundle\/main\.js/, 'runtime 必须只从 build 阶段取那一个产物')
  assert.doesNotMatch(runtime, /^RUN (npm|pnpm) (install|ci)/m, 'runtime 阶段不许有依赖安装：这条是本镜像存在的理由')
  assert.doesNotMatch(DOCKERFILE, /^COPY .*node_modules/m, '不许把 node_modules 拷进任何阶段')
})

test('Dockerfile：产物级断言在构建里（离线搬运时 CI 并不在场）', () => {
  // 镜像是"在别处构建、再 docker load 过去"的，所以断言不能只住在 tests/ 里。
  assert.match(DOCKERFILE, /head -1 dist\/bundle\/main\.js/, 'shebang 断言')
  assert.match(DOCKERFILE, /产物里没有包版本/, '版本号断言：否则 /healthz 的 version 会是 0.0.0 而没人发现')
})

test('Dockerfile：DRC_BIND 被显式设成 0.0.0.0（容器自己就是边缘）', () => {
  // 代码默认绑 127.0.0.1。容器里那样绑 = `-p` 发布成功但外面连不上。
  // 这条在 SELF-HOSTING.md 里被单独警告过一次，是最容易在复制粘贴中丢掉的一行。
  const env = /^ENV .*$/m.exec(DOCKERFILE)?.[0] ?? ''
  assert.match(env, /DRC_BIND=0\.0\.0\.0/, `ENV 行里必须有 DRC_BIND=0.0.0.0，实际：${env}`)
  assert.doesNotMatch(
    env,
    /DRC_STATE_FILE/,
    '镜像里**故意不设** DRC_STATE_FILE：落盘路径属于部署形态，与卷由 compose 配',
  )
})

test('Dockerfile：STOPSIGNAL 与 ENTRYPOINT 的形状', () => {
  assert.match(DOCKERFILE, /^STOPSIGNAL SIGTERM$/m, '必须是 SIGTERM：main.ts 靠它走优雅停机')
  assert.match(
    DOCKERFILE,
    /^ENTRYPOINT \["node", "\/app\/relay\.mjs"\]$/m,
    'ENTRYPOINT 固定、参数透传，docker run … --version 才能问出镜像里是哪一版',
  )
})

test('Dockerfile 按 **单仓布局**拷文件（这条判据钉的是 2026-10-08 那个真实故障的**现行**形状）', () => {
  // 这份 Dockerfile 的 COPY 形状**翻转过两次**，两边的教训都留着：
  //
  // ① 2026-10-08（v3 刚拆仓）：服务器上摆的是伞仓树，而 Dockerfile 还是 v2 的单包写法
  //    （`COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./`）⇒ 拷到的是 **monorepo 根**
  //    的清单，pnpm 报「lockfile 有 ^22.9.0、manifest 要 ^26.6.3」这种看起来毫不相关的
  //    mismatch（真实原因：那份清单不是这个包的）。当时的修法是改成 `packages/` 前缀。
  //
  // ② 2026-10-13（3.1.5 起，用户裁决）：服务器改成**单仓部署**（部署源 = 本仓，不再摆伞仓）
  //    ⇒ `packages/` 前缀反而成了错的：单仓的仓根**就是**包根，`COPY package.json ./`
  //    拷的就是本包清单；`@dsh-remote/protocol` 是 devDependency、从 **npm** 装。
  //
  // ⇒ 现在钉的是**单仓**形状；`packages/` 前缀成了新的反向禁令（它是伞仓形态的残留，
  //   在单仓构建里会因文件不存在而失败）。
  assert.match(DOCKERFILE, /^COPY package\.json \.\/$/m, '仓根清单就是本包清单（单仓：仓根 = 包根）')
  assert.match(DOCKERFILE, /^COPY pnpm-lock\.yaml \.\/$/m, '锁文件必须随仓（CI 的 --frozen-lockfile 也依赖它）')
  assert.doesNotMatch(
    DOCKERFILE,
    /^COPY packages\//m,
    '`packages/` 前缀是**伞仓形态**的残留：单仓构建上下文里没有这个目录，构建会直接失败',
  )
  // ⚠️ `pnpm-workspace.yaml` 在单仓里**必须在场并拷进镜像**：它不是工作区定义，
  // 是 pnpm 11 的设置位（allowBuilds / minimumReleaseAge 例外，由 split-repos 生成）。
  // 缺了它 pnpm 11 默认不跑依赖安装脚本 ⇒ ERR_PNPM_IGNORED_BUILDS（2026-10-13 实测）。
  assert.match(DOCKERFILE, /^COPY pnpm-workspace\.yaml \.\/$/m, 'pnpm-workspace.yaml 是 pnpm 11 的设置位，必须拷进镜像')
  // 构建工作目录就是仓根（单仓：仓根 = 包根），`pnpm build` 直接产出 bundle。
  // ⚠️ 用**行号比较**而不是 `[\s\S]{0,N}` 贪婪窗口：中间隔着成段的解释注释，
  // 窗口大小会随注释长度变红（第一版 {0,200} 就这么红的——判据又骗了一次人）。
  const lineIdx = (re) => DOCKERFILE.split('\n').findIndex((line) => re.test(line))
  const workdirAt = lineIdx(/^WORKDIR \/src$/)
  const buildAt = lineIdx(/^RUN pnpm build$/)
  assert.ok(workdirAt >= 0, '找不到 WORKDIR /src')
  assert.ok(buildAt >= 0, '找不到 RUN pnpm build')
  assert.ok(workdirAt < buildAt, 'pnpm build 必须在 WORKDIR /src 之后（仓根 = 包根）')
  assert.doesNotMatch(DOCKERFILE, /pnpm --filter @dsh-remote\/protocol build/, 'workspace 的 --filter 构建是伞仓残留')
  // 产物拷贝路径要与仓根一致（改一处忘另一处 = 镜像里没有 /app/relay.mjs）
  assert.match(
    DOCKERFILE,
    /^COPY --from=build \/src\/dist\/bundle\/main\.js /m,
    '产物路径不带 packages/ 前缀：与仓根 WORKDIR 一致，否则这一步在镜像构建末尾才失败',
  )
  // 反向：`packages/` 前缀的产物路径不许残留
  assert.doesNotMatch(DOCKERFILE, /COPY --from=build \/src\/packages\//, '伞仓形态的产物路径残留')
})

test('Dockerfile：COPY 只取镜像真正要的那几个文件，install 与源码的顺序是单仓形状', () => {
  // 单仓形态下 `@dsh-remote/protocol` 是 **devDependency、从 npm 装**：
  // 镜像里不再需要 protocol 的清单与源码（伞仓形态才需要——它的 `prepare` 在 install
  // 生命周期里跑 tsc，所以那时源码必须在 install **之前**进来；那条理由随协议进 npm 而消失）。
  //
  // 历史教训保留（2026-10-08）：那次「lockfile 有 ^22.9.0、manifest 要 ^26.6.3」的真相不是
  // "清单没拷全"，而是**根 package.json 被覆盖**——上传源码时用 `tar xzf`，relay 的清单
  // 盖到了仓库根 ⇒ pnpm 拿 relay 的依赖去比根的 lock。
  // **报错指错地方时，先怀疑"文件被覆盖"，别急着加 COPY。**
  assert.doesNotMatch(
    DOCKERFILE,
    /^COPY packages\/protocol\/(package\.json|tsconfig\.json|src)/m,
    'protocol 的清单/源码是伞仓形态的残留（单仓从 npm 装 devDependency）',
  )
  // 镜像构建要用的三个路径：清单、锁、源码与脚本
  for (const f of ['tsconfig.json', 'src', 'scripts']) {
    assert.ok(DOCKERFILE.includes(`COPY ${f}`), `缺 ${f}：tsc/bundle 在构建阶段要用`)
  }
  // install 必须在源码 COPY **之前**：锁命中后改 src 不必重装依赖树（与伞仓相反的方向，
  // 那边的顺序理由是 protocol 的 prepare，这里没有）。
  const lineOf = (re) => DOCKERFILE.split('\n').findIndex((line) => re.test(line))
  const installAt = lineOf(/^RUN\s+corepack enable && pnpm install/)
  const srcAt = lineOf(/^COPY src \./)
  assert.ok(installAt >= 0, '找不到 pnpm install 那一步')
  assert.ok(srcAt >= 0 && srcAt > installAt, '源码应当在 install **之后** COPY（锁命中，改 src 不重装）')
})

test('COPY 行不许带行尾注释（Dockerfile 会把 # 之后的内容当成拷贝路径）', () => {
  // 2026-10-08 栽过：`COPY package.json ./   # monorepo 根清单`
  // ⇒ 报错形态是 `"/需要它来解": not found`——一个**看起来像文件名**的中文片段。
  // ⚠️ **逐行判定**，不用 `/^COPY.*#.*$/m`：那条正则里的 \s 会吃掉换行，
  // 于是它把「COPY 行 + 下一行注释」当成一行（2026-10-08 实测：匹配到 5 行全是误报）。
  // 这正是「判据自己也会骗人」的一例——症状同样是"判据红了但实现是对的"。
  const offenders = DOCKERFILE.split('\n')
    .map((line, i) => ({ line: i + 1, text: line }))
    .filter(({ text }) => /^\s*COPY\s/.test(text) && text.includes('#'))
    .map(({ line, text }) => `第 ${line} 行：${text.trim()}`)
  assert.deepEqual(offenders, [], `这些 COPY 行的行尾带注释：${offenders.join(' / ')}\n要说明就写在上一行`)
})

test('compose：端口只发布到宿主机回环（nginx 一行都不用改的前提）', () => {
  // ⚠️ 引号写成 `["']`：这些断言要验的是**值**，不是 YAML 的引号风格。
  // v3 跑了一次 `pnpm format` 之后 compose 里的 `"` 被 prettier 换成 `'`，
  // 于是三条判据一起红——而部署语义一个字都没变。
  // 「判据红了先怀疑判据」在这里的结论仍然是：判据更脆（它把风格当成了语义）。
  assert.match(
    COMPOSE,
    /- ["']127\.0\.0\.1:\$\{DRC_PORT(?::-\d+)?\}:\$\{DRC_PORT(?::-\d+)?\}["']/,
    '必须是 127.0.0.1:PORT:PORT：绑 0.0.0.0 会把 8787 直接暴露公网、绕过 nginx 的按 IP 限流',
  )
  assert.doesNotMatch(COMPOSE, /- ["']0\.0\.0\.0:/, '不许发布到 0.0.0.0')
  assert.match(COMPOSE, /DRC_BIND: ["']0\.0\.0\.0["']/, '容器内必须绑 0.0.0.0，否则发布了没人监听')
})

test('compose：落盘路径与卷是一对，且默认用具名卷', () => {
  const stateFile = /^\s*DRC_STATE_FILE:.*$/m.exec(COMPOSE)?.[0] ?? ''
  const volume = /^\s*- \$\{DRC_DATA_DIR(?::-[^}]+)?\}:\/data$/m.exec(COMPOSE)?.[0] ?? ''
  assert.match(stateFile, /\/data\/state\.json/, `DRC_STATE_FILE 要落在挂载点上，实际：${stateFile}`)
  assert.ok(volume, '必须挂 /data')
  assert.match(
    COMPOSE,
    /^volumes:\n\s+relay-data:/m,
    '要有具名卷 relay-data：Docker 用镜像里 /data 的属主初始化它，开箱即用',
  )
  assert.match(volume, /:-relay-data\}/, 'DRC_DATA_DIR 的默认值必须是那个具名卷，而不是 ./data（后者属主由宿主机决定）')
})

test('compose：加固项与 systemd 单元取同一个口径', () => {
  for (const [pattern, why] of [
    [/^\s*read_only: true$/m, '只读根文件系统：中继只写 /data'],
    [/^\s*cap_drop:/m, '它不需要任何 capability'],
    [/no-new-privileges:true/, '不需要提权'],
    [/^\s*mem_limit: 512m$/m, '与单元里的 MemoryMax=512M 同一个数'],
    [/^\s*stop_grace_period: 15s$/m, '必须大于程序内部 5 秒兜底，否则 compose 先 SIGKILL，最后一次补写被砍掉'],
    [/max-size: ["']10m["']/, '日志行数无界，不轮转会把磁盘吃满'],
  ]) {
    assert.match(COMPOSE, pattern, `compose 缺 ${pattern} —— ${why}`)
  }
  assert.match(
    COMPOSE,
    /restart: unless-stopped/,
    '崩溃即拉起；但**不是** always：优雅停机 exit 0 之后 always 会把它再拉起来',
  )
  assert.doesNotMatch(COMPOSE, /restart: always/, 'always 是错的（"停机之后进程自己回来了"）')
})

test('compose：缺 token 时在启动前就报错', () => {
  assert.match(
    COMPOSE,
    /DRC_HOST_TOKEN: \$\{DRC_HOST_TOKEN:\?/,
    '用 :? 让 compose 自己拒绝，而不是让容器起来再拒绝（那时报错在 logs 里）',
  )
})

test('.dockerignore：裁掉该裁的，留住构建要用的', () => {
  for (const entry of ['node_modules', 'dist', 'data', '.git', 'tests', 'docs']) {
    assert.match(IGNORE, new RegExp('^' + entry.replace('.', '\\.') + '$', 'm'), `.dockerignore 少了 ${entry}`)
  }
  // 这两个漏了就会构建失败或把构建搞慢，所以要在判据里点名。
  assert.doesNotMatch(IGNORE, /^scripts$/m, 'scripts/ 要留着：打包那一步在里面')
  assert.doesNotMatch(IGNORE, /^src$/m, 'src/ 要留着')
  assert.doesNotMatch(
    IGNORE,
    /^deploy$/m,
    'deploy/ 不走 context（Dockerfile 用 -f 指定），裁掉它是可以的，但别在这里裁',
  )
})

test('指南：镜像加速那条路必须说清"合并 daemon.json"与"核对 digest"（2026-10-07 生产实测）', () => {
  // 这两条都不是 nice-to-have，而是踩过才知道的：
  //
  // ① **合并而不是覆盖**。生产那台机器的 /etc/docker/daemon.json 里已经有三条现网配置
  //    （log-driver + log-opts、live-restore、default-address-pools）。指南原来只写
  //    `{ "registry-mirrors": [...] }` 一行，照抄会把那三条**整个抹掉** ——
  //    而写坏 daemon.json 会让 docker 起不来，那是那台机器上所有容器的地基。
  // ② **核对 digest**。加速站是第三方，"拉下来了"不等于"是官方的内容"。
  //    只有 RepoDigests 与直连 Docker Hub 一致才可信（2026-10-07 实测两者同为
  //    sha256:0a7108bf…）。不写这一条，将来配了加速就等于无条件信任那个域名。
  assert.match(
    GUIDE,
    /要合并，不能覆盖|合并而不是覆盖/,
    '指南没写清 daemon.json 要合并 —— 照抄那一行会抹掉 log-driver / live-restore / 地址池',
  )
  assert.match(
    GUIDE,
    /RepoDigests|repoDigests/,
    '指南没提核对 digest —— 加速站是第三方，不核对等于无条件信任它返回的字节',
  )
  // 反向：别把一个具体地址写成"FROM 用它"。FROM 硬写第三方域名等于把供应链
  // 交给一个别人随时可能下线或被投毒的域名（Dockerfile 文件头已经这么判过一次）。
  assert.doesNotMatch(
    DOCKERFILE,
    /1ms\.run|1ms\.cloud/,
    'Dockerfile 的 FROM 里出现了具体镜像站域名：可达性该由环境（daemon.json）解决，' + '而不是把供应链交给那个域名',
  )
})

test('指南：从 systemd 切过来时，属主改在停服务之后（顺序反了会静默丢配对记录）', () => {
  // 2026-10-07 生产实测踩过。单元里有 StateDirectory=dsh-remote-control，
  // systemd 会在**每次停止时**按 User= 把那个目录的属主改回去。所以：
  //   chown 10001 → systemctl stop（改回 root）→ 起容器（uid 10001 读 root 的 600）
  //   → EACCES → starting empty → 30 秒后落盘把空状态写回去 → **配对记录不可逆地没了**
  // 最后一步是"从 systemd 切容器"这条路独有的，别的坑顶多让服务起不来。
  const cut = GUIDE.slice(GUIDE.indexOf('## 与 systemd 并存'))
  assert.match(
    cut,
    /systemctl stop[\s\S]{0,200}chown -R 10001:10001/,
    '指南没有把「先 stop 再 chown」这个顺序写出来 —— 照着做的人会先 chown，' +
      '然后被 StateDirectory 改回去，导致配对记录被空状态覆盖（2026-10-07 生产实测）',
  )
  // 反向：顺序反过来的写法不许出现在指南里（那是会丢数据的那个版本）。
  //
  // ⚠️ 这里**必须只看相邻两行**，不能用 `[\s\S]{0,N}` 跨段落匹配：这一节里本来就有
  //   「切回 systemd」的代码块（`chown -R root:root`），而它离正确顺序块不到 200 字 ——
  // 第一版写成 `[\s\S]{0,120}` 时**判据把指南自己写的正确内容也判成违规**，
  // 那是最坏的一种红：会让人去改对的东西。
  // 判据因装置错误而红，比判据红本身更贵。
  const codeLines = cut.split('\n')
  const badOrder = codeLines.some(
    (line, i) => /chown -R 10001:10001/.test(line) && /systemctl stop/.test(codeLines[i + 1] || ''),
  )
  assert.equal(
    badOrder,
    false,
    '指南的切容器代码块里，chown 写在 systemctl stop 的下一行 —— ' +
      '这正是 2026-10-07 丢了一条会话的顺序（StateDirectory 会在 stop 时把属主改回去）',
  )
  // 判据本身：切完必看 stateRestored，而它与 conversations 的组合才是证据。
  // 单看 conversations:0 会被读成"新配对还没建"，单看 stateRestored:0 会被忽略。
  assert.match(
    cut,
    /stateRestored/,
    '指南没提 stateRestored —— 它是"读不到旧状态、被当成空启动"唯一的可观测证据' +
      '（/healthz 仍然是 ok:true，配对表面也正常）',
  )
  assert.match(
    cut,
    /unreadable|stateWriteFailures/,
    '指南没提用日志/stateWriteFailures 交叉核对 —— 那是属主不对时的第二个信号',
  )
})

test('docker compose config 在装了 compose 的机器上真的成立（没装就跳过，不假装通过）', async (t) => {
  const { spawnSync } = await import('node:child_process')
  // timeout：docker CLI 在 daemon 不起时可能长时间挂住；没有上限的话
  // 一条判据就能把整套 relay 测试钉死（2026-10-08 加，见 e2e/child-harness-guard ④）。
  const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 20_000 })
  if (probe.status !== 0) {
    t.skip('这台机器上没有 docker compose')
    return
  }
  const res = spawnSync('docker', ['compose', '-f', 'deploy/docker/compose.yaml', 'config'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DRC_HOST_TOKEN: 'docker-test-dummy-token-0123456789' },
    timeout: 30_000,
  })
  assert.equal(res.status, 0, `compose config 失败：${res.stderr}`)
  // 反过来：不给 token 必须失败，且错误信息要指名去哪里设。
  const missing = spawnSync('docker', ['compose', '-f', 'deploy/docker/compose.yaml', 'config'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DRC_HOST_TOKEN: '' },
    timeout: 30_000,
  })
  assert.notEqual(missing.status, 0, '缺 DRC_HOST_TOKEN 时 compose config 就该失败')
  assert.match(missing.stderr + missing.stdout, /DRC_HOST_TOKEN/, '失败信息要指名是哪个变量')
})
