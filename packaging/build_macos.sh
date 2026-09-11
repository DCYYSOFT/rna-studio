#!/usr/bin/env bash
# 在 macOS 上构建 RNA Studio.app 并打成 .dmg
#
# 前置条件（本机需联网）：
#   · Python 3.9+
#   · JDK 17+（提供 jlink，用来生成随包的精简 JRE）
#       建议： brew install openjdk@21
#   若没装 JDK，脚本会跳过 JRE 打包，装出来的应用出图时会去找系统 Java。
#
# 用法：  ./packaging/build_macos.sh
# 产物：  dist/RNA Studio.app  和  release/RNA-Studio-<版本>-macOS-<架构>.dmg

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP_NAME="RNA Studio"
VERSION="0.0.4"
OUT="$ROOT/release"

echo "==> 项目目录：$ROOT"
echo "==> 架构：$(uname -m)"

# ───────────────────────── 1. Python 依赖 ─────────────────────────

VENV="$ROOT/.venv-build"
if [[ ! -d "$VENV" ]]; then
  echo "==> 创建构建用虚拟环境"
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "==> 安装依赖"
python -m pip install --upgrade pip >/dev/null
python -m pip install -r requirements.txt -r requirements-desktop.txt

# ───────────────────────── 2. 精简 JRE ─────────────────────────

JRE="$ROOT/jre"
rm -rf "$JRE"

JLINK=""
if command -v jlink >/dev/null 2>&1; then
  JLINK="$(command -v jlink)"
else
  # 常见 Homebrew 安装位置
  for c in /opt/homebrew/opt/openjdk*/bin/jlink /usr/local/opt/openjdk*/bin/jlink; do
    [[ -x "$c" ]] && JLINK="$c" && break
  done
fi
# 也试试 JAVA_HOME
if [[ -z "$JLINK" && -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/jlink" ]]; then
  JLINK="$JAVA_HOME/bin/jlink"
fi

if [[ -n "$JLINK" ]]; then
  echo "==> 用 jlink 生成精简 JRE（VARNA 需要 java.desktop）"
  "$JLINK" \
    --add-modules java.base,java.desktop,java.logging,java.prefs \
    --strip-debug --no-man-pages --no-header-files --compress=zip-6 \
    --output "$JRE"
  du -sh "$JRE"
  echo "    自检："
  "$JRE/bin/java" -version 2>&1 | head -1 | sed 's/^/      /'
else
  echo "==> 未找到 jlink，跳过 JRE 打包。"
  echo "    应用仍可用，但 VARNA 出图需要用户机器上装了 Java。"
  echo "    想带上 JRE 的话： brew install openjdk@21 后重跑本脚本。"
fi

# ───────────────────────── 3. PyInstaller ─────────────────────────

echo "==> 打包"
rm -rf "$ROOT/build" "$ROOT/dist"
python -m PyInstaller --noconfirm --clean \
  --distpath "$ROOT/dist" --workpath "$ROOT/build" \
  packaging/rna-studio.spec

APP_PATH="$ROOT/dist/$APP_NAME.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "打包失败：没有生成 $APP_PATH" >&2
  exit 1
fi

# ───────────────────────── 4. 签名 ─────────────────────────

# 没有开发者证书时做 ad-hoc 签名。这样至少能通过本机 Gatekeeper 的
# 「已损坏」检查，用户仍会看到「未验证开发者」提示，需右键→打开。
echo "==> ad-hoc 签名"
codesign --force --deep --sign - "$APP_PATH" 2>/dev/null \
  && echo "    已签名（ad-hoc）" \
  || echo "    签名失败，不影响使用（用户需右键→打开）"

# ───────────────────────── 5. 打 DMG ─────────────────────────

mkdir -p "$OUT"
rm -f "$OUT"/*.dmg

ARCH="$(uname -m)"     # arm64 / x86_64
DMG="$OUT/RNA-Studio-${VERSION}-macOS-${ARCH}.dmg"

echo "==> 生成 DMG"
STAGE="$(mktemp -d)"
cp -R "$APP_PATH" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/首次打开请先读我.txt" <<'TXT'
macOS 首次打开会提示「无法验证开发者」，这是正常的（本应用未做苹果开发者签名）。

打开方法（任选一种）：
  1. 在「应用程序」里右键点击 RNA Studio →「打开」→ 再点一次「打开」。
     只需做一次，之后双击即可正常启动。
  2. 或在终端执行： xattr -dr com.apple.quarantine "/Applications/RNA Studio.app"

安装：把 RNA Studio 拖到旁边的 Applications 文件夹即可。

应用自带运行环境（含 Java），不需要额外安装任何东西。
TXT

# 给 DMG 卷本身也设个图标（需要 SetFile，没装 Xcode 命令行工具时跳过）
cp -f "$ROOT/packaging/icons/icon.icns" "$STAGE/.VolumeIcon.icns" 2>/dev/null || true
if command -v SetFile >/dev/null 2>&1; then
  SetFile -a C "$STAGE" 2>/dev/null || true
fi

hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

echo
echo "==> 完成"
echo "    应用：$APP_PATH"
echo "    安装包：$DMG  ($(du -h "$DMG" | cut -f1))"
