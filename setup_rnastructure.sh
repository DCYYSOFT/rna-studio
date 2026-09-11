#!/usr/bin/env bash
# 安装可选的第二个预测引擎：RNAstructure（Mathews lab）
#
# 不装也能用 —— 默认引擎 ViennaRNA 已覆盖全部功能。
# 装它的价值在于：换一套热力学参数交叉验证预测结果，
# 以及使用 ProbKnot（给出含假结的结构）和 MaxExpect（最大期望准确度）。
#
# 用法：  ./setup_rnastructure.sh

set -euo pipefail

cd "$(dirname "$0")"

OS="$(uname -s)"
ARCH="$(uname -m)"
DEST="vendor/RNAstructure"

BASE="https://rna.urmc.rochester.edu/Releases/current"

case "$OS" in
  Darwin)
    URL="$BASE/RNAstructureTextInterfacesMac.tgz"
    ;;
  Linux)
    if [[ "$ARCH" == "x86_64" ]]; then
      URL="$BASE/RNAstructureLinuxTextInterfaces64bit.tgz"
    else
      URL="$BASE/RNAstructureLinuxTextInterfaces.tgz"
    fi
    ;;
  *)
    echo "不支持的平台：$OS。请手动到 https://rna.urmc.rochester.edu/RNAstructureDownload.html 下载。"
    exit 1
    ;;
esac

echo "系统：$OS / $ARCH"
echo "下载：$URL"
echo

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! curl -fL --progress-bar -o "$TMP/rs.tgz" "$URL"; then
  echo
  echo "下载失败。可以手动下载后解压到 $DEST/（目录内应含 exe/ 与 data_tables/）。"
  exit 1
fi

echo
echo "解压到 $DEST …"
rm -rf "$DEST"
mkdir -p vendor
tar xzf "$TMP/rs.tgz" -C vendor

# 压缩包里的顶层目录可能是 RNAstructure，也可能不是，这里统一一下
if [[ ! -d "$DEST" ]]; then
  FIRST="$(find vendor -maxdepth 1 -mindepth 1 -type d -name 'RNAstructure*' | head -1)"
  if [[ -n "$FIRST" ]]; then mv "$FIRST" "$DEST"; fi
fi

if [[ ! -x "$DEST/exe/Fold" ]]; then
  echo "解压后没找到 $DEST/exe/Fold。请检查压缩包结构。"
  exit 1
fi

echo "校验可执行文件…"
if ! "$DEST/exe/Fold" --version >/dev/null 2>&1; then
  echo
  echo "警告：无法执行 $DEST/exe/Fold"
  if [[ "$OS" == "Darwin" && "$ARCH" == "arm64" ]]; then
    echo "  官方 macOS 版是 x86_64 二进制，Apple Silicon 需要 Rosetta 2。请执行："
    echo "      softwareupdate --install-rosetta --agree-to-license"
    echo "  装好后重新运行本脚本，或直接启动应用（会自动重试）。"
  else
    echo "  可能是架构不匹配或缺少动态库。"
  fi
else
  echo "  ✓ Fold 可以运行"
fi

echo
echo "完成。启动应用时会自动发现 $DEST。"
echo "如果你的安装位置不在这里，可以设置环境变量后启动："
echo "    export RNASTRUCTURE_PATH=/路径/到/RNAstructure"
echo "    ./run.sh"
