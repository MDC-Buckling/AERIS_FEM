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
# Reuse the launcher + phase marker + MED→.vtu machinery from the static
# wrapper (importing the module does not run its main — that's __main__-guarded).
from code_aster_static import (                            # noqa: E402
    _phase, _run_aster, _write_result_files, _patch_meshio_med,
)


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
    # Load pattern: axial (uniform) or bending (cos θ). For both, F_ref is
    # scaled so the PEAK compressive membrane stress = σ_classical, so the
    # reported σ_cr = λ₁·σ_cl is the critical (peak) compressive stress and the
    # CENTRE eigensolver shift is valid for either pattern.
    load_kind = (model.load or {}).get("kind", "axial")
    if load_kind not in ("axial", "bending"):
        load_kind = "axial"  # LBA reference supports axial/bending; others → axial
    # Expert mode with load.sets → the buckling reference IS that arbitrary load
    # pattern (no classical σ_cl to compare to); the .comm uses PLUS_PETITE and
    # the eigenvalue λ₁ is the critical MULTIPLIER of the user's applied load.
    expert_load = (getattr(model, "uiMode", "beginner") == "expert"
                   and bool((model.load or {}).get("sets")))
    if expert_load:
        load_kind = "expert"

    print("=" * 70)
    print(f"Aeris Code_Aster · LBA (linear buckling) · cylinder + {load_kind}")
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
    # Buckling (eigensolve + RIGI_GEOM) needs far more JEVEUX than the static
    # paths — the 2048 MB default OOMs on a real cylinder mesh ("MEMOIRE JEVEUX
    # MINIMALE REQUISE > limit" → abort, no fort.80). This is a cap, not a
    # reservation: Code_Aster allocates only what it needs (~2.5 GB at h=2.5);
    # 16 GB gives headroom for finer meshes / more modes on a 64 GB host.
    export_path.write_text(
        build_export(str(work_dir), time_limit_s=3600, memory_mb=16384,
                     n_mode_files=nmodes)
    )

    _phase("solving")
    # Fine buckling meshes have an expensive factorization; give the subprocess
    # a generous wall-clock (PLUS_PETITE keeps the eigensolve itself cheap).
    _run_aster(export_path, work_dir, threads=args.threads, timeout_s=3700)

    _phase("parsing")
    lambdas = json.loads((work_dir / "charcrit.json").read_text())
    # Smallest positive critical load factor = first buckling mode.
    positive = sorted(x for x in lambdas if x > 0)
    if not positive:
        raise RuntimeError(f"no positive critical load factor in {lambdas}")
    lam1 = positive[0]
    if expert_load:
        # Arbitrary load pattern → λ₁ is the critical MULTIPLIER of the user's
        # applied load; there's no single σ_cr / classical to compare against.
        F_cr = sigma_cr = ratio = None
    else:
        F_cr = lam1 * F_ref
        sigma_cr = F_cr / area
        ratio = sigma_cr / sigma_cl

    # Convert each per-mode MED (written by the .comm's IMPR_RESU loop) into a
    # viewport-renderable .vtu (+.pvd) and assemble the modes[] list the
    # post-processor's results tree + viewport drive off. Without this the LBA
    # produces only numbers and the post-processor has nothing to select.
    # mode_k.med holds the k-th computed ordre's DEPL, so it pairs with the
    # k-th raw critical factor (lambdas[k-1], NOT positive[k-1]).
    _phase("modes")
    import meshio                                          # noqa: E402
    _patch_meshio_med()
    modes: list[dict] = []
    for k in range(1, nmodes + 1):
        med_k = work_dir / f"mode_{k}.med"
        if not med_k.exists():
            break
        try:
            mesh_k = meshio.read(str(med_k))
            pvd = _write_result_files(mesh_k, work_dir, stem=f"mode{k}")
        except Exception as exc:                           # best-effort per mode
            print(f"  mode {k}: shape export failed ({exc}); skipping",
                  file=sys.stderr)
            continue
        if not pvd:
            continue
        lam_k = lambdas[k - 1] if k - 1 < len(lambdas) else None
        modes.append({
            "id": f"mode{k}",
            "pvd": pvd,
            "label": f"Buckling mode {k}",
            "lambda": lam_k,
            # Expert load: λ_k is a load factor (no σ comparison). Beginner:
            # σ_cr,k = λ_k·σ_cl (peak compressive stress).
            "sigmaComputed": None if expert_load
                             else ((lam_k * sigma_cl) if lam_k is not None else None),
        })
    print(f"  wrote {len(modes)} mode shape(s) → mode*.vtu")

    _phase("verdict")
    print()
    print("=" * 70)
    print("Verdict")
    print("=" * 70)
    print(f"Critical load factors λ : {[round(x, 6) for x in positive[:nmodes]]}")
    print(f"λ₁ (first mode)         : {lam1:.6g}")
    if expert_load:
        print("Load pattern            : EXPERT (per-region load.sets)")
        print(f"Critical load factor    : {lam1:.6g}  "
              f"→ buckles at λ₁ × your applied load (no classical σ_cr to compare).")
    else:
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
        "load": {"kind": load_kind,
                 "magnitude": (None if expert_load else F_ref),
                 "note": ("λ₁ = critical multiplier of your applied expert load"
                          if expert_load
                          else "σ_cr is the peak compressive membrane stress (bending)"
                          if load_kind == "bending" else "uniform axial")},
        "analysis": {"kind": "lba", "nmodes": nmodes, "threads": int(args.threads)},
        "eigenvalues": positive[:nmodes],
        "criticalLoad": F_cr,
        "criticalStress": sigma_cr,
        "classicalStress": (None if expert_load else sigma_cl),
        "stressRatio": ratio,
        "criticalLoadFactor": lam1,
        "files": {"mess": "study.mess"},
        "modes": modes,
        "verdict": {
            "lambda1": lam1,
            "criticalLoadFactor": lam1,
            "expertLoad": bool(expert_load),
            "criticalStress": sigma_cr,
            "classicalStress": (None if expert_load else sigma_cl),
            "stressRatio": ratio,
            "solverOk": True,
        },
    }
    (work_dir / "run.json").write_text(json.dumps(run_json, indent=2))
    print(f"\nSidecar manifest written: {work_dir}/run.json")

    if not args.keep_files:
        stale = ["study.comm", "study.export", "charcrit.json"]
        # Per-mode MEDs are intermediates — the .vtu/.pvd are what the viewport
        # loads, so drop the (large) MEDs once converted.
        stale += [f"mode_{k}.med" for k in range(1, nmodes + 1)]
        for f in stale:
            try:
                (work_dir / f).unlink()
            except OSError:
                pass

    _phase("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
