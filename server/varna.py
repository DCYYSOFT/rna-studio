"""VARNA 封装（调用官方 VARNAv3-93.jar）。

两个已实测的集成要点：

1. **VARNA 输出的 SVG 是 ``width="100%" height="100%"`` 且没有 viewBox。**
   坐标值域是 VARNA 内部尺度（可能到几百），直接嵌进浏览器会按容器像素尺寸渲染，
   导致内容被裁切或缩放错乱。所以这里会解析出实际内容包围盒，
   重新注入 ``width`` / ``height`` / ``viewBox`` 并补一块白底。

2. VARNA 需要 Java 运行时（Java 8+ 均可，实测 Java 11 正常）。
   ``status()`` 会同时检查 java 与 jar，缺哪个都给出对应提示。
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .dotbracket import StructureError, parse
from .paths import bundled_java, bundled_jre_dir, resource

JAR_NAME = "VARNAv3-93.jar"
MAIN_CLASS = "fr.orsay.lri.varna.applications.VARNAcmd"
TIMEOUT = 120

ALGORITHMS = ["naview", "radiate", "circular", "line"]
RASTER_FORMATS = {"png", "jpeg", "eps", "xfig"}


def jar_path() -> Path:
    """VARNA jar 的位置：随包 vendor/，可用环境变量 VARNA_JAR 覆盖。"""
    env = os.environ.get("VARNA_JAR")
    if env:
        return Path(env).expanduser()
    return resource("vendor", JAR_NAME)


def java_path() -> str | None:
    """java 可执行文件。

    查找顺序：随包捆绑的精简 JRE → JAVA_HOME → PATH。
    捆绑 JRE 优先，保证打包后的程序不依赖用户机器上装没装 Java。
    """
    b = bundled_java()
    if b:
        return b
    home = os.environ.get("JAVA_HOME")
    if home:
        exe = Path(home) / "bin" / ("java.exe" if os.name == "nt" else "java")
        if exe.exists():
            return str(exe)
    return shutil.which("java")


def status() -> dict:
    jp = jar_path()
    jv = java_path()
    jre = bundled_jre_dir()
    problems = []
    if not jv:
        problems.append(
            "未找到 Java 运行时。安装包一般都随包自带精简 JRE；"
            "若是源码运行，请安装 Java（macOS：brew install openjdk）或设置 JAVA_HOME。"
        )
    if not jp.exists():
        problems.append(
            f"未找到 VARNA jar（应在 {jp}）。可从 http://varna.lri.fr/bin/ 下载 {JAR_NAME} 放入 vendor/"
        )
    version = None
    if jv:
        try:
            r = subprocess.run([jv, "-version"], capture_output=True, text=True, timeout=20)
            m = re.search(r'version "([^"]+)"', r.stderr or r.stdout)
            version = m.group(1) if m else None
        except Exception:
            pass
    return {
        "available": not problems,
        "java": jv,
        "java_version": version,
        "java_source": "bundled" if jre else ("system" if jv else None),
        "jar": str(jp),
        "jar_exists": jp.exists(),
        "problems": problems,
    }


def _run(args: list[str], timeout: int = TIMEOUT) -> None:
    jv = java_path()
    if not jv:
        raise StructureError("未找到 java，无法调用 VARNA。请先安装 Java 运行时。")
    jp = jar_path()
    if not jp.exists():
        raise StructureError(f"未找到 VARNA jar：{jp}")

    r = subprocess.run(
        [jv, "-cp", str(jp), MAIN_CLASS, *args],
        capture_output=True, text=True, timeout=timeout,
    )
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0 or "Exception" in out:
        tail = [l for l in out.strip().splitlines() if l.strip()]
        msg = tail[-1] if tail else f"退出码 {r.returncode}"
        raise StructureError(f"VARNA 执行失败：{msg}")


# ------------------------------------------------------------------ SVG 后处理
_NUM = r"(-?[\d.]+(?:[eE][+-]?\d+)?)"


def _content_bounds(svg: str) -> tuple[float, float, float, float] | None:
    xs: list[float] = []
    ys: list[float] = []

    for m in re.finditer(rf'<line x1="{_NUM}" y1="{_NUM}" x2="{_NUM}" y2="{_NUM}"', svg):
        xs += [float(m.group(1)), float(m.group(3))]
        ys += [float(m.group(2)), float(m.group(4))]
    for m in re.finditer(rf'<circle cx="{_NUM}" cy="{_NUM}"', svg):
        xs.append(float(m.group(1)))
        ys.append(float(m.group(2)))
    for m in re.finditer(rf'<text x="{_NUM}" y="{_NUM}"', svg):
        xs.append(float(m.group(1)))
        ys.append(float(m.group(2)))
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def fix_svg_size(svg: str, *, pad: float = 14.0, scale: float = 1.0) -> str:
    """把 VARNA 的无尺寸 SVG 补成带 viewBox 的自包含 SVG。"""
    b = _content_bounds(svg)
    if not b:
        return svg
    min_x, min_y, max_x, max_y = b
    w = (max_x - min_x) + 2 * pad
    h = (max_y - min_y) + 2 * pad
    vx, vy = min_x - pad, min_y - pad

    bg = (f'<rect x="{vx:.3f}" y="{vy:.3f}" width="{w:.3f}" height="{h:.3f}" '
          f'fill="#ffffff"/>')
    new_open = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{w * scale:.1f}" height="{h * scale:.1f}" '
        f'viewBox="{vx:.3f} {vy:.3f} {w:.3f} {h:.3f}" '
        f'preserveAspectRatio="xMidYMid meet">'
    )
    svg = re.sub(r"<svg\b[^>]*>", new_open, svg, count=1)
    # VARNA 的 DOCTYPE 在浏览器内联时无意义，去掉更干净
    svg = re.sub(r"<!DOCTYPE[^>]*>", "", svg, count=1)
    svg = re.sub(r"<\?xml[^>]*\?>", "", svg, count=1)
    # 白底插到第一个图元之前
    svg = re.sub(r"(<svg\b[^>]*>)", r"\1" + bg, svg, count=1)
    return svg.strip()


# -------------------------------------------------------------------- 选项构造
def _common_args(
    sequence: str,
    structure: str,
    *,
    algorithm: str,
    title: str | None,
    period_num: int | None,
    bp_style: str | None,
    aux_bps: list[tuple[int, int]] | None,
    color_map: list[float] | None,
    color_map_style: str | None,
    color_map_min: float | None,
    color_map_max: float | None,
    draw_tertiary: bool,
    rotation: float | None,
    extra: list[str] | None,
) -> list[str]:
    args = [
        "-sequenceDBN", sequence,
        "-structureDBN", structure,
        "-algorithm", algorithm,
        "-drawTertiary", "true" if draw_tertiary else "false",
    ]
    if title:
        args += ["-title", title]
    if period_num:
        args += ["-periodNum", str(int(period_num))]
    if bp_style:
        args += ["-bpStyle", bp_style]
    if rotation is not None:
        args += ["-rotation", str(float(rotation))]

    if aux_bps:
        # 假结等额外配对：VARNA 用 1-based 坐标
        spec = ";".join(f"({i + 1},{j + 1}):color=#d62728" for i, j in aux_bps)
        args += ["-auxBPs", spec]

    if color_map:
        args += [
            "-colorMap", ",".join(f"{float(v):.4f}" for v in color_map),
            "-colorMapStyle", color_map_style or "0:#FFFFFF;1:#08306B",
            "-drawColorMap", "true",
        ]
        if color_map_min is not None:
            args += ["-colorMapMin", str(float(color_map_min))]
        if color_map_max is not None:
            args += ["-colorMapMax", str(float(color_map_max))]

    if extra:
        args += extra
    return args


def render_svg(
    sequence: str,
    structure: str,
    *,
    algorithm: str = "naview",
    title: str | None = None,
    period_num: int | None = 10,
    bp_style: str | None = None,
    aux_bps: list[tuple[int, int]] | None = None,
    color_map: list[float] | None = None,
    color_map_style: str | None = None,
    color_map_min: float | None = None,
    color_map_max: float | None = None,
    draw_tertiary: bool = True,
    rotation: float | None = None,
    extra: list[str] | None = None,
) -> str:
    seq = sequence.upper().replace("T", "U")
    parsed = parse(structure, seq)   # 关口：长度/括号不合法直接拒绝
    # VARNA 自身能画假结（drawTertiary / auxBPs），所以这里把交叉配对单独取出
    aux = list(aux_bps or [])
    if parsed.crossing_pairs:
        # 交叉配对不能出现在主结构串里，单独交给 auxBPs 画
        crossing = {tuple(sorted(p)) for cp in parsed.crossing_pairs for p in cp}
        keep = [p for p in parsed.pairs if tuple(sorted(p)) not in crossing]
        from .dotbracket import pairs_to_dotbracket
        structure = pairs_to_dotbracket(len(seq), keep)
        aux += sorted(crossing)

    args = _common_args(
        seq, structure,
        algorithm=algorithm if algorithm in ALGORITHMS else "naview",
        title=title, period_num=period_num, bp_style=bp_style,
        aux_bps=aux, color_map=color_map, color_map_style=color_map_style,
        color_map_min=color_map_min, color_map_max=color_map_max,
        draw_tertiary=draw_tertiary, rotation=rotation, extra=extra,
    )

    with tempfile.TemporaryDirectory(prefix="varna_") as td:
        out = Path(td) / "out.svg"
        _run([*args, "-o", str(out)])
        if not out.exists():
            raise StructureError("VARNA 未生成 SVG 文件")
        svg = out.read_text(errors="replace")

    if not svg.lstrip().startswith("<?xml") and "<svg" not in svg:
        raise StructureError("VARNA 输出不是有效的 SVG")
    return fix_svg_size(svg)


def render_raster(
    sequence: str,
    structure: str,
    *,
    fmt: str = "png",
    algorithm: str = "naview",
    resolution: float = 2.0,
    title: str | None = None,
    period_num: int | None = 10,
    bp_style: str | None = None,
    color_map: list[float] | None = None,
    color_map_style: str | None = None,
    color_map_min: float | None = None,
    color_map_max: float | None = None,
    extra: list[str] | None = None,
) -> bytes:
    fmt = fmt.lower()
    if fmt not in RASTER_FORMATS:
        raise StructureError(f"VARNA 不支持的位图格式：{fmt}")

    seq = sequence.upper().replace("T", "U")
    parsed = parse(structure, seq)
    structure = parsed.dotbracket
    aux: list[tuple[int, int]] = []
    if parsed.crossing_pairs:
        crossing = {tuple(sorted(p)) for cp in parsed.crossing_pairs for p in cp}
        keep = [p for p in parsed.pairs if tuple(sorted(p)) not in crossing]
        from .dotbracket import pairs_to_dotbracket
        structure = pairs_to_dotbracket(len(seq), keep)
        aux = sorted(crossing)

    args = _common_args(
        seq, structure,
        algorithm=algorithm if algorithm in ALGORITHMS else "naview",
        title=title, period_num=period_num, bp_style=bp_style,
        aux_bps=aux, color_map=color_map, color_map_style=color_map_style,
        color_map_min=color_map_min, color_map_max=color_map_max,
        draw_tertiary=True, rotation=None, extra=extra,
    )
    if fmt in {"png", "jpeg"}:
        args += ["-resolution", str(float(resolution))]

    with tempfile.TemporaryDirectory(prefix="varna_") as td:
        out = Path(td) / f"out.{fmt}"
        _run([*args, "-o", str(out)])
        if not out.exists():
            raise StructureError(f"VARNA 未生成 {fmt} 文件")
        return out.read_bytes()
