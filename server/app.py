"""RNA Studio 后端：FastAPI 应用与 REST 接口。

设计要点
--------
* 所有进入预测引擎的结构串都会先过 :mod:`server.dotbracket` 校验，
  避免非法括号串把 ViennaRNA 的 C 扩展打崩（实测会 segfault）。
* 「手动编辑后实时重算 ΔG」走 ``/api/evaluate``：只做能量评估 + 重新排布，
  不重跑折叠，因此是毫秒级。
* ``/api/predict`` 负责真正的折叠（MFE / MaxExpect / ProbKnot），可以带约束和探测数据。
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import engines, layout as layout_mod, varna
from .ct import read_ct, write_ct
from .dotbracket import StructureError, parse, pairs_to_dotbracket, structural_distance
from .paths import resource

WEB_DIR = resource("web")

app = FastAPI(title="RNA Studio", version="1.0")


# --------------------------------------------------------------------- schemas
class Probing(BaseModel):
    method: str = "SHAPE"                      # SHAPE | DMS
    values: list[float | None] = Field(default_factory=list)
    m: float = 1.8
    b: float = -0.6
    beta: float = 1.0
    default: float = 0.5


class PredictReq(BaseModel):
    sequence: str
    engine: str | None = None
    method: str = "mfe"
    constraints: str | None = None
    probing: Probing | None = None
    temperature: float | None = None
    layout: str = "naview"
    with_probabilities: bool = True


class EvaluateReq(BaseModel):
    sequence: str
    structure: str
    engine: str | None = None
    temperature: float | None = None
    layout: str = "naview"
    with_probabilities: bool = False
    compare_mfe: bool = True


class CofoldReq(BaseModel):
    sequence_a: str
    sequence_b: str
    engine: str | None = None
    temperature: float | None = None
    layout: str = "naview"


class LayoutReq(BaseModel):
    sequence: str
    structure: str
    layout: str = "naview"


class ProbReq(BaseModel):
    sequence: str
    engine: str | None = None
    temperature: float | None = None


class RenderReq(BaseModel):
    sequence: str
    structure: str
    algorithm: str = "naview"          # naview | radiate | circular | line
    title: str | None = None
    period_num: int | None = 10
    bp_style: str | None = None
    color_values: list[float | None] | None = None
    color_style: str | None = None
    color_min: float | None = None
    color_max: float | None = None
    rotation: float | None = None


class ExportReq(BaseModel):
    sequence: str
    structure: str
    fmt: str = "ct"                    # ct | dotbracket | fasta


# ------------------------------------------------------------------- utilities
def _engine_or_400(engine_id: str | None):
    try:
        return engines.get(engine_id)
    except KeyError as e:
        raise HTTPException(status_code=400, detail=str(e.args[0])) from e


def _sparse_probs(matrix: list[list[float]] | None, threshold: float = 0.002) -> list[list[float]]:
    """把稠密概率矩阵转成稀疏 [[i, j, p], ...]，避免大 RNA 的响应体积爆掉。"""
    if not matrix:
        return []
    out: list[list[float]] = []
    n = len(matrix)
    for i in range(n):
        row = matrix[i]
        for j in range(i + 1, n):
            p = row[j]
            if p >= threshold:
                out.append([i, j, round(float(p), 4)])
    return out


def _build_layout(sequence: str, structure: str, mode: str, breaks: list[int] | None = None) -> dict:
    try:
        return layout_mod.build(sequence, structure, mode=mode, breaks=breaks).to_dict()
    except StructureError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _analyse_payload(
    *,
    sequence: str,
    structure: str,
    energy: float | None,
    engine_id: str,
    layout_mode: str,
    probs: list[list[float]] | None = None,
    decomposition: list[dict] | None = None,
    notes: list[str] | None = None,
    warnings: list[str] | None = None,
    infeasible: bool = False,
    breaks: list[int] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict:
    parsed = parse(structure, sequence)
    payload: dict[str, Any] = {
        "sequence": sequence,
        "structure": parsed.dotbracket,
        "energy": energy,
        "infeasible": infeasible,
        "engine": engine_id,
        "pairs": [[i, j] for i, j in parsed.pairs],
        "has_pseudoknot": parsed.has_pseudoknot,
        "crossing_pairs": [[list(a), list(b)] for a, b in parsed.crossing_pairs],
        "forbidden": parsed.forbidden,
        "length": len(sequence),
        "layout": _build_layout(sequence, parsed.dotbracket, layout_mode, breaks),
        "probabilities": probs or [],
        "decomposition": decomposition or [],
        "notes": notes or [],
        "warnings": warnings or [],
    }
    if extra:
        payload.update(extra)
    return payload


# ---------------------------------------------------------------- status / web
@app.get("/api/status")
def api_status():
    return {
        "engines": [s.__dict__ for s in engines.statuses()],
        "default_engine": engines.DEFAULT_ENGINE,
        "varna": varna.status(),
        "layouts": layout_mod.SUPPORTED,
        "varna_algorithms": varna.ALGORITHMS,
    }


@app.get("/", response_class=HTMLResponse)
def index():
    f = WEB_DIR / "index.html"
    if not f.exists():
        raise HTTPException(status_code=500, detail="缺少 web/index.html")
    return HTMLResponse(f.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------- predict
@app.post("/api/predict")
def api_predict(req: PredictReq):
    eng = _engine_or_400(req.engine)
    st = eng.status()
    if not st.available:
        raise HTTPException(status_code=400, detail=f"{st.name} 不可用：{st.detail}")

    kwargs: dict[str, Any] = {}
    if req.constraints:
        kwargs["constraints"] = req.constraints
    if req.probing:
        kwargs["probing"] = req.probing.model_dump()
    if req.temperature is not None:
        kwargs["temperature"] = req.temperature
    # RNAstructure 的方法选择
    if eng.id == "rnastructure":
        kwargs["method"] = req.method if req.method in {"mfe", "maxexpect", "probknot"} else "mfe"

    try:
        res = eng.predict(req.sequence, **kwargs)
    except StructureError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    probs = None
    prob_error = None
    if req.with_probabilities:
        try:
            probs = _sparse_probs(eng.probabilities(req.sequence, temperature=req.temperature))
        except Exception as e:  # 概率算不出来不该阻断主流程
            prob_error = str(e)

    warnings = list(res.warnings)
    if prob_error:
        warnings.append(f"配对概率计算失败：{prob_error}")

    # 让仪表盘在「刚折叠完」就有 MFE 对标可比。用 mfe 方法时它本身就是 MFE；
    # 用 MaxExpect / ProbKnot 时另外跑一次 MFE 作为参照。
    extra: dict[str, Any] = {}
    is_mfe = (eng.id == "vienna") or (req.method == "mfe")
    if is_mfe:
        extra["mfe_structure"] = res.dotbracket
        extra["mfe_energy"] = res.energy
        extra["delta_from_mfe"] = 0.0
    else:
        try:
            ref = eng.predict(req.sequence, **{**kwargs, "method": "mfe"})
            extra["mfe_structure"] = ref.dotbracket
            extra["mfe_energy"] = ref.energy
            if res.energy is not None and ref.energy is not None:
                extra["delta_from_mfe"] = round(res.energy - ref.energy, 2)
        except Exception as e:
            warnings.append(f"MFE 参照计算失败：{e}")

    return _analyse_payload(
        sequence=res.sequence or req.sequence,
        structure=res.dotbracket,
        energy=res.energy,
        engine_id=eng.id,
        layout_mode=req.layout,
        probs=probs,
        decomposition=res.decomposition,
        notes=res.notes,
        warnings=warnings,
        infeasible=res.infeasible,
        extra=extra,
    )


@app.post("/api/evaluate")
def api_evaluate(req: EvaluateReq):
    """评估一个（通常是手动编辑过的）结构的 ΔG，并重新排布坐标。"""
    eng = _engine_or_400(req.engine)

    try:
        res = eng.evaluate(
            req.sequence, req.structure,
            temperature=req.temperature,
            with_probabilities=False,
            with_decomposition=True,
        )
    except StructureError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    extra: dict[str, Any] = {}
    notes = list(res.notes)
    warnings = list(res.warnings)

    # 与 MFE 对比：让使用者一眼看出自己搭的结构比最优结构差多少
    if req.compare_mfe:
        try:
            mfe = eng.predict(req.sequence, temperature=req.temperature, with_probabilities=False)
            extra["mfe_structure"] = mfe.dotbracket
            extra["mfe_energy"] = mfe.energy
            if res.energy is not None and mfe.energy is not None:
                extra["delta_from_mfe"] = round(res.energy - mfe.energy, 2)
            try:
                extra["pair_difference_from_mfe"] = structural_distance(
                    res.dotbracket, mfe.dotbracket
                )
            except StructureError:
                pass
        except Exception as e:
            warnings.append(f"MFE 对比计算失败：{e}")

    probs = None
    if req.with_probabilities:
        try:
            probs = _sparse_probs(eng.probabilities(req.sequence, temperature=req.temperature))
        except Exception as e:
            warnings.append(f"配对概率计算失败：{e}")

    return _analyse_payload(
        sequence=res.sequence or req.sequence,
        structure=res.dotbracket,
        energy=res.energy,
        engine_id=eng.id,
        layout_mode=req.layout,
        probs=probs,
        decomposition=res.decomposition,
        notes=notes,
        warnings=warnings,
        infeasible=res.infeasible,
        extra=extra,
    )


@app.post("/api/cofold")
def api_cofold(req: CofoldReq):
    eng = _engine_or_400(req.engine)
    st = eng.status()
    if not st.available:
        raise HTTPException(status_code=400, detail=f"{st.name} 不可用：{st.detail}")
    try:
        res = eng.cofold(
            req.sequence_a, req.sequence_b,
            temperature=req.temperature,
        )
    except (StructureError, NotImplementedError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    la = len(req.sequence_a.upper().replace("T", "U"))
    payload = _analyse_payload(
        sequence=res.sequence,
        structure=res.dotbracket,
        energy=res.energy,
        engine_id=eng.id,
        layout_mode=req.layout,
        notes=res.notes,
        warnings=res.warnings,
        infeasible=res.infeasible,
        breaks=[la - 1],           # 骨架在两条链之间断开
        extra={
            "strand_a_length": la,
            "strand_b_length": len(req.sequence_b.upper().replace("T", "U")),
            "interstrand_pairs": [[i, j] for i, j in res.pairs if i < la <= j],
        },
    )
    return payload


# ----------------------------------------------------------------------- layout
@app.post("/api/layout")
def api_layout(req: LayoutReq):
    return _build_layout(req.sequence, req.structure, req.layout)


@app.post("/api/probabilities")
def api_probabilities(req: ProbReq):
    eng = _engine_or_400(req.engine)
    try:
        m = eng.probabilities(req.sequence, temperature=req.temperature)
    except (StructureError, NotImplementedError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {
        "sequence": req.sequence.upper().replace("T", "U"),
        "engine": eng.id,
        "probabilities": _sparse_probs(m),
        "length": len(req.sequence.strip()),
    }


# ----------------------------------------------------------------------- export
@app.post("/api/render/varna")
def api_render_varna(req: RenderReq, fmt: str = Query("svg")):
    """用 VARNA 出图。fmt=svg 直接返回 SVG 文本，其余返回二进制下载。"""
    if not varna.status()["available"]:
        raise HTTPException(status_code=400, detail="；".join(varna.status()["problems"]))
    try:
        if fmt == "svg":
            svg = varna.render_svg(
                req.sequence, req.structure,
                algorithm=req.algorithm, title=req.title,
                period_num=req.period_num, bp_style=req.bp_style,
                color_map=req.color_values, color_map_style=req.color_style,
                color_map_min=req.color_min, color_map_max=req.color_max,
                rotation=req.rotation,
            )
            return Response(content=svg, media_type="image/svg+xml")
        data = varna.render_raster(
            req.sequence, req.structure, fmt=fmt, algorithm=req.algorithm,
            title=req.title, period_num=req.period_num, bp_style=req.bp_style,
            color_map=req.color_values, color_map_style=req.color_style,
            color_map_min=req.color_min, color_map_max=req.color_max,
        )
        media = {"png": "image/png", "jpeg": "image/jpeg", "eps": "application/postscript",
                 "xfig": "application/x-xfig"}.get(fmt, "application/octet-stream")
        return Response(content=data, media_type=media)
    except StructureError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/export")
def api_export(req: ExportReq):
    parsed = parse(req.structure, req.sequence)
    seq, fmt = parsed.sequence, (req.fmt or "ct").lower()

    if fmt == "ct":
        body = write_ct(seq, parsed.pairs, title="RNA Studio")
        name, media = "rna.ct", "text/plain; charset=utf-8"
    elif fmt in {"dotbracket", "db", "dbn"}:
        body = f">rna\n{seq}\n{parsed.dotbracket}\n"
        name, media = "rna.dbn", "text/plain; charset=utf-8"
    elif fmt == "fasta":
        body = f">rna\n{seq}\n"
        name, media = "rna.fa", "text/plain; charset=utf-8"
    else:
        raise HTTPException(status_code=400, detail=f"不支持的导出格式：{req.fmt}")

    return Response(
        content=body, media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


class ImportReq(BaseModel):
    text: str
    fmt: str = "ct"          # ct | dotbracket


@app.post("/api/import")
def api_import(req: ImportReq):
    """导入 CT 或 dot-bracket（例如从 VARNA/mfold 拿到的结构）继续编辑。"""
    try:
        if (req.fmt or "ct").lower() == "ct":
            seq, pairs = read_ct(req.text)
            struct = pairs_to_dotbracket(len(seq), pairs)
        else:
            lines = [l.strip() for l in req.text.splitlines() if l.strip() and not l.startswith(">")]
            if len(lines) < 2:
                raise StructureError("dot-bracket 需要单独一行结构串（可含 FASTA 头与序列行）")
            seq = lines[0].upper().replace("T", "U")
            struct = lines[1] if len(lines) > 1 else lines[0]
            if len(struct) != len(seq):
                raise StructureError("序列行与结构行长度不一致")
            parse(struct, seq)
    except StructureError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"sequence": seq, "structure": struct}


@app.exception_handler(StructureError)
def _structure_error_handler(_request, exc: StructureError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")
