#!/usr/bin/env bash
# 把 RNA Studio 推送到 GitHub，从而触发 Actions 自动构建 macOS / Windows 安装包。
#
# 用法（在项目根目录执行）：
#   ./push_to_github.sh                 交互式，脚本会问你仓库名
#   ./push_to_github.sh rna-studio      指定仓库名
#   ./push_to_github.sh <完整仓库地址>   直接推到你已建好的仓库
#
# 两条路径：
#   A. 装了 gh CLI 并已登录 → 自动创建仓库并推送，全程无需打开浏览器
#        mac 装法： brew install gh && gh auth login
#   B. 没有 gh → 脚本帮你初始化并提交，然后你到网页上建一个空仓库，
#        把地址粘回来，脚本继续推送

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
APP="RNA Studio"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m！ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ───────────────────────── 前置检查 ─────────────────────────

command -v git >/dev/null 2>&1 || die "没找到 git。macOS 上执行 xcode-select --install 安装。"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 && ALREADY_REPO=1 || ALREADY_REPO=0

# git 身份：没有就让用户填，否则 commit 会失败
if [[ -z "$(git config user.email || true)" ]]; then
  warn "还没有配置 git 身份（提交记录需要署名）"
  echo "    可以直接用下面这行，把邮箱换成你 GitHub 账号的邮箱："
  echo "      git config --global user.name \"你的名字\""
  echo "      git config --global user.email \"you@example.com\""
  echo
  read -r -p "    现在就设置？输入你的 GitHub 邮箱（留空则退出）: " EMAIL
  [[ -n "$EMAIL" ]] || die "请先配置 git 身份后再运行本脚本。"
  read -r -p "    显示名（默认用邮箱前缀）: " NAME
  git config --global user.email "$EMAIL"
  git config --global user.name "${NAME:-${EMAIL%%@*}}"
  echo "    已设置：$(git config user.name) <$(git config user.email)>"
fi

# ───────────────────────── 确认提交范围 ─────────────────────────

say "检查将要提交的内容"

# 这些是本地产物，绝不能推上去（尤其 .venv 和 jre 是几十上百 MB 的平台相关文件）
BAD_PRESENT=()
for d in .venv .venv-build jre runtime dist build release; do
  [[ -e "$d" ]] && BAD_PRESENT+=("$d")
done
if [[ ${#BAD_PRESENT[@]} -gt 0 ]]; then
  echo "    本地产物（不会被提交）：${BAD_PRESENT[*]}"
fi
for f in rna-studio.log; do
  [[ -e "$f" ]] && echo "    日志（不会被提交）：$f"
done

if [[ ! -f .gitignore ]]; then
  die "缺少 .gitignore —— 没有它会把 .venv、jre 等大文件一起推上去。"
fi

echo "    将提交的文件："
git init -q 2>/dev/null || true
git add -A
git status --short | sed 's/^/      /' | head -40
COUNT=$(git diff --cached --name-only | wc -l | tr -d ' ')
echo "    共 $COUNT 个文件"

# 保险：确认没有把大目录暂存进去
if git diff --cached --name-only | grep -qE '^(\.venv|jre|dist|build|release)/'; then
  die "有本地产物被暂存了。请检查 .gitignore，然后 git reset 重来。"
fi

[[ "$COUNT" -gt 0 ]] || say "没有新改动需要提交"

# ───────────────────────── 提交 ─────────────────────────

if [[ "$COUNT" -gt 0 ]]; then
  say "创建提交"
  git commit -q -m "RNA Studio：RNA 二级结构预测 / 可视化 / 手动建模工具

- 预测引擎：ViennaRNA（进程内）+ RNAstructure（命令行，自动探测）
- 功能：MFE 预测、约束预测（锁定/禁止配对 + SHAPE/DMS）、
  手动编辑后实时重算 ΔG、RNA–RNA 共折叠
- 出图：内置矢量导出 + VARNA（随包精简 JRE）
- 打包：PyInstaller + GitHub Actions，自动产出 macOS ARM 与 Windows 安装包"
  echo "    提交完成：$(git log -1 --oneline)"
fi

git branch -M main 2>/dev/null || true

# ───────────────────────── 推送到 GitHub ─────────────────────────

TARGET="${1:-}"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  say "检测到 gh CLI 且已登录，自动创建仓库并推送"

  if [[ -n "$TARGET" && "$TARGET" == */* && "$TARGET" != */*/* ]]; then
    REPO="$TARGET"
  else
    REPO="${TARGET:-rna-studio}"
  fi

  if git remote get-url origin >/dev/null 2>&1; then
    echo "    已有 origin：$(git remote get-url origin)，直接推送"
    git push -u origin main
  else
    # private 仓库同样可以免费用 Actions（公开仓库则完全不消耗额度）
    gh repo create "$REPO" --private --source=. --remote=origin --push
  fi

  URL="$(git remote get-url origin | sed -e 's#git@github.com:#https://github.com/#' -e 's#\.git$##')"
  say "完成"
  echo "    仓库：$URL"
  echo "    构建进度：$URL/actions"
  echo
  echo "    大约 5–10 分钟后，在 Actions 页面那次运行的底部"
  echo "    Artifacts 区域就能下载两个安装包。"
  exit 0
fi

# 没有 gh：走网页建仓库 + 粘贴地址的方式
say "没有检测到可用的 gh CLI"
echo "    接下来需要你在浏览器里建一个空仓库（约 30 秒）："
echo
echo "      1. 打开 https://github.com/new"
echo "      2. Repository name 填： rna-studio"
echo "      3. 选 Private 或 Public 都行"
echo "      4. ⚠️ 不要勾选 Add README / .gitignore / license（会与本地冲突）"
echo "      5. 点 Create repository，把页面上给的地址复制过来"
echo
echo "    也可以先装 gh 让它全自动： brew install gh && gh auth login"
echo

read -r -p "    粘贴仓库地址（https://github.com/用户名/rna-studio.git，留空退出）: " REMOTE
[[ -n "$REMOTE" ]] || die "已取消。"

# 常见错法：粘了网页地址而不是 git 地址，这里自动纠正
REMOTE="${REMOTE%/}"
REMOTE="${REMOTE%.git}"
case "$REMOTE" in
  https://github.com/*) REMOTE="$REMOTE.git" ;;
  git@github.com:*)     REMOTE="$REMOTE.git" ;;
  *) ;;
esac

say "推送"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

git push -u origin main || {
  echo
  warn "推送失败。常见原因："
  echo "      · 仓库不是空的（建仓库时勾了 README）→"
  echo "        先执行 git pull --rebase origin main 再重试"
  echo "      · 没有权限 / 没登录 → 检查 HTTPS 凭据，或改用 SSH 地址"
  echo "      · 地址写错 → 重新运行本脚本，粘贴正确地址"
  exit 1
}

say "完成"
echo "    仓库：${REMOTE%.git}"
echo "    构建进度：${REMOTE%.git}/actions"
echo
echo "    大约 5–10 分钟后，在 Actions 页面那次运行的底部"
echo "    Artifacts 区域就能下载两个安装包。"
echo
echo "    想让安装包挂到 Releases 上方便分享，之后再执行："
echo "      git tag v0.0.2 && git push origin v0.0.2"
