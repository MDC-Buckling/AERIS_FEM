"""Aeris static solver for MacNeal-Harder pinched cylinder benchmark.

Closed cylinder with two opposing point loads at mid-span (z = L/2).
Reference: |u| = 1.8248e-5 at the load (KL shell).

Geometry: 4-patch closed cylinder (same as cylinder_lba.py)
Loads: Two concentrated point loads at opposite sides, mid-height.
Analysis: static (linear) or gna (nonlinear with NR iteration).
QoI: |u| = sqrt(u_x² + u_y² + u_z²) at one load point.
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

sys.path.insert(0, str(Path(__file__).parent))
from cylinder_lba import (
    Case,
    _quarter_geometry,
    _material_xml,
    COUPLING_METHOD,
    SMOOTH_METHOD, SMOOTH_DEGREE, SMOOTH_SMOOTHNESS,
)

sys.path.insert(0, "/benchmarks")
from common.vts import parse_vts


SOLVER_EXE = Path(os.environ.get(
    "AERIS_STATIC_MULTIPATCH_EXE",
    "/opt/gismo/build/bin/static_shell_multipatch_XML",
))


def _phase(name: str) -> None:
    print(f"[AERIS-PHASE] {name}", flush=True)


def _progress(**fields) -> None:
    parts = [f"{k}={v}" for k, v in fields.items()]
    print(f"[AERIS-PROGRESS] {' '.join(parts)}", flush=True)


def _model_to_case(model: dict) -> Case:
    cyl = model["geometry"]["cylinder"]
    mat = model["materials"][0]
    return Case(
        R=float(cyl["R"]), L=float(cyl["L"]), t=float(cyl["t"]),
        E=float(mat["E"]), nu=float(mat["nu"]),
    )


def _bands_from_model(model: dict) -> list[tuple[float, float]]:
    cyl = model["geometry"]["cylinder"]
    L = float(cyl["L"])
    partitions = sorted(float(p["z"]) for p in (cyl.get("partitions") or []))
    if not partitions:
        return [(0.0, L)]
    edges = [0.0, *partitions, L]
    return list(zip(edges[:-1], edges[1:]))


def build_pinched_cylinder_xml(model: dict, load_factor: float = 1.0) -> str:
    """Build XML for pinched cylinder with two opposing point loads at mid-span.

    Pinched cylinder: closed 4-patch cylinder with two concentrated loads
    at z = L/2 on opposite sides (±y direction). The loads are applied
    at parametric (u=0.5, v=0.5) on patches 0 and 2 (the +x and -x
    quadrants), which map to (R, 0, L/2) and (-R, 0, L/2) physically.
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

    material = _material_xml(case, mat_id=10, thickness=case.t)

    # Pinched cylinder: load.kind must be "point_load"
    load_kind = model["load"].get("kind", "point_load")
    if load_kind != "point_load":
        raise SystemExit(
            f"pinched_cylinder_static.py: expected load.kind='point_load', "
            f"got '{load_kind}'"
        )

    F_user = float(model["load"].get("magnitude", 1.0))
    F = F_user * float(load_factor)

    # Zero BCs (only point loads, no distributed edge tractions)
    bcs = f"""<boundaryConditions id="20" multipatch="0">
  <Function type="FunctionExpr" dim="3" index="0">
  <c> 0 </c>
  <c> 0 </c>
  <c> 0 </c>
  </Function>

  <bc type="Dirichlet" function="0" unknown="0" component="-1">
"""
    for q in range(4):
        bcs += f"    {q} 3\n"
    bcs += f"  </bc>\n"
    bcs += f"  <bc type=\"Clamped\" function=\"0\" unknown=\"0\" component=\"2\">\n"
    for q in range(4):
        bcs += f"    {q} 3\n"
    bcs += """  </bc>
</boundaryConditions>"""

    # Point loads: two opposing loads at mid-span (z = L/2).
    # Patch 0 (quadrant +x+y): (u=0.5, v=0.5) → physical (R, 0, L/2)
    # Patch 2 (quadrant -x-y): (u=0.5, v=0.5) → physical (-R, 0, L/2)
    # Load direction: Fy (perpendicular to z-axis, loading in ±y).
    # Two opposite loads: +F and -F so the cylinder pinches.
    point_loads = (
        f'<Matrix rows="2" cols="2" id="30" tag="Loads">\n'
        f'0.5 0.5\n'
        f'0.5 0.5\n'
        f'</Matrix>\n'
        f'<Matrix rows="3" cols="2" id="31" tag="Loads">\n'
        f'0 0\n'
        f'{F:.15g} {-F:.15g}\n'
        f'0 0\n'
        f'</Matrix>\n'
        f'<Matrix rows="2" cols="2" id="32" tag="Loads">\n'
        f'0 2\n'
        f'0 2\n'
        f'</Matrix>'
    )

    loads = f"""<Function type="FunctionExpr" id="21" tag="Loads" dim="3">
  <c> 0 </c>
  <c> 0 </c>
  <c> 0 </c>
</Function>
<Function type="FunctionExpr" id="22" tag="Loads" dim="3">0</Function>

{point_loads}"""

    # Reference point: same as cylinder_static (mid-top of patch 0)
    refs = """<Matrix rows="2" cols="1" id="50" >
0.5
1.0
</Matrix>
<Matrix rows="1" cols="1" id="51" >0</Matrix>
<Matrix rows="0" cols="0" id="52" ></Matrix>"""

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

DOF_LINE = re.compile(r"size=(\d+)")
NR_ITER_LINE = re.compile(r"\bIter\s*=?\s*(\d+)\b", re.IGNORECASE)


def _run_solver(xml_path: Path, work_dir: Path, refines: int,
                degree: int, smoothness: int, method: int,
                threads: int, nonlinear: bool,
                gna_solver: str = "newton") -> dict:
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
                dofs = int(m.group(1)) * 4 * 3
        m = NR_ITER_LINE.search(line)
        if m:
            nr_iter = max(nr_iter or 0, int(m.group(1)))
    return {"dofs": dofs, "nrIter": nr_iter}


def _extract_qoi(work_dir: Path, R: float, L: float) -> dict:
    """Extract |u| = sqrt(u_x² + u_y² + u_z²) at the load point.

    Pinched cylinder load point: parametric (0.5, 0.5) on patch 0,
    physical (R, 0, L/2).
    """
    candidates = ["solution_0.vts", "solution0.vts"]
    vts_path = next((work_dir / c for c in candidates
                     if (work_dir / c).exists()), None)
    if vts_path is None:
        raise RuntimeError(
            f"no solution .vts found in {work_dir} "
            f"(tried: {', '.join(candidates)})"
        )
    vts = parse_vts(vts_path)
    pos, disp = vts.point_at_param(0.5, 0.5)
    if vts.field_components < 3:
        raise RuntimeError(
            f"expected 3-component displacement, got {vts.field_components}"
        )
    u_mag = math.sqrt(sum(float(d)**2 for d in disp[:3]))
    return {
        "u_qoi": u_mag,
        "u_qoi_abs": u_mag,
        "qoi_position": [float(pos[0]), float(pos[1]), float(pos[2])],
        "qoi_name": "u_mag_load_point",
        "qoi_label": "|u| at load point",
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Aeris static solver for MacNeal-Harder pinched cylinder"
    )
    parser.add_argument("--model", type=Path, required=True,
                        help="model.json path")
    parser.add_argument("--work-dir", type=Path, required=True,
                        help="output directory")
    parser.add_argument("--refines", type=int, default=5,
                        help="mesh refinement level (default 5)")
    parser.add_argument("--threads", type=int, default=1,
                        help="OMP threads (default 1)")
    parser.add_argument("--convergence-refines", type=str, default="",
                        help="comma-separated r values for convergence sweep")
    parser.add_argument("--gna-solver", type=str, default="newton",
                        choices=["newton", "dr"],
                        help="GNA solver method (default newton)")
    args = parser.parse_args()

    args.work_dir.mkdir(parents=True, exist_ok=True)

    with open(args.model) as f:
        model = json.load(f)

    analysis_kind = model["analysis"].get("kind", "static")
    refines = int(args.refines)
    degree = int(model["mesh"].get("degree", 3))
    smoothness = int(model["mesh"].get("smoothness", 2))
    coupling = str(model["mesh"].get("coupling", "gsSmoothInterfaces"))
    method = {"gsSmoothInterfaces": 0, "gsAlmostC1": 1}.get(coupling, 0)

    case = _model_to_case(model)

    # Single-run static or multi-step GNA
    if analysis_kind == "static":
        _phase("solving_step_1")
        xml_path = args.work_dir / "input.xml"
        xml_path.write_text(build_pinched_cylinder_xml(model, load_factor=1.0))
        solver_info = _run_solver(
            xml_path, args.work_dir, refines, degree, smoothness, method,
            args.threads, nonlinear=False
        )
        qoi_data = _extract_qoi(args.work_dir, case.R, case.L)
        load_deflection = [{
            "loadFactor": 1.0,
            "u_qoi": qoi_data["u_qoi"],
            "u_qoi_abs": qoi_data["u_qoi_abs"],
            **solver_info,
        }]

    elif analysis_kind == "gna":
        # Nonlinear GNA sweep: ramp force from 0 to 1 in N steps
        n_steps = 5
        load_deflection = []
        for step_k in range(1, n_steps + 1):
            load_factor = float(step_k) / float(n_steps)
            _phase(f"solving_step_{step_k}")
            xml_path = args.work_dir / f"input_step_{step_k}.xml"
            xml_path.write_text(
                build_pinched_cylinder_xml(model, load_factor=load_factor)
            )
            solver_info = _run_solver(
                xml_path, args.work_dir, refines, degree, smoothness, method,
                args.threads, nonlinear=True, gna_solver=args.gna_solver
            )
            qoi_data = _extract_qoi(args.work_dir, case.R, case.L)
            _progress(
                step=step_k,
                of=n_steps,
                loadFactor=f"{load_factor:.3f}",
                F=f"{float(model['load'].get('magnitude', 1.0)) * load_factor:.3f}",
                u_qoi=f"{qoi_data['u_qoi']:.6e}",
                **solver_info,
            )
            load_deflection.append({
                "loadFactor": load_factor,
                "u_qoi": qoi_data["u_qoi"],
                "u_qoi_abs": qoi_data["u_qoi_abs"],
                **solver_info,
            })

    else:
        raise SystemExit(f"unsupported analysis.kind: {analysis_kind}")

    # Write sidecar
    finest = load_deflection[-1]
    case_dict = {
        "R": case.R, "L": case.L, "t": case.t,
        "E": case.E, "nu": case.nu,
    }
    run_json = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "analysisKind": analysis_kind,
        "case": case_dict,
        "geometry": {
            "shape": "cylinder",
            "n_patches": 4 * len(_bands_from_model(model)),
            "n_bands": len(_bands_from_model(model)),
        },
        "mesh": {
            "refinement": int(refines),
            "degree": int(degree),
            "smoothness": int(smoothness),
            "coupling": coupling,
        },
        "load": {
            "kind": str(model["load"].get("kind", "point_load")),
            "magnitude": float(model["load"].get("magnitude", 1.0)),
        },
        "qois": [{
            "qoiValue": finest["u_qoi"],
            "qoiAbsValue": finest["u_qoi_abs"],
            "qoiName": "u_mag_load_point",
            "qoiLabel": "|u| at load point",
        }],
        "loadDeflection": load_deflection,
        "convergence": [],
    }

    sidecar_path = args.work_dir / "run.json"
    with open(sidecar_path, "w") as f:
        json.dump(run_json, f, indent=2)

    print(f"\n[AERIS-DONE] run.json written to {sidecar_path}")


if __name__ == "__main__":
    main()
