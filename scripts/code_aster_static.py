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
from aster_engine.comm import build_comm, build_comm_gna, build_export  # noqa: E402


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


def _find_depl3(mesh) -> "np.ndarray":
    """Nodal displacement as an (N, 3) array (DX, DY, DZ). Code_Aster writes
    DEPL with 6 components (translations + rotations) and meshio's layout
    varies by version, so the lookup is defensive."""
    import numpy as np
    pd = mesh.point_data
    # 1) a single multi-component DEPL field → first 3 cols are translations
    for k, v in pd.items():
        if "DEPL" in k.upper():
            a = np.asarray(v)
            if a.ndim == 2 and a.shape[1] >= 3:
                return a[:, :3].astype(np.float64)
    # 2) split component fields DX/DY/DZ → stack them
    cols = {}
    for k, v in pd.items():
        ku = k.upper()
        if "DEPL" not in ku:
            continue
        for axis, key in (("X", 0), ("Y", 1), ("Z", 2)):
            if ku.rstrip("0123456789").endswith("D" + axis) or ku.endswith("D" + axis):
                cols[key] = np.asarray(v).reshape(-1)
    if {0, 1, 2} <= set(cols):
        return np.column_stack([cols[0], cols[1], cols[2]]).astype(np.float64)
    # 3) any 3+-component vector field → first 3 cols
    for k, v in pd.items():
        a = np.asarray(v)
        if a.ndim == 2 and a.shape[1] >= 3:
            return a[:, :3].astype(np.float64)
    raise RuntimeError(
        f"could not locate a DEPL vector in result MED point_data; keys = {list(pd)}"
    )


def _extract_qoi(mesh, qoi_spec: dict) -> dict:
    """u_z at the node nearest the QoI target. name/label come from the mesh
    manifest's qoi spec so each geometry reports its own QoI identity."""
    import numpy as np
    target = qoi_spec["target"]
    pts = np.asarray(mesh.points)
    dz = _find_depl3(mesh)[:, 2]
    d = np.linalg.norm(pts - np.asarray(target), axis=1)
    i = int(d.argmin())
    return {
        "name": qoi_spec.get("name", "uz"),
        "label": qoi_spec.get("label", "u_z at QoI point"),
        "qoiValue": float(dz[i]),
        "qoiAbsValue": abs(float(dz[i])),
        "deformedPosition": [float(pts[i][0]), float(pts[i][1]), float(pts[i][2])],
        "physicalTarget": [float(target[0]), float(target[1]), float(target[2])],
        "nodeDistance": float(d[i]),
    }


def _write_result_files(mesh, work_dir: Path) -> str | None:
    """Convert the Code_Aster result into a viewport-renderable .vtu (+ a .pvd
    wrapper so the GUI's existing .pvd→mesh machinery resolves it). Writes only
    the triangle SHELL cells (the 1D/0D BC groups are dropped so they don't add
    stray faces) and the displacement as a 3-component "SolutionField" — the
    exact field name the frontend parsers look for. Best-effort: on any failure
    we log and return None (the QoI verdict still stands, only the 3D view is
    skipped). Returns the .pvd filename on success."""
    import meshio
    import numpy as np
    try:
        disp = _find_depl3(mesh)
        tri = mesh.cells_dict.get("triangle")
        if tri is None:
            # quadratic-mesh fallback: corner-node triangles from TRIA6
            tri6 = mesh.cells_dict.get("triangle6")
            tri = tri6[:, :3] if tri6 is not None else None
        if tri is None:
            sys.stderr.write(
                "[code_aster_static] no triangle cells in result MED; "
                "skipping .vtu (viewport stays blank)\n"
            )
            return None
        out = meshio.Mesh(
            points=np.asarray(mesh.points),
            cells=[("triangle", np.asarray(tri))],
            point_data={"SolutionField": disp},
        )
        meshio.write(str(work_dir / "result.vtu"), out, binary=False)
        (work_dir / "result.pvd").write_text(
            '<?xml version="1.0"?>\n'
            '<VTKFile type="Collection" version="0.1" byte_order="LittleEndian">\n'
            '  <Collection>\n'
            '    <DataSet timestep="0" group="" part="0" file="result.vtu"/>\n'
            '  </Collection>\n'
            '</VTKFile>\n'
        )
        return "result.pvd"
    except Exception as exc:  # best-effort — never fail the run over rendering
        sys.stderr.write(f"[code_aster_static] result .vtu export failed: {exc}\n")
        return None


def _write_sidecar(work_dir: Path, model: ModelConfig, manifest: dict,
                   qoi: dict, threads: int, solution_file: str | None = None,
                   analysis_kind: str = "static") -> None:
    """run.json mirroring scordelis_static.py so the GUI + Hub interpreter
    read it unchanged; engine="code_aster" + a FEM mesh block distinguish it."""
    shape = model.geometry.get("shape")
    geom = model.geometry[shape]
    mat = model.materials[0]
    case = {k: float(geom[k]) for k in ("R", "L", "t", "phi_deg") if k in geom}
    case["E"] = float(mat["E"])
    case["nu"] = float(mat["nu"])
    run_json = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "command": " ".join(sys.argv),
        "engine": "code_aster",
        "analysisKind": analysis_kind,
        "case": case,
        "geometry": {"shape": shape, "n_patches": None},
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
            "magnitude": float(model.load.get("magnitude", 1.0)),
        },
        "analysis": {"kind": analysis_kind, "threads": int(threads)},
        "files": {
            "result_med": "result.med",
            "mess": "study.mess",
            # files.solution drives the ResultsPanel "LSA solution (deformed)"
            # item → Viewport3D loads it. Present only when the .vtu export
            # succeeded (best-effort), so a conversion failure degrades to a
            # verdict-only run rather than a broken-link result.
            **({"solution": solution_file} if solution_file else {}),
        },
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
    if shape not in ("cylinder_segment", "cylinder"):
        raise SystemExit(
            "code_aster_static.py wires geometry.shape in "
            f"{{'cylinder_segment', 'cylinder'}} (Steps 3, 6); got {shape!r}."
        )
    if kind not in ("static", "gna"):
        raise SystemExit(
            f"code_aster_static.py wires analysis.kind in {{'static','gna'}} "
            f"(Steps 3, 8); got {kind!r}."
        )

    work_dir = args.model.parent
    geom = model.geometry[shape]
    mat = model.materials[0]
    load = model.load

    analysis_label = "GNA (geometrically nonlinear)" if kind == "gna" else "LSA (linear static)"
    print("=" * 70)
    print(f"Aeris Code_Aster · {analysis_label} · {shape} + {load.get('kind')}")
    print("=" * 70)
    dims = "  ".join(f"{k}={geom[k]}" for k in ("R", "L", "t", "phi_deg") if k in geom)
    print(f"Geometry : {dims}")
    print(f"Material : E={mat['E']}, nu={mat['nu']}")
    print(f"Load     : {load.get('kind')} · magnitude={load.get('magnitude')}")
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
    if kind == "gna":
        if shape != "cylinder_segment":
            raise SystemExit(
                "code_aster_static.py: GNA is wired for cylinder_segment only (Step 8)"
            )
        comm_text = build_comm_gna(model, manifest)
    else:
        comm_text = build_comm(model, manifest)
    comm_path.write_text(comm_text)
    export_path.write_text(build_export(str(work_dir)))

    _phase("solving")
    _run_aster(export_path, work_dir, threads=args.threads)

    _phase("parsing")
    import meshio
    result_mesh = meshio.read(str(work_dir / "result.med"))
    qoi = _extract_qoi(result_mesh, manifest["qoi"])
    # MED → .vtu (+ .pvd) so the deformed shell renders in the GUI viewport.
    solution_file = _write_result_files(result_mesh, work_dir)

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

    _write_sidecar(work_dir, model, manifest, qoi, threads=args.threads,
                   solution_file=solution_file, analysis_kind=kind)
    if solution_file:
        print(f"Viewport  : result.vtu + {solution_file} written for the 3D view")
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
