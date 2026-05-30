"""Aeris Code_Aster static-linear shell solver — FEM-engine entry point.

The classical-FEM sibling of scordelis_static.py: same model.json contract,
same run.json sidecar shape, but driven by `solver.engine = "code_aster"`
instead of the G+Smo IGA path. The dev-server (/run-solver) dispatches here
when engine=code_aster + shape=cylinder_segment + kind=static.

Pipeline (one engine, one image):
  1. read /work/model.json
  2. mesh it with scripts/meshing/gmsh_shells.py → /work/mesh.med (named groups)
  3. render study.comm (MECA_STATIQUE on COQUE_3D) + study.export
  4. run_aster /work/study.export   (falls back to as_run)
  5. read /work/result.med, take u_z at the node nearest the free-edge
     midpoint (the same QoI the IGA path reports → direct cross-validation)
  6. write /work/run.json (analysisKind="static", engine="code_aster")

This is the first validated Code_Aster path; the verdict is meant to be
compared against scordelis_static.py on the identical physical model (the
degenerate IGA-vs-FEM sanity check) before trusting any new .comm template.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# scripts/ on the path so aeris_model / meshing / aster import whatever the cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aeris_model import ModelConfig                       # noqa: E402
from meshing.gmsh_shells import build_shell_mesh          # noqa: E402
from aster_engine.comm import build_comm, build_export    # noqa: E402


# run_aster is the conda-forge launcher; as_run is the legacy name. Probed
# in order at run time so the wrapper survives either packaging.
LAUNCHERS = ("run_aster", "as_run")


def _phase(name: str) -> None:
    """GUI live-monitor phase marker — same protocol as the IGA scripts."""
    print(f"[AERIS-PHASE] {name}", flush=True)


def _run_aster(export_path: Path, work_dir: Path, threads: int) -> None:
    """Invoke the first available Code_Aster launcher on the .export."""
    env = dict(os.environ)
    env["OMP_NUM_THREADS"] = str(max(1, threads))
    last_err: Exception | None = None
    for exe in LAUNCHERS:
        cmd = [exe, str(export_path)]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True,
                                 timeout=900, env=env)
        except FileNotFoundError as exc:
            last_err = exc
            continue
        sys.stdout.write(res.stdout)
        sys.stderr.write(res.stderr)
        # Code_Aster signals study success in the .mess ("DIAGNOSTIC ... OK")
        # rather than purely via exit code; surface the mess tail on failure.
        if res.returncode != 0:
            mess = work_dir / "study.mess"
            if mess.exists():
                sys.stderr.write("\n--- study.mess (tail) ---\n")
                sys.stderr.write("\n".join(mess.read_text(errors="replace")
                                           .splitlines()[-40:]))
            raise RuntimeError(f"{exe} exited {res.returncode}")
        return
    raise RuntimeError(
        f"no Code_Aster launcher found (tried {', '.join(LAUNCHERS)}); "
        f"last error: {last_err}"
    )


def _extract_qoi(result_med: Path, target: list[float]) -> dict:
    """u_z at the node nearest `target` (the free-edge midpoint). Reuses the
    meshio/h5py MED path the mesh-layer already validated.

    Code_Aster writes DEPL as a nodal field (DX,DY,DZ,DRX,DRY,DRZ). meshio's
    component layout varies by version, so the DZ lookup is defensive."""
    import meshio
    import numpy as np

    mesh = meshio.read(str(result_med))
    pts = np.asarray(mesh.points)

    def _dz() -> "np.ndarray":
        pd = mesh.point_data
        # 1) a single multi-component DEPL field → column 2 is DZ
        for k, v in pd.items():
            if "DEPL" in k.upper():
                a = np.asarray(v)
                if a.ndim == 2 and a.shape[1] >= 3:
                    return a[:, 2]
        # 2) split component fields → the DZ-looking one
        for k, v in pd.items():
            ku = k.upper()
            if "DEPL" in ku and ("DZ" in ku or ku.rstrip("0123456789").endswith("Z")):
                return np.asarray(v).reshape(-1)
        # 3) any 3+-component vector field, take column 2
        for k, v in pd.items():
            a = np.asarray(v)
            if a.ndim == 2 and a.shape[1] >= 3:
                return a[:, 2]
        raise RuntimeError(
            f"could not locate DEPL/DZ in result MED point_data; "
            f"keys = {list(pd)}"
        )

    dz = _dz()
    d = np.linalg.norm(pts - np.asarray(target), axis=1)
    i = int(d.argmin())
    return {
        "name": "uz_free_edge_midpoint",
        "label": "u_z at free-edge midpoint",
        "qoiValue": float(dz[i]),
        "qoiAbsValue": abs(float(dz[i])),
        "deformedPosition": [float(pts[i][0]), float(pts[i][1]), float(pts[i][2])],
        "physicalTarget": [float(target[0]), float(target[1]), float(target[2])],
        "nodeDistance": float(d[i]),
    }


def _write_sidecar(work_dir: Path, model: ModelConfig, manifest: dict,
                   qoi: dict, threads: int) -> None:
    """run.json mirroring scordelis_static.py so the GUI + Hub interpreter
    read it unchanged; engine="code_aster" + a FEM mesh block distinguish it."""
    seg = model.geometry["cylinder_segment"]
    mat = model.materials[0]
    run_json = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "command": " ".join(sys.argv),
        "engine": "code_aster",
        "analysisKind": "static",
        "case": {
            "R": float(seg["R"]), "L": float(seg["L"]),
            "t": float(seg["t"]), "phi_deg": float(seg["phi_deg"]),
            "E": float(mat["E"]), "nu": float(mat["nu"]),
        },
        "geometry": {"shape": "cylinder_segment", "n_patches": None},
        "mesh": {
            "engine": "code_aster",
            "element_family": manifest.get("element_family"),
            "mesh_order": manifest.get("mesh_order"),
            "mesh_size": manifest.get("mesh_size"),
            "n_nodes": manifest.get("n_nodes"),
            "n_elements": manifest.get("n_elements"),
        },
        "bcs": {"kind": str(model.bcs.get("kind"))},
        "load": {
            "kind": str(model.load.get("kind")),
            "magnitude": float(model.load.get("magnitude", 90.0)),
        },
        "analysis": {"kind": "static", "threads": int(threads)},
        "files": {"result_med": "result.med", "mess": "study.mess"},
        "qois": [qoi],
        "convergence": [{"r": manifest.get("mesh_order"), **qoi}],
        "modes": [],
        "verdict": {
            "qoiValue": qoi["qoiValue"],
            "qoiAbsValue": qoi["qoiAbsValue"],
            "qoiName": qoi["name"],
            "solverOk": True,
        },
    }
    (work_dir / "run.json").write_text(json.dumps(run_json, indent=2))


def main(argv: list[str] | None = None) -> int:
    import argparse
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", type=Path, required=True)
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--keep-files", action="store_true",
                   help="keep study.comm/.export/.mess after the run")
    args = p.parse_args(argv)

    _phase("setup")
    model = ModelConfig.from_json_file(args.model)

    shape = model.geometry.get("shape")
    kind = model.analysis.get("kind")
    engine = model.engine()
    if engine != "code_aster":
        raise SystemExit(
            f"code_aster_static.py expects solver.engine='code_aster'; got {engine!r}"
        )
    if shape != "cylinder_segment":
        raise SystemExit(
            f"code_aster_static.py wires geometry.shape='cylinder_segment' "
            f"(Step 3); got {shape!r}."
        )
    if kind != "static":
        raise SystemExit(
            f"code_aster_static.py wires analysis.kind='static' (Step 3); got {kind!r}."
        )

    work_dir = args.model.parent
    seg = model.geometry["cylinder_segment"]
    mat = model.materials[0]

    print("=" * 70)
    print("Aeris Code_Aster · LSA (linear static) · cylinder_segment + gravity")
    print("=" * 70)
    print(f"Geometry : R={seg['R']}, L={seg['L']}, t={seg['t']}, phi={seg['phi_deg']}°")
    print(f"Material : E={mat['E']}, nu={mat['nu']}")
    print(f"Load     : gravity, q={model.load.get('magnitude', 90.0)} per area, -z")
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
    comm_path = work_dir / "study.comm"
    export_path = work_dir / "study.export"
    comm_path.write_text(build_comm(model, manifest))
    export_path.write_text(build_export(str(work_dir)))

    _phase("solving")
    _run_aster(export_path, work_dir, threads=args.threads)

    _phase("parsing")
    qoi = _extract_qoi(work_dir / "result.med", manifest["qoi"]["target"])

    _phase("verdict")
    print()
    print("=" * 70)
    print("Verdict")
    print("=" * 70)
    print(f"QoI  : {qoi['label']}")
    print(f"  physical target   = ({qoi['physicalTarget'][0]:.3f}, "
          f"{qoi['physicalTarget'][1]:.3f}, {qoi['physicalTarget'][2]:.3f})")
    print(f"  nearest node dist = {qoi['nodeDistance']:.4f}")
    print(f"  u_z (signed)      = {qoi['qoiValue']:+.8f}")
    print(f"  |u_z|             = {qoi['qoiAbsValue']:.8f}")
    print("(reference comparison is per-benchmark; the Hub interpreter handles it)")

    _write_sidecar(work_dir, model, manifest, qoi, threads=args.threads)
    print(f"\nSidecar manifest written: {work_dir}/run.json")

    if not args.keep_files:
        for f in ("study.comm", "study.export"):
            try:
                (work_dir / f).unlink()
            except OSError:
                pass

    _phase("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
