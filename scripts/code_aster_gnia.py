"""Aeris Code_Aster GNIA (imperfect post-buckling / knockdown) — FEM entry point.

The classical-FEM counterpart to the IGA arc-length path (cylinder_arclength.py):
same model.json contract + gnia run.json shape, but the knockdown comes from a
Code_Aster STAT_NON_LINE with a held 'dimple' imperfection + displacement-
controlled axial compression (see aster_engine/comm.py::build_comm_gnia) instead
of a G+Smo arc-length continuation.

Pipeline:
  1. mesh the cylinder (FINE — h≲1, else the mesh is too stiff to buckle)
  2. build_comm_gnia → study.comm (dimple + axial ramp, STAT_NON_LINE GROT_GDEP)
  3. run_aster → gnia_curve.json (the reaction-vs-shortening path)
  4. peak reaction = imperfect buckling load; knockdown = peak / classical F_cr;
     write run.json (analysisKind='gnia') with the loadDeflection curve so the
     post-processor's GNIA chart + verdict render unchanged.
"""
from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aeris_model import ModelConfig                       # noqa: E402
from meshing.gmsh_shells import build_shell_mesh          # noqa: E402
from aster_engine.comm import build_comm_gnia, build_export  # noqa: E402
from code_aster_static import _phase, _run_aster          # noqa: E402


def _classical_sigma_cr(E, nu, R, t):
    return E * t / (R * math.sqrt(3.0 * (1.0 - nu * nu)))


def main(argv=None) -> int:
    import argparse
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", type=Path, required=True)
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--keep-files", action="store_true")
    args = p.parse_args(argv)

    _phase("setup")
    model = ModelConfig.from_json_file(args.model)
    raw = json.loads(args.model.read_text())   # imperfections dropped by ModelConfig
    shape = model.geometry.get("shape")
    if model.engine() != "code_aster":
        raise SystemExit("code_aster_gnia.py expects solver.engine='code_aster'")
    if shape != "cylinder":
        raise SystemExit(f"code_aster_gnia.py wires geometry.shape='cylinder'; got {shape!r}")
    if model.analysis.get("kind") != "gnia":
        raise SystemExit("code_aster_gnia.py wires analysis.kind='gnia'")

    work_dir = args.model.parent
    cyl = model.geometry["cylinder"]
    R, L, t = float(cyl["R"]), float(cyl["L"]), float(cyl["t"])
    mat = model.materials[0]
    E, nu = float(mat["E"]), float(mat["nu"])
    area = 2.0 * math.pi * R * t
    sigma_cl = _classical_sigma_cr(E, nu, R, t)
    F_cl = sigma_cl * area

    # Imperfection amplitude (dimple): model.imperfections.amplitude, default = t
    # (w/t = 1). kind 'eigenmode' is a planned follow-up; today the dimple is used.
    imp = raw.get("imperfections", {}) or {}
    imp_kind = imp.get("kind", "dimple")
    w = float(imp.get("amplitude") or 0.0)
    if w <= 0.0:
        w = t  # a meaningful default so GNIA always carries an imperfection

    print("=" * 70)
    print("Aeris Code_Aster · GNIA (dimple imperfection + knockdown) · cylinder")
    print("=" * 70)
    disc = model.disc("code_aster")
    print(f"Geometry : R={R}, L={L}, t={t}  (R/t={R / t:.0f})")
    print(f"Imperf   : dimple w={w:.4g}  (w/t={w / t:.3g})")
    print(f"Mesh     : {disc.get('element_family')} · h={disc.get('mesh_size')} · "
          f"threads={args.threads}")
    if float(disc.get("mesh_size", 1.0)) > 2.0:
        print("  WARNING: coarse mesh (h>2) is often too stiff to buckle — "
              "use h≲1 for a meaningful knockdown.", file=sys.stderr)

    _phase("meshing")
    mesh_path = work_dir / "mesh.med"
    manifest = build_shell_mesh(model, mesh_path)
    print(f"Mesh     : {manifest['n_nodes']} nodes, {manifest['n_elements']} "
          f"{manifest['element_family']} elements")

    _phase("comm")
    (work_dir / "study.comm").write_text(
        build_comm_gnia(model, manifest, work_dir=str(work_dir), w=w)
    )
    export_path = work_dir / "study.export"
    export_path.write_text(build_export(str(work_dir), time_limit_s=3600, memory_mb=16384))

    _phase("solving")
    _run_aster(export_path, work_dir, threads=args.threads, timeout_s=3700)

    _phase("parsing")
    curve = json.loads((work_dir / "gnia_curve.json").read_text())
    inst, reac, dmax = curve["inst"], curve["reacDZ"], float(curve["dmax"])
    # Axial phase = pseudo-time in [1,2]; shortening u = dmax*(inst-1).
    rows, step = [], 0
    for i, ti in enumerate(inst):
        if ti < 1.0 - 1e-9:
            continue
        F = abs(reac[i])
        rows.append({
            "step": step,
            "loadFactor": F / F_cl if F_cl else None,
            "F": F,
            "u_qoi": dmax * (ti - 1.0),
            "u_qoi_abs": dmax * (ti - 1.0),
            "Dmin": None,
            "bif": False,
            "solver": "dimple-NL",
        })
        step += 1
    if not rows:
        raise RuntimeError("GNIA: no axial-phase steps in the reaction curve")

    peak = max(rows, key=lambda r: r["F"])
    peak["bif"] = True                       # flag the limit point
    F_cr_computed = peak["F"]
    knockdown = F_cr_computed / F_cl if F_cl else None
    snapped = len(inst) and inst[-1] < 2.0 - 1e-6   # ramp stopped early = snapped

    _phase("verdict")
    print()
    print("=" * 70)
    print("Verdict")
    print("=" * 70)
    print(f"Converged axial steps : {len(rows)}  ({'snapped at limit' if snapped else 'full ramp'})")
    print(f"Peak (limit) load     : F_cr = {F_cr_computed:.6g} N  at u = {peak['u_qoi']:.5g}")
    print(f"Classical F_cr        : {F_cl:.6g} N")
    print(f"Knockdown factor      : {knockdown:.4f}  (imperfect / classical)")
    if not snapped:
        print("  NOTE: ramp completed without a clear snap — the peak may be a "
              "range max, not a true limit point. Increase dmax or refine the mesh.",
              file=sys.stderr)

    run_json = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "command": " ".join(sys.argv),
        "engine": "code_aster",
        "analysisKind": "gnia",
        "case": {"R": R, "L": L, "t": t, "E": E, "nu": nu},
        "geometry": {"shape": "cylinder", "n_patches": None},
        "mesh": {
            "engine": "code_aster",
            "element_family": manifest.get("element_family"),
            "mesh_size": manifest.get("mesh_size"),
            "n_nodes": manifest.get("n_nodes"),
            "n_elements": manifest.get("n_elements"),
        },
        "load": {"kind": "axial", "magnitude": F_cl},
        "analysis": {"kind": "gnia", "threads": int(args.threads), "dmax": dmax},
        "imperfections": {
            "kind": "dimple" if imp_kind in (None, "none") else imp_kind,
            "mode": int(imp.get("mode", 1)),
            "amplitude": w,
            "lbaEigenvalue": None,
            "lbaMode": None,
        },
        "files": {"mess": "study.mess"},
        "loadDeflection": rows,
        "modes": [],
        "qois": [{
            "name": "knockdown",
            "label": "Knockdown factor (λ_cr)",
            "qoiValue": knockdown,
            "qoiAbsValue": knockdown,
        }],
        "verdict": {
            "lambdaCritical": knockdown,
            "knockdownFactor": knockdown,
            "criticalLoadComputed": F_cr_computed,
            "criticalLoadClassical": F_cl,
            "bifurcationStep": peak["step"] if snapped else None,
            "solverOk": True,
        },
    }
    (work_dir / "run.json").write_text(json.dumps(run_json, indent=2))
    print(f"\nSidecar manifest written: {work_dir}/run.json")

    if not args.keep_files:
        for f in ("study.comm", "study.export", "gnia_curve.json"):
            try:
                (work_dir / f).unlink()
            except OSError:
                pass

    _phase("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
