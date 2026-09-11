"""从 PDB / mmCIF 的三维坐标推断 RNA 二级结构。

思路是**几何判定**：直接看哪些碱基在空间上真的形成了氢键，而不是拿序列
重新跑一遍预测——后者等于把实验结构的信息丢掉，读 PDB 就失去意义了。

配对判据（实测校准过）：
  * 只统计「供体—受体」原子对。早期版本只看两个 N/O 靠得够近就算，
    结果把 N3–N3（两个都是受体）也误判成配对，tRNA 上多检出一堆假配对。
  * N–O 距离 ≤ 3.6 Å，N–N ≤ 3.4 Å。
  * 至少 2 个氢键才算一个配对。

修饰核苷酸不写死清单，而是**按特征原子反推母体**：带 O6+N2 的算 G，
带 O4+N3+O2 的算 U，带 N4+O2 的算 C，带 N6 的算 A。
这样 2MG、PSU、5MC、7MG 乃至没见过的修饰都能自动归位。
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

from .dotbracket import StructureError, parse, pairs_to_dotbracket

# 碱基上的氢键供体 / 受体（只列杂原子）
DONORS = {
    "A": {"N6"},
    "G": {"N1", "N2"},
    "C": {"N4"},
    "U": {"N3"},
}
ACCEPTORS = {
    "A": {"N1", "N7"},
    "G": {"O6", "N7"},
    "C": {"N3", "O2"},
    "U": {"O2", "O4"},
}

MAX_NO = 3.6      # N–O 氢键上限（Å）
MAX_NN = 3.4      # N–N 氢键上限（Å）
MIN_HBONDS = 2    # 少于这个数不算配对

# 经典配对的判定模式：母体组合 + 必需的原子接触
CANONICAL_PATTERNS = [
    ("A", "U", {("N1", "N3"), ("N6", "O4")}),
    ("U", "A", {("N3", "N1"), ("O4", "N6")}),
    ("G", "C", {("N1", "N3"), ("O6", "N4"), ("N2", "O2")}),
    ("C", "G", {("N3", "N1"), ("N4", "O6"), ("O2", "N2")}),
    ("G", "U", {("N1", "O2"), ("O6", "N3")}),      # 摆动配对
    ("U", "G", {("O2", "N1"), ("N3", "O6")}),
]


@dataclass
class Residue:
    index: int            # 在本链中的顺序编号，0-based
    seq_id: str           # 文件里的残基编号（字符串，可能是 12A 这种）
    base: str             # 归一化后的母体：A/U/G/C
    raw_name: str         # 原始残基名（可能是修饰核苷酸）
    atoms: dict[str, tuple[float, float, float]] = field(default_factory=dict)

    @property
    def modified(self) -> bool:
        return self.raw_name != self.base


@dataclass
class Chain:
    chain_id: str
    residues: list[Residue]
    kind: str = "rna"     # rna | protein | other
    ligands: list[dict] = field(default_factory=list)

    @property
    def sequence(self) -> str:
        return "".join(r.base for r in self.residues)


# ─────────────────────────── 解析 ───────────────────────────

def base_from_atoms(atom_names) -> str | None:
    """按特征原子反推核苷酸母体；不是核苷酸（水、离子、配体）返回 None。"""
    has = set(atom_names)
    if "O6" in has and "N2" in has:
        return "G"
    if "O4" in has and "N3" in has and "O2" in has:
        return "U"
    if "N4" in has and "O2" in has:
        return "C"
    if "N6" in has:
        return "A"
    return None


WATERS = {"HOH", "WAT", "DOD", "H2O"}


def _backbone_linked(a: dict, b: dict) -> bool:
    """a 的 O3' 与 b 的 P 是否成键——判断两个核苷酸是不是连在同一条链上。"""
    o3 = a.get("O3'") or a.get("O3*")
    p_atom = b.get("P")
    if not o3 or not p_atom:
        return False
    d = ((o3[0] - p_atom[0]) ** 2 + (o3[1] - p_atom[1]) ** 2
         + (o3[2] - p_atom[2]) ** 2) ** 0.5
    return d <= 2.0


def _split_chain(residues: list[tuple[str, dict]]) -> tuple[list, list]:
    """
    把一条链里的残基分成「属于 RNA 的」和「配体」。

    不能靠 ATOM/HETATM 区分：链上的修饰核苷酸（2MG、PSU…）也是 HETATM，
    而游离配体可能和 RNA 在同一个链号里。真正的判据是**骨架连通性**——
    链上的核苷酸会与相邻残基通过磷酸二酯键相连（O3'–P ≈ 1.6 Å），
    游离的腺嘌呤、GTP、c-di-AMP 则不会。
    """
    nuc, other = [], []
    for seq_id, info in residues:
        (nuc if base_from_atoms(info["atoms"]) is not None else other).append((seq_id, info))

    ligands = list(other)
    if not nuc:
        return [], ligands

    # 并查集求「骨架连通分量」
    parent = list(range(len(nuc)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i in range(len(nuc) - 1):
        if _backbone_linked(nuc[i][1]["atoms"], nuc[i + 1][1]["atoms"]):
            ra, rb = find(i), find(i + 1)
            if ra != rb:
                parent[ra] = rb

    groups: dict[int, list] = {}
    for i in range(len(nuc)):
        groups.setdefault(find(i), []).append(nuc[i])
    comps = sorted(groups.values(), key=len, reverse=True)

    # 多残基片段一律算 RNA 链的一部分。
    # 早先只保留最大的一段，结果 23S rRNA 被无序区切成 9 段后只剩 587 nt，
    # 其余 2000 多个残基全被误当成配体。
    chain_res, singles = [], []
    for comp in comps:
        (chain_res.extend(comp) if len(comp) >= 2 else singles.append(comp[0]))

    def _num(seq_id):
        m = re.match(r"\s*(-?\d+)", seq_id or "")
        return int(m.group(1)) if m else None

    nums = [x for x in (_num(sid) for sid, _ in chain_res) if x is not None]
    lo, hi = (min(nums), max(nums)) if nums else (None, None)

    # 单残基分量：像链上核苷酸就留着，否则当配体。
    # 判据是「有标准命名的磷酸 P」——游离的 GTP 用 PG/PA、c-di-AMP 用 P1，
    # 而链上核苷酸的磷酸一律叫 P；游离碱基（如腺嘌呤）连糖环都没有。
    for seq_id, info in singles:
        atoms = info["atoms"]
        nm = _num(seq_id)
        backbone_like = ("P" in atoms) and ("O3'" in atoms or "O5'" in atoms)
        in_span = (lo is None or nm is None or lo <= nm <= hi)
        if backbone_like and in_span:
            chain_res.append((seq_id, info))
        else:
            ligands.append((seq_id, info))

    return chain_res, ligands


def _build(raw: dict[str, dict[str, dict]]):
    """把解析出的原子记录整理成 RNA 链与配体。"""
    chains, ligands = [], []
    for chain_id, residues in raw.items():
        chain_res, ligs = _split_chain(list(residues.items()))
        for seq_id, info in ligs:
            if info["name"] in WATERS:
                continue
            ligands.append({"name": info["name"], "seq_id": seq_id,
                            "chain_id": chain_id, "atoms": info["atoms"]})
        if not chain_res:
            continue
        residues_out = []
        for seq_id, info in chain_res:
            base = base_from_atoms(info["atoms"])
            residues_out.append(Residue(
                index=len(residues_out), seq_id=seq_id, base=base,
                raw_name=info["name"], atoms=info["atoms"],
            ))
        chains.append(Chain(chain_id=chain_id, residues=residues_out, kind="rna"))
    return chains, ligands


def parse_pdb(text: str) -> list[Chain]:
    """解析经典 PDB 格式（定长列）。"""
    raw: dict[str, dict[str, dict]] = {}
    order: list[str] = []
    for line in text.splitlines():
        rec = line[:6]
        if rec not in ("ATOM  ", "HETATM"):
            continue
        name = line[17:20].strip()
        altloc = line[16]
        if altloc not in (" ", "A"):      # 只取主构象
            continue
        chain_id = line[21] or "A"
        seq_id = line[22:27].strip()
        atom = line[12:16].strip()
        ins = line[26].strip()
        key_id = f"{seq_id}{ins}"
        try:
            xyz = (float(line[30:38]), float(line[38:46]), float(line[46:54]))
        except ValueError:
            continue                       # 坐标字段残缺的记录跳过

        if chain_id not in raw:
            raw[chain_id] = {}
            order.append(chain_id)
        ch = raw[chain_id]
        if key_id not in ch:
            ch[key_id] = {"name": name, "atoms": {}}
        ch[key_id]["atoms"].setdefault(atom, xyz)

    return _build({cid: raw[cid] for cid in order})


def parse_mmcif(text: str) -> list[Chain]:
    """解析 mmCIF 的 atom_site 表。现代大结构（核糖体等）只有 cif 格式。"""
    lines = text.splitlines()
    start = None
    columns: list[str] = []
    for i, line in enumerate(lines):
        if line.startswith("_atom_site."):
            columns.append(line.strip().split(".")[1])
            start = i + 1 if start is None else start
        elif columns and start is not None and i >= start and line.strip() and not line.startswith("_"):
            break

    if not columns:
        return [], []

    def col(name: str) -> int:
        short = name.replace("auth_", "").replace("label_", "")
        for want in (name, short, f"label_{short}", f"auth_{short}"):
            if want in columns:
                return columns.index(want)
        return -1

    i_atom = col("label_atom_id")
    i_name = col("label_comp_id") if col("label_comp_id") >= 0 else col("comp_id")
    i_chain = col("auth_asym_id")
    if i_chain < 0:
        i_chain = col("label_asym_id")
    i_seq = col("auth_seq_id")
    if i_seq < 0:
        i_seq = col("label_seq_id")
    i_x, i_y, i_z = col("Cartn_x"), col("Cartn_y"), col("Cartn_z")
    i_alt = col("label_alt_id")
    i_ins = col("pdbx_PDB_ins_code")
    if min(i_atom, i_name, i_chain, i_seq, i_x, i_y, i_z) < 0:
        return [], []

    raw: dict[str, dict[str, dict]] = {}
    order: list[str] = []
    for line in lines:
        s = line.strip()
        if not s or s.startswith(("_", "#", "loop_", "data_", ";")):
            continue
        parts = s.split()
        try:
            if len(parts) <= max(i_atom, i_name, i_chain, i_seq, i_x, i_y, i_z):
                continue
            if i_alt >= 0 and parts[i_alt] not in (".", "?", "A"):
                continue
            chain_id = parts[i_chain]
            if chain_id in (".", "?"):
                continue
            ins = parts[i_ins] if (i_ins >= 0 and parts[i_ins] not in (".", "?")) else ""
            key_id = f"{parts[i_seq]}{ins}"
            xyz = (float(parts[i_x]), float(parts[i_y]), float(parts[i_z]))
        except (ValueError, IndexError):
            continue
        atom = parts[i_atom].strip('"')
        if chain_id not in raw:
            raw[chain_id] = {}
            order.append(chain_id)
        ch = raw[chain_id]
        if key_id not in ch:
            ch[key_id] = {"name": parts[i_name].strip('"'), "atoms": {}}
        ch[key_id]["atoms"].setdefault(atom, xyz)

    return _build({cid: raw[cid] for cid in order})


def parse_structure(text: str, fmt: str | None = None) -> tuple[list[Chain], list[dict]]:
    """按格式解析，返回 (RNA 链列表, 全文件的配体列表)。不给格式就按内容猜。"""
    head = text[:2000]
    if fmt is None:
        fmt = "cif" if ("_atom_site." in head or "data_" in head[:200]) else "pdb"
    chains, ligands = parse_mmcif(text) if fmt == "cif" else parse_pdb(text)
    if not chains:            # 猜错了就换另一种再试一次
        chains, ligands = parse_pdb(text) if fmt == "cif" else parse_mmcif(text)
    if not chains:
        raise StructureError("没在文件里找到 RNA 链。确认这是含核酸的 PDB/mmCIF 文件。")
    return chains, ligands


# ─────────────────────────── 配对判定 ───────────────────────────

def _pair_hbonds(ri: Residue, rj: Residue) -> list[tuple[str, str, float]]:
    """两个碱基之间成立的氢键列表（要求一供一受）。"""
    out = []
    di, ai = DONORS[ri.base], ACCEPTORS[ri.base]
    dj, aj = DONORS[rj.base], ACCEPTORS[rj.base]
    for x, px in ri.atoms.items():
        if x not in di and x not in ai:
            continue
        for y, py in rj.atoms.items():
            if y not in dj and y not in aj:
                continue
            # 必须一个是供体、另一个是受体
            if not ((x in di and y in aj) or (x in ai and y in dj)):
                continue
            d = math.dist(px, py)
            limit = MAX_NN if (x.startswith("N") and y.startswith("N")) else MAX_NO
            if d <= limit:
                out.append((x, y, round(d, 2)))
    return out


def classify_pair(bi: str, bj: str, hbonds) -> str:
    """判断配对属于哪一类。返回 'A-U' / 'G-C' / 'G-U' 或 '非经典'。"""
    got = {(x, y) for x, y, _ in hbonds}
    for pbi, pbj, need in CANONICAL_PATTERNS:
        if bi == pbi and bj == pbj and need & got:
            return f"{bi}-{bj}"
    return "非经典"


def detect_pairs(chain: Chain, *, min_separation: int = 3) -> list[dict[str, Any]]:
    """检出所有几何上成立的配对（尚未做冲突筛选）。"""
    res = chain.residues
    n = len(res)

    # 空间预筛：两个碱基要成氢键，糖环不可能离太远。
    # 不做这一步，几千残基的 rRNA 要跑上千万次原子对距离计算（实测 12 秒）。
    # 用 C1' 建网格，每个残基只看邻近格子里的候选。
    cell = 25.0
    grid = {}
    centers = []
    for i, r in enumerate(res):
        c = r.atoms.get("C1'") or r.atoms.get("C1*")
        if c is None:
            vals = list(r.atoms.values()) or [(0.0, 0.0, 0.0)]
            c = tuple(sum(v[k] for v in vals) / len(vals) for k in range(3))
        centers.append(c)
        grid.setdefault((int(c[0] // cell), int(c[1] // cell), int(c[2] // cell)), []).append(i)

    found = []
    for i in range(n):
        ci = centers[i]
        gx, gy, gz = int(ci[0] // cell), int(ci[1] // cell), int(ci[2] // cell)
        cand = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    cand.extend(grid.get((gx + dx, gy + dy, gz + dz), ()))
        for j in sorted(cand):
            if j < i + min_separation:
                continue
            ri, rj = res[i], res[j]
            hb = _pair_hbonds(ri, rj)
            if len(hb) < MIN_HBONDS:
                continue
            found.append({
                "i": i, "j": j,
                "hbonds": len(hb),
                "atoms": [[x, y, d] for x, y, d in hb],
                "type": classify_pair(ri.base, rj.base, hb),
                "bases": f"{ri.base}-{rj.base}",
                "canonical": classify_pair(ri.base, rj.base, hb) != "非经典",
                # 用于排序：氢键多、距离短的优先
                "score": (len(hb), -sum(d for _, _, d in hb) / len(hb)),
                "stack": 0,
            })

    # 堆叠支撑：一个配对上下还有几个配对和它构成连续螺旋。
    # 这是区分「二级结构里的配对」和「三级相互作用」的关键特征——
    # 螺旋上的配对至少有 1 个邻居，而三级配对往往是孤立的。
    pairset = {(p["i"], p["j"]) for p in found}
    for p in found:
        i, j = p["i"], p["j"]
        p["stack"] = ((1 if (i + 1, j - 1) in pairset else 0)
                      + (1 if (i - 1, j + 1) in pairset else 0))
    return found


def _crossings(pairs: list[dict]) -> list[tuple[int, int]]:
    """返回互相交叉的配对在列表中的下标对（交叉 = 会形成假结）。"""
    out = []
    ps = sorted(range(len(pairs)), key=lambda k: (pairs[k]["i"], pairs[k]["j"]))
    for a in range(len(ps)):
        i, j = pairs[ps[a]]["i"], pairs[ps[a]]["j"]
        for b in range(a + 1, len(ps)):
            k, l = pairs[ps[b]]["i"], pairs[ps[b]]["j"]
            if k >= j:
                break
            if l > j:
                out.append((ps[a], ps[b]))
    return out


def drop_pseudoknots(pairs: list[dict]) -> tuple[list[dict], list[dict]]:
    """
    去掉会造成假结的配对，得到可以嵌套表示、能算 ΔG 的二级结构。

    做法是按置信度从高到低贪心保留，遇到与已保留的配对交叉就跳过。
    这样留下的是「能嵌套的最大高置信度子集」。

    置信度的排序是关键：只看氢键数和键长分不出二级配对和三级相互作用
    （tRNA 的 D 臂配对和三级配对 (15,48) 氢键数一样多），
    必须把**堆叠支撑**放在前面——螺旋上的配对有堆叠邻居，三级配对往往是孤立的。
    早先版本漏了这一点，结果删掉的是 D 臂和 T 臂的正经配对。
    """
    ordered = sorted(
        pairs,
        key=lambda p: (
            0 if p["canonical"] else 1,
            -p.get("stack", 0),
            -p["hbonds"],
            -p["score"][1],
        ),
    )
    kept: list[dict] = []
    dropped: list[dict] = []
    for p in ordered:
        if any(_crosses(p, q) for q in kept):
            dropped.append(p)
        else:
            kept.append(p)
    kept.sort(key=lambda p: p["i"])
    return kept, dropped


def _crosses(a: dict, b: dict) -> bool:
    """两个配对是否交叉（会形成假结）。"""
    i, j = a["i"], a["j"]
    k, l = b["i"], b["j"]
    return (i < k < j < l) or (k < i < l < j)


def resolve_conflicts(pairs: list[dict], *, prefer_canonical: bool = True) -> list[dict]:
    """
    每个碱基在二级结构里只能属于一个配对，这里做贪心挑选。

    排序规则：氢键多的优先，其次经典配对优先，再次平均键长短的优先。
    不做这一步的话，螺旋上相邻的两对会互相「串味」——比如受体臂里
    会同时检出 4-69 和 4-70 两个配对，而 4 只能配一个。
    """
    ordered = sorted(
        pairs,
        key=lambda p: (
            0 if (prefer_canonical and p["canonical"]) else 1,
            -p.get("stack", 0),
            -p["hbonds"],
            -p["score"][1],
        ),
    )
    used: set[int] = set()
    kept = []
    for p in ordered:
        if p["i"] in used or p["j"] in used:
            continue
        used.add(p["i"])
        used.add(p["j"])
        kept.append(p)
    kept.sort(key=lambda p: p["i"])
    return kept


# ─────────────────── 参考序列比对（把配对映射回参考坐标） ───────────────────

def align_to_reference(pdb_seq: str, ref_seq: str) -> dict[str, Any]:
    """
    把 PDB 抽出的序列与用户给的参考序列做全局比对。

    用途：晶体结构里常有残基没解析出来，抽出的序列会比真实序列短、
    后面的编号全部错位。有了比对就能把配对映射回参考序列的坐标上。

    序列不长（几百到几千），直接 Needleman-Wunsch 即可。
    """
    a, b = pdb_seq.upper(), ref_seq.upper().replace("T", "U")
    n, m = len(a), len(b)
    # 打分：匹配 +2，错配 -1，空位 -2
    MATCH, MISMATCH, GAP = 2, -1, -2
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i * GAP
    for j in range(1, m + 1):
        dp[0][j] = j * GAP
    for i in range(1, n + 1):
        ai = a[i - 1]
        row, prev = dp[i], dp[i - 1]
        for j in range(1, m + 1):
            s = MATCH if ai == b[j - 1] else MISMATCH
            row[j] = max(prev[j - 1] + s, prev[j] + GAP, row[j - 1] + GAP)

    # 回溯
    map_pdb_to_ref: dict[int, int] = {}
    i, j = n, m
    gaps_in_pdb, missing_in_pdb, mismatches = 0, [], []
    while i > 0 and j > 0:
        ai, bj = a[i - 1], b[j - 1]
        s = MATCH if ai == bj else MISMATCH
        if dp[i][j] == dp[i - 1][j - 1] + s:
            if ai == bj:
                map_pdb_to_ref[i - 1] = j - 1
            else:
                mismatches.append({"pdb_pos": i, "pdb_base": ai,
                                   "ref_pos": j, "ref_base": bj})
            i -= 1; j -= 1
        elif dp[i][j] == dp[i - 1][j] + GAP:
            gaps_in_pdb += 1          # PDB 里多出来的碱基
            i -= 1
        else:
            missing_in_pdb.append(j)  # 参考里有、PDB 里没解析出来
            j -= 1
    while i > 0:
        gaps_in_pdb += 1; i -= 1
    while j > 0:
        missing_in_pdb.append(j); j -= 1

    matched = len(map_pdb_to_ref)
    return {
        "map": map_pdb_to_ref,                    # pdb 索引 → 参考索引
        "matched": matched,
        "identity": round(matched / max(1, len(b)), 4),
        "extra_in_pdb": gaps_in_pdb,
        "missing_in_pdb": sorted(missing_in_pdb),
        "mismatches": sorted(mismatches, key=lambda d: d["pdb_pos"]),
        "pdb_length": n,
        "ref_length": m,
    }


# ─────────────────────────── 主流程 ───────────────────────────

def structure_from_chain(
    chain: Chain,
    *,
    ligands: list[dict] | None = None,
    reference: str | None = None,
    include_noncanonical: bool = True,
    nested_only: bool = False,
) -> dict[str, Any]:
    """把一条链转成二级结构。返回序列、点括号、配对明细与统计。"""
    raw_pairs = detect_pairs(chain)
    pairs = resolve_conflicts(raw_pairs)

    if not include_noncanonical:
        pairs = [p for p in pairs if p["canonical"]]

    dropped_pk: list[dict] = []
    if nested_only:
        # 去掉交叉配对，得到能嵌套表示、可算 ΔG 的二级结构
        pairs, dropped_pk = drop_pseudoknots(pairs)

    n_pdb = len(chain.residues)
    notes: list[str] = []
    mods = sorted({r.raw_name for r in chain.residues if r.modified})

    # 序列与配对：默认直接用 PDB 抽出来的
    sequence = chain.sequence
    index_map = {i: i for i in range(n_pdb)}      # pdb 索引 → 输出索引
    ref_info = None

    if reference and reference.strip():
        ref_clean = re.sub(r"[^A-Za-z]", "", reference).upper().replace("T", "U")
        if not ref_clean:
            raise StructureError("参考序列里没有有效的碱基字母")
        ref_info = align_to_reference(sequence, ref_clean)
        index_map = ref_info["map"]
        # 以参考序列为准，PDB 没解析出来的位置补成未配对
        sequence = ref_clean
        notes.append(
            f"已与参考序列比对：{ref_info['matched']}/{len(ref_clean)} 位对齐"
            + (f"，PDB 中缺失 {len(ref_info['missing_in_pdb'])} 个残基"
               if ref_info["missing_in_pdb"] else "")
            + (f"，{len(ref_info['mismatches'])} 处碱基不同"
               if ref_info["mismatches"] else "")
        )

    mapped = []
    for p in pairs:
        oi = index_map.get(p["i"])
        oj = index_map.get(p["j"])
        if oi is None or oj is None:
            continue                              # 落在 PDB 缺失区域，丢弃
        mapped.append({**p, "i": min(oi, oj), "j": max(oi, oj)})
    mapped.sort(key=lambda p: p["i"])

    structure = pairs_to_dotbracket(len(sequence), [(p["i"], p["j"]) for p in mapped])

    # 括号只有 4 种，假结的交叉层次超过 4 层时会有配对被省略。
    # 这种丢失必须说出来，不能悄悄少几对。
    try:
        achieved = len(parse(structure, sequence).pairs)
    except StructureError:
        achieved = len(mapped)
    lost = len(mapped) - achieved
    if lost > 0:
        notes.append(
            f"有 {lost} 个配对因假结交叉层次过深（可用的括号种类不够）未能表示，已省略。"
            "勾选「去掉假结」可得到完整但嵌套的结构。"
        )

    # 配体接触：把残基索引映射到输出坐标，落在缺失区间的丢掉。
    # 局部变量千万别再叫 ligands —— 那会遮蔽同名参数，
    # 传给接触检测的成了空列表，配体就永远检测不出来。
    out_ligands = []
    for lig in find_ligand_contacts(chain, ligands):
        pos = []
        for c in lig["contacts"]:
            oi = index_map.get(c["index"])
            if oi is not None:
                pos.append({"index": oi, "base": c["base"], "distance": c["distance"]})
        if pos:
            out_ligands.append({
                "name": lig["name"], "seq_id": lig["seq_id"],
                "n_atoms": lig["n_atoms"], "n_contacts": len(pos),
                "positions": pos,
            })

    canon = sum(1 for p in mapped if p["canonical"])
    return {
        "sequence": sequence,
        "structure": structure,
        "chain_id": chain.chain_id,
        "length": len(sequence),
        "pairs": mapped,
        "n_pairs": len(mapped),
        "n_canonical": canon,
        "n_noncanonical": len(mapped) - canon,
        "n_raw_candidates": len(raw_pairs),
        "modified_residues": mods,
        "notes": notes,
        "reference": ref_info,
        "n_pseudoknot_pairs_dropped": len(dropped_pk),
        # PDB 里没解析出来的连续区段（参考序列坐标，0-based 闭区间）。
        # 这些位置在结构上是自由单链，前端会把它们标成灰色缺口带。
        "missing_regions": _contiguous(ref_info["missing_in_pdb"]) if ref_info else [],
        "ligands": out_ligands,
        "unresolved": (len(ref_info["missing_in_pdb"]) if ref_info else 0),
    }


def _contiguous(positions_1based: list[int]) -> list[list[int]]:
    """把零散的 1-based 位置合并成连续区段，返回 0-based 闭区间。"""
    if not positions_1based:
        return [], []
    ps = sorted(set(positions_1based))
    out, start, prev = [], ps[0], ps[0]
    for p in ps[1:]:
        if p == prev + 1:
            prev = p
        else:
            out.append([start - 1, prev - 1])
            start = prev = p
    out.append([start - 1, prev - 1])
    return out


def find_ligand_contacts(chain: Chain, ligands: list[dict] | None = None,
                         *, cutoff: float = 4.0) -> list[dict[str, Any]]:
    """
    找出每个配体与哪些核苷酸有接触（任一原子对距离 ≤ cutoff）。

    用空间网格加速：把 RNA 的原子按 6 Å 的格子分桶，每个配体原子只查邻近格子。
    不做这一步的话，一个带几千个配体（含离子和水）的核糖体结构要做十亿次
    距离计算——实测直接卡死。
    """
    ligands = ligands if ligands is not None else chain.ligands
    if not ligands:
        return []

    cell = max(6.0, cutoff * 1.5)
    grid: dict[tuple[int, int, int], list[tuple[int, tuple[float, float, float]]]] = {}
    for r in chain.residues:
        for xyz in r.atoms.values():
            key = (int(xyz[0] // cell), int(xyz[1] // cell), int(xyz[2] // cell))
            grid.setdefault(key, []).append((r.index, xyz))

    c2 = cutoff * cutoff
    out = []
    for lig in ligands:
        best: dict[int, float] = {}
        for la in lig["atoms"].values():
            gx, gy, gz = int(la[0] // cell), int(la[1] // cell), int(la[2] // cell)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for ridx, ra in grid.get((gx + dx, gy + dy, gz + dz), ()):
                            d2 = ((la[0] - ra[0]) ** 2 + (la[1] - ra[1]) ** 2
                                  + (la[2] - ra[2]) ** 2)
                            if d2 <= c2:
                                d = d2 ** 0.5
                                if ridx not in best or d < best[ridx]:
                                    best[ridx] = d
        if best:
            out.append({
                "name": lig["name"],
                "seq_id": lig["seq_id"],
                "n_atoms": len(lig["atoms"]),
                "n_contacts": len(best),
                "contacts": [{"index": i,"seq_id": chain.residues[i].seq_id,
                              "base": chain.residues[i].base, "distance": round(d, 2)}
                             for i, d in sorted(best.items())],
            })
    out.sort(key=lambda x: (-x["n_contacts"], x["name"]))
    return out


def chain_summary(chain: Chain) -> dict[str, Any]:
    """给界面用的链概览。"""
    seq = chain.sequence
    mods = sorted({r.raw_name for r in chain.residues if r.modified})
    return {
        "chain_id": chain.chain_id,
        "length": len(seq),
        "sequence_preview": seq[:60] + ("…" if len(seq) > 60 else ""),
        "sequence": seq,
        "modified_residues": mods,
        "n_ligands": len(chain.ligands),
        "ligand_names": sorted({l["name"] for l in chain.ligands}),
    }
