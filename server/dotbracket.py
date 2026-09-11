"""
Dot-bracket 解析 / 校验 / 转换。

这个模块是整个后端的**安全关口**：ViennaRNA 的 C 扩展在收到不合法的
点括号串（长度不符、括号不配对）时会直接 segfault 崩掉整个进程，
Python 层无法捕获。因此所有进入引擎的 structure 字符串都必须先过这里。

支持的括号类型：() [] {} <>    （多种类型用于表示假结 pseudoknot）
未配对：. , _ -
禁配约束：x（大写 X 亦可）
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

OPEN = "([{<"
CLOSE = ")]}>"
UNPAIRED = ".,_-:"
PAIR_CLOSE = {o: c for o, c in zip(OPEN, CLOSE)}
PAIR_OPEN = {c: o for o, c in zip(OPEN, CLOSE)}


class StructureError(ValueError):
    """结构字符串不合法。调用方应把它转成 400 返回给前端，绝不要传给引擎。"""


@dataclass
class ParsedStructure:
    dotbracket: str
    sequence: str
    pairs: list[tuple[int, int]] = field(default_factory=list)  # 0-based (i, j), i < j
    forbidden: list[int] = field(default_factory=list)          # 0-based 禁配位点
    has_pseudoknot: bool = False
    crossing_pairs: list[tuple[tuple[int, int], tuple[int, int]]] = field(default_factory=list)

    @property
    def n(self) -> int:
        return len(self.sequence)

    def pair_map(self) -> dict[int, int]:
        m: dict[int, int] = {}
        for i, j in self.pairs:
            m[i] = j
            m[j] = i
        return m


def _crossings(pairs: Iterable[tuple[int, int]]) -> list[tuple[tuple[int, int], tuple[int, int]]]:
    """找出互相交叉（形成假结）的配对。O(n log n)：按左端排序后检查右端是否递减。"""
    ps = sorted(pairs)
    out = []
    # 对每个配对，找右端跨度互相交错的那些
    for a in range(len(ps)):
        i, j = ps[a]
        for b in range(a + 1, len(ps)):
            k, l = ps[b]
            if k >= j:
                break
            if l > j:  # i < k < j < l  → 交叉
                out.append(((i, j), (k, l)))
    return out


def parse(dotbracket: str, sequence: str, *, allow_pseudoknot: bool = True) -> ParsedStructure:
    """校验并解析点括号串。任何不合法输入都抛 StructureError，绝不返回半成品。"""
    if sequence is None:
        raise StructureError("缺少序列")
    seq = "".join(sequence.split()).upper().replace("T", "U")
    db = "".join((dotbracket or "").split())

    if not seq:
        raise StructureError("序列为空")
    if not db:
        raise StructureError("结构为空")
    if len(db) != len(seq):
        raise StructureError(f"结构长度 {len(db)} 与序列长度 {len(seq)} 不一致")

    stacks: dict[str, list[int]] = {o: [] for o in OPEN}
    pairs: list[tuple[int, int]] = []
    forbidden: list[int] = []

    for idx, ch in enumerate(db):
        if ch in UNPAIRED:
            continue
        if ch in "xX":
            forbidden.append(idx)
            continue
        if ch in OPEN:
            stacks[ch].append(idx)
            continue
        if ch in CLOSE:
            o = PAIR_OPEN[ch]
            if not stacks[o]:
                raise StructureError(f"第 {idx + 1} 位出现多余的 '{ch}'，没有对应的 '{o}'")
            i = stacks[o].pop()
            pairs.append((i, idx))
            continue
        raise StructureError(f"第 {idx + 1} 位出现无法识别的字符 '{ch}'")

    leftover = [(o, pos) for o, st in stacks.items() for pos in st]
    if leftover:
        o, pos = sorted(leftover, key=lambda t: t[1])[0]
        raise StructureError(f"第 {pos + 1} 位的 '{o}' 没有闭合")

    # 同一位置既禁配又配对 → 矛盾
    paired_idx = {i for p in pairs for i in p}
    clash = sorted(paired_idx & set(forbidden))
    if clash:
        raise StructureError(f"第 {clash[0] + 1} 位同时被标记为禁配和配对")

    cross = _crossings(pairs)
    if cross and not allow_pseudoknot:
        (i, j), (k, l) = cross[0]
        raise StructureError(
            f"存在交叉配对（假结）：{i + 1}-{j + 1} 与 {k + 1}-{l + 1}"
        )

    return ParsedStructure(
        dotbracket=db,
        sequence=seq,
        pairs=sorted(pairs),
        forbidden=sorted(forbidden),
        has_pseudoknot=bool(cross),
        crossing_pairs=cross,
    )


def pairs_to_dotbracket(n: int, pairs: Iterable[tuple[int, int]]) -> str:
    """把配对列表转成纯 '.'/'()' 的点括号串。交叉配对自动改用不同括号类型。"""
    out = ["."] * n
    used = set()
    for i, j in sorted(pairs, key=lambda p: p[1] - p[0]):
        if i in used or j in used:
            continue
        # 选一个不与已有括号类型冲突的括号类型
        for o, c in zip(OPEN, CLOSE):
            conflict = False
            for a, b in _existing_pairs(out, o, c):
                if not (j < a or i > b or (i < a and j > b) or (a < i and b > j)):
                    conflict = True
                    break
            if not conflict:
                out[i], out[j] = o, c
                used.update((i, j))
                break
    return "".join(out)


def _existing_pairs(buf: list[str], o: str, c: str):
    st = []
    res = []
    for idx, ch in enumerate(buf):
        if ch == o:
            st.append(idx)
        elif ch == c and st:
            res.append((st.pop(), idx))
    return res


def canonical(dotbracket: str) -> str:
    """统一成只用 () 的等价表示，便于比较两个结构是否相同。"""
    db = "".join(dotbracket.split())
    out = []
    for ch in db:
        if ch in "([{<":
            out.append("(")
        elif ch in ")]}>":
            out.append(")")
        elif ch in "xX":
            out.append("x")
        elif ch in UNPAIRED:
            out.append(".")
        else:
            out.append(ch)
    return "".join(out)


def structural_distance(a: str, b: str) -> int:
    """两个结构之间的碱基配对数差异（用于和 MFE 比较）。"""
    pa = {tuple(sorted(p)) for p in parse(a, "N" * len(a)).pairs}
    pb = {tuple(sorted(p)) for p in parse(b, "N" * len(b)).pairs}
    return len(pa ^ pb)
