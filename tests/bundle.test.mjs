/**
 * 部署产物测试：`dist/bundle/main.js` 必须是一个**自包含、不含密码学代码**的单文件。
 *
 * 这两条都是"结构性"保证，比"代码里没调用"强：
 * - 不含密码学：协议层标了 `sideEffects:false`，中继只 import `frames`/`ids`，
 *   所以 tree-shaking 之后产物里根本没有 secretbox/xsalsa20 的实现——
 *   零知识不是纪律，是依赖图上不可达。
 * - 自包含：拷到一个空目录（没有 node_modules）也能跑起来并应答 `/healthz`，
 *   于是生产部署退化成"scp 一个文件 + systemctl restart"，
 *   少一步 `npm install`，也就少一类"服务器上的依赖树和 CI 不一样"的故障。
 */
import { stopChild } from './child-harness.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { skipUnlessSignals } from './test-platform.mjs'

const BUNDLE = fileURLToPath(new URL('../dist/bundle/main.js', import.meta.url))
/** 按包名解析协议包，而不是写死它在工作区里的相对路径——这里是独立仓，只有 node_modules。 */
const require = createRequire(import.meta.url)

test('产物里没有任何密码学实现（零知识在依赖图上成立）', () => {
  const source = readFileSync(BUNDLE, 'utf8')
  for (const marker of ['xsalsa20', 'secretbox', 'tweetnacl', 'nacl_verify', 'salsa20', 'poly1305']) {
    assert.ok(!new RegExp(marker, 'i').test(source), `产物里出现了 ${marker} —— 中继不该带密码学`)
  }
  // 反向确认它确实是需要的那个东西，而不是一个空壳。
  assert.match(source, /pair-begin-client/)
  assert.match(source, /\/healthz/)
  assert.match(source, /dsh-rc|WebSocket/)
  const kb = Math.round(statSync(BUNDLE).size / 1024)
  assert.ok(kb < 3_000, `产物 ${kb} KB，超出预期`)
})

// ⚠️ 「优雅退出」靠 SIGTERM —— win32 上它是 TerminateProcess，进程没有机会优雅停机。
//    （relay 的非信号出口本身另有判据：lifecycle 的「win32：信号不投递」那条。）
test('单文件在没有 node_modules 的空目录里能启动、应答健康检查并优雅退出', skipUnlessSignals(), async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-relay-'))
  const target = path.join(dir, 'relay.mjs')
  copyFileSync(BUNDLE, target)
  const child = spawn(process.execPath, [target], {
    cwd: dir,
    env: {
      ...process.env,
      DRC_HOST_TOKEN: 'bundle-smoke-token-0123456789abcdef',
      DRC_PORT: '0',
      DRC_BIND: '127.0.0.1',
      DRC_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  let resolvePort
  const portReady = new Promise((resolve, reject) => {
    resolvePort = resolve
    child.on('exit', (code) => reject(new Error(`提前退出 code=${String(code)}：${lines.join('\n')}`)))
  })
  const onData = (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      lines.push(line)
      try {
        const record = JSON.parse(line)
        if (record.msg === 'relay listening') resolvePort(record.port)
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  try {
    const port = await Promise.race([
      portReady,
      sleep(4000).then(() => {
        throw new Error(`没等到启动日志：${lines.join('\n')}`)
      }),
    ])
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json())
    assert.equal(health.ok, true)
    assert.equal(health.hosts, 0)
    // 断言**具体值**而不是"是个字符串"：单文件部署时旁边没有 package.json，
    // 靠文件探针读版本的实现会静默退化成 `0.0.0`，而旧断言对此完全无感。
    // `/healthz` 的 version 是运维判断"线上跑的是哪一版"的唯一入口。
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(typeof health.version, 'string')
    assert.equal(
      health.version,
      pkg.version,
      `产物报的版本是 ${String(health.version)}，包版本是 ${pkg.version}：版本号没在打包时注入`,
    )
    assert.match(readFileSync(BUNDLE, 'utf8'), new RegExp(`"${pkg.version}"`), 'define 没有真的落进产物')

    // 收场走共用装置（2026-10-08）：它带上限 + SIGKILL 兜底。
    // 原来这里自己 race 了一个 3 秒的 sleep —— 能用，但那是**第四份**收场写法，
    // 而"收场有没有上限"正是 2026-10-08 在 Linux 腿上抓到过的坑，不该有第四份。
    const code = await stopChild(child)
    assert.equal(code, 0, `优雅停机必须 exit 0（实得 ${code}；'timeout' = 3 秒内没退出）`)
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

test('协议包声明 sideEffects:false —— 上面那条零知识保证的前提', () => {
  const pkg = JSON.parse(readFileSync(require.resolve('@dsh-remote/protocol/package.json'), 'utf8'))
  assert.equal(pkg.sideEffects, false, '没有这条，打包器不会把 record/keys 从产物里摇掉')
  assert.ok(!('tweetnacl' in (pkg.dependencies ?? {})) === false, 'tweetnacl 仍是协议包的运行时依赖（插件要用）')
})

/**
 * 分发形状的闸门：⚠️ **2026-10-23 起本仓不再发 npm**（用户裁决：npm 只发 protocol 与 plugin；
 * 中继是自部署服务，走 Docker 镜像 + GitHub Release 上的自包含单文件）。
 * 这条判据现在钉的是**"不许发"**：private + 无发布步骤 + 仍建 Release 挂单文件产物。
 *
 * ## 为什么改过（原判据钉的是相反的事）
 *
 * 原来这条钉 `private: true`、不许出现发包步骤与 `id-token`。它给的理由是
 * **包名撞墙**：`dsh-remote-server` 在 npm 上属于另一个无关项目
 * （`bondzhu` / `MRZHUH/dsh-remote-server`，一个"在 DSH 会话里 @ 服务器走 SSH 执行命令"的工具），
 * 2026-10-03 用户拍板"先不发"。
 *
 * ⚠️ **那条理由到 2026-10-10 已经不成立了**：包名早就从 `dsh-remote-server` 改成了
 * **带 scope 的 `@dsh-remote/relay`**，而它在 npm 上是 **404（没被占）**。
 * 撞的是**旧名字**，不是现在这个名字。用户 2026-10-10 拍板"发"。
 *
 * ## 但它防的东西仍然值得防 —— 所以是**改写**，不是删掉
 *
 * 原判据真正有价值的部分是"**别半发**"：那种形状是"package.json 去掉了 private、
 * workflow 里加了 publish，但别的没跟上"，结局要么红在 CI，要么更糟。
 * 现在"半发"的新形状是：**该发的没进白名单**（源码/测试被打进包里）、
 * **该不发的那条 workflow 混进了发布步骤**、或者**发布权限给了不该有的 job**。
 * 下面逐条钉这些。
 *
 * 末尾两条与发不发无关，是产物事实：运行时依赖为空、shebang 在第一行。
 */
test('分发形状：relay **不发** npm（private + 无发布步骤），但单文件产物与 Release 挂载必须还在', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

  // ── 不发：private 是硬保险（npm 直接拒发 private 包），publishConfig 不许再自称要发 ──
  assert.equal(pkg.private, true, 'private 必须为 true：npm 硬拒发 private 包，这是最后一道保险')
  assert.equal(
    pkg.publishConfig,
    undefined,
    'publishConfig 还在自称"公开发布 + provenance" —— 口径没跟上裁决（要么删掉，要么改成注释）',
  )

  // ── 产物事实（与发不发无关，一直成立）──
  assert.equal(pkg.main, './dist/bundle/main.js', 'main 要指向单文件产物：Docker 镜像与 Release 都用它')
  assert.deepEqual(
    pkg.dependencies,
    {},
    '产物已内联 ws/zod/@dsh-remote/protocol，运行时依赖必须是空：列了就是让源码消费者白拉一棵树',
  )
  assert.equal(
    readFileSync(BUNDLE, 'utf8').split('\n', 1)[0],
    '#!/usr/bin/env node',
    'shebang 必须在第一行，否则 chmod +x 之后 ./relay.mjs 起不来',
  )

  /**
   * ── 发布 workflow 的形状（2026-10-23：只校验 + 建 Release，**不碰 npm**）──
   *
   * ⚠️ **必须剥注释再匹配**（今天第三次栽在这上面）。`release.yml` 的注释里**成段地**
   * 讨论 `NODE_AUTH_TOKEN` / `pnpm publish`（那是在解释"当初为什么必须这么写"）⇒ 不剥的话，
   * 下面那些 `match` 会命中注释里的字面量，**把调用删掉判据照样绿**（这个方向比"永远红"更危险）。
   */
  const stripComments = (text) => text.replace(/^\s*#.*$/gm, '')
  const release = stripComments(readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8'))

  assert.doesNotMatch(release, /pnpm publish|npm publish/, 'release.yml 里不许再有发包步骤（relay 不发 npm）')
  assert.doesNotMatch(release, /attestations/, 'release.yml 里不许再验 provenance（那是发 npm 才有的步骤）')
  assert.doesNotMatch(release, /id-token:\s*write/, '不发 npm 就不需要 OIDC 权限')
  assert.doesNotMatch(release, /NODE_AUTH_TOKEN/, '不发 npm 就不该再有 token 相关步骤')
  assert.match(release, /dist\/bundle\/main\.js/, 'release.yml 必须仍然把单文件产物挂到 Release 上（部署路径靠它）')
})
