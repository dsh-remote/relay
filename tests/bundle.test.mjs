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
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const BUNDLE = new URL('../dist/bundle/main.js', import.meta.url).pathname
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

test('单文件在没有 node_modules 的空目录里能启动、应答健康检查并优雅退出', async () => {
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

    const exitCode = new Promise((resolve) => child.on('exit', resolve))
    child.kill('SIGTERM')
    assert.equal(await Promise.race([exitCode, sleep(3000).then(() => 'timeout')]), 0, '优雅停机必须 exit 0')
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
 * 分发决策的闸门：**本仓不发 npm**。原因很硬——`dsh-remote-server` 这个包名在 npm 上属于
 * 另一个无关项目（`bondzhu` / `MRZHUH/dsh-remote-server`，一个"在 DSH 会话里 @ 服务器走 SSH
 * 执行命令"的工具），2026-10-03 用户拍板"先不发"。
 * 这里钉的是**别半发**：半发的形状是 package.json 去掉了 private、release.yml 里多了一步
 * publish，而包名撞墙——结局要么红在 CI，要么更糟：装到别人的东西。
 * 末尾两条与发不发无关，是产物事实：运行时依赖为空、shebang 在第一行。
 */
test('本仓不发 npm：private 必须为 true，release.yml 里不许出现发包步骤与 id-token', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.private, true, 'private 被去掉了：那意味着有人准备发包，但这个名字是别人的')
  assert.equal(pkg.bin, undefined, 'bin 是发包才需要的东西，留着它会让人以为 npm 上装得到')
  assert.equal(pkg.files, undefined, 'files 白名单同理：它只会诱导别人去 npm pack 一个私有包')
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.doesNotMatch(workflow, /(npm|pnpm)\s+(publish|pack)\b/, 'release.yml 里出现了发包步骤，而本仓不发 npm')
  assert.doesNotMatch(workflow, /id-token: write/, 'id-token 只为 OIDC provenance 存在；不发 npm 就不该申请这个权限')
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
})
