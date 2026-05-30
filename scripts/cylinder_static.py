"""Aeris static / GNA solver for the closed-cylinder shape.

Sister script to cylinder_lba.py: shares the 4-patch quarter-NURBS
geometry construction + material block + multipatch topology, but
dispatches to ``static_shell_multipatch_XML`` instead of
``buckling_shell_multipatch_XML``. Supports two analysis kinds:

  - static : K · u = F, one shot. Linear, no NR iteration.
  - gna    : load-step sweep with Newton-Raphson per step. The script
             wraps a python outer loop that ramps the applied force
             from F · (1/N) → F · 1 in N equal increments, calling
             the solver with --NR at each step and recording the QoI
             after each. The result is a load-deflection table
             (loadDeflection[] in run.json), the headline view the
             GUI charts live in the monitor.

Live monitor protocol — the GUI's RunStatusPanel parses these lines
from stdout to drive its inline load-deflection chart, residual
panel, and solver metadata badges:

    [AERIS-PROGRESS] step=N of=M loadFactor=X F=Y u_qoi=Z
                     nrIter=K residual=R dofs=D solver=NR|MNR

One [AERIS-PHASE] solving_step_N marker per increment (PHASE_SEQUENCE
in RunSolve.jsx maps these onto a progress bar).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# Reuse the heavy XML helpers from cylinder_lba.py — same script dir,
# same /aeris/scripts mount inside the container.
sys.path.insert(0, str(Path(__file__).parent))
from cylinder_lba import (  # noqa: E402
    Case,
    _quarter_geometry,
    _material_xml,
    COUPLING_METHOD,
    SMOOTH_METHOD, SMOOTH_DEGREE, SMOOTH_SMOOTHNESS,
)

# benchmarks/common/vts.py — same vts parser the segment script uses.
sys.path.insert(0, "/benchmarks")
from common.vts import parse_vts  # noqa: E402


SOLVER_EXE = Path(os.environ.get(
    "AERIS_STATIC_MULTIPATCH_EXE",
    "/opt/gismo/build/bin/static_shell_multipatch_XML",
))


def _phase(name: str) -> None:
    """Coarse phase marker — drives the segmented progress bar in the
    GUI's RunStatusPanel. Per-iteration detail goes through the
    AERIS-PROGRESS protocol instead."""
    print(f"[AERIS-PHASE] {name}", flush=True)


def _progress(**fields) -> None:
    """Emit one structured progress line. Keys/values are joined as
    key=value pairs so the GUI-side parser is regex-trivial. Always
    flush so the dev-server's stdoutTail polling sees it in real time."""
    parts = [f"{k}={v}" for k, v in fields.items()]
    print(f"[AERIS-PROGRESS] {' '.join(parts)}", flush=True)


# ---------------------------------------------------------------------------
# XML builder — closed cylinder + Dirichlet/Neumann + physical load
# ---------------------------------------------------------------------------

def _model_to_case(model: dict) -> Case:
    """Pull the canonical Case (R, L, t, E, nu) out of model.json."""
    cyl = model["geometry"]["cylinder"]
    mat = model["materials"][0]
    return Case(
        R=float(cyl["R"]), L=float(cyl["L"]), t=float(cyl["t"]),
        E=float(mat["E"]), nu=float(mat["nu"]),
    )


def _bands_from_model(model: dict) -> list[tuple[float, float]]:
    """Replicate cylinder_lba.py's band_z_ranges() locally — partitioned
    cylinder bands as (z_lo, z_hi) tuples. Single band (no partitions)
    = the whole cylinder."""
    cyl = model["geometry"]["cylinder"]
    L = float(cyl["L"])
    partitions = sorted(float(p["z"]) for p in (cyl.get("partitions") or []))
    if not partitions:
        return [(0.0, L)]
    edges = [0.0, *partitions, L]
    return list(zip(edges[:-1], edges[1:]))


def build_cylinder_static_xml(model: dict, load_factor: float = 1.0) -> str:
    """Build the bvp XML for static_shell_multipatch_XML at the given
    load factor.

    Differences vs cylinder_lba.py's build_cylinder_xml:
      - No <OptionList id="94"> (Spectra-only options — static driver
        doesn't read it).
      - Neumann traction uses the ACTUAL physical force, not the
        E-scaled reference state. We don't have the buckling
        K_geom = K_NL − K_L catastrophic-cancellation issue, so no
        need for the conditioning trick.
      - Compression sign: axial load.magnitude > 0 means COMPRESSION,
        emitted as Tz < 0 on the top edge. Matches the user mental
        model "apply 8000 N axial compression" → see the cylinder
        shorten.

    `load_factor` scales the magnitude — for the GNA sweep we call this
    with k/N at step k of N to ramp the load smoothly. At factor 1.0
    the full model.load.magnitude is applied.
    """
    case = _model_to_case(model)
    bands = _bands_from_model(model)
    n_bands = len(bands)
    n_patches = 4 * n_bands

    patches = "\n\n".join(
        _quarter_geometry(9991 + 4 * b + q, case.R, z_lo, z_hi, q)
        for b, (z_lo, z_hi) in enumerate(bands)
        for q in range(4)
    )

    iface_lines = []
    for b in range(n_bands):
        off = 4 * b
        iface_lines.append(f"{off+0} 1 {off+3} 2 0 1 0 1")
        iface_lines.append(f"{off+0} 2 {off+1} 1 0 1 0 1")
        iface_lines.append(f"{off+1} 2 {off+2} 1 0 1 0 1")
        iface_lines.append(f"{off+2} 2 {off+3} 1 0 1 0 1")
    for b in range(n_bands - 1):
        lo, hi = 4 * b, 4 * (b + 1)
        for q in range(4):
            iface_lines.append(f"{lo+q} 4 {hi+q} 3 0 1 0 1")
    interfaces = "\n".join(iface_lines)

    bnd_lines = []
    for q in range(4):
        bnd_lines.append(f"{q} 3")
        bnd_lines.append(f"{4 * (n_bands - 1) + q} 4")
    boundary = "\n".join(bnd_lines)

    multipatch = (
        f'<MultiPatch parDim="2" id="0">\n'
        f'<patches type="id_range">9991 {9991 + n_patches - 1}</patches>\n'
        f'  <interfaces>{interfaces}\n</interfaces>\n'
        f'  <boundary>{boundary}\n</boundary>\n'
        f'</MultiPatch>'
    )

    # Single-thickness material only (the static path mirrors the LBA
    # single-band convention for now; multi-band stepped thickness can
    # be lifted later from cylinder_lba.py if needed).
    material = _material_xml(case, mat_id=10, thickness=case.t)

    # Physical load. model.load.magnitude is the user-facing total force
    # (axial: total N; bending: total moment N·mm). For axial the line
    # traction is F / (2π R); for bending it's the cos(θ)-weighted edge
    # traction Tz(x) = (M / (π R³)) · x. Compression = negative Tz.
    load_kind = model["load"].get("kind", "axial")
    F_user = float(model["load"].get("magnitude", 1.0))
    F = F_user * float(load_factor)

    bottom_patches = "\n    ".join(f"{q} 3" for q in range(4))
    top_off = 4 * (n_bands - 1)
    top_patches = "\n    ".join(f"{top_off + q} 4" for q in range(4))

    if load_kind == "axial":
        Tz = -F / (2.0 * math.pi * case.R)
        neumann_components = (
            f"  <c> 0 </c>\n"
            f"  <c> 0 </c>\n"
            f"  <c> {Tz:.15g} </c>"
        )
    elif load_kind == "bending":
        # Cos(θ) edge traction realising a bending moment M = F about y-axis.
        # Tz(x) = M · x / I_top  where I_top = π R³ · t (top-edge area-moment).
        # For just-the-LINE-load (per unit circumference) drop the t:
        # Tz_line(x) = (M / (π R³)) · x  [force/length].
        Tz_slope = F / (math.pi * case.R ** 3)
        neumann_components = (
            f"  <c> 0 </c>\n"
            f"  <c> 0 </c>\n"
            f"  <c> {Tz_slope:.15g} * x </c>"
        )
    else:
        raise SystemExit(
            f"cylinder_static.py: load.kind '{load_kind}' not wired; "
            "supported: axial, bending"
        )

    bcs = f"""<boundaryConditions id="20" multipatch="0">
  <Function type="FunctionExpr" dim="3" index="0">
  <c> 0 </c>
  <c> 0 </c>
  <c> 0 </c>
  </Function>
  <Function type="FunctionExpr" dim="3" index="1">
{neumann_components}
  </Function>

  <bc type="Dirichlet" function="0" unknown="0" component="-1">
    {bottom_patches}
  </bc>
  <bc type="Clamped" function="0" unknown="0" component="2">
    {bottom_patches}
  </bc>
  <bc type="Neumann" function="1" unknown="0">
    {top_patches}
  </bc>
</boundaryConditions>"""

    # Static driver expects body force (id=21) and pressure (id=22),
    # both zero for the pure-Neumann case. Point loads (id=30/31/32)
    # are populated only if geometry.cylinder.imperfectionForce > 0 —
    # then we add one outward-radial point load at midheight +
    # mid-quadrant of patch 0. This is the symmetry-breaker that
    # seeds the GNA path off the trivial axisymmetric branch, exactly
    # like ABAQUS's "pin u_r at midpoint" trick but with a force
    # imperfection instead of a displacement one (same effect on the
    # bifurcation, simpler to wire through gsBoundaryConditions which
    # doesn't expose interior-point Dirichlet BCs).
    cyl = model["geometry"]["cylinder"]
    imp_force = float(cyl.get("imperfectionForce", 0.0))
    if imp_force > 0:
        # Patch 0 (+x+y quadrant) parametric (0.5, 0.5) maps to
        # physical (R·cos(π/4), R·sin(π/4), L/2) — midheight of the
        # 45-deg meridian. Radial outward direction at that point is
        # (cos(π/4), sin(π/4), 0); we apply the perturbation along it.
        fx = imp_force * math.cos(math.pi / 4)
        fy = imp_force * math.sin(math.pi / 4)
        point_loads = (
            f'<Matrix rows="2" cols="1" id="30" tag="Loads">\n'
            f'0.5\n0.5\n</Matrix>\n'
            f'<Matrix rows="3" cols="1" id="31" tag="Loads">\n'
            f'{fx:.15g}\n{fy:.15g}\n0\n</Matrix>\n'
            f'<Matrix rows="1" cols="1" id="32" tag="Loads">0</Matrix>'
        )
    else:
        point_loads = (
            '<Matrix rows="2" cols="0" id="30" tag="Loads" ></Matrix>\n'
            '<Matrix rows="3" cols="0" id="31" tag="Loads" ></Matrix>\n'
            '<Matrix rows="1" cols="0" id="32" tag="Loads" ></Matrix>'
        )
    loads = f"""<Function type="FunctionExpr" id="21" tag="Loads" dim="3">
  <c> 0 </c>
  <c> 0 </c>
  <c> 0 </c>
</Function>
<Function type="FunctionExpr" id="22" tag="Loads" dim="3">0</Function>

{point_loads}"""

    # Reference point — required by the driver for QoI extraction.
    # Mid-top of patch 0 (parametric (0.5, 1.0)) so we can later wire
    # this through the driver's data.csv output too if needed.
    refs = """<Matrix rows="2" cols="1" id="50" >
0.5
1.0
</Matrix>
<Matrix rows="1" cols="1" id="51" >0</Matrix>
<Matrix rows="0" cols="0" id="52" ></Matrix>"""

    # Interface penalty — mirrors cylinder_lba.py's default. Honoured
    # by gsThinShellAssembler's addWeakC0/C1 fallback even when the
    # primary coupling is gsSmoothInterfaces (smooth path is exact;
    # penalty is the legacy single-patch-driver fallback).
    ifc_penalty = float(model["analysis"].get("interface_penalty", 1e6))
    options = f"""<OptionList id="92">
<int label="Continuity" desc="Interface continuity" value="0"/>
<real label="IfcPenalty" desc="Penalty for weak C0/C1 coupling at multipatch interfaces" value="{ifc_penalty}"/>
</OptionList>"""

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<xml>
{multipatch}

{material}

{bcs}

{loads}

{refs}

{options}

{patches}
</xml>
"""


# ---------------------------------------------------------------------------
# Solver invocation
# ---------------------------------------------------------------------------

DOF_LINE = re.compile(r"size=(\d+)")        # parsed from driver's basis line
NR_ITER_LINE = re.compile(r"\bIter\s*=?\s*(\d+)\b", re.IGNORECASE)


def _run_solver(xml_path: Path, work_dir: Path, refines: int,
                degree: int, smoothness: int, method: int,
                threads: int, nonlinear: bool,
                gna_solver: str = "newton") -> dict:
    """One solver invocation. Returns parsed metadata for the AERIS-PROGRESS
    line (dofs, nrIter — best-effort). stdout/stderr are echoed to the
    caller's stdout so the user's stream stays unified.

    NOTE: static_shell_multipatch_XML doesn't accept -p / -s like the
    buckling driver does. Degree comes via `-e` (degree elevation off
    the geometry's base degree); smoothness is implicit in the smoothing
    method picked by `-m`. Geometry XML is degree-2 NURBS, so
    e = degree - 2 lands at the desired final degree (3 → e=1)."""
    e = max(0, int(degree) - 2)
    cmd = [
        str(SOLVER_EXE),
        "-i", str(xml_path),
        "-o", str(work_dir),
        "-r", str(refines),
        "-e", str(e),
        "-m", str(method),
        "--plot",
        "--stress",
    ]
    if nonlinear:
        # GNA solver method: Newton-Raphson (--NR) or Dynamic Relaxation
        # (--DR). static_shell_XML's composite chains LIN → the chosen
        # solver; DR is the robust pseudo-transient fallback.
        cmd.append("--DR" if gna_solver == "dr" else "--NR")
    env = dict(os.environ)
    env["OMP_NUM_THREADS"] = str(max(1, threads))
    res = subprocess.run(cmd, capture_output=True, text=True,
                         timeout=600, env=env)
    sys.stdout.write(res.stdout)
    sys.stderr.write(res.stderr)
    if res.returncode != 0:
        raise RuntimeError(f"static_shell_multipatch_XML exited {res.returncode}")

    dofs = None
    nr_iter = None
    for line in res.stdout.splitlines():
        if dofs is None:
            m = DOF_LINE.search(line)
            if m:
                # Per-patch basis size. Multiply by 4 patches × 3 components
                # for a coarse global DOF count — exact value would require
                # accounting for inter-patch coupling, but for a status badge
                # the order-of-magnitude is what the user actually cares about.
                dofs = int(m.group(1)) * 4 * 3
        m = NR_ITER_LINE.search(line)
        if m:
            nr_iter = max(nr_iter or 0, int(m.group(1)))
    return {"dofs": dofs, "nrIter": nr_iter}


def _extract_qoi(work_dir: Path, R: float, L: float) -> dict:
    """u_z at top-of-cylinder mid-circumference. For axial compression
    this is the (uniform, axisymmetric) axial shortening. Parametric
    (u=0.5, v=1.0) on patch 0 lands at (R, 0, L) physical — top edge
    of the +x quadrant.

    The multipatch driver writes per-patch files as `solution_0.vts`,
    `solution_1.vts`, … (underscore separator). The single-patch driver
    writes `solution0.vts` (no underscore). We try both so a future
    single-patch reuse Just Works."""
    candidates = ["solution_0.vts", "solution0.vts"]
    vts_path = next((work_dir / c for c in candidates
                     if (work_dir / c).exists()), None)
    if vts_path is None:
        raise RuntimeError(
            f"no solution .vts found in {work_dir} "
            f"(tried: {', '.join(candidates)})"
        )
    vts = parse_vts(vts_path)
    pos, disp = vts.point_at_param(0.5, 1.0)
    if vts.field_components < 3:
        raise RuntimeError(
            f"expected 3-component displacement, got {vts.field_components}"
        )
    uz = float(disp[2])
    return {
        "u_qoi": uz,
        "u_qoi_abs": abs(uz),
        "qoi_position": [float(pos[0]), float(pos[1]), float(pos[2])],
        "qoi_name": "uz_top_midcirc",
        "qoi_label": "u_z at top edge",
    }


# ---------------------------------------------------------------------------
# Sidecar
# ---------------------------------------------------------------------------

def _write_sidecar(work_dir: Path, model: dict,
                   load_deflection: list[dict],
                   refinement: int, threads: int,
                   analysis_kind: str,
                   halted_reason: str | None = None,
                   retries_log: list[dict] | None = None) -> None:
    """Write /work/run.json. Same shape as scordelis_static.py's sidecar
    but with the cylinder-shape `case` block and a `loadDeflection` array
    that the GUI charts both LIVE (during the run, via AERIS-PROGRESS
    parsing) and offline (from this sidecar after success).

    The headline qoi[] entry is the LAST load-step row — that's the
    final converged state under full F."""
    finest = load_deflection[-1]
    case = _model_to_case(model)
    cyl = model["geometry"]["cylinder"]
    mat = model["materials"][0]
    run_json = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "command": " ".join(sys.argv),
        "analysisKind": analysis_kind,
        "case": {
            "R": case.R, "L": case.L, "t": case.t,
            "E": case.E, "nu": case.nu,
        },
        "geometry": {
            "shape": "cylinder",
            "n_patches": 4 * len(_bands_from_model(model)),
            "n_bands": len(_bands_from_model(model)),
        },
        "mesh": {
            "refinement": int(refinement),
            "degree": int(model["mesh"].get("degree", 3)),
            "smoothness": int(model["mesh"].get("smoothness", 2)),
            "coupling": str(model["mesh"].get("coupling", "gsSmoothInterfaces")),
        },
        "bcs": {"kind": str(model["bcs"].get("kind", "clamped_neumann"))},
        "load": {
            "kind": str(model["load"]["kind"]),
            "magnitude": float(model["load"].get("magnitude", 1.0)),
            "controlMode": str(model["load"].get("controlMode", "force")),
        },
        "analysis": {
            "kind": analysis_kind,
            "threads": int(threads),
            # Echo back the user's increment config + the actual count of
            # converged steps so the post-processor can show "X / N"
            # without re-parsing the loadDeflection table.
            "maxIncrements": int(model["analysis"].get("maxIncrements", 100)),
            "initIncrement": float(model["analysis"].get("initIncrement", 0.01)),
            "maxIncrement":  float(model["analysis"].get("maxIncrement",  0.1)),
            "minIncrement":  float(model["analysis"].get("minIncrement",  1e-5)),
            "convergedSteps": len(load_deflection),
        },
        "files": {
            "geometry": "mp.pvd",
            "solution": "solution.pvd",
            **{
                k: v for k, v in {
                    "stressVonMises":          "MembraneStressVM.pvd",
                    "principalMembraneStress": "PrincipalMembraneStress.pvd",
                    "principalFlexuralStress": "PrincipalFlexuralStress.pvd",
                    "principalMembraneStrain": "PrincipalMembraneStrain.pvd",
                    "principalFlexuralStrain": "PrincipalFlexuralStrain.pvd",
                }.items()
                if (work_dir / v).exists()
            },
        },
        "qois": [{
            "name": finest["qoi_name"],
            "label": finest["qoi_label"],
            "qoiValue": finest["u_qoi"],
            "qoiAbsValue": finest["u_qoi_abs"],
            "deformedPosition": finest["qoi_position"],
        }],
        "loadDeflection": load_deflection,
        "modes": [],
        "verdict": {
            "qoiValue": finest["u_qoi"],
            "qoiAbsValue": finest["u_qoi_abs"],
            "qoiName": finest["qoi_name"],
            "solverOk": halted_reason is None,
            "finalLoadFactor": finest["loadFactor"],
            "haltedReason": halted_reason,
            "bisectionRetries": len(retries_log) if retries_log else 0,
        },
        "retriesLog": retries_log or [],
    }
    # For GNIA: include imperfections metadata so the Inspector can render it
    if analysis_kind == "gnia":
        imp = model.get("imperfections", {})
        run_json["imperfections"] = {
            "kind": str(imp.get("kind", "random")),
            "mode": int(imp.get("mode", 1)),
            "amplitude": float(imp.get("amplitude", 0.001)),
            "lbaEigenvalue": imp.get("lbaEigenvalue"),
            "lbaMode": imp.get("lbaMode"),
        }
    (work_dir / "run.json").write_text(json.dumps(run_json, indent=2))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", type=Path, required=True)
    p.add_argument("--refines", type=int, nargs="+", default=[5],
                   help="Mesh refinement level (uses last value of the list — "
                        "convergence sweep not yet wired for static/gna). "
                        "Plural form kept for API parity with cylinder_lba.")
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--keep-xml", action="store_true")
    args = p.parse_args(argv)

    _phase("setup")
    model = json.loads(args.model.read_text())

    shape = model.get("geometry", {}).get("shape")
    kind = model.get("analysis", {}).get("kind")
    gna_solver = str(model.get("analysis", {}).get("gnaSolver", "newton")).lower()

    if shape != "cylinder":
        raise SystemExit(
            f"cylinder_static.py expects geometry.shape='cylinder'; got {shape!r}."
        )

    # Accept kind in {'static', 'gna'} directly, or 'gnia' with gnaSolver='newton'
    # (GNIA with Newton-Raphson + imperfections; arc-length GNIA routes to cylinder_arclength.py)
    if kind not in ("static", "gna") and not (kind == "gnia" and gna_solver == "newton"):
        raise SystemExit(
            f"cylinder_static.py expects analysis.kind in {{'static', 'gna'}} "
            f"or 'gnia' with gnaSolver='newton'; got kind={kind!r}, gnaSolver={gna_solver!r}."
        )

    # Nonlinear if kind is 'gna' OR 'gnia' with Newton-Raphson
    nonlinear = (kind == "gna") or (kind == "gnia" and gna_solver == "newton")
    # ABAQUS-style increment configuration. LSA collapses these to one
    # direct solve. GNA reads four fields:
    #   maxIncrements  hard cap on attempts (retries + ok)
    #   initIncrement  Δλ at start of walk
    #   maxIncrement   ceiling for grow-back
    #   minIncrement   floor for bisect; halt below
    # Falls back to legacy loadSteps if the new fields aren't on the
    # model.json (so old jobs from before the schema change still run):
    # init = max = 1/loadSteps, min = init/100, maxAttempts = 4*loadSteps.
    analysis_cfg = model["analysis"]
    if "initIncrement" in analysis_cfg:
        d_init = float(analysis_cfg.get("initIncrement", 0.01))
        d_max  = float(analysis_cfg.get("maxIncrement",  0.1))
        d_min  = float(analysis_cfg.get("minIncrement",  1e-5))
        max_attempts = int(analysis_cfg.get("maxIncrements", 100))
    elif "loadSteps" in analysis_cfg:
        # Legacy path — uniform stepping derived from N
        n_legacy = max(1, int(analysis_cfg["loadSteps"]))
        d_init = 1.0 / n_legacy
        d_max  = 1.0 / n_legacy
        d_min  = d_init / 100.0
        max_attempts = 4 * n_legacy
    else:
        d_init, d_max, d_min, max_attempts = 0.01, 0.1, 1e-5, 100
    if not nonlinear:
        # LSA: force a single direct solve regardless of GNA settings
        d_init = d_max = 1.0
        d_min = 1.0
        max_attempts = 1
    # Sanity clamps
    d_max = max(d_max, d_init)
    d_min = min(d_min, d_init)

    case = _model_to_case(model)
    work_dir = args.model.parent

    # Control mode dispatches the per-step loop. "force" is the canonical
    # path (user prescribes F, solver computes u). "displacement" inverts
    # the problem: user prescribes the target u_z at the top edge, we
    # iterate a force search (secant on F) per step. Cheap when GNA is
    # near-linear (1-2 inner solves per step); the per-step F is stored
    # in loadDeflection[] so the chart still reads as F-vs-u just like
    # force control.
    control_mode = str(model["load"].get("controlMode", "force")).lower()
    if control_mode not in ("force", "displacement"):
        raise SystemExit(
            f"unknown load.controlMode '{control_mode}'; "
            "expected 'force' or 'displacement'"
        )
    is_disp_control = (control_mode == "displacement")
    magnitude = float(model["load"].get("magnitude", 1.0))
    if is_disp_control:
        d_total = magnitude       # prescribed total axial compression
        F_total = None            # search per step
    else:
        F_total = magnitude
        d_total = None

    refinement = int(args.refines[-1])
    degree = int(model["mesh"].get("degree", SMOOTH_DEGREE))
    smoothness = int(model["mesh"].get("smoothness", SMOOTH_SMOOTHNESS))
    coupling_name = str(model["mesh"].get("coupling", "gsSmoothInterfaces"))
    method = COUPLING_METHOD.get(coupling_name, SMOOTH_METHOD)

    print("=" * 70)
    print(f"Aeris KL-shell · {'GNA (load-step + Newton-Raphson)' if nonlinear else 'LSA (linear static)'}")
    print(f"     · cylinder ({4 * len(_bands_from_model(model))} patches)")
    print(f"     · control={control_mode}")
    print("=" * 70)
    print(f"Geometry : R={case.R}, L={case.L}, t={case.t}")
    print(f"Material : E={case.E}, nu={case.nu}")
    if is_disp_control:
        print(f"Load     : {model['load']['kind']}, target |u_z|_top = {d_total} (force searched per step)")
    else:
        print(f"Load     : {model['load']['kind']}, F = {F_total} {('(scaled per step)' if nonlinear else '')}")
    print(f"Mesh     : r={refinement}, p={degree}, s={smoothness}, coupling={coupling_name}")
    if nonlinear:
        print(f"Incs     : init Δλ={d_init:g}  max={d_max:g}  min={d_min:g}  "
              f"cap={max_attempts}")
    else:
        print("Steps    : 1 (LSA single direct solve)")
    print()

    # One solve at a prescribed force. Returns (u_qoi, |u_qoi|, meta).
    # The load_factor argument feeds build_cylinder_static_xml so the XML's
    # Tz reflects the actual force being applied this iteration — F applied
    # is always F_user * load_factor.
    def solve_at_force(F_applied: float) -> tuple[float, float, dict]:
        # We piggyback on build_cylinder_static_xml's load_factor param to
        # set the absolute force: temporarily swap model.load.magnitude
        # to F_applied and pass load_factor=1.0. Cleaner than threading
        # an "override" parameter through the builder.
        saved_mag = model["load"]["magnitude"]
        model["load"]["magnitude"] = float(F_applied)
        try:
            xml_text = build_cylinder_static_xml(model, load_factor=1.0)
        finally:
            model["load"]["magnitude"] = saved_mag
        xml_path = work_dir / "input.xml"
        xml_path.write_text(xml_text)
        meta = _run_solver(
            xml_path, work_dir,
            refines=refinement, degree=degree, smoothness=smoothness,
            method=method, threads=args.threads, nonlinear=nonlinear,
            gna_solver=gna_solver,
        )
        qoi = _extract_qoi(work_dir, R=case.R, L=case.L)
        return qoi["u_qoi"], qoi["u_qoi_abs"], {**qoi, **meta}

    # Linear axial stiffness for first-guess F estimation in disp control.
    # k_axial = E·A/L where A = 2πRt. Gives F_est = k_axial · d for a
    # clamped-free thin cylinder under uniform axial load (first-order).
    # Used only as a Newton starting point — the secant iteration corrects
    # any error from the geometric stiffening / clamping effect.
    A_axial = 2.0 * math.pi * case.R * case.t
    k_axial = case.E * A_axial / case.L

    # Divergence sniffer — heuristic without requiring solver-side
    # changes. Trips on:
    #   - NaN / Inf in u_qoi (driver returned garbage)
    #   - |u_z| > 5 · R (geometrically impossible for an axially-loaded
    #     cylinder — the top can't move down 5 radii)
    #   - per-step delta > 10× the rolling average of previous deltas
    #     (a soft "softening detector" — catches divergence near the
    #     bifurcation point even before |u| crosses the absolute bound)
    # Returns (diverged: bool, reason: str | None).
    def diverged(u_abs: float, prev_history: list[dict],
                 expected_dlam: float) -> tuple[bool, str | None]:
        if not math.isfinite(u_abs):
            return True, "non-finite u_qoi"
        if u_abs > 5.0 * case.R:
            return True, f"|u|={u_abs:.3g} > 5·R={5*case.R:.3g}"
        if len(prev_history) >= 2:
            recent_deltas = [
                abs(prev_history[i]["u_qoi_abs"] - prev_history[i-1]["u_qoi_abs"])
                for i in range(1, len(prev_history))
            ]
            avg_delta = sum(recent_deltas) / len(recent_deltas)
            new_delta = abs(u_abs - prev_history[-1]["u_qoi_abs"])
            if avg_delta > 1e-12 and new_delta > 10.0 * avg_delta:
                return True, (f"|Δu|={new_delta:.3g} > 10·avg "
                              f"({avg_delta:.3g}) — likely past limit point")
        return False, None

    load_deflection: list[dict] = []
    solver_tag = "NR" if nonlinear else "LIN"
    # State carried between steps — last converged (F, u) gives the
    # disp-control search a warm start and the rate-based divergence
    # sniffer something to compare against.
    F_prev: float | None = None
    u_prev: float | None = None

    def is_diverged(u_abs: float) -> tuple[bool, str | None]:
        """Heuristic divergence check — fires on:
          - NaN / Inf from the solver
          - |u_z| > 5·R (geometrically impossible — top can't move 5 radii)
          - jump > 10× the average step-to-step delta of prior history
            (catches softening near the bifurcation point even before
            |u| crosses the absolute bound)
        Returns (diverged: bool, reason: str | None)."""
        if not math.isfinite(u_abs):
            return True, "non-finite u_qoi"
        if u_abs > 5.0 * case.R:
            return True, f"|u|={u_abs:.3g} > 5·R"
        if len(load_deflection) >= 2:
            deltas = [
                abs(load_deflection[i]["u_qoi_abs"]
                    - load_deflection[i-1]["u_qoi_abs"])
                for i in range(1, len(load_deflection))
            ]
            avg = sum(deltas) / len(deltas)
            new_delta = abs(u_abs - load_deflection[-1]["u_qoi_abs"])
            if avg > 1e-12 and new_delta > 10.0 * avg:
                return True, (f"|Δu|={new_delta:.3g} > 10·avg ({avg:.3g})")
        return False, None

    def attempt_step(load_factor: float, step_idx: int):
        """One step attempt at the given load factor. Returns
        (row: dict, ok: bool, reason: str | None). When ok=False the
        outer walker bisects the step and retries. Doesn't mutate
        any state on its own — the caller commits the row + updates
        F_prev/u_prev only on ok=True."""
        nonlocal F_prev, u_prev
        if not is_disp_control:
            F_step = F_total * load_factor
            try:
                _u_signed, u_abs, info = solve_at_force(F_step)
            except RuntimeError as err:
                print(f"  [warn] solver raised: {err}", flush=True)
                return None, False, f"solver-exit: {err}"
            inner_solves = 1
            d_step = None
        else:
            d_step = d_total * load_factor
            tol = max(1e-4, 0.01 * d_step)
            # Warm start from previous converged step, else axial-
            # stiffness guess (E·A/L × d).
            if F_prev is not None and u_prev is not None and abs(u_prev) > 1e-12:
                F_try = F_prev * (d_step / abs(u_prev))
            else:
                F_try = k_axial * d_step
            inner_solves = 0
            history: list[tuple[float, float]] = []
            converged_inner = False
            info = None
            u_abs = float("nan")
            for _ in range(5):
                try:
                    _u_signed, u_abs, info = solve_at_force(F_try)
                except RuntimeError as err:
                    print(f"  [warn] disp-control inner solve raised: {err}",
                          flush=True)
                    return None, False, f"inner-solve-exit: {err}"
                inner_solves += 1
                history.append((F_try, u_abs))
                if abs(u_abs - d_step) <= tol:
                    converged_inner = True
                    break
                if len(history) >= 2:
                    F_a, u_a = history[-2]
                    F_b, u_b = history[-1]
                    if abs(u_b - u_a) < 1e-15:
                        F_try = F_b * (d_step / max(u_b, 1e-15))
                    else:
                        F_try = F_b + (d_step - u_b) * (F_b - F_a) / (u_b - u_a)
                else:
                    F_try = F_try * (d_step / max(u_abs, 1e-15))
                F_try = max(min(F_try, 1e3 * k_axial * d_step),
                            1e-9 * k_axial * d_step)
            F_step = history[-1][0]
            if not converged_inner:
                print(f"  [warn] disp-control step {step_idx}: "
                      f"{inner_solves} inner iters didn't hit tol — "
                      f"|u|={u_abs:.6g} vs target {d_step:.6g}", flush=True)
        # Divergence sniffer
        bad, reason = is_diverged(u_abs)
        if bad:
            return None, False, reason
        row = {
            "step": step_idx,
            "loadFactor": load_factor,
            "F": F_step,
            "u_qoi": info["u_qoi"],
            "u_qoi_abs": info["u_qoi_abs"],
            "qoi_position": info["qoi_position"],
            "qoi_name": info["qoi_name"],
            "qoi_label": info["qoi_label"],
            "dofs": info["dofs"],
            "nrIter": info["nrIter"] or (1 if not nonlinear else 0),
            "innerSolves": inner_solves,
            "controlMode": control_mode,
            "solver": solver_tag,
        }
        if is_disp_control:
            row["dTarget"] = d_step
        return row, True, None

    # ----- Adaptive stepping walker (ABAQUS-style) -----
    # Δλ starts at initIncrement, bisects /2 on divergence (floor =
    # minIncrement → halt below), grows ×1.5 after 3 consecutive
    # successes (cap = maxIncrement). maxIncrements is a hard cap on
    # TOTAL attempts (retries + ok) — ABAQUS prints "too many attempts"
    # and halts when reached; we do the same and surface it via
    # haltedReason.
    lam = 0.0
    dlam = d_init
    consec_ok = 0
    step = 0
    halted_reason: str | None = None
    retries_log: list[dict] = []

    while lam < 1.0 - 1e-12 and step < max_attempts:
        step += 1
        accepted = False
        # Per-step retry cap is the lesser of (5, remaining attempts in
        # the global cap). Without the cap a stuck step could exhaust
        # the global budget bisecting in place.
        max_retries = min(5, max_attempts - step)
        retries_this_step = 0
        while not accepted and retries_this_step <= max_retries:
            lam_try = min(lam + dlam, 1.0)
            _phase(f"solving_step_{step}")
            row, ok, reason = attempt_step(lam_try, step)
            if not ok:
                retries_this_step += 1
                if dlam <= d_min:
                    halted_reason = (f"diverged at λ={lam_try:.4f} with "
                                     f"Δλ={dlam:.2e} (minIncrement); "
                                     f"reason: {reason}")
                    break
                new_dlam = max(dlam / 2.0, d_min)
                retries_log.append({
                    "step": step, "lam": lam_try, "dlam_before": dlam,
                    "dlam_after": new_dlam, "reason": reason,
                })
                # Live-monitor: surface the retry so the user sees the
                # bisection happening (no row in loadDeflection, but the
                # progress feed gets a `retry` line).
                _progress(
                    step=step, retry=retries_this_step,
                    lam=f"{lam_try:.4g}",
                    dlam=f"{new_dlam:.4g}",
                    bisected="yes",
                    reason=reason.replace(" ", "_") if reason else "?",
                )
                print(f"  [adapt] step {step}: bisect Δλ "
                      f"{dlam:.4g} → {new_dlam:.4g} (reason: {reason})",
                      flush=True)
                dlam = new_dlam
                consec_ok = 0
                continue
            accepted = True

        if not accepted:
            if halted_reason is None:
                halted_reason = (f"exhausted {max_retries} retries at step {step} "
                                 f"(λ_target ≈ {lam_try:.4f})")
            print(f"  [halt] {halted_reason}", flush=True)
            break

        # Accepted: commit the step + emit progress.
        lam = lam_try
        load_deflection.append(row)
        if is_disp_control:
            F_prev = row["F"]
            u_prev = row["u_qoi_abs"]
        consec_ok += 1
        # Grow back step size after 3 consecutive successes — cap at the
        # user's maxIncrement (NOT the initial value), so the walker can
        # actually accelerate beyond the start size when the path is
        # stable. This is the ABAQUS *AUTOMATIC behaviour.
        if consec_ok >= 3 and dlam < d_max:
            new_dlam = min(dlam * 1.5, d_max)
            if new_dlam > dlam:
                print(f"  [adapt] step {step}: grow Δλ "
                      f"{dlam:.4g} → {new_dlam:.4g} (3 consec ok, cap {d_max:g})",
                      flush=True)
            dlam = new_dlam
            consec_ok = 0

        # Live-monitor row. `of` field reports the maxIncrements cap (so
        # the monitor reads "step 7 / 100"); the actual progress is
        # better tracked by λ (= load fraction) which is on the chart's
        # F-axis anyway.
        _progress(
            step=step, **{"of": max_attempts},
            loadFactor=f"{row['loadFactor']:.6g}",
            dlam=f"{dlam:.4g}",
            F=f"{row['F']:.6g}",
            u_qoi=f"{row['u_qoi']:.6g}",
            nrIter=row["nrIter"],
            innerSolves=row["innerSolves"],
            dofs=row["dofs"] if row["dofs"] else "?",
            control=control_mode,
            solver=solver_tag,
        )

    if not args.keep_xml:
        try: (work_dir / "input.xml").unlink()
        except OSError: pass

    _phase("verdict")
    if not load_deflection:
        # No step at all converged — this should be impossible since
        # step 1 with dlam=1/N is essentially LSA-sized; if even that
        # diverges the model is fundamentally unsolvable.
        raise SystemExit("no step converged — model produces NaN at the smallest "
                         "load increment")
    finest = load_deflection[-1]
    final_lam = finest["loadFactor"]
    print()
    print("=" * 70)
    print("Verdict")
    print("=" * 70)
    print(f"Steps converged : {len(load_deflection)} (attempt cap {max_attempts})")
    print(f"Final λ         : {final_lam:.4f}  ({final_lam * 100:.1f} %)")
    if halted_reason:
        print(f"HALTED EARLY    : {halted_reason}")
    if retries_log:
        print(f"Bisection retries: {len(retries_log)} total")
    print(f"Final load F    : {finest['F']:.6g}")
    print(f"Final u_qoi     : {finest['u_qoi']:+.8f}  (|u| = {finest['u_qoi_abs']:.8f})")
    print()
    if len(load_deflection) > 1:
        print("Load-deflection table:")
        print(f"  {'step':>4}  {'F':>12}  {'u_qoi':>14}  {'nrIter':>6}")
        for r in load_deflection:
            print(f"  {r['step']:>4}  {r['F']:>12.6g}  {r['u_qoi']:>+14.8f}  "
                  f"{r['nrIter']:>6}")

    _write_sidecar(work_dir, model, load_deflection,
                   refinement=refinement, threads=args.threads,
                   analysis_kind=kind,
                   halted_reason=halted_reason,
                   retries_log=retries_log)
    print(f"\nSidecar manifest written: {work_dir}/run.json")
    _phase("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
