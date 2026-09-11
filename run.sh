#!/usr/bin/env bash
# RNA Studio 一键启动
#   首次运行会创建虚拟环境并安装依赖（需要联网），之后直接启动。
#   用法：  ./run.sh            启动并在浏览器打开
#           ./run.sh --port 9000 指定端口
#           ./run.sh --no-browser 不自动开浏览器

set -euo pipefail

cd "$(dirname "$0")"

PORT=8765
OPEN_BROWSER=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --no-browser) OPEN_BROWSER=0; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "找不到 python3。请先安装 Python 3.9 或更高版本：https://www.python.org/downloads/"
  exit 1
fi

PYVER=$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])')
echo "使用 Python $PYVER"

VENV=".venv"
if [[ ! -d "$VENV" ]]; then
  echo "首次运行：创建虚拟环境 $VENV …"
  "$PY" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

# 依赖装齐了就不再重复安装
STAMP="$VENV/.deps-ok"
if [[ ! -f "$STAMP" ]]; then
  echo "安装依赖（需要联网，约 1–2 分钟）…"
  python -m pip install --upgrade pip >/dev/null
  if ! python -m pip install -r requirements.txt; then
    echo
    echo "依赖安装失败。常见原因："
    echo "  · 网络不通，或需要配置 pip 镜像（例如 -i https://pypi.tuna.tsinghua.edu.cn/simple）"
    echo "  · ViennaRNA 没有对应 wheel，需要源码编译 → 先装 Xcode 命令行工具："
    echo "      xcode-select --install"
    exit 1
  fi
  touch "$STAMP"
fi

# 环境自检：把可用的引擎与 VARNA 状态打印出来，便于排查
echo
python - <<'PY'
import sys, json
sys.path.insert(0, ".")
try:
    from server import engines, varna
    for s in engines.statuses():
        mark = "✓" if s.available else "✗"
        print(f"  {mark} {s.name:14s} {s.version or s.detail[:40]}")
    v = varna.status()
    print(f"  {'✓' if v['available'] else '✗'} VARNA         "
          f"{'Java ' + str(v['java_version']) if v['java'] else '未找到 java'}")
    if not v["available"]:
        for p in v["problems"]:
            print(f"      ! {p}")
except Exception as e:  # 自检失败不阻塞启动
    print(f"  (自检跳过：{e})")
PY

URL="http://127.0.0.1:${PORT}/"
echo
echo "启动服务：${URL}"
echo "按 Ctrl+C 停止"
echo

if [[ "$OPEN_BROWSER" == "1" ]]; then
  (
    for _ in $(seq 1 40); do
      sleep 0.5
      if curl -s -o /dev/null "${URL}api/status" 2>/dev/null; then
        case "$(uname -s)" in
          Darwin) open "$URL" ;;
          Linux)  command -v xdg-open >/dev/null && xdg-open "$URL" ;;
        esac
        break
      fi
    done
  ) &
fi

exec python -m uvicorn server.app:app --host 127.0.0.1 --port "$PORT"
