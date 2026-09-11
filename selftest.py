"""后端接口自检：跑通所有 REST 端点并验证关键行为。

用法（在 rna-studio 目录下）：
    python3 selftest.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402

from server.app import app  # noqa: E402

SEQ = "GCGGAUUUAGCUCAGUUGGGAGAGCGCCAGACUGAAGAUCUGGAGGUCCUGUGUUCGAUCCACAGAAUUCGCACCA"
WHITE_BG = 'fill="#ffffff"'
OK = "✓"
BAD = "✗"
failures: list[str] = []


def _force_utf8_streams() -> None:
    """Windows 上 stdout/stderr 默认用系统代码页（cp1252/cp936），
    打印中文会抛 UnicodeEncodeError；打包成窗口程序时它们甚至可能是 None。
    统一改成 UTF-8 + 出错不抛异常，保证任何一条日志都不会把程序打挂。"""
    import sys as _s

    for name in ("stdout", "stderr"):
        stream = getattr(_s, name, None)
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"   {OK if cond else BAD} {label}{('  ' + extra) if extra else ''}")
    if not cond:
        failures.append(label)


def main() -> int:
    _force_utf8_streams()
    c = TestClient(app)

    print("=== /api/status ===")
    d = c.get("/api/status").json()
    for e in d["engines"]:
        print(f"   {e['id']:14s} available={e['available']} version={e['version']}")
    check("至少一个预测引擎可用", any(e["available"] for e in d["engines"]))
    v = d["varna"]
    print(f"   VARNA: available={v['available']} java={v['java']} ({v['java_version']}) jar={v['jar_exists']}")

    print("\n=== /api/predict (ViennaRNA, naview) ===")
    r = c.post("/api/predict", json={"sequence": SEQ, "engine": "vienna", "layout": "naview"})
    d = r.json()
    check("HTTP 200", r.status_code == 200, f"ΔG={d['energy']:.2f}")
    check("返回坐标点数 == 序列长度", len(d["layout"]["points"]) == len(SEQ))
    check("naview 布局生效", d["layout"]["layout"] == "naview")
    check("返回配对概率", len(d["probabilities"]) > 0, f"{len(d['probabilities'])} 条")
    base = d["structure"]
    print(f"   结构: {base}")

    print("\n=== /api/predict (RNAstructure ProbKnot，允许假结) ===")
    r = c.post("/api/predict", json={"sequence": SEQ, "engine": "rnastructure",
                                     "method": "probknot", "layout": "naview"})
    if r.status_code != 200:
        print(f"   (跳过：{r.json().get('detail')})")
    else:
        d = r.json()
        check("HTTP 200", True, f"ΔG={d['energy']}")
        check("识别出假结", d["has_pseudoknot"] is True)
        check("假结结构自动降级为环形布局",
              d["layout"]["layout"] == "circular" and bool(d["layout"]["fallback_reason"]))
        print(f"   结构: {d['structure'][:60]}...")

    print("\n=== /api/predict 带约束 ===")
    con = list("." * len(SEQ))
    con[4], con[15] = "(", ")"
    r = c.post("/api/predict", json={"sequence": SEQ, "engine": "vienna",
                                     "constraints": "".join(con), "with_probabilities": False})
    d = r.json()
    check("HTTP 200", r.status_code == 200)
    check("强制配对 5-16 生效", [4, 15] in d["pairs"], f"ΔG={d['energy']:.2f}")

    print("\n=== /api/predict 带 SHAPE 数据 ===")
    vals = [0.0] * len(SEQ)
    for i in (3, 4, 5, 15, 16, 17):
        vals[i] = 2.5
    r = c.post("/api/predict", json={"sequence": SEQ, "engine": "vienna", "with_probabilities": False,
                                     "probing": {"method": "SHAPE", "values": vals}})
    d = r.json()
    check("HTTP 200", r.status_code == 200)
    check("SHAPE 软约束改变了结果", d["structure"] != base, f"ΔG={d['energy']:.2f}")

    print("\n=== /api/evaluate（手动编辑后重算 ΔG）===")
    r = c.post("/api/evaluate", json={"sequence": SEQ, "structure": base, "engine": "vienna"})
    d = r.json()
    check("HTTP 200", r.status_code == 200, f"ΔG={d['energy']:.2f}")
    check("返回与 MFE 的差值", "delta_from_mfe" in d, f"ΔΔG={d.get('delta_from_mfe')}")
    check("返回逐环能量分解", len(d["decomposition"]) > 0, f"{len(d['decomposition'])} 条")
    if d["decomposition"] and d["energy"] is not None:
        s = round(sum(x["energy"] for x in d["decomposition"]), 2)
        check("分解求和 == 总 ΔG", abs(s - round(d["energy"], 2)) < 0.05, f"{s} vs {round(d['energy'],2)}")

    # 手动加一个错误的配对，ΔG 应该变差
    edited = list(base)
    edited[7] = "("
    edited[15] = ")"
    r2 = c.post("/api/evaluate", json={"sequence": SEQ, "structure": "".join(edited), "engine": "vienna"})
    d2 = r2.json()
    check("编辑后结构被接受", r2.status_code == 200,
          f"编辑后 ΔG={d2.get('energy')} vs 原 {d.get('energy'):.2f}")

    print("\n=== 非法结构必须被拦截（否则 ViennaRNA 会 segfault）===")
    for bad in ["((((", "(((...))).", "AAA", "((((((((((((((((((((", "((((((((((((((((((((("]:
        r = c.post("/api/evaluate", json={"sequence": SEQ, "structure": bad})
        check(f"拒绝 {bad[:16]!r}", r.status_code == 400, str(r.json().get("detail", ""))[:46])

    print("\n=== /api/cofold ===")
    for eng in ("vienna", "rnastructure"):
        r = c.post("/api/cofold", json={"sequence_a": "GGGAAACCC", "sequence_b": "GGGAAACCC",
                                        "engine": eng})
        if r.status_code != 200:
            print(f"   ({eng} 跳过：{r.json().get('detail')})")
            continue
        d = r.json()
        check(f"{eng} 共折叠成功", True,
              f"ΔG={d['energy']:.2f} 链间配对={len(d['interstrand_pairs'])} 链断点={d['layout']['breaks']}")
        check(f"{eng} 链间配对存在", len(d["interstrand_pairs"]) > 0)
    print("   两引擎的共折叠 ΔG 应接近（交叉验证）")

    print("\n=== /api/render/varna ===")
    r = c.post("/api/render/varna?fmt=svg", json={"sequence": SEQ, "structure": base,
                                                  "algorithm": "naview"})
    if r.status_code == 200:
        svg = r.text
        check("返回 SVG", "svg" in r.headers.get("content-type", ""), f"{len(r.content)} bytes")
        check("注入了 viewBox（VARNA 原图没有）", "viewBox=" in svg)
        check("补了白色背景", WHITE_BG in svg)
    else:
        print(f"   (跳过：{r.json().get('detail')})")

    if r.status_code == 200:
        r2 = c.post("/api/render/varna?fmt=png", json={"sequence": SEQ, "structure": base,
                                                       "algorithm": "radiate"})
        check("PNG 输出", r2.status_code == 200 and r2.content[:4] == b"\x89PNG",
              f"{len(r2.content)} bytes")

    print("\n=== /api/export + /api/import ===")
    for f in ("ct", "dotbracket", "fasta"):
        r = c.post("/api/export", json={"sequence": SEQ, "structure": base, "fmt": f})
        check(f"导出 {f}", r.status_code == 200, f"{len(r.text)} bytes")
    ctr = c.post("/api/export", json={"sequence": SEQ, "structure": base, "fmt": "ct"})
    imp = c.post("/api/import", json={"text": ctr.text, "fmt": "ct"}).json()
    check("CT 往返结构无损", imp["structure"] == base)
    check("CT 往返序列无损", imp["sequence"] == SEQ)

    print("\n=== RNAstructure 方法差异 ===")
    st = c.get("/api/status").json()
    rs_ok = next((e for e in st["engines"] if e["id"] == "rnastructure"), {}).get("available")
    if not rs_ok:
        print("   (跳过：RNAstructure 未安装)")
    else:
        # ProbKnot / MaxExpect 不认 -t，直接把 -t 传过去会静默返回全不配对的结果，
        # 所以引擎内部改成经 partition 中转。这里验证带温度时结果仍然正常。
        for meth in ("mfe", "maxexpect", "probknot"):
            r = c.post("/api/predict", json={
                "sequence": SEQ, "engine": "rnastructure", "method": meth,
                "temperature": 37, "with_probabilities": False, "layout": "naview",
            })
            if r.status_code != 200:
                check(f"{meth} 带温度运行", False, r.json().get("detail", ""))
                continue
            d = r.json()
            npairs = len(d["pairs"])
            check(f"{meth} 带温度有配对结果", npairs > 0, f"{npairs} 对, ΔG={d['energy']}")
        d = c.post("/api/predict", json={
            "sequence": SEQ, "engine": "rnastructure", "method": "probknot",
            "with_probabilities": False,
        }).json()
        check("ProbKnot 检出假结", d["has_pseudoknot"] is True)
        check("假结自动回退到环形布局",
              d["layout"]["layout"] == "circular" and bool(d["layout"]["fallback_reason"]))

        # PropKnot/MaxExpect 不支持硬约束，必须明确报错而不是静默忽略
        con = list("." * len(SEQ))
        con[4], con[15] = "(", ")"
        r = c.post("/api/predict", json={
            "sequence": SEQ, "engine": "rnastructure", "method": "probknot",
            "constraints": "".join(con), "with_probabilities": False,
        })
        check("ProbKnot + 硬约束被明确拒绝", r.status_code == 400,
              str(r.json().get("detail", ""))[:44])

    print("\n=== 布局渲染尺度 ===")
    for mode in ("naview", "circular", "linear"):
        r = c.post("/api/predict", json={"sequence": SEQ, "engine": "vienna",
                                         "layout": mode, "with_probabilities": False})
        d = r.json()
        pts = d["layout"]["points"]
        check(f"{mode} 返回坐标", r.status_code == 200 and len(pts) == len(SEQ),
              f"span={d['layout']['bounds']['span']}")

    print("\n" + "=" * 60)
    if failures:
        print(f"{BAD} {len(failures)} 项失败：")
        for f in failures:
            print(f"    - {f}")
        return 1
    print(f"{OK} 全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
