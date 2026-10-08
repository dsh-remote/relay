#!/bin/sh
# relay-start.sh — 在本地起一个中继（开发与真链路取证用）。
#
#   ./scripts/relay-start.sh                     # 127.0.0.1:8787，token 取自 $DRC_HOST_TOKEN
#   DRC_PORT=9000 ./scripts/relay-start.sh
#   ./scripts/relay-start.sh --bundle            # 跑单文件产物，与生产形态一致
#
# token 必须与主机插件那份逐字一致。主路径是从环境变量传；作为便利（仅本地开发），
# 脚本也会去 DSH profile 的 cordis patch 文件里抓一行 `hostToken:`。
# 任何情况下最多只打印前 4 位（短于 4 字符时连那 4 位也不打印）——完整值绝不外泄。
# 日志级别默认 info（debug 会打印完整配对码，要排错时显式开）。
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/desktop}"
PATCH_FILE="$PROFILE/cordis.patch.yml"
PORT="${DRC_PORT:-8787}"
ARTIFACT="$ROOT/dist/src/main.js"
BUNDLE="$ROOT/dist/bundle/main.js"

if [ "$1" = "--bundle" ]; then
  ARTIFACT="$BUNDLE"
fi

if [ -z "$DRC_HOST_TOKEN" ] && [ -f "$PATCH_FILE" ]; then
  # 抓 `hostToken:` 那一行（值可能带引号）。
  DRC_HOST_TOKEN=$(grep -oE 'hostToken:[[:space:]]*"?[^"[:space:]]+"?' "$PATCH_FILE" | head -1 | sed -E 's/^hostToken:[[:space:]]*"?//; s/"$//')
  # 只在长度 >= 4 时才取前 4 位：短于 4 的 token，`%"${VAR#????}"` 求值出的是整个值，
  # 那句"任何情况下只打印前 4 位"会在这里当场破功（P2）。
  if [ -n "$DRC_HOST_TOKEN" ]; then
    if [ "${#DRC_HOST_TOKEN}" -ge 4 ]; then
      echo "relay-start: 从 $PATCH_FILE 读到 hostToken（以 ${DRC_HOST_TOKEN%"${DRC_HOST_TOKEN#????}"}… 开头，完整值不打印）"
    else
      echo "relay-start: 从 $PATCH_FILE 读到 hostToken（长度 ${#DRC_HOST_TOKEN}，短于 4 字符，完整值不打印）"
    fi
  fi
fi

if [ -z "$DRC_HOST_TOKEN" ]; then
  echo "relay-start: 没有 DRC_HOST_TOKEN，$PATCH_FILE 里也没找到。" >&2
  echo "             显式传一个：DRC_HOST_TOKEN=xxx ./scripts/relay-start.sh" >&2
  exit 1
fi

if [ ! -f "$ARTIFACT" ]; then
  echo "relay-start: 产物 $ARTIFACT 不存在——先跑 \`pnpm build\`" >&2
  exit 1
fi

export DRC_HOST_TOKEN DRC_PORT="$PORT" DRC_BIND="${DRC_BIND:-127.0.0.1}"
# **info**，不是 debug：`server.ts` 在 debug 级会把**完整配对码**打进日志
# （`pair token issued (debug)`，那是本地排错的最后一招）。把这个脚本的默认级别
# 定在 debug，等于"照文档起一个中继"就默认落了一份完整码到终端/日志里（P2）。
# 需要看码时显式开：DRC_LOG_LEVEL=debug ./scripts/relay-start.sh
export DRC_LOG_LEVEL="${DRC_LOG_LEVEL:-info}"
export DRC_PAIR_TTL_MS="${DRC_PAIR_TTL_MS:-120000}"
echo "relay-start: $ARTIFACT listening on $DRC_BIND:$DRC_PORT"
exec node "$ARTIFACT"
