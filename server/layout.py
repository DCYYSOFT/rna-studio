"""结构布局：把序列 + 配对表换算成前端可直接绘制的坐标。

三种布局：

* ``naview``  —— 经典 RNA 二级结构画法（茎环/三叶草）。直接调用 ViennaRNA 的
  ``naview_xy_coordinates``，进程内调用、毫秒级，适合手动编辑后即时重排。
  **假结不影响使用**：实测 naview 拿到含 ``[]`` ``{}`` ``<>`` 的结构照常排版，
  交叉配对会照常画出坐标，只是需要用不同的线型标注（见前端）。
  早先版本一遇假结就整张图降级为环形，是没必要的。
* ``circular`` —— 碱基均匀排布在圆周上，配对画成圆内的弧。类似 VARNA 的 radiate 风格，
  **可以显示假结**。
* ``linear``   —— 碱基水平排列，配对画成上方的半圆弧。适合长序列和带假结的结构。

坐标统一为「右手系、y 轴向下」的屏幕坐标，前端可直接使用。
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

from .dotbracket import StructureError, parse

try:
    import ViennaRNA as V
except Exception:  # pragma: no cover
    V = None  # type: ignore[assignment]


@dataclass
class Layout:
    layout: str
    points: list[dict] = field(default_factory=list)   # {i, x, y, base}
    pairs: list[list[int]] = field(default_factory=list)
    breaks: list[int] = field(default_factory=list)    # 骨架断开处：索引 k 表示 k 与 k+1 之间不画骨架
    bounds: dict = field(default_factory=dict)
    fallback_reason: str | None = None
    radius: float = 1.0

    def to_dict(self) -> dict:
        return asdict(self)


def _finish(name: str, xs: list[float], ys: list[float], seq: str,
            pairs, breaks, fallback=None) -> Layout:
    pts = [{"i": i, "x": round(xs[i], 3), "y": round(ys[i], 3), "base": seq[i]}
           for i in range(len(seq))]
    span = max(max(xs) - min(xs), max(ys) - min(ys), 1e-6)
    return Layout(
        layout=name,
        points=pts,
        pairs=[[i, j] for i, j in pairs],
        breaks=sorted(breaks),
        bounds={
            "minX": round(min(xs), 3), "maxX": round(max(xs), 3),
            "minY": round(min(ys), 3), "maxY": round(max(ys), 3),
            "span": round(span, 3),
        },
        fallback_reason=fallback,
    )


# --------------------------------------------------------------------- naview
def naview_layout(seq: str, pairs: list[tuple[int, int]], breaks: list[int]) -> Layout:
    if V is None:
        raise StructureError("未安装 ViennaRNA，无法使用 naview 布局")
    from .dotbracket import pairs_to_dotbracket

    db = pairs_to_dotbracket(len(seq), pairs)
    c = V.naview_xy_coordinates(db)
    # 0-indexed：索引 0..n-1 对应碱基 1..n，索引 n 是 (0,0) 补位
    xs = [float(c[i].X) for i in range(len(seq))]
    ys = [float(c[i].Y) for i in range(len(seq))]
    return _finish("naview", xs, ys, seq, pairs, breaks)


# ------------------------------------------------------------------ circular
def circular_layout(seq: str, pairs: list[tuple[int, int]], breaks: list[int],
                    *, gap_deg: float = 24.0) -> Layout:
    """均匀圆环。``breaks`` 处留出角度空隙，便于区分共折叠的两条链。"""
    n = len(seq)
    gap_count = len(breaks)
    total = 360.0 - gap_deg * gap_count
    step = total / max(n, 1)

    xs, ys = [], []
    ang = -90.0
    brk = set(breaks)
    for i in range(n):
        rad = math.radians(ang)
        xs.append(math.cos(rad))
        ys.append(math.sin(rad))
        ang += step
        if i in brk:
            ang += gap_deg
    return _finish("circular", xs, ys, seq, pairs, breaks)


# -------------------------------------------------------------------- linear
def linear_layout(seq: str, pairs: list[tuple[int, int]], breaks: list[int]) -> Layout:
    """碱基水平排列，配对画在上方（半圆弧）。y 全部为 0，弧高由配对跨度决定。

    为了让「弧」有高度信息，这里把每个碱基的 y 设为 0，
    而配对弧的高度交给前端按跨度计算，避免后端和前端两套几何。
    """
    n = len(seq)
    xs = [float(i) for i in range(n)]
    ys = [0.0 for _ in range(n)]
    return _finish("linear", xs, ys, seq, pairs, breaks)


# ------------------------------------------------------------------- dispatch
def build(seq: str, dotbracket: str, *, mode: str = "naview",
          breaks: list[int] | None = None) -> Layout:
    """按 mode 生成布局。naview 真的失败时才降级为环形。"""
    parsed = parse(dotbracket, seq)
    breaks = breaks or []
    mode = (mode or "naview").lower()

    if mode == "naview":
        # 假结不构成降级理由：naview 能给出正常排布，交叉配对照常画线即可。
        # 早先版本在这里对 has_pseudoknot 直接返回环形，等于一有假结就废掉茎环图。
        try:
            return naview_layout(seq, parsed.pairs, breaks)
        except StructureError as e:
            lay = circular_layout(seq, parsed.pairs, breaks)
            lay.fallback_reason = f"naview 布局不可用（{e}），已切换为环形布局。"
            return lay

    if mode == "circular":
        return circular_layout(seq, parsed.pairs, breaks)
    if mode == "linear":
        return linear_layout(seq, parsed.pairs, breaks)

    raise StructureError(f"未知布局：{mode}")


SUPPORTED = ["naview", "circular", "linear"]
