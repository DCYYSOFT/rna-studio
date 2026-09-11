"""引擎抽象层：所有预测引擎都实现同一套接口，上层路由不关心用的是哪个。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

# ViennaRNA 用一个极大的正数表示"结构不可行"（环太小、空间冲突等）。
# 实测该值并不总是精确的 100000.0（例如 99982.6），所以用一个远高于任何真实
# RNA 结构的阈值来判断——真核/原核 RNA 的 ΔG 通常在 -1000 ~ +100 kcal/mol 之间。
INFEASIBLE_THRESHOLD = 50000.0
INFEASIBLE_ENERGY = INFEASIBLE_THRESHOLD  # 向后兼容的别名


@dataclass
class StructureResult:
    dotbracket: str
    energy: float | None = None          # kcal/mol，None 表示引擎未给
    sequence: str = ""
    engine: str = ""
    infeasible: bool = False             # True 表示该结构在热力学上不成立
    pairs: list[tuple[int, int]] = field(default_factory=list)
    probabilities: list[list[float]] | None = None   # n×n，仅配对概率
    decomposition: list[dict[str, Any]] | None = None
    ensemble_energy: float | None = None
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class EngineStatus:
    id: str
    name: str
    available: bool
    version: str | None = None
    detail: str = ""
    install_hint: str = ""
    supports: list[str] = field(default_factory=list)


class Engine(Protocol):
    id: str
    name: str

    def status(self) -> EngineStatus: ...
    def predict(self, sequence: str, **kw) -> StructureResult: ...
    def evaluate(self, sequence: str, structure: str, **kw) -> StructureResult: ...
    def cofold(self, sequence_a: str, sequence_b: str, **kw) -> StructureResult: ...
    def probabilities(self, sequence: str, **kw) -> list[list[float]]: ...
