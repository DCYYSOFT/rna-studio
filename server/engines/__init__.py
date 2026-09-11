"""预测引擎注册表。"""
from __future__ import annotations

from .base import INFEASIBLE_ENERGY, Engine, EngineStatus, StructureResult
from .rnastructure import ENGINE as RNASTRUCTURE
from .vienna import ENGINE as VIENNA

ENGINES: dict[str, Engine] = {
    VIENNA.id: VIENNA,
    RNASTRUCTURE.id: RNASTRUCTURE,
}

DEFAULT_ENGINE = VIENNA.id


def get(engine_id: str | None) -> Engine:
    """取引擎实例；未指定则返回默认引擎。未知 id 抛 KeyError（由路由层转 400）。"""
    if not engine_id:
        return ENGINES[DEFAULT_ENGINE]
    if engine_id not in ENGINES:
        raise KeyError(f"未知引擎：{engine_id}")
    return ENGINES[engine_id]


def statuses() -> list[EngineStatus]:
    return [e.status() for e in ENGINES.values()]


__all__ = [
    "ENGINES", "DEFAULT_ENGINE", "Engine", "EngineStatus", "StructureResult",
    "INFEASIBLE_ENERGY", "get", "statuses", "VIENNA", "RNASTRUCTURE",
]
