# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置 —— macOS 与 Windows 共用。

要点
----
* 入口是 desktop.py（原生窗口），不是 run.sh，用户不会看到终端和浏览器。
* 随包数据：web/ 前端、vendor/ 的 VARNA jar、可选的精简 JRE、示例数据。
* uvicorn 与 pywebview 都用运行时动态导入，必须显式列成 hiddenimports，
  否则打包后启动时才报 ModuleNotFoundError。
* macOS 额外产出 .app bundle；Windows 产出单目录 + 单文件 exe。

CI 里会在调用本 spec 之前，用 jlink 在项目根目录生成 jre/，
这里检测到就一并打进去（检测不到也能打包，只是 VARNA 出图需要系统 Java）。
"""
# 构建日志强制 UTF-8：Windows 控制台默认是 cp1252，非 ASCII 字符会直接抛
# UnicodeEncodeError 让整个打包失败（已踩过）。这里兜住，防止将来又写中文注释输出。
import sys
for _name in ("stdout", "stderr"):
    _stream = getattr(sys, _name, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

from pathlib import Path

# SPECPATH 是 spec 文件所在目录（packaging/），项目根在上一级
ROOT = Path(SPECPATH).resolve().parent

DESKTOP_ENTRY = str(ROOT / "desktop.py")
APP_NAME = "RNA Studio"

# ─────────────────────────── 随包数据 ───────────────────────────

datas = [
    (str(ROOT / "web"), "web"),
    (str(ROOT / "vendor"), "vendor"),
    (str(ROOT / "example_data"), "example_data"),
]

# jlink 生成的精简 JRE（由 CI 或本地构建脚本放在项目根）
jre_dir = ROOT / "jre"
if jre_dir.is_dir():
    datas.append((str(jre_dir), "jre"))
    print(f"[spec] bundling trimmed JRE: {jre_dir}")
else:
    print("[spec] no jre/ found; VARNA export will rely on system Java")

# RNAstructure 是可选引擎；如果构建机上装了，就一起带上
rs_dir = ROOT / "vendor" / "RNAstructure"
if rs_dir.is_dir():
    print(f"[spec] bundling RNAstructure: {rs_dir}")

# ───────────────────────── hidden imports ─────────────────────────

hiddenimports = [
    # uvicorn 的协议/事件循环实现全靠字符串动态导入
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    # 应用自身
    "server",
    "server.app",
    "server.dotbracket",
    "server.ct",
    "server.layout",
    "server.varna",
    "server.paths",
    "server.engines",
    "server.engines.base",
    "server.engines.vienna",
    "server.engines.rnastructure",
    # 其他
    "pydantic",
    "anyio",
    "anyio._backends._asyncio",
]

# pywebview 的窗口后端是按平台条件导入的，必须按目标平台补上
if sys.platform == "darwin":
    hiddenimports += [
        "webview.platforms.cocoa",
        "objc",
        "Foundation",
        "AppKit",
        "WebKit",
        "PyObjCTools",
    ]
elif sys.platform == "win32":
    hiddenimports += [
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
        "clr",
        "clr_loader",
    ]
else:
    hiddenimports += ["webview.platforms.gtk"]

# ───────────────────────── collect_all ─────────────────────────

datas_from_collect = []
binaries_from_collect = []


def _collect(pkg):
    """尽力收集一个包的代码、数据与二进制；包不存在就跳过，不让构建失败。"""
    try:
        from PyInstaller.utils.hooks import collect_all

        d, b, h = collect_all(pkg)
        datas_from_collect.extend(d)
        binaries_from_collect.extend(b)
        hiddenimports.extend(h)
        print(f"[spec] collect_all({pkg}) ok")
    except Exception as e:  # noqa: BLE001
        print(f"[spec] skipped collect_all({pkg}): {e}")


for pkg in ("ViennaRNA", "RNA", "webview", "uvicorn", "fastapi", "pydantic"):
    _collect(pkg)

# RNAstructure 引擎通过 subprocess 调用外部程序，本身没有可 import 的模块，
# 所以不 collect —— 它的目录已经在 datas 里了。

# ─────────────────────────── Analysis ───────────────────────────

block_cipher = None

a = Analysis(
    [DESKTOP_ENTRY],
    pathex=[str(ROOT)],
    binaries=binaries_from_collect,
    datas=datas + datas_from_collect,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 明显用不到的大件，剔掉能显著减小体积
        "tkinter",
        "matplotlib",
        "scipy",
        "pandas",
        "IPython",
        "pytest",
        "setuptools",
        "pip",
        "wheel",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# ───────────────────────── 可执行文件 ─────────────────────────

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=APP_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,           # UPX 在 macOS 上会破坏签名，且对含 JRE 的包收益有限
    console=False,       # 关键：不弹终端窗口
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name=APP_NAME,
)

# ─────────────────── macOS：额外产出 .app bundle ───────────────────

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name=f"{APP_NAME}.app",
        icon=None,
        bundle_identifier="io.rnastudio.app",
        info_plist={
            "CFBundleName": APP_NAME,
            "CFBundleDisplayName": APP_NAME,
            "CFBundleShortVersionString": "0.0.2",
            "CFBundleVersion": "0.0.2",
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "11.0",
            # 应用只在本机 127.0.0.1 上跑服务，不需要任何网络权限
            "LSApplicationCategoryType": "public.app-category.education",
            "NSHumanReadableCopyright": "RNA Studio",
        },
    )
