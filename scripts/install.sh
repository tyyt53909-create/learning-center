#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/tyyt53909-create/learning-center.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/learning-center}"
AUTO_START="${AUTO_START:-1}"

echo "========================================"
echo "  学习中心（Learning Center）一键安装"
echo "========================================"

if ! command -v git >/dev/null 2>&1; then
  echo "✗ 未检测到 git，请先安装 git 后重试。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 Node.js，请先安装 Node.js 24+（推荐 24.15+ 或 26+）：" >&2
  echo "  macOS: brew install node" >&2
  echo "  官网:  https://nodejs.org/" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "✗ 当前 Node.js 版本为 $(node -v)，需要 Node.js 24.15+ 或 26+。" >&2
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "→ 检测到已存在目录 $INSTALL_DIR，正在拉取最新代码…"
  git -C "$INSTALL_DIR" pull --ff-only
else
  if [ -e "$INSTALL_DIR" ]; then
    echo "✗ 目标路径 $INSTALL_DIR 已存在且不是 git 仓库，请通过 INSTALL_DIR 指定其他目录。" >&2
    exit 1
  fi
  echo "→ 正在拉取代码到 $INSTALL_DIR …"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

echo "→ 正在安装依赖…"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "→ 正在构建 Web 前端与 Chrome 扩展…"
npm run build

echo ""
echo "✓ 安装完成！目录：$INSTALL_DIR"
echo "  访问地址：http://127.0.0.1:3000"
echo "  后续启动：cd \"$INSTALL_DIR\" && npm start"
echo ""

if [ "$AUTO_START" = "1" ]; then
  echo "→ 正在启动学习中心（按 Ctrl+C 停止）…"
  exec node --env-file-if-exists=.env server/index.js
fi
