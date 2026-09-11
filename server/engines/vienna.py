"""ViennaRNA 引擎实现。

对应 API 为 ViennaRNA 2.7.x 的 Python 绑定，关键约定（已实测确认）：

* ``fc.mfe()`` 返回 ``[structure, energy]``（list，不是对象）
* ``fc.bpp()`` 必须**先调用 ``fc.pf()``**，否则返回空 tuple；
  且矩阵是 **1-indexed**，维度 (n+2)×(n+2)，真实配对 (i,j) 在 ``M[i][j]``
* ``V.naview_xy_coordinates(st)`` 返回长度 n+1 的 tuple，
  **0-indexed**：索引 0..n-1 对应碱基 1..n，索引 n 是 (0,0) 补位
* 强制配对必须带 ``CONSTRAINT_DB_ENFORCE_BP``，否则被静默忽略
* 结构不可行时能量是一个极大的正数（实测可能是 99982.6 而非精确的 100000.0），
  因此用 ``INFEASIBLE_THRESHOLD`` 阈值判断
"""
from __future__ import annotations

import re
from typing import Any

from ..dotbracket import StructureError, parse, pairs_to_dotbracket
from .base import INFEASIBLE_THRESHOLD, EngineStatus, StructureResult

try:  # 允许在没有装 ViennaRNA 的机器上 import 本模块（用于报状态）
    import ViennaRNA as V

    _IMPORT_ERROR: str | None = None
except Exception as e:  # pragma: no cover
    V = None  # type: ignore[assignment]
    _IMPORT_ERROR = str(e)

# 约束字符（ViennaRNA 点括号约束语法）
C_FREE = "."
C_FORBID = "x"
C_OPEN = "("
C_CLOSE = ")"


def _constraint_flags(V_mod, *, forcing: bool) -> int:
    flags = V_mod.CONSTRAINT_DB | V_mod.CONSTRAINT_DB_DEFAULT
    if forcing:
        flags |= V_mod.CONSTRAINT_DB_ENFORCE_BP
    return flags


class ViennaEngine:
    id = "vienna"
    name = "ViennaRNA"

    # ---------------------------------------------------------------- status
    def status(self) -> EngineStatus:
        if V is None:
            return EngineStatus(
                id=self.id,
                name=self.name,
                available=False,
                detail=f"未安装：{_IMPORT_ERROR}",
                install_hint="pip install ViennaRNA",
            )
        version = getattr(V, "__version__", None)
        if not version:
            try:
                from importlib.metadata import version as pkg_version

                version = pkg_version("ViennaRNA")
            except Exception:
                version = "2.x"
        return EngineStatus(
            id=self.id,
            name=self.name,
            available=True,
            version=version,
            detail="ViennaRNA C 核心，通过 Python 绑定直接调用（进程内，无需外部程序）",
            supports=["mfe", "constrained", "probing", "probabilities", "evaluate", "cofold", "subopt"],
        )

    # ------------------------------------------------------------- internals
    def _fc(self, sequence: str, temperature: float | None = None, dangles: int | None = None):
        seq = sequence.upper().replace("T", "U")
        md = None
        if temperature is not None or dangles is not None:
            md = V.md()  # type: ignore[attr-defined]
            if temperature is not None:
                md.temperature = float(temperature)
            if dangles is not None:
                md.dangles = int(dangles)
        return V.fold_compound(seq, md) if md is not None else V.fold_compound(seq)

    def _apply_constraints(self, fc, parsed, *, honor_forbidden: bool = True):
        """把 ParsedStructure 转成 ViennaRNA 约束串并应用。返回是否需要 ENFORCE_BP。"""
        n = parsed.n
        buf = [C_FREE] * n
        if honor_forbidden:
            for i in parsed.forbidden:
                buf[i] = C_FORBID
        forcing = bool(parsed.pairs)
        for i, j in parsed.pairs:
            buf[i] = C_OPEN
            buf[j] = C_CLOSE
        if any(c != C_FREE for c in buf):
            fc.constraints_add("".join(buf), _constraint_flags(V, forcing=forcing))
        return forcing

    def _apply_probing(self, fc, probing: dict | None, n: int):
        """probing = {"method": "SHAPE"|"DMS", "values": [...], "m": float, "b": float}"""
        if not probing:
            return
        values = probing.get("values") or []
        if len(values) != n:
            raise StructureError(f"探测数据长度 {len(values)} 与序列长度 {n} 不一致")
        vals = [float(x) if x is not None else -999.0 for x in values]
        method = (probing.get("method") or "SHAPE").upper()
        if method == "DMS":
            beta = float(probing.get("beta", 1.0))
            default = float(probing.get("default", 0.5))
            pd = V.probing_data_zarringhalam(vals, beta, "", default)  # type: ignore[attr-defined]
        else:
            m = float(probing.get("m", 1.8))
            b = float(probing.get("b", -0.6))
            pd = V.probing_data_deigan(vals, m, b)  # type: ignore[attr-defined]
        fc.sc_probing(pd)

    @staticmethod
    def _bpp_matrix(fc, n: int) -> list[list[float]]:
        """返回 n×n 的 0-indexed 配对概率矩阵。"""
        fc.pf()
        M = fc.bpp()
        # M 是 1-indexed，维度 (n+2)x(n+2)；真实配对 (i,j) 1-based 位于 M[i][j]
        out = [[0.0] * n for _ in range(n)]
        for i in range(1, n + 1):
            row = M[i]
            for j in range(i + 1, n + 1):
                p = float(row[j])
                if p > 0.0:
                    out[i - 1][j - 1] = p
                    out[j - 1][i - 1] = p
        return out

    @staticmethod
    def _decompose(sequence: str, structure: str) -> list[dict[str, Any]]:
        """抓取 eval_structure_verbose 的逐环能量分解。

        注意：这段输出由 C 层 printf 直接写到文件描述符 1，
        Python 的 contextlib.redirect_stdout 抓不到，必须做 fd 级重定向。
        能量单位是 10 cal/mol，需除以 100 换算成 kcal/mol。
        """
        import os
        import sys
        import tempfile

        try:
            fc = V.fold_compound(sequence.upper().replace("T", "U"))
            sys.stdout.flush()
            with tempfile.TemporaryFile(mode="w+") as tf:
                saved = os.dup(1)
                try:
                    os.dup2(tf.fileno(), 1)
                    fc.eval_structure_verbose(structure)
                    sys.stdout.flush()
                finally:
                    os.dup2(saved, 1)
                    os.close(saved)
                tf.seek(0)
                text = tf.read()
        except Exception:
            return []
        if not text.strip():
            return []

        out: list[dict[str, Any]] = []
        # 形如： "Interior loop (  1, 21) GC; (  2, 20) GC:  -330"
        for line in text.splitlines():
            m = re.match(r"^\s*(.+?)\s*:\s*(-?\d+)\s*$", line.rstrip())
            if not m:
                continue
            label, val = m.group(1).strip(), int(m.group(2))
            out.append({"label": label, "energy": val / 100.0})  # 10 cal/mol → kcal/mol

        # 把 "External loop" 排到最后，读起来更顺
        out.sort(key=lambda d: d["label"].startswith("External"))
        return out

    # --------------------------------------------------------------- predict
    def predict(
        self,
        sequence: str,
        *,
        constraints: str | None = None,
        probing: dict | None = None,
        temperature: float | None = None,
        dangles: int | None = None,
        with_probabilities: bool = True,
    ) -> StructureResult:
        seq = sequence.upper().replace("T", "U")
        if not seq:
            raise StructureError("序列为空")

        parsed = None
        if constraints and constraints.strip("."):
            parsed = parse(constraints, seq, allow_pseudoknot=False)

        fc = self._fc(seq, temperature, dangles)
        if parsed is not None:
            self._apply_constraints(fc, parsed)
        self._apply_probing(fc, probing, len(seq))

        struct, energy = fc.mfe()
        notes: list[str] = []
        if parsed is not None and (parsed.pairs or parsed.forbidden):
            notes.append(
                f"已应用约束：强制 {len(parsed.pairs)} 个配对，禁止配对 {len(parsed.forbidden)} 个位点"
            )
        if probing:
            notes.append(f"已应用 {probing.get('method', 'SHAPE')} 探测数据软约束")

        res = StructureResult(
            dotbracket=struct,
            energy=float(energy),
            sequence=seq,
            engine=self.id,
            notes=notes,
        )
        res.pairs = sorted(parse(struct, seq).pairs)
        res.infeasible = float(energy) >= INFEASIBLE_THRESHOLD

        if with_probabilities:
            try:
                fc2 = self._fc(seq, temperature, dangles)
                res.probabilities = self._bpp_matrix(fc2, len(seq))
            except Exception as e:
                res.warnings.append(f"配对概率计算失败：{e}")
        return res

    # -------------------------------------------------------------- evaluate
    def evaluate(
        self,
        sequence: str,
        structure: str,
        *,
        temperature: float | None = None,
        dangles: int | None = None,
        with_probabilities: bool = False,
        with_decomposition: bool = True,
    ) -> StructureResult:
        seq = sequence.upper().replace("T", "U")
        parsed = parse(structure, seq)  # ← 关口：不合法直接抛，绝不喂给 C 层

        if parsed.has_pseudoknot:
            (i, j), (k, l) = parsed.crossing_pairs[0]
            raise StructureError(
                f"该结构含假结（{i + 1}-{j + 1} 与 {k + 1}-{l + 1} 交叉），"
                "ViennaRNA 的近邻热力学模型不支持假结，无法计算 ΔG。"
                "可以切换到环形布局继续观察结构，或解除其中一对。"
            )

        fc = self._fc(seq, temperature, dangles)
        energy = float(fc.eval_structure(parsed.dotbracket))

        res = StructureResult(
            dotbracket=parsed.dotbracket,
            energy=energy,
            sequence=seq,
            engine=self.id,
            pairs=parsed.pairs,
            infeasible=energy >= INFEASIBLE_THRESHOLD,
        )
        if res.infeasible:
            res.warnings.append(
                "该结构在热力学上不可行（可能存在过短的环或空间冲突），ΔG 无意义。"
            )
        if with_decomposition and not res.infeasible:
            res.decomposition = self._decompose(seq, parsed.dotbracket)

        if with_probabilities:
            try:
                fc2 = self._fc(seq, temperature, dangles)
                res.probabilities = self._bpp_matrix(fc2, len(seq))
            except Exception as e:
                res.warnings.append(f"配对概率计算失败：{e}")
        return res

    # ---------------------------------------------------------------- cofold
    def cofold(
        self,
        sequence_a: str,
        sequence_b: str,
        *,
        temperature: float | None = None,
        dangles: int | None = None,
        with_probabilities: bool = False,
    ) -> StructureResult:
        a = sequence_a.upper().replace("T", "U")
        b = sequence_b.upper().replace("T", "U")
        if not a or not b:
            raise StructureError("共折叠需要两条非空序列")

        fc = self._fc(a + "&" + b, temperature, dangles)
        struct, energy = fc.mfe_dimer()

        # mfe_dimer 返回的串对应拼接序列（含分隔符位置）
        joined_len = len(a) + len(b)
        struct = struct[:joined_len] if len(struct) > joined_len else struct
        if len(struct) < joined_len:
            struct = struct + "." * (joined_len - len(struct))

        res = StructureResult(
            dotbracket=struct,
            energy=float(energy),
            sequence=a + b,
            engine=self.id,
            infeasible=float(energy) >= INFEASIBLE_THRESHOLD,
        )
        parsed = parse(struct, "N" * len(struct))
        res.pairs = [
            (i, j) for i, j in parsed.pairs if i < len(a) or j < len(a)
        ]
        res.notes.append(
            f"RNA–RNA 共折叠：链 A {len(a)} nt + 链 B {len(b)} nt，"
            f"链间配对 {sum(1 for i, j in res.pairs if i < len(a) <= j)} 个"
        )
        res.notes.append(f"拆分为 [{a}] 与 [{b}]")
        return res

    # --------------------------------------------------------- probabilities
    def probabilities(self, sequence: str, *, temperature: float | None = None) -> list[list[float]]:
        seq = sequence.upper().replace("T", "U")
        if not seq:
            raise StructureError("序列为空")
        fc = self._fc(seq, temperature, None)
        return self._bpp_matrix(fc, len(seq))


ENGINE = ViennaEngine()
