"""Aeris static-linear KL-shell solver, entry-point for the GUI flow.

Sister script to cylinder_lba.py: same model.json contract + same
run.json sidecar shape, but for `analysis.kind = "static"` on a
`geometry.shape = "cylinder_segment"` (Scordelis-Lo class) geometry.
The GUI's dev-server (/run-solver) dispatches to THIS script instead
of cylinder_lba.py when those two schema fields point at static-on-
segment; cylinder_lba.py keeps owning the buckling-on-cylinder path.

What it does:
  1. Read /work/model.json
  2. Validate it's the case we handle (cylinder_segment + static)
  3. Build a single-patch biquadratic-NURBS input XML for
     static_shell_XML, with the geometry parametrised from model.json,
     diaphragm + corner-pin BCs (scordelis_diaphragm), uniform
     gravity body force (0, 0, -magnitude)
  4. Spawn /opt/gismo/build/bin/static_shell_XML --plot
  5. Parse the resulting solution0.vts for the QoI
     (u_z at parametric (0.5, 1) = free-edge midpoint at v=1)
  6. Write /work/run.json with the static verdict shape
     (analysisKind="static", qois[], no eigenvalue / criticalLoad fields)

The QoI extraction reuses benchmarks/common/vts.py so the file format
parsing stays in one place. The Hub's per-benchmark interpreter
(catalog.js) reads the qois[] entry and compares vs the literature
reference (0.3006 for Scordelis-Lo KL).
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# benchmarks/common/vts.py lives at /benchmarks/common/ inside the container
# (vite.config mounts both /scripts and /benchmarks). Adding /benchmarks
# to sys.path lets us reuse the structured-grid parser the CLI Scordelis
# benchmark already uses — no copy-paste drift.
sys.path.insert(0, "/benchmarks")
from common.vts import parse_vts  # noqa: E402


SOLVER_EXE = Path(os.environ.get(
    "AERIS_STATIC_EXE",
    "/opt/gismo/build/bin/static_shell_XML",
))


def _phase(name: str) -> None:
    """Phase marker for the GUI's live solver monitor — same protocol as
    cylinder_lba.py (line `[AERIS-PHASE] <name>` flushed immediately)."""
    print(f"[AERIS-PHASE] {name}", flush=True)


# ---------------------------------------------------------------------------
# XML builder — cylinder-segment geometry + Scordelis diaphragm + gravity
# ---------------------------------------------------------------------------

def _geometry_cps(R: float, L: float, phi_deg: float
                  ) -> list[tuple[float, float, float, float]]:
    """9 control points of the biquadratic NURBS surface for a
    cylinder-segment roof. Axis along x, arc in y-z plane swung from
    -phi to +phi about the apex at (·, 0, R*cos(phi) + R*sin(phi)*tan(phi)).
    Layout mirrors /opt/gismo/filedata/surfaces/scordelis_lo_roof.xml —
    arc endpoints at (·, 0, 0) and (·, -2R·sin(phi), 0), middle CP at
    (·, -R·sin(phi), R·sin(phi)·tan(phi)) with weight cos(phi). Returns
    (x, y, z, w) per CP in row-major (u fastest) order."""
    phi = math.radians(phi_deg)
    sphi = math.sin(phi)
    cphi = math.cos(phi)
    # Arc points in (y, z) — same construction as benchmarks/scordelis_lo/.
    y0, z0 = 0.0, 0.0
    y1, z1 = -R * sphi, R * sphi * math.tan(phi)
    y2, z2 = -2.0 * R * sphi, 0.0
    cps = []
    for (y, z, w) in [(y0, z0, 1.0), (y1, z1, cphi), (y2, z2, 1.0)]:
        for x in [0.0, L / 2.0, L]:
            cps.append((x, y, z, w))
    return cps


def _build_input_xml(model: dict) -> str:
    """Assemble the bvp XML that static_shell_XML reads. Mirrors the
    structure of the existing buckling XML in cylinder_lba.py:
        id=0   MultiPatch wrapping the geometry
        id=10  MaterialMatrix (Linear3 = Saint-Venant Kirchhoff)
        id=20  boundaryConditions
        id=21  surface force function (vector)
        id=22  pressure function (scalar — required by the driver)
        id=9991 the Geometry itself (referenced from the MultiPatch's
                <patches> id_range — same convention as the
                filedata/pde/*_1p.xml examples we copied from). """
    seg = model["geometry"]["cylinder_segment"]
    R = float(seg["R"])
    L = float(seg["L"])
    thickness = float(seg["t"])
    phi_deg = float(seg["phi_deg"])

    # Material resolution mirrors ModelConfig.case() — pull from the
    # assignment chain so multi-material setups will Just Work later.
    # For now there's exactly one assignment + one section + one material.
    mat = model["materials"][0]
    E = float(mat["E"])
    nu = float(mat["nu"])

    # Gravity load: uniform body force per unit shell area, vertical -z.
    # The magnitude is the user-facing |q|. Scordelis-Lo literature uses 90.
    load = model["load"]
    if load.get("kind") != "gravity":
        raise SystemExit(
            f"scordelis_static.py only handles load.kind = 'gravity'; "
            f"got {load.get('kind')!r}"
        )
    magnitude = float(load.get("magnitude", 90.0))
    fx, fy, fz = 0.0, 0.0, -magnitude

    cps = _geometry_cps(R, L, phi_deg)
    coefs = "\n    ".join(f"{x:.15g} {y:.15g} {z:.15g}" for (x, y, z, _w) in cps)
    weights = " ".join(f"{w:.15g}" for (_x, _y, _z, w) in cps)

    multipatch = """<MultiPatch parDim="2" id="0">
  <patches type="id_range">9991 9991</patches>
  <boundary>
    0 1
    0 2
    0 3
    0 4
  </boundary>
</MultiPatch>"""

    geometry = f"""<Geometry type="TensorNurbs2" id="9991">
  <Basis type="TensorNurbsBasis2">
    <Basis type="TensorBSplineBasis2">
      <Basis type="BSplineBasis" index="0">
        <KnotVector degree="2">0 0 0 1 1 1</KnotVector>
      </Basis>
      <Basis type="BSplineBasis" index="1">
        <KnotVector degree="2">0 0 0 1 1 1</KnotVector>
      </Basis>
    </Basis>
    <weights>{weights}</weights>
  </Basis>
  <coefs geoDim="3">
    {coefs}
  </coefs>
</Geometry>"""

    material = f"""<MaterialMatrix type="Linear3" id="10" TFT="false">
  <Thickness>
    <Function type="FunctionExpr" dim="3" index="0">{thickness:.15g}</Function>
  </Thickness>
  <Density>
    <Function type="FunctionExpr" dim="3" index="0">1</Function>
  </Density>
  <Parameters>
    <Function type="FunctionExpr" dim="3" index="0">{E:.15g}</Function>
    <Function type="FunctionExpr" dim="3" index="1">{nu:.15g}</Function>
  </Parameters>
</MaterialMatrix>"""

    bcs_kind = model["bcs"].get("kind", "scordelis_diaphragm")
    if bcs_kind != "scordelis_diaphragm":
        raise SystemExit(
            f"scordelis_static.py only handles bcs.kind = 'scordelis_diaphragm'; "
            f"got {bcs_kind!r}"
        )
    bcs = """<boundaryConditions id="20" multipatch="0">
  <Function type="FunctionExpr" dim="3" index="0">
    <c>0</c>
    <c>0</c>
    <c>0</c>
  </Function>

  <!-- Diaphragm on west (u=0, the curved arc at x=0):
       fix u_y = 0 (component 1) and u_z = 0 (component 2). u_x free. -->
  <bc type="Dirichlet" function="0" unknown="0" component="1">
    0 1
  </bc>
  <bc type="Dirichlet" function="0" unknown="0" component="2">
    0 1
  </bc>
  <!-- Diaphragm on east (u=1, the curved arc at x=L): same. -->
  <bc type="Dirichlet" function="0" unknown="0" component="1">
    0 2
  </bc>
  <bc type="Dirichlet" function="0" unknown="0" component="2">
    0 2
  </bc>
  <!-- Corner pin at south-west (u=v=0): fix u_x = 0 to kill the axial
       rigid-body mode the diaphragm BCs leave free. -->
  <cv unknown="0" component="0" corner="1" patch="0">0.0</cv>
</boundaryConditions>"""

    # Surface body force = gravity, written as a 3-vector FunctionExpr.
    force = f"""<Function type="FunctionExpr" id="21" tag="Loads" dim="3">
  <c>{fx:.15g}</c>
  <c>{fy:.15g}</c>
  <c>{fz:.15g}</c>
</Function>"""

    # Pressure function (id=22) — the driver reads it; we provide a
    # zero function since the load is a body force, not a pressure.
    pressure_fn = (
        '<Function type="FunctionExpr" id="22" tag="Loads" dim="3">0</Function>'
    )

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<xml>
{multipatch}

{geometry}

{material}

{bcs}

{force}

{pressure_fn}
</xml>
"""


# ---------------------------------------------------------------------------
# Solver invocation + QoI extraction
# ---------------------------------------------------------------------------

def _run_static(xml_path: Path, work_dir: Path,
                refines: int, threads: int,
                nonlinear: bool = False, gna_solver: str = "newton") -> None:
    """Spawn static_shell_XML with --plot. stdout is forwarded line-by-line
    so the GUI's /run-status polling sees solver progress (the C++ driver
    prints its own banners, plus we emit phase markers around it).

    When `nonlinear` is true we add --NR, which chains a Newton-Raphson
    iteration after the initial linear solve. The lambdas inside
    static_shell_XML rebuild K(u) and r(u) from the *deformed*
    configuration (mp_def), so this is true GNA: equilibrium on the
    current geometry, not the reference one. Same material, same BCs;
    only the equilibrium iteration changes."""
    cmd = [
        str(SOLVER_EXE),
        "-i", str(xml_path),
        "-o", str(work_dir),
        "-r", str(refines),
        "--plot",
        # --stress activates the constructStress block in static_shell_XML
        # which writes MembraneStress / MembraneStressVM / Principal* .pvds
        # alongside solution.pvd. Cheap (one extra pass through the patches)
        # and the GUI uses it for the post-processor's stress view.
        "--stress",
    ]
    if nonlinear:
        # GNA solver method: --NR Newton-Raphson (default) or --DR Dynamic
        # Relaxation. static_shell_XML's composite chains LIN → the chosen.
        cmd.append("--DR" if gna_solver == "dr" else "--NR")
    env = dict(os.environ)
    env["OMP_NUM_THREADS"] = str(max(1, threads))
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=env)
    # Always echo the solver's stdout/stderr so the user can see what
    # the driver actually said.
    sys.stdout.write(res.stdout)
    sys.stderr.write(res.stderr)
    if res.returncode != 0:
        raise RuntimeError(f"static_shell_XML exited {res.returncode}")


def _extract_qoi(work_dir: Path, R: float, L: float, phi_deg: float,
                 r: int) -> dict:
    """u_z at parametric (u=0.5, v=1) — the midpoint of the free edge
    at v=1 (the lower eave at chord-endpoint y = -2R·sin(phi)). The
    structured grid that gsWriteParaview emits is uniform in parametric
    space, so VtsGrid.point_at_param resolves it directly.

    Returns a row dict that goes into both qois[] (last entry =
    headline) and convergence[] (one row per r in the sweep)."""
    vts = parse_vts(work_dir / "solution0.vts")
    pos, disp = vts.point_at_param(0.5, 1.0)
    if vts.field_components < 3:
        raise RuntimeError(
            f"expected 3-component displacement, got {vts.field_components} "
            f"(field {vts.field_name!r})"
        )
    uz = disp[2]
    phi = math.radians(phi_deg)
    physical_target = (L / 2.0, -2.0 * R * math.sin(phi), 0.0)
    return {
        "r": int(r),
        "name": "uz_free_edge_midpoint",
        "label": "u_z at free-edge midpoint",
        "qoiValue": uz,
        "qoiAbsValue": abs(uz),
        "deformedPosition": [pos[0], pos[1], pos[2]],
        "physicalTarget": list(physical_target),
        "parametricPoint": [0.5, 1.0],
    }


# ---------------------------------------------------------------------------
# Sidecar
# ---------------------------------------------------------------------------

def _write_sidecar(work_dir: Path, model: dict,
                   convergence: list[dict], refines: list[int],
                   threads: int, analysis_kind: str = "static") -> None:
    """Write /work/run.json. Shape mirrors cylinder_lba.py's sidecar so
    the GUI's loadResultsManifest path Just Works; the static-specific
    fields live under qois[] + analysisKind="static". The Hub
    interpreter for Scordelis-Lo reads qois[0].value (the finest-r
    headline) and the convergence[] table (per-r history) and compares
    against the literature 0.3006 reference.

    `convergence` is the list of per-r QoI rows captured during the
    sweep — the last entry is the headline (finest r). `refines` is
    the full list of refinement levels that were actually run."""
    finest_qoi = convergence[-1]
    seg = model["geometry"]["cylinder_segment"]
    mat = model["materials"][0]
    run_json = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "command": " ".join(sys.argv),
        "analysisKind": analysis_kind,
        "case": {
            "R": float(seg["R"]), "L": float(seg["L"]),
            "t": float(seg["t"]), "phi_deg": float(seg["phi_deg"]),
            "E": float(mat["E"]), "nu": float(mat["nu"]),
        },
        "geometry": {
            "shape": "cylinder_segment",
            "n_patches": 1,
        },
        "mesh": {
            "refinement": int(refines[-1]),
            "degree": int(model["mesh"].get("degree", 3)),
            "smoothness": int(model["mesh"].get("smoothness", 2)),
            "coupling": str(model["mesh"].get("coupling", "gsSmoothInterfaces")),
        },
        "bcs": {"kind": str(model["bcs"]["kind"])},
        "load": {
            "kind": str(model["load"]["kind"]),
            "magnitude": float(model["load"].get("magnitude", 90.0)),
        },
        "analysis": {
            "kind": analysis_kind,
            "threads": int(threads),
        },
        "files": {
            # Match the gsWriteParaview naming exactly so the GUI's
            # post-processor can find these via /data/jobs/<id>/...
            # The .vts is the FINEST r's plot pass — gsWriteParaview
            # overwrites the file per call, so intermediate r's
            # plots are gone but the convergence[] numbers survive.
            "geometry": "mp.pvd",
            "solution": "solution.pvd",
            # Stress / strain fields written by the C++ driver's --stress
            # switch (we always pass it now; see _run_static). Only files
            # that actually landed on disk are listed — keeps the GUI
            # from trying to fetch missing entries on older job folders.
            # σ_vm is a true scalar; the principal-* entries are
            # 3-component vectors (sorted principal eigenvalues) that
            # the GUI loader projects to max(|component|) per vertex
            # for a single-scalar contour view.
            **{
                k: v for k, v in {
                    "stressVonMises":           "MembraneStressVM.pvd",
                    "principalMembraneStress":  "PrincipalMembraneStress.pvd",
                    "principalFlexuralStress":  "PrincipalFlexuralStress.pvd",
                    "principalMembraneStrain":  "PrincipalMembraneStrain.pvd",
                    "principalFlexuralStrain":  "PrincipalFlexuralStrain.pvd",
                }.items()
                if (work_dir / v).exists()
            },
        },
        "qois": [finest_qoi],
        # convergence[] is the per-r sweep history. Each row carries
        # {r, qoiValue, qoiAbsValue} — pct-vs-reference comparison is
        # per-benchmark and lives in the Hub interpreter.
        "convergence": convergence,
        # Empty arrays for fields the LBA sidecar carries so the
        # GUI's existing parsers don't blow up on missing keys.
        "modes": [
            {
                "refinement": finest_r,
                "pvd_path": "solution.pvd",
                "kind": "displacement",
            },
            *([{
                "refinement": finest_r,
                "pvd_path": "MembraneStressVM.pvd",
                "kind": "stress",
            }] if (work_dir / "MembraneStressVM.pvd").exists() else []),
        ],
        "verdict": {
            # The reference value is per-benchmark, not per-script —
            # the Hub interpreter applies it. Script just reports what
            # it computed + whether the solver converged at all.
            "qoiValue": finest_qoi["qoiValue"],
            "qoiAbsValue": finest_qoi["qoiAbsValue"],
            "qoiName": finest_qoi["name"],
            "solverOk": True,
        },
    }
    (work_dir / "run.json").write_text(json.dumps(run_json, indent=2))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    import argparse
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", type=Path, required=True,
                   help="Path to the model.json inside the container "
                        "(/work/model.json from the dev-server flow)")
    p.add_argument("--refines", type=int, nargs="+", default=[5],
                   help="h-refinement level(s) for the static solve. "
                        "First value used; the multi-r convergence sweep "
                        "lives in the Hub side, not here.")
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--keep-xml", action="store_true")
    args = p.parse_args(argv)

    _phase("setup")
    model = json.loads(args.model.read_text())

    shape = model.get("geometry", {}).get("shape")
    kind = model.get("analysis", {}).get("kind")
    if shape != "cylinder_segment":
        raise SystemExit(
            f"scordelis_static.py expects geometry.shape='cylinder_segment'; "
            f"got {shape!r}. cylinder_lba.py owns the closed-cylinder path."
        )
    if kind not in ("static", "gna"):
        raise SystemExit(
            f"scordelis_static.py expects analysis.kind in {{'static', 'gna'}}; "
            f"got {kind!r}."
        )
    nonlinear = (kind == "gna")
    gna_solver = str(model.get("analysis", {}).get("gnaSolver", "newton")).lower()

    work_dir = args.model.parent
    xml_text = _build_input_xml(model)
    xml_path = work_dir / "input.xml"
    xml_path.write_text(xml_text)

    print("=" * 70)
    analysis_label = "GNA (Newton-Raphson)" if nonlinear else "LSA (linear static)"
    print(f"Aeris KL-shell · {analysis_label} · cylinder_segment + scordelis_diaphragm + gravity")
    print("=" * 70)
    seg = model["geometry"]["cylinder_segment"]
    mat = model["materials"][0]
    print(f"Geometry : R={seg['R']}, L={seg['L']}, t={seg['t']}, phi={seg['phi_deg']}°")
    print(f"Material : E={mat['E']}, nu={mat['nu']}")
    print(f"Load     : gravity, q = {model['load'].get('magnitude', 90.0)} per area, -z")
    print(f"Analysis : {analysis_label}")
    print(f"Mesh     : r = {args.refines} · OMP threads = {args.threads}")
    print()

    # Convergence sweep: one solve per requested r. Each solve overwrites
    # solution0.vts (gsWriteParaview's hardcoded filename), so we extract
    # the QoI immediately after each solve before the next overwrites it.
    # The .vts of the LAST r in the list survives on disk → the GUI's
    # post-processor loads that one's mesh.
    print("Convergence sweep:")
    print(f"  {'-r':>4}  {'|u_z|':>14}  {'u_z (signed)':>14}")
    print(f"  {'-' * 50}")

    convergence: list[dict] = []
    for r in args.refines:
        _phase(f"solving_r{r}")
        _run_static(xml_path, work_dir, refines=r, threads=args.threads,
                    nonlinear=nonlinear, gna_solver=gna_solver)
        row = _extract_qoi(work_dir,
                           R=float(seg["R"]), L=float(seg["L"]),
                           phi_deg=float(seg["phi_deg"]), r=r)
        convergence.append(row)
        print(f"  {r:>4}  {row['qoiAbsValue']:>14.8f}  {row['qoiValue']:>+14.8f}")

    _phase("verdict")
    finest = convergence[-1]

    print()
    print("=" * 70)
    print("Verdict")
    print("=" * 70)
    print(f"QoI  : {finest['label']}  (finest r = {finest['r']})")
    print(f"  parametric (u, v) = ({finest['parametricPoint'][0]}, {finest['parametricPoint'][1]})")
    print(f"  physical target   = ({finest['physicalTarget'][0]:.3f}, "
          f"{finest['physicalTarget'][1]:.3f}, {finest['physicalTarget'][2]:.3f})")
    print(f"  deformed position = ({finest['deformedPosition'][0]:.6f}, "
          f"{finest['deformedPosition'][1]:.6f}, {finest['deformedPosition'][2]:.6f})")
    print(f"  u_z (signed)      = {finest['qoiValue']:+.8f}")
    print(f"  |u_z|             = {finest['qoiAbsValue']:.8f}")
    print()
    print("(reference comparison is per-benchmark; the Hub interpreter handles it)")

    _write_sidecar(work_dir, model, convergence,
                   refines=args.refines, threads=args.threads,
                   analysis_kind=kind)
    print(f"\nSidecar manifest written: {work_dir}/run.json")

    if not args.keep_xml:
        try: xml_path.unlink()
        except OSError: pass

    _phase("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
