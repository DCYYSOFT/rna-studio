"""RNAstructure 引擎适配器（调用 Mathews lab 的命令行程序）。

本模块的每一处 CLI 用法与文件格式都在真机（RNAstructure 6.6，本地编译版）上实测确认过：

* ``Fold <seq> <out> -k``          输出 dot-bracket；默认单位是 CT
* ``MaxExpect <seq> <out> --sequence``  最大期望准确度结构
* ``ProbKnot  <seq> <out> --sequence``  **允许假结**的 MEA 结构
* ``DuplexFold <seqA> <seqB> <out>``    RNA–RNA 相互作用；两链间会自动插入 3 nt 的 ``III`` 连接子
* ``efn2 <ct> <out>``               评估**指定结构**的自由能（用于手动建模后重算 ΔG）
* ``partition`` + ``ProbabilityPlot --text``  输出 ``i j -log10(P)`` 形式的配对概率

约束文件（``-c``）必须包含**全部 6 段且顺序固定**，缺失的段要写成 ``-1`` / ``-1 -1``：
    DS: -1 / SS: <pos...> -1 / Mod: -1 / Pairs: <i j...> -1 -1 / FMN: -1 / Forbids: <i j...> -1 -1
（只写部分段会导致解析错位，约束被静默忽略——这是实测踩过的坑。）

温度单位是**开尔文**，与 ViennaRNA 的摄氏度不同，本模块内部统一按摄氏度对外。
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from ..ct import read_ct, write_ct
from ..dotbracket import StructureError, pairs_to_dotbracket, parse
from ..paths import bundle_dir
from .base import EngineStatus, StructureResult

# 每个程序允许的运行时间（秒）。RNA 越长越慢，给足余量。
TIMEOUT = 180


def _candidate_roots() -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("RNASTRUCTURE_PATH")
    if env:
        out.append(Path(env).expanduser())

    # 打包后随包目录优先（用户不需要自己装）
    base = bundle_dir()
    out += [base / "vendor" / "RNAstructure", base / "RNAstructure"]

    # 开发时以及常见的安装位置
    for b in [Path(__file__).resolve().parents[2], Path.home(), Path("/usr/local"), Path("/opt")]:
        out += [
            b / "vendor" / "RNAstructure",
            b / "RNAstructure",
            b / "RNAstructure" / "RNAstructure",
        ]
    out += [Path("/Applications/RNAstructure"), Path("/usr/local/share/RNAstructure")]
    return out


def _probe_root(root: Path) -> tuple[Path, Path] | None:
    """返回 (可执行文件目录, data_tables 目录)。"""
    if not root or not root.exists():
        return None
    for exe_dir in [root / "exe", root, root / "RNAstructure" / "exe"]:
        if (exe_dir / "Fold").exists():
            for dp in [root / "data_tables", exe_dir.parent / "data_tables", exe_dir / "data_tables"]:
                if dp.exists():
                    return exe_dir, dp
    return None


def locate() -> tuple[Path, Path] | None:
    for root in _candidate_roots():
        got = _probe_root(root)
        if got:
            return got
    which = shutil.which("Fold")
    if which:
        exe_dir = Path(which).parent
        for dp in [exe_dir.parent / "data_tables", exe_dir / "data_tables"]:
            if dp.exists():
                return exe_dir, dp
    return None


class RNAstructureEngine:
    id = "rnastructure"
    name = "RNAstructure"

    def __init__(self) -> None:
        self._loc: tuple[Path, Path] | None = None
        self._located = False

    # ---------------------------------------------------------------- locate
    @property
    def loc(self) -> tuple[Path, Path] | None:
        if not self._located:
            self._loc = locate()
            self._located = True
        return self._loc

    def status(self) -> EngineStatus:
        loc = self.loc
        if not loc:
            return EngineStatus(
                id=self.id,
                name=self.name,
                available=False,
                detail="未检测到 RNAstructure 命令行程序",
                install_hint=(
                    "到 https://rna.urmc.rochester.edu/RNAstructureDownload.html 下载 "
                    "「Text (Command-Line) Interfaces」对应系统的压缩包，解压后设置环境变量 "
                    "RNASTRUCTURE_PATH 指向该目录（内含 exe/ 与 data_tables/）。"
                    "注意官方 Mac 版是 x86_64，Apple Silicon 需要 Rosetta 2。"
                ),
            )
        exe_dir, data_dir = loc
        version = None
        try:
            r = subprocess.run(
                [str(exe_dir / "Fold"), "--version"],
                capture_output=True, text=True, timeout=30,
                env={**os.environ, "DATAPATH": str(data_dir)},
            )
            m = re.search(r"(\d+\.\d+(?:\.\d+)?)", r.stdout + r.stderr)
            version = m.group(1) if m else None
        except Exception:
            pass
        return EngineStatus(
            id=self.id,
            name=self.name,
            available=True,
            version=version,
            detail=f"命令行程序目录：{exe_dir}",
            supports=["mfe", "maxexpect", "probknot", "constrained", "probing", "evaluate", "cofold", "probabilities"],
        )

    # ------------------------------------------------------------------- run
    def _run(self, prog: str, args: list[str], *, timeout: int = TIMEOUT) -> str:
        loc = self.loc
        if not loc:
            raise StructureError("RNAstructure 未安装或未配置 RNASTRUCTURE_PATH")
        exe_dir, data_dir = loc
        env = {**os.environ, "DATAPATH": str(data_dir)}
        r = subprocess.run(
            [str(exe_dir / prog), *args],
            capture_output=True, text=True, timeout=timeout, env=env,
            cwd=tempfile.gettempdir(),
        )
        if r.returncode != 0:
            tail = (r.stderr or r.stdout or "").strip().splitlines()
            msg = tail[-1] if tail else f"退出码 {r.returncode}"
            raise StructureError(f"{prog} 执行失败：{msg}")
        return r.stdout

    def _write_seq(self, d: Path, name: str, seq: str) -> Path:
        p = d / name
        p.write_text(f">rna\n{seq}\n")
        return p

    # ----------------------------------------------------- 约束/探测 文件生成
    @staticmethod
    def _con_file(parsed) -> str:
        """按固定顺序生成完整 6 段约束文件（缺段必须写 -1，否则解析错位）。"""
        forced = " ".join(f"{i + 1} {j + 1}" for i, j in parsed.pairs)
        single = " ".join(str(i + 1) for i in parsed.forbidden)
        lines = [
            "DS: -1",
            f"SS: {single} -1" if single else "SS: -1",
            "Mod: -1",
            f"Pairs: {forced} -1 -1" if forced else "Pairs: -1 -1",
            "FMN: -1",
            "Forbids: -1 -1",
        ]
        return "\n".join(lines) + "\n"

    @staticmethod
    def _shape_file(values: list[float | None], method: str) -> str:
        """SHAPE/DMS 数据：两列「位置 反应性」，无数据的位点写 -999（不是终止符）。"""
        lines = []
        for idx, v in enumerate(values, 1):
            lines.append(f"{idx}\t{' -999' if v is None else f'{float(v):.5f}'}")
        return "\n".join(lines) + "\n"

    @staticmethod
    def _read_bracket(text: str) -> tuple[str, str, float | None]:
        """从 `>ENERGY = x  name / seq / (((...)))` 三行式输出里取出序列、结构与能量。"""
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        struct = None
        for l in reversed(lines):
            if l and set(l) <= set(".()[]{}<>"):
                struct = l
                break
        if not struct:
            raise StructureError("RNAstructure 没有返回结构（可能序列过短或含非法字符）")
        seq = ""
        for l in lines:
            if l and set(l.upper()) <= set("ACGUTN") and len(l) == len(struct):
                seq = l.upper().replace("T", "U")
                break
        energy = None
        for l in lines:
            m = re.search(r"ENERGY\s*=\s*(-?[\d.]+)", l)
            if m:
                energy = float(m.group(1))
                break
        return seq, struct, energy  # type: ignore[return-value]
    @staticmethod
    def _read_energy_file(text: str) -> tuple[float | None, list[dict[str, Any]]]:
        m = re.search(r"Energy\s*=\s*(-?[\d.]+)", text)
        energy = float(m.group(1)) if m else None
        decomp = []
        for line in text.splitlines():
            mm = re.match(r"^\s*(.+?):\s*(-?[\d.]+)\s*$", line.strip())
            if mm and "Energy" not in mm.group(1):
                decomp.append({"label": mm.group(1).strip(), "energy": float(mm.group(2))})
        return energy, decomp

    # --------------------------------------------------------------- predict
    def predict(
        self,
        sequence: str,
        *,
        constraints: str | None = None,
        probing: dict | None = None,
        temperature: float | None = None,
        method: str = "mfe",
        **_ignored,
    ) -> StructureResult:
        seq = sequence.upper().replace("T", "U")
        if not seq:
            raise StructureError("序列为空")

        method = (method or "mfe").lower()
        if method not in {"mfe", "maxexpect", "probknot"}:
            raise StructureError(f"RNAstructure 不支持的方法：{method}")

        parsed = None
        has_cons = bool(constraints and constraints.strip("."))
        if has_cons:
            parsed = parse(constraints, seq)

        # 实测：只有 Fold / DuplexFold / partition / efn2 认识 -t。
        # MaxExpect / ProbKnot 收到 -t 不会报错，而是**静默返回一个全不配对的错误结果**，
        # 所以绝不能直接把 -t 传给它们——需要温度时改走 partition 中转。
        # partition 也不接受硬约束（实测会 OOM 崩掉），因此这两条路互斥。
        if has_cons and method != "mfe":
            raise StructureError(
                f"{method.upper()} 不支持硬约束（强制/禁止配对）。"
                "请改用「MFE」方法，或先清空约束再运行。"
            )

        temp_args = ["-t", f"{float(temperature) + 273.15:.2f}"] if temperature is not None else []
        notes: list[str] = []

        with tempfile.TemporaryDirectory(prefix="rnas_") as td:
            d = Path(td)
            seqfile = self._write_seq(d, "in.fa", seq)

            probe_args: list[str] = []
            if probing:
                vals = probing.get("values") or []
                if len(vals) != len(seq):
                    raise StructureError(f"探测数据长度 {len(vals)} 与序列长度 {len(seq)} 不一致")
                sf = d / "probe.shape"
                sf.write_text(self._shape_file(vals, probing.get("method", "SHAPE")))
                meth = (probing.get("method") or "SHAPE").upper()
                if meth == "DMS":
                    probe_args += ["-dms", str(sf)]
                else:
                    probe_args += [
                        "-sh", str(sf),
                        "-sm", str(probing.get("m", 1.8)),
                        "-si", str(probing.get("b", -0.6)),
                    ]
                notes.append(f"已应用 {meth} 探测数据（伪能量软约束）")

            if method == "mfe":
                out = d / "out.bracket"
                args = [str(seqfile), str(out), "-k", "-mfe"]
                if parsed is not None and (parsed.pairs or parsed.forbidden):
                    cf = d / "constraints.con"
                    cf.write_text(self._con_file(parsed))
                    args += ["-c", str(cf)]
                    notes.append(
                        f"已应用约束：强制 {len(parsed.pairs)} 个配对、"
                        f"禁止配对 {len(parsed.forbidden)} 个位点"
                    )
                self._run("Fold", [*args, *probe_args, *temp_args])
                _seq_in_file, struct, energy = self._read_bracket(out.read_text())
                result_seq = seq
            else:
                # partition（可带温度和 SHAPE）→ pfs → MaxExpect / ProbKnot
                pfs = d / "p.pfs"
                self._run("partition", [str(seqfile), str(pfs), *probe_args, *temp_args])
                ct = d / "out.ct"
                prog = "MaxExpect" if method == "maxexpect" else "ProbKnot"
                self._run(prog, [str(pfs), str(ct)])
                text = ct.read_text()
                result_seq, pairs = read_ct(text)
                struct = pairs_to_dotbracket(len(result_seq), pairs)
                energy = None
                notes.append(
                    f"方法：{'最大期望准确度（MaxExpect）' if method == 'maxexpect' else 'ProbKnot，允许假结'}"
                    + ("；先经 partition 计算配分函数以支持温度设定" if temp_args else "")
                )
                if method == "probknot":
                    notes.append("ProbKnot 结果可能包含交叉配对（假结）")

            if temp_args:
                notes.append(f"温度 {temperature} °C")

        # 结果序列必须与输入一致——防止程序静默返回错位的结构
        if result_seq and result_seq != seq:
            raise StructureError(
                f"RNAstructure 返回的序列与输入不一致（{len(result_seq)} vs {len(seq)} nt），"
                "已放弃该结果。"
            )

        res = StructureResult(
            dotbracket=struct, energy=energy, sequence=seq,
            engine=self.id, notes=notes,
        )
        try:
            res.pairs = sorted(parse(struct, seq).pairs)
        except StructureError:
            res.pairs = []
        return res

    # -------------------------------------------------------------- evaluate
    def evaluate(
        self,
        sequence: str,
        structure: str,
        *,
        temperature: float | None = None,
        with_decomposition: bool = True,
        **_ignored,
    ) -> StructureResult:
        seq = sequence.upper().replace("T", "U")
        parsed = parse(structure, seq)
        if parsed.has_pseudoknot:
            res = StructureResult(
                dotbracket=parsed.dotbracket, energy=None, sequence=seq,
                engine=self.id, pairs=parsed.pairs,
                notes=["efn2 不能处理假结结构，返回结构但不给出 ΔG"],
            )
            res.warnings.append("RNAstructure 的 efn2 不支持假结，无法计算该结构的 ΔG。")
            return res

        with tempfile.TemporaryDirectory(prefix="rnas_") as td:
            d = Path(td)
            ct = d / "s.ct"
            ct.write_text(write_ct(seq, parsed.pairs))
            eout = d / "e.txt"
            args = [str(ct), str(eout)]
            if temperature is not None:
                args += ["-t", str(float(temperature) + 273.15)]
            self._run("efn2", args)
            energy, decomp = self._read_energy_file(eout.read_text())

        res = StructureResult(
            dotbracket=parsed.dotbracket, energy=energy, sequence=seq,
            engine=self.id, pairs=parsed.pairs,
        )
        if with_decomposition:
            res.decomposition = decomp
        res.notes.append("能量由 efn2 计算（与 Fold 报告的 ΔG 口径略有不同，属正常）")
        return res

    # ---------------------------------------------------------------- cofold
    def cofold(self, sequence_a: str, sequence_b: str, *, temperature: float | None = None, **_ignored) -> StructureResult:
        a = sequence_a.upper().replace("T", "U")
        b = sequence_b.upper().replace("T", "U")
        if not a or not b:
            raise StructureError("共折叠需要两条非空序列")

        with tempfile.TemporaryDirectory(prefix="rnas_") as td:
            d = Path(td)
            fa = self._write_seq(d, "a.fa", a)
            fb = self._write_seq(d, "b.fa", b)
            ct = d / "d.ct"
            args = [str(fa), str(fb), str(ct)]
            if temperature is not None:
                args += ["-t", str(float(temperature) + 273.15)]
            self._run("DuplexFold", args)

            text = ct.read_text()
            s, pairs = read_ct(text)
            energy = None
            m = re.search(r"ENERGY\s*=\s*(-?[\d.]+)", text)
            if m:
                energy = float(m.group(1))

        # DuplexFold 会在两链之间插入 3 nt 的 "III" 连接子，需要据此换算索引
        linker = len(s) - len(a) - len(b)
        if linker < 0:
            raise StructureError("DuplexFold 返回的序列长度异常")
        la, lb = len(a), len(b)
        b_offset = la + linker

        def remap(idx: int) -> int | None:
            if idx < la:
                return idx
            if idx >= b_offset:
                return la + (idx - b_offset)
            return None  # 落在连接子内

        remapped: list[tuple[int, int]] = []
        for i, j in pairs:
            ri, rj = remap(i), remap(j)
            if ri is not None and rj is not None:
                remapped.append((ri, rj))
        remapped.sort()
        combined = a + b
        struct = pairs_to_dotbracket(len(combined), remapped)

        res = StructureResult(
            dotbracket=struct, energy=energy, sequence=combined,
            engine=self.id, pairs=remapped,
        )
        res.notes.append(
            f"RNA–RNA 共折叠（DuplexFold）：链 A {la} nt + 链 B {lb} nt；"
            f"DuplexFold 内部插入了 {linker} nt 连接子，索引已换算回原始坐标"
        )
        res.notes.append(f"链间配对 {sum(1 for i, j in remapped if i < la <= j)} 个")
        return res

    # --------------------------------------------------------- probabilities
    def probabilities(self, sequence: str, *, temperature: float | None = None) -> list[list[float]]:
        seq = sequence.upper().replace("T", "U")
        if not seq:
            raise StructureError("序列为空")
        n = len(seq)
        with tempfile.TemporaryDirectory(prefix="rnas_") as td:
            d = Path(td)
            seqfile = self._write_seq(d, "in.fa", seq)
            pfs = d / "p.pfs"
            args = [str(seqfile), str(pfs)]
            if temperature is not None:
                args += ["-t", str(float(temperature) + 273.15)]
            self._run("partition", args)

            txt = d / "pp.txt"
            self._run("ProbabilityPlot", [str(pfs), str(txt), "--text"])

            M = [[0.0] * n for _ in range(n)]
            for line in txt.read_text().splitlines()[1:]:
                parts = line.split()
                if len(parts) < 3:
                    continue
                try:
                    i, j, neglog = int(parts[0]), int(parts[1]), float(parts[2])
                except ValueError:
                    continue
                if 1 <= i <= n and 1 <= j <= n and i != j:
                    p = min(1.0, 10.0 ** (-neglog))
                    M[i - 1][j - 1] = p
                    M[j - 1][i - 1] = p
        return M


ENGINE = RNAstructureEngine()
