#!/usr/bin/env bash
#
# 把 AI Workflows 装到 /Applications，并解除 macOS 的隔离标记。
#
#   bash scripts/install-app.sh ~/Downloads/AI\ Workflows_0.2.0_universal.dmg
#   bash scripts/install-app.sh                 # 自己找 ~/Downloads 里最新的那个
#
# ## 为什么需要这一步
#
# 这个应用在公司内部分发，没有经过 Apple 公证 —— 公证需要 Developer ID
# 证书（99 美元/年的付费账号），而内部工具犯不上。
#
# 代价是：从网上下载的文件会被打上 `com.apple.quarantine` 标记，
# Gatekeeper 见到「有隔离标记 + 没公证」就拦下来。macOS 15 起
# **右键 → 打开也不再绕得过**，Apple 把那条路堵了。
#
# 所以这个脚本做的就是把那个标记去掉。它只对我们自己构建的这一个 App
# 动手，路径写死，不接受任意参数 —— 拿它去解除别处下载的东西的隔离
# 是另一回事，别那么用。
#
# 不使用 sudo：装到 /Applications 不需要（那个目录当前用户可写），
# 而要 sudo 的命令等于把整台机器交出去。

set -euo pipefail

APP_NAME="AI Workflows.app"
DEST="/Applications/$APP_NAME"

DMG="${1:-}"
if [ -z "$DMG" ]; then
  # 没给路径就找 ~/Downloads 里最新的那个
  DMG="$(ls -t "$HOME"/Downloads/*AI*Workflows*.dmg 2>/dev/null | head -1 || true)"
fi

if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "找不到 dmg。用法：" >&2
  echo "  bash scripts/install-app.sh ~/Downloads/AI\\ Workflows_x.y.z_universal.dmg" >&2
  exit 1
fi

echo "▸ 挂载 $DMG"
MOUNT="$(mktemp -d)"
hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MOUNT"
# 无论后面成功与否都卸载：留一堆挂载点在那儿是很烦人的副作用
trap 'hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; rmdir "$MOUNT" 2>/dev/null || true' EXIT

if [ ! -d "$MOUNT/$APP_NAME" ]; then
  echo "dmg 里没有 $APP_NAME —— 这个包可能不是 AI Workflows" >&2
  exit 1
fi

if [ -d "$DEST" ]; then
  echo "▸ 移除旧版本 $DEST"
  rm -rf "$DEST"
fi

echo "▸ 复制到 /Applications"
cp -R "$MOUNT/$APP_NAME" /Applications/

# 隔离标记在这里去掉。
#
# 不去的话首次打开会是「无法打开，因为无法验证开发者」，
# 而在系统设置里点「仍要打开」每装一次都要重来一遍。
echo "▸ 解除隔离标记（内部分发未经公证，见脚本开头的说明）"
xattr -dr com.apple.quarantine "$DEST"

# 顺手确认签名还在。ad-hoc 签名（identity "-"）是构建时加的，
# Apple Silicon 要求 arm64 可执行文件必须有它，否则 Gatekeeper 直接判「已损坏」。
if codesign --verify --deep --strict "$DEST" 2>/dev/null; then
  echo "▸ 签名校验通过（ad-hoc）"
else
  echo "⚠️  签名校验没过。应用可能仍然打得开，但如果报「已损坏」，" >&2
  echo "   多半是构建时漏了 APPLE_SIGNING_IDENTITY='-'" >&2
fi

echo
echo "装好了：$DEST"
echo "直接双击打开，或者：open '$DEST'"
