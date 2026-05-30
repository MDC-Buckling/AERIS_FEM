"""Aeris Code_Aster linear-buckling (LBA) solver — FEM-engine entry point.

The classical-FEM counterpart to the IGA path's cylinder_lba.py: same
model.json contract, but the critical load comes from a Code_Aster
MODE_FLAMB eigen-buckling chain (pre-buckling MECA_STATIQUE → RIGI_GEOM →
CALC_MODES) instead of a G+Smo Spectra eigenproblem. The dev-server routes
here when solver.engine='code_aster' + shape='cylinder' + analysis.kind='lba'.

Cross-check target: the classical Lorenz/Timoshenko axial critical stress
    σ_cl = E·t / (R·√(3(1-ν²)))
which the IGA path already matches to ~0.16%. A converged FE σ_cr that lands
near σ_cl is an independent confirmation of the buckling pipeline.

Pipeline:
  1. mesh the cylinder (scripts/meshing/gmsh_shells.py) → mesh.med
  2. build_comm_buckling → study.comm (+ study.export)
  3. run_aster → charcrit.json (the critical load factors λ)
  4. σ_cr = λ₁·F_ref / (2πRt); write run.json (analysisKind='lba')
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
from aster_engine.comm import build_comm_buckling, build_export  # noqa: E402
# Reuse the launcher + phase marker from the static wrapper (importing the
# module does not run its main — that's __main__-guarded).
from code_aster_static import _phase, _run_aster          # noqa: E402


def _classical_sigma_cr(E: float, nu: float, R: float, t: float) -> float:
    """Lorenz/Timoshenko classical axial buckling stress of a cylinder."""
    return E * t / (R * math.sqrt(3.0 * (1.0 - nu * nu)))


def main(argv: list[str] | None = None) -> int:
    import argparse
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", type=Path, required=True)
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--nmodes", type=int, default=5)
    p.add_argument("--keep-files", action="store_true")
    args = p.parse_args(argv)

    _phase("setup")
    model = ModelConfig.from_json_file(args.model)
    shape = model.geometry.get("shape")
    kind = model.analysis.get("kind")
    if model.engine() != "code_aster":
        raise SystemExit(
            f"code_aster_buckling.py expects solver.engine='code_aster'; "
            f"got {model.engine()!r}"
        )
    if shape != "cylinder":
        raise SystemExit(
            f"code_aster_buckling.py wires geometry.shape='cylinder' (Step 7); "
            f"got {shape!r}."
        )
    if kind != "lba":
        raise SystemExit(
            f"code_aster_buckling.py wires analysis.kind='lba'; got {kind!r}."
        )

    work_dir = args.model.parent
    cyl = model.geometry["cylinder"]
    R, L, t = float(cyl["R"]), float(cyl["L"]), float(cyl["t"])
    mat = model.materials[0]
    E, nu = float(mat["E"]), float(mat["nu"])
    nmodes = int(model.analysis.get("nmodes", args.nmodes))
    # Scale the reference axial load to the classical F_cr estimate so the
    # critical load factor λ₁ ≈ 1 (well inside OPTION='PLUS_PETITE's reach).
    area = 2.0 * math.pi * R * t
    sigma_cl = _classical_sigma_cr(E, nu, R, t)
    F_ref = sigma_cl * area

    print("=" * 70)
    print("Aeris Code_Aster · LBA (linear buckling) · cylinder + axial")
    print("=" * 70)
    print(f"Geometry : R={R}, L={L}, t={t}  (R/t={R / t:.0f})")
    print(f"Material : E={E}, nu={nu}")
    disc = model.disc("code_aster")
    print(f"Mesh     : {disc.get('element_family')} · h={disc.get('mesh_size')} · "
          f"OMP threads={args.threads}")
    print()

    _phase("meshing")
    mesh_path = work_dir / "mesh.med"
    manifest = build_shell_mesh(model, mesh_path)
    print(f"Mesh     : {manifest['n_nodes']} nodes, {manifest['n_elements']} "
          f"{manifest['element_family']} elements → {mesh_path.name}")

    _phase("comm")
    (work_dir / "study.comm").write_text(
        build_comm_buckling(model, manifest, work_dir=str(work_dir),
                            nmodes=nmodes, f_ref=F_ref)
    )
    export_path = work_dir / "study.export"
    export_path.write_text(build_export(str(work_dir)))

    _phase("solving")
    _run_aster(export_path, work_dir, threads=args.threads)

    _phase("parsing")
    lambdas = json.loads((work_dir / "charcrit.json").read_text())
    # Smallest positive critical load factor = first buckling mode.
    positive = sorted(x for x in lambdas if x > 0)
    if not positive:
        raise RuntimeError(f"no positive critical load factor in {lambdas}")
    lam1 = positive[0]
    F_cr = lam1 * F_ref
    sigma_cr = F_cr / area
    ratio = sigma_cr / sigma_cl

    _phase("verdict")
    print()
    print("=" * 70)
    print("Verdict")
    print("=" * 70)
    print(f"Critical load factors λ : {[round(x, 6) for x in positive[:nmodes]]}")
    print(f"λ₁ (first mode)         : {lam1:.6g}")
    print(f"F_cr = λ₁·F_ref         : {F_cr:.6g}   (F_ref={F_ref})")
    print(f"σ_cr = F_cr/(2πRt)      : {sigma_cr:.6g}")
    print(f"σ_classical (Lorenz)    : {sigma_cl:.6g}")
    print(f"σ_cr / σ_classical      : {ratio:.4f}")

    run_json = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "command": " ".join(sys.argv),
        "engine": "code_aster",
        "analysisKind": "lba",
        "case": {"R": R, "L": L, "t": t, "E": E, "nu": nu},
        "geometry": {"shape": "cylinder", "n_patches": None},
        "mesh": {
            "engine": "code_aster",
            "element_family": manifest.get("element_family"),
            "mesh_size": manifest.get("mesh_size"),
            "n_nodes": manifest.get("n_nodes"),
            "n_elements": manifest.get("n_elements"),
        },
        "load": {"kind": "axial", "magnitude": F_ref},
        "analysis": {"kind": "lba", "nmodes": nmodes, "threads": int(args.threads)},
        "eigenvalues": positive[:nmodes],
        "criticalLoad": F_cr,
        "criticalStress": sigma_cr,
        "classicalStress": sigma_cl,
        "stressRatio": ratio,
        "files": {"mess": "study.mess"},
        "modes": [],
        "verdict": {
            "lambda1": lam1,
            "criticalStress": sigma_cr,
            "classicalStress": sigma_cl,
            "stressRatio": ratio,
            "solverOk": True,
        },
    }
    (work_dir / "run.json").write_text(json.dumps(run_json, indent=2))
    print(f"\nSidecar manifest written: {work_dir}/run.json")

    if not args.keep_files:
        for f in ("study.comm", "study.export", "charcrit.json"):
            try:
                (work_dir / f).unlink()
            except OSError:
                pass

    _phase("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
