"""打包后的资源定位。

开发时资源在项目目录里；用 PyInstaller 打包后，随包的数据会被解包到
``sys._MEIPASS``。所有对「随包文件」的引用都必须走这里，否则打包后必然找不到。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def is_frozen() -> bool:
    """是否运行在 PyInstaller 打包出的程序里。"""
    return bool(getattr(sys, "frozen", False))


def bundle_dir() -> Path:
    """随包资源的根目录。

    * 打包后 → PyInstaller 的解包目录（``sys._MEIPASS``）
    * 开发时 → 项目根目录（本文件的上一级）
    """
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parents[1]


def resource(*parts: str) -> Path:
    """随包资源的绝对路径，例如 ``resource("vendor", "VARNAv3-93.jar")``。"""
    return bundle_dir().joinpath(*parts)


def bundled_jre_dir() -> Path | None:
    """随包捆绑的精简 JRE 目录（由 jlink 生成），没有则返回 None。"""
    for name in ("jre", "runtime"):
        d = bundle_dir() / name
        if (d / "bin" / "java").exists() or (d / "bin" / "java.exe").exists():
            return d
    # macOS 上如果 JRE 被打进 Resources，位置会整体下移一层
    for name in ("jre", "runtime"):
        d = bundle_dir() / "Resources" / name
        if (d / "bin" / "java").exists() or (d / "bin" / "java.exe").exists():
            return d
    return None


def bundled_java() -> str | None:
    """随包 JRE 里的 java 可执行文件路径。"""
    d = bundled_jre_dir()
    if not d:
        return None
    exe = d / "bin" / ("java.exe" if os.name == "nt" else "java")
    return str(exe) if exe.exists() else None
