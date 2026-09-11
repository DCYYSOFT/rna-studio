"""RNA Studio 桌面应用入口。

把 FastAPI 服务跑在后台线程里，再用 pywebview 开一个原生窗口指向它，
所以用户看到的是一个普通应用程序窗口，没有终端、也没有浏览器地址栏。

窗口后端因平台而异，都是系统自带的：
  * macOS   → WKWebView（系统自带，无需额外依赖）
  * Windows → WebView2（Win10/11 自带；极老的系统需装一次运行时）
  * Linux   → GTK/WebKitGTK（需系统装 libgtk-3 与 webkit2gtk）

若 pywebview 或窗口后端不可用，会退回「用默认浏览器打开」，并打印原因，
不会直接崩掉。
"""
from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import time
import traceback
from pathlib import Path

# 允许以 `python desktop.py` 直接运行（此时包目录还没进 sys.path）
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

APP_NAME = "RNA Studio"
WINDOW_W, WINDOW_H = 1440, 900
MIN_W, MIN_H = 900, 600


def _log_candidates() -> list[Path]:
    """日志文件的候选位置（按优先级）。"""
    out: list[Path] = []
    env = os.environ.get("RNA_STUDIO_LOG_FILE")
    if env:
        out.append(Path(env))
    if getattr(sys, "frozen", False):
        out.append(Path(sys.executable).resolve().parent / "rna-studio.log")
    out.append(Path.home() / "rna-studio.log")
    return out


def _open_fallback_stream():
    """给缺失的标准流找一个真实的落点：优先日志文件，实在不行丢进黑洞。"""
    for p in _log_candidates():
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            return p.open("a", encoding="utf-8", errors="replace", buffering=1)
        except OSError:
            continue
    return open(os.devnull, "w", encoding="utf-8")


def _force_utf8_streams() -> None:
    """让 sys.stdout / sys.stderr 一定可用。

    打包成窗口程序后（Windows 的 console=False 尤其如此）标准流是 None。
    而不少库会直接调用它们，例如 uvicorn 的日志 formatter 会执行
    ``sys.stdout.isatty()`` —— 实测这会让 uvicorn.Config 构造直接抛
    AttributeError，后端起不来，用户看到的现象就是「双击了没反应」。
    所以这里不仅要处理编码，还要保证流**存在**。

    Windows 标准流默认还是 cp1252/cp936，打印中文同样会抛
    UnicodeEncodeError，因此统一重新配置成 UTF-8。
    """
    fallback = None
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            if fallback is None:
                fallback = _open_fallback_stream()
            setattr(sys, name, fallback)
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def free_port(preferred: int = 0) -> int:
    """要一个空闲端口。preferred 为 0 时由系统分配。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", preferred))
        return s.getsockname()[1]


def serve_in_thread(port: int) -> threading.Thread:
    import uvicorn

    from server.app import app

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)

    t = threading.Thread(target=server.run, name="rna-studio-server", daemon=True)
    t.start()
    return t


def wait_ready(port: int, timeout: float = 30.0) -> bool:
    """等后端真的能响应再开窗口，避免白屏。"""
    import urllib.error
    import urllib.request

    url = f"http://127.0.0.1:{port}/api/status"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.15)
    return False


def _log_url(url: str, reason: str = "") -> Path | None:
    """把访问地址落盘。

    打包成 .app / .exe 后 console=False，**没有标准输出**，所以地址不能只靠
    print。这里同时支持：
      * 环境变量 RNA_STUDIO_URL_FILE 指定的路径（CI 冒烟测试用，位置确定）
      * 可执行文件旁边的 rna-studio.log（用户排查用）
      * 家目录下的 rna-studio.log（可执行文件所在目录只读时的退路）
    """
    import datetime

    candidates: list[Path] = []
    env = os.environ.get("RNA_STUDIO_URL_FILE")
    if env:
        candidates.append(Path(env))
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / "rna-studio.log")
    candidates.append(Path.home() / "rna-studio.log")

    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    body = f"[{ts}] {APP_NAME} 服务地址：{url}\n"
    if reason:
        body += f"[{ts}] 回退原因：{reason}\n"

    for p in candidates:
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            with p.open("a", encoding="utf-8") as f:
                f.write(body)
            return p
        except OSError:
            continue
    return None


def _native_alert(title: str, message: str) -> None:
    """在没有终端的情况下弹一个系统对话框。失败就算了，不阻塞主流程。"""
    try:
        if sys.platform == "win32":
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, message, title, 0x40)
        elif sys.platform == "darwin":
            import subprocess

            script = f'display dialog "{message}" with title "{title}" buttons {{"好"}} default button 1'
            subprocess.run(["osascript", "-e", script], timeout=120, check=False)
    except Exception:
        pass


def open_in_browser(url: str, reason: str = "") -> None:
    import webbrowser

    log = _log_url(url, reason)
    print(f"{APP_NAME} 已在默认浏览器中打开：{url}")
    if log:
        print(f"地址也记在了：{log}")
    print("关闭这个终端窗口即可退出程序。")

    opened = False
    try:
        opened = webbrowser.open(url)
    except Exception:
        opened = False

    if not opened:
        # 打包版没有终端，这里必须让用户看见地址
        msg = f"应用已在后台运行，请在浏览器中打开：\n\n{url}"
        if log:
            msg += f"\n\n地址也已写入：{log}"
        if reason:
            msg += f"\n\n（原生窗口不可用：{reason}）"
        _native_alert(APP_NAME, msg)

    try:
        while True:      # 保持进程存活，让后端继续服务
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


def main(argv: list[str] | None = None) -> int:
    _force_utf8_streams()
    ap = argparse.ArgumentParser(description=f"{APP_NAME} 桌面版")
    ap.add_argument("--port", type=int, default=0, help="固定端口（默认自动选择空闲端口）")
    ap.add_argument("--browser", action="store_true", help="已废弃：无窗口后端时会自动回退到浏览器")
    ap.add_argument("--debug", action="store_true", help="打开调试控制台")
    args = ap.parse_args(argv)

    port = free_port(args.port)
    serve_in_thread(port)

    if not wait_ready(port):
        print("后端启动失败，无法继续。请检查依赖是否完整。", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{port}/"

    # 先把地址落盘：打包版没有标准输出，这是外部（含 CI 冒烟测试）
    # 唯一能可靠拿到端口的方式，也是窗口起不来时用户能找到地址的保证。
    log_path = _log_url(url)
    if log_path:
        print(f"服务地址已写入：{log_path}")

    try:
        import webview
    except Exception as e:
        open_in_browser(url, reason=f"未安装 pywebview（{e}）")
        return 0

    try:
        webview.create_window(
            APP_NAME,
            url,
            width=WINDOW_W,
            height=WINDOW_H,
            min_size=(MIN_W, MIN_H),
            background_color="#EEF1F5",
            text_select=True,
        )
        # webview.start() 必须在主线程调用（macOS 的窗口系统要求）
        webview.start(debug=args.debug)
        return 0
    except Exception as e:
        traceback.print_exc()
        open_in_browser(url, reason=f"{type(e).__name__}: {e}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
