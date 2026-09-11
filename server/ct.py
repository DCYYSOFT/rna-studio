"""
CT (Connectivity Table) 格式读写。

CT 是 RNAstructure 的原生格式，也是与 mfold/RNAfold 生态互通的通用格式。
列定义（1-based 编号）：
    1  index       碱基编号
    2  base        碱基字母
    3  prev        前一个碱基编号（0 表示无）
    4  next        后一个碱基编号（0 表示无）
    5  pair        配对的碱基编号（0 表示未配对）
    6  index(again) 编号重复
"""
from __future__ import annotations

from .dotbracket import StructureError, pairs_to_dotbracket


def write_ct(sequence: str, pairs: list[tuple[int, int]], *, title: str | None = None) -> str:
    """把 0-based 配对列表写成 CT 文本。"""
    n = len(sequence)
    partner = {0: 0}
    for i, j in pairs:
        if not (0 <= i < n and 0 <= j < n and i != j):
            raise StructureError(f"非法配对 ({i + 1}, {j + 1})")
        partner[i + 1] = j + 1
        partner[j + 1] = i + 1

    lines = [f"{n}{'  ' + title if title else '  RNA Studio export'}"]
    for k in range(1, n + 1):
        prev = k - 1 if k > 1 else 0
        nxt = k + 1 if k < n else 0
        lines.append(
            f"{k:>6}{sequence[k - 1]:>6}{prev:>6}{nxt:>6}{partner.get(k, 0):>6}{k:>6}"
        )
    return "\n".join(lines) + "\n"


def read_ct(text: str) -> tuple[str, list[tuple[int, int]]]:
    """解析 CT 文本 → (序列, 0-based 配对表)。兼容缺少表头行的变体。"""
    rows: list[list[str]] = []
    seq: list[str] = []
    partner_raw: dict[int, int] = {}
    declared_n: int | None = None

    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        # 表头行：单个整数（可能后接标题）
        if lineno == 1 and len(parts) >= 1 and parts[0].isdigit() and len(parts) <= 2 + 10 and len(parts) < 6:
            declared_n = int(parts[0])
            continue
        if len(parts) < 6:
            # 有些工具会丢掉第 6 列
            if len(parts) == 5:
                parts = parts + [parts[0]]
            else:
                raise StructureError(f"CT 第 {lineno} 行字段不足：{line!r}")

        try:
            idx = int(parts[0])
            base = parts[1]
            prt = int(parts[4])
        except ValueError as e:
            raise StructureError(f"CT 第 {lineno} 行无法解析：{line!r}") from e

        rows.append(parts)
        seq.append(base)
        partner_raw[idx] = prt

    if not rows:
        raise StructureError("CT 文件没有任何碱基行")
    if declared_n is not None and declared_n != len(rows):
        raise StructureError(f"CT 表头声明 {declared_n} 个碱基，实际读到 {len(rows)} 个")

    # 编号必须从 1 连续递增
    for k, parts in enumerate(rows, 1):
        if int(parts[0]) != k:
            raise StructureError(f"CT 编号不连续：第 {k} 行编号为 {parts[0]}")

    pairs: list[tuple[int, int]] = []
    for i, j in partner_raw.items():
        if j and j > i:
            if j > len(seq):
                raise StructureError(f"第 {i} 位配对指向不存在的 {j}")
            pairs.append((i - 1, j - 1))

    return "".join(seq).upper().replace("T", "U"), sorted(pairs)


def ct_to_dotbracket(text: str) -> tuple[str, str]:
    seq, pairs = read_ct(text)
    return seq, pairs_to_dotbracket(len(seq), pairs)
