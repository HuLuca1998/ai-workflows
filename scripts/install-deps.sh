#!/usr/bin/env bash
#
# 一键补齐运行工作流所需的依赖。
#
#   bash scripts/install-deps.sh          # 交互：逐项问过再装
#   bash scripts/install-deps.sh --yes    # 不问，装齐所有缺的
#   bash scripts/install-deps.sh --dry-run # 只打印将执行的命令
#
# 三条不可协商的原则（来自图纸「06 首次安装与检测」）：
#
#   1. **不使用 sudo**。要 sudo 的命令等于把整台机器交出去，
#      而用户多半会照贴不误。
#   2. **不改 shell profile**。装完之后 PATH 由各工具自己的安装器负责，
#      我们不往 ~/.zshrc 里塞任何东西。
#   3. **先列出要执行什么，确认后才执行**。这个脚本本身可读，
#      每条命令执行前也会打印出来。
#
# 应用自己不下载任何东西 —— 它只告诉你缺什么，然后让你跑这个脚本。
# 这样攻击面就只有你能看到的这几行。

set -euo pipefail

YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) YES=1 ;;
    --dry-run | -n) DRY_RUN=1 ;;
    --help | -h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "不认识的参数：$arg（--yes / --dry-run / --help）" >&2
      exit 2
      ;;
  esac
done

# ── 要检查的依赖 ───────────────────────────────────────────────────────
#
# 与 crates/core-api/src/env.rs 的 PROBES 保持一致。
# 那边是给界面看的，这边是真去装的 —— 两份都在，是因为脚本不该依赖
# 应用能跑起来（用户装依赖的时候，应用多半还跑不起来）。
#
# 格式：能力⋮显示名⋮探测命令⋮安装命令⋮是否必需
#
# 分隔符用 ⋮ 而不是 |：uv 的官方安装命令里就有一个管道，
# 用 | 分隔的话那条会被切成两段 —— 症状是「可选」标记莫名消失。
DEPS=(
  "git⋮Git⋮git⋮xcode-select --install⋮required"
  "node⋮Node.js⋮node⋮brew install node@22⋮required"
  "uv⋮Python (uv)⋮uv⋮curl -LsSf https://astral.sh/uv/install.sh | sh⋮optional"
  "gh⋮GitHub CLI⋮gh⋮brew install gh⋮optional"
  "docker⋮Docker / OrbStack⋮docker⋮brew install --cask orbstack⋮optional"
)

has() { command -v "$1" >/dev/null 2>&1; }

echo "▸ 检查运行工作流所需的依赖"
echo

missing=()
for dep in "${DEPS[@]}"; do
  IFS='⋮' read -r cap label probe install need <<<"$dep"
  if has "$probe"; then
    version="$("$probe" --version 2>/dev/null | head -1 || echo '')"
    printf '  ✓ %-22s %s\n' "$label" "${version:-已安装}"
  else
    mark=$([ "$need" = required ] && echo '✗' || echo '·')
    printf '  %s %-22s 未安装%s\n' "$mark" "$label" \
      "$([ "$need" = optional ] && echo '（可选）' || echo '')"
    missing+=("$dep")
  fi
done

echo
if [ ${#missing[@]} -eq 0 ]; then
  echo "全部就绪，不用装任何东西。"
  exit 0
fi

# brew 是好几条命令的前提。它自己的安装要用户亲自去官网 ——
# 我们不代跑一段从网上拉的安装脚本
needs_brew=0
for dep in "${missing[@]}"; do
  IFS='⋮' read -r _ _ _ install _ <<<"$dep"
  [[ "$install" == brew* ]] && needs_brew=1
done

if [ "$needs_brew" = 1 ] && ! has brew; then
  echo "有几项要用 Homebrew，但这台机器上没有。"
  echo "先去 https://brew.sh 按官方说明装好，再回来跑这个脚本。"
  echo
  echo "（不代跑 brew 的安装脚本：那是一段从网上拉下来的代码，"
  echo "  该由你自己看过再决定。）"
  exit 1
fi

echo "将要执行（不使用 sudo，不改 shell profile）："
echo
for dep in "${missing[@]}"; do
  IFS='⋮' read -r _ label _ install _ <<<"$dep"
  printf '  # %s\n  %s\n\n' "$label" "$install"
done

if [ "$DRY_RUN" = 1 ]; then
  echo "（--dry-run：什么都没执行）"
  exit 0
fi

if [ "$YES" != 1 ]; then
  read -r -p "执行以上命令？[y/N] " answer
  case "$answer" in
    [yY] | [yY][eE][sS]) ;;
    *)
      echo "已取消。"
      exit 0
      ;;
  esac
fi

failed=()
for dep in "${missing[@]}"; do
  IFS='⋮' read -r _ label _ install _ <<<"$dep"
  echo
  echo "▸ $label"
  echo "  \$ $install"
  # 一项失败不中断其余：装不上 Docker 不该挡住装 gh
  if ! eval "$install"; then
    failed+=("$label")
    echo "  ✗ 装失败，跳过"
  fi
done

echo
if [ ${#failed[@]} -gt 0 ]; then
  echo "以下项没装上，按上面的命令自己试一次："
  printf '  - %s\n' "${failed[@]}"
  exit 1
fi

echo "装完了。回应用里点「重新检查」确认。"
