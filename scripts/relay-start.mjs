#!/usr/bin/env node
/**
 * relay-start — 在本地起一个中继（开发与真链路取证用）。
 *
 *   node scripts/relay-start.mjs                     # 127.0.0.1:8787，token 取自 $DRC_HOST_TOKEN
 *   DRC_PORT=9000 node scripts/relay-start.mjs
 *   node scripts/relay-start.mjs --bundle            # 跑单文件产物，与生产形态一致
 *
 * ## v2 → v3：从 `.sh` 改成 `.mjs`（A4）
 *
 * v2 用 `grep -oE 'hostToken:…' | head -1 | sed -E …` 从 profile 的 patch 文件里抽凭据。
 * 三个理由：
 * 1. **`grep` / `sed` 在 Windows 上不存在**（Git Bash 之外）——不是"不支持"，是 ENOENT；
 * 2. 那条正则要同时吃引号、可选引号、行尾空白，写在 shell 里每换一次就要重新对一遍引号；
 * 3. `sh` 本身也是同一个问题。
 * 现在是一段可被单测读到的 JS。
 *
 * ## token 的处理纪律（v2 的注释逐条保留）
 *
 * token 必须与主机插件那份逐字一致。主路径是从环境变量传；作为便利（仅本地开发），
 * 脚本也会去 DSH profile 的 cordis patch 文件里抓一行 `hostToken:`。
 * **任何情况下最多只打印前 4 位**（短于 4 字符时连那 4 位也不打印）——完整值绝不外泄。
 *
 * ⚠️ 日志级别默认 **info**，不是 debug：`server.ts` 在 debug 级会把**完整配对码**打进日志
 * （`pair token issued (debug)`，那是本地排错的最后一招）。把这个脚本的默认级别定在 debug，
 * 等于"照文档起一个中继"就默认落了一份完整码到终端/日志里。需要看码时显式开。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const PROFILE = process.env.DSH_PROFILE ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const PATCH_FILE = path.join(PROFILE, 'cordis.patch.yml')
const PORT = process.env.DRC_PORT ?? '8787'
const ARTIFACT = process.argv.includes('--bundle')
  ? path.join(ROOT, 'dist', 'bundle', 'main.js')
  : path.join(ROOT, 'dist', 'src', 'main.js')

/**
 * 从 patch 文件里取 `hostToken:` 的值（可有可无可选引号）。
 *
 * 逐行扫而不是一条大正则：patch 是 YAML，`hostToken:` 后面可能跟注释、空格、引号。
 * 取**第一条**命中——profile 里只会有一份。
 */
export function readHostToken(yaml) {
  for (const line of String(yaml).split('\n')) {
    const m = /^\s*hostToken:\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[1].trim()
    // 去掉行尾注释（`#` 前要有空白才算，避免动到值里的 `#`）
    value = value.replace(/\s+#.*$/, '').trim()
    // 剥掉成对引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value) return value
  }
  return ''
}

function fail(message) {
  process.stderr.write(`relay-start: ${message}\n`)
  process.exit(1)
}

/**
 * 启动本体。
 *
 * 刻意与上面的纯逻辑分开，并用「这是主模块吗」守卫：否则判据 `import` 一下
 * `readHostToken` 就会真的起一个中继（而那条判据只是想验 YAML 解析）。
 */
function start() {
  if (!process.env.DRC_HOST_TOKEN && existsSync(PATCH_FILE)) {
    process.env.DRC_HOST_TOKEN = readHostToken(readFileSync(PATCH_FILE, 'utf8'))
    const token = process.env.DRC_HOST_TOKEN
    if (token) {
      // 只在长度 >= 4 时才取前 4 位：短于 4 的 token，`%${VAR#????}` 求值出的是**整个值**，
      // 那句"任何情况下只打印前 4 位"会在这里当场破功（v2 的 P2）。
      if (token.length >= 4) {
        process.stdout.write(
          `relay-start: 从 ${PATCH_FILE} 读到 hostToken（以 ${token.slice(0, 4)}… 开头，完整值不打印）\n`,
        )
      } else {
        process.stdout.write(
          `relay-start: 从 ${PATCH_FILE} 读到 hostToken（长度 ${token.length}，短于 4 字符，完整值不打印）\n`,
        )
      }
    }
  }

  if (!process.env.DRC_HOST_TOKEN) {
    fail(`没有 DRC_HOST_TOKEN，${PATCH_FILE} 里也没找到。`)
    fail('             显式传一个：DRC_HOST_TOKEN=xxx node scripts/relay-start.mjs')
  }

  if (!existsSync(ARTIFACT)) {
    fail(`产物 ${ARTIFACT} 不存在——先跑 \`pnpm build\``)
  }

  const env = {
    ...process.env,
    DRC_HOST_TOKEN: process.env.DRC_HOST_TOKEN,
    DRC_PORT: PORT,
    DRC_BIND: process.env.DRC_BIND ?? '127.0.0.1',
    // **info**，不是 debug：理由见文件头。
    DRC_LOG_LEVEL: process.env.DRC_LOG_LEVEL ?? 'info',
    DRC_PAIR_TTL_MS: process.env.DRC_PAIR_TTL_MS ?? '120000',
  }
  process.stdout.write(`relay-start: ${ARTIFACT} listening on ${env.DRC_BIND}:${env.DRC_PORT}\n`)

  // `exec` 语义（v2 的最后一行）：信号要直达中继进程，stdio 继承。
  // spawn + stdio:'inherit' 达不到 exec 的效果，所以显式转发信号。
  const child = spawn(process.execPath, [ARTIFACT], { env, stdio: 'inherit' })
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal)
    })
  }
  child.on('exit', (code, signal) => {
    process.exit(signal ? 0 : (code ?? 0))
  })
}

// 主模块守卫：被 import 时只跑纯逻辑（readHostToken），不启动中继。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  start()
}
