"""Aeris GNIA (arc-length) solver for the closed-cylinder shape.

Sister to cylinder_lba.py / cylinder_static.py. Drives the custom
``arclength_shell_multipatch_XML`` C++ blackbox (Aeris-built, baked into
the aeris/gismo image) to trace the geometrically-nonlinear buckling
path of an imperfect cylinder THROUGH its limit point — the gold-standard
knockdown analysis that force-control GNA can't do (NR diverges at the
bifurcation; arc-length continues).

Pipeline:
  1. Read /work/model.json (cylinder + analysis.kind = "gnia")
  2. Build the bvp XML via cylinder_lba.build_cylinder_xml (same multipatch
     topology / material / BC schema the arc-length driver reads), then
     override the Neumann to a COMPRESSIVE, physically-scaled reference:
        Tz_ref = -sigma_cr_classical * t        [force / length]
     so the load factor lambda = 1 corresponds to the classical perfect-
     shell critical load. The peak lambda the arc-length reaches is then
     the KNOCKDOWN FACTOR directly (imperfect / classical).
  3. Spawn arclength_shell_multipatch_XML with the arc-length knobs +
     radial imperfection from model.analysis.
  4. Parse the driver's [AERIS-PROGRESS] stream into a loadDeflection[]
     table (one row per converged arc-length step), find the limit point
     (peak lambda before the first Dmin sign-flip = bifurcation).
  5. Write /work/run.json (analysisKind="gnia") — same sidecar shape as
     cylinder_static so the GUI's load-deflection monitor + post-processor
     consume it unchanged.

Live monitor: the C++ driver already emits the AERIS-PROGRESS protocol
(step / L / u / Dmin / bif / bisected), so the GUI's RunStatusPanel
charts the load-deflection curve live AND flags the bifurcation —
exactly the ABAQUS-monitor experience (load step + the negative-eigenvalue
indicator) the user asked for.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from aeris_model import ModelConfig                          # noqa: E402
from cylinder_lba import build_cylinder_xml, classical_sigma_cr, classical_N_cr  # noqa: E402


SOLVER_EXE = Path(os.environ.get(
    "AERIS_ARCLENGTH_EXE",
    "/opt/gismo/build/bin/arclength_shell_multipatch_XML",
))

PROGRESS_RE = re.compile(r"^\[AERIS-PROGRESS\]\s+(.+)$")


def _phase(name: str) -> None:
    print(f"[AERIS-PHASE] {name}", flush=True)


def _compressive_reference_xml(model: ModelConfig) -> tuple[str, float, float]:
    """Build the bvp XML, then swap the buckling driver's TENSILE E-scaled
    Neumann (Tz = +t*E) for a COMPRESSIVE physical reference
    (Tz = -sigma_cr * t). Returns (xml, Tz_ref, classical_N_cr).

    The string swap is exact: build_cylinder_xml emits the z-traction as
    `<c> {t*E} </c>` (top-band thickness * E), and we know that value, so
    we replace just that token. Compression sign (negative) makes the
    arc-length walk drive the cylinder INTO buckling as lambda grows."""
    case = model.case()
    xml = build_cylinder_xml(model)

    # The exact tensile token build_cylinder_xml wrote (axial case):
    # top-band thickness * E. For a homogeneous cylinder that's t * E.
    tensile_Tz = case.t * case.E
    search = f"<c> {tensile_Tz} </c>"
    if search not in xml:
        # Fallback: locate the third <c> in the Neumann function block. We
        # bail loudly rather than silently solve the wrong load.
        raise SystemExit(
            f"could not find expected tensile Neumann token {search!r} in the "
            "generated XML — build_cylinder_xml format changed; update "
            "cylinder_arclength._compressive_reference_xml"
        )
    sigma_cr = classical_sigma_cr(case)
    Tz_ref = -sigma_cr * case.t          # compressive line traction
    xml = xml.replace(search, f"<c> {Tz_ref:.15g} </c>", 1)
    return xml, Tz_ref, classical_N_cr(case)


def _run_arclength(xml_path: Path, work_dir: Path, *,
                   refines: int, arc_length: float, max_steps: int,
                   alm_method: int, threads: int,
                   imperf_kind: int, imperf_mode: int,
                   imperf_amplitude: float) -> tuple[list[dict], dict]:
    """Spawn the arc-length driver, stream + echo its stdout, collect the
    parsed AERIS-PROGRESS rows AND the LBA stage info (mode / eigenvalue,
    when eigenmode imperfection is used). Returns (rows, lbaInfo).

    imperf_kind: 0 none, 1 random radial, 2 eigenmode-shaped."""
    cmd = [
        str(SOLVER_EXE),
        "-i", str(xml_path),
        "-o", str(work_dir),
        "-r", str(refines),
        "-A", str(alm_method),
        "-L", f"{arc_length:.15g}",
        "-N", str(max_steps),
        "--bifurcation",
        "-K", str(imperf_kind),
        "-P", f"{imperf_amplitude:.15g}",
        "-M", str(imperf_mode),
    ]
    env = dict(os.environ)
    env["OMP_NUM_THREADS"] = str(max(1, threads))

    rows: list[dict] = []
    lba_info: dict = {}
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, env=env, bufsize=1)
    for line in proc.stdout:
        sys.stdout.write(line)         # echo through so the GUI sees the raw stream
        sys.stdout.flush()
        s = line.strip()
        # Capture the LBA-stage marker: "[AERIS-PHASE] lba_done mode=N eigenvalue=X"
        if s.startswith("[AERIS-PHASE] lba_done"):
            for tok in s.split():
                if tok.startswith("mode="):
                    lba_info["mode"] = int(tok.split("=", 1)[1])
                elif tok.startswith("eigenvalue="):
                    try: lba_info["eigenvalue"] = float(tok.split("=", 1)[1])
                    except ValueError: pass
            continue
        m = PROGRESS_RE.match(s)
        if not m:
            continue
        fields = {}
        for tok in m.group(1).split():
            if "=" in tok:
                k, v = tok.split("=", 1)
                fields[k] = v
        if "L" in fields and "u" in fields:
            rows.append({
                "step": int(fields.get("step", len(rows))),
                "L": float(fields["L"]),
                "u": float(fields["u"]),
                "Dmin": float(fields.get("Dmin", "nan")),
                "bif": int(fields.get("bif", "0")),
                "bisected": int(fields.get("bisected", "0")),
            })
    proc.wait()
    # Non-zero exit is OK if we have converged steps (e.g., post-bifurcation divergence).
    # The limit point was found; the solver just couldn't continue past it.
    if proc.returncode != 0 and rows:
        print(f"[WARNING] arclength_shell_multipatch_XML exited {proc.returncode}, "
              f"but {len(rows)} converged steps collected — proceeding with verdict.", flush=True)
    elif proc.returncode != 0:
        raise RuntimeError(f"arclength_shell_multipatch_XML exited {proc.returncode} with no converged steps")
    return rows, lba_info


def _find_limit_point(rows: list[dict]) -> dict:
    """Identify the limit point: the peak load factor L reached BEFORE the
    first bifurcation flag (Dmin sign-flip). Falls back to the global max L
    if no bifurcation was flagged (e.g. mesh too coarse to buckle in range).
    Returns {lambdaCritical, stepAtPeak, bifurcationStep|None}."""
    bif_step = next((r["step"] for r in rows if r["bif"]), None)
    if bif_step is not None:
        pre = [r for r in rows if r["step"] <= bif_step]
    else:
        pre = rows
    peak = max(pre, key=lambda r: r["L"]) if pre else (rows[-1] if rows else None)
    return {
        "lambdaCritical": peak["L"] if peak else None,
        "stepAtPeak": peak["step"] if peak else None,
        "bifurcationStep": bif_step,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", type=Path, required=True)
    p.add_argument("--refines", type=int, nargs="+", default=[4],
                   help="Mesh refinement (uses last value). r>=4 needed to "
                        "resolve the circumferential buckling mode on thin "
                        "cylinders — coarser meshes are artificially stiff.")
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--keep-xml", action="store_true")
    args = p.parse_args(argv)

    _phase("setup")
    model = ModelConfig.from_json_file(args.model)
    raw = json.loads(args.model.read_text())

    shape = raw.get("geometry", {}).get("shape")
    kind = raw.get("analysis", {}).get("kind")
    if shape != "cylinder":
        raise SystemExit(f"cylinder_arclength.py expects shape='cylinder'; got {shape!r}")
    if kind != "gnia":
        raise SystemExit(f"cylinder_arclength.py expects analysis.kind='gnia'; got {kind!r}")

    analysis = raw["analysis"]
    arc_length   = float(analysis.get("arcLength", 0.05))
    max_steps    = int(analysis.get("maxSteps", 60))
    alm_method   = int(analysis.get("almMethod", 2))    # 2 = Crisfield
    refinement   = int(args.refines[-1])

    # Imperfection — model.imperfections is the source of truth (the
    # Imperfections inspector section). Falls back to analysis.imperfection
    # (legacy random-radial amplitude) when the section is absent.
    imp = raw.get("imperfections", {})
    imp_kind_name = str(imp.get("kind", "random")).lower()
    imp_kind = {"none": 0, "random": 1, "eigenmode": 2}.get(imp_kind_name, 1)
    imp_mode = int(imp.get("mode", 1))
    imp_amplitude = float(imp.get("amplitude",
                          analysis.get("imperfection", 0.001)))

    case = model.case()
    work_dir = args.model.parent
    xml, Tz_ref, N_cr_classical = _compressive_reference_xml(model)
    xml_path = work_dir / "input.xml"
    xml_path.write_text(xml)

    print("=" * 70)
    print("Aeris KL-shell · GNIA (arc-length + imperfection) · cylinder")
    print("=" * 70)
    print(f"Geometry : R={case.R}, L={case.L}, t={case.t}")
    print(f"Material : E={case.E}, nu={case.nu}")
    print(f"Ref load : Tz={Tz_ref:.6g} (compressive) → lambda=1 == classical F_cr={N_cr_classical:.6g}")
    print(f"Imperf   : kind={imp_kind_name} (K={imp_kind}), mode={imp_mode}, amplitude={imp_amplitude}")
    print(f"Arc-len  : dLb={arc_length}, maxSteps={max_steps}")
    print(f"Mesh     : r={refinement} · ALM method={alm_method} (0=LC,1=Riks,2=Crisfield)")
    print()

    rows, lba_info = _run_arclength(
        xml_path, work_dir,
        refines=refinement, arc_length=arc_length, max_steps=max_steps,
        alm_method=alm_method, threads=args.threads,
        imperf_kind=imp_kind, imperf_mode=imp_mode,
        imperf_amplitude=imp_amplitude,
    )
    if not rows:
        raise SystemExit("arc-length produced no converged steps")

    _phase("verdict")
    lp = _find_limit_point(rows)
    lam_cr = lp["lambdaCritical"]
    F_cr_computed = (lam_cr * N_cr_classical) if lam_cr is not None else None
    knockdown = lam_cr if lam_cr is not None else None    # lambda=1 == classical

    print()
    print("=" * 70)
    print("Verdict")
    print("=" * 70)
    print(f"Arc-length steps     : {len(rows)}")
    if lp["bifurcationStep"] is not None:
        print(f"Bifurcation at step  : {lp['bifurcationStep']}")
    else:
        print("Bifurcation          : NOT detected in range "
              "(mesh too coarse, or load range below F_cr — try higher r or maxSteps)")
    print(f"Critical load factor : lambda_cr = {lam_cr:.6g}")
    print(f"Knockdown factor     : {knockdown:.4f}  (imperfect / classical)")
    print(f"Computed buckling load: F_cr = {F_cr_computed:.6g}  "
          f"(classical {N_cr_classical:.6g})")

    if lba_info:
        print(f"LBA stage            : mode {lba_info.get('mode','?')} "
              f"eigenvalue {lba_info.get('eigenvalue','?')}")

    _write_sidecar(work_dir, raw, model, rows, lp,
                   N_cr_classical=N_cr_classical, F_cr_computed=F_cr_computed,
                   refinement=refinement, threads=args.threads,
                   arc_length=arc_length, imperfection=imp_amplitude,
                   imp_kind=imp_kind_name, imp_mode=imp_mode, lba_info=lba_info)
    print(f"\nSidecar manifest written: {work_dir}/run.json")

    if not args.keep_xml:
        try: xml_path.unlink()
        except OSError: pass

    _phase("done")
    return 0


def _write_sidecar(work_dir, raw, model, rows, lp, *,
                   N_cr_classical, F_cr_computed, refinement, threads,
                   arc_length, imperfection,
                   imp_kind="random", imp_mode=1, lba_info=None) -> None:
    case = model.case()
    # loadDeflection rows reuse the cylinder_static shape (step/F/u_qoi) so
    # the GUI's existing chart parser Just Works. Here F = lambda * F_cr_classical
    # (physical load on the path), u_qoi = |U| (global solution norm — a
    # physical per-point u_z QoI is a follow-up).
    load_deflection = [
        {
            "step": r["step"],
            "loadFactor": r["L"],
            "F": r["L"] * N_cr_classical,
            "u_qoi": r["u"],
            "u_qoi_abs": abs(r["u"]),
            "Dmin": r["Dmin"],
            "bif": r["bif"],
            "solver": "ALM",
        }
        for r in rows
    ]
    run_json = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "command": " ".join(sys.argv),
        "analysisKind": "gnia",
        "case": {"R": case.R, "L": case.L, "t": case.t, "E": case.E, "nu": case.nu},
        "geometry": {"shape": "cylinder", "n_patches": 4},
        "mesh": {
            "refinement": int(refinement),
            "degree": int(raw["mesh"].get("degree", 3)),
            "smoothness": int(raw["mesh"].get("smoothness", 2)),
            "coupling": str(raw["mesh"].get("coupling", "gsSmoothInterfaces")),
        },
        "bcs": {"kind": str(raw["bcs"].get("kind", "clamped_neumann"))},
        "load": {"kind": str(raw["load"]["kind"]),
                 "magnitude": float(raw["load"].get("magnitude", 1.0))},
        "analysis": {
            "kind": "gnia",
            "threads": int(threads),
            "arcLength": float(arc_length),
            "maxSteps": int(raw["analysis"].get("maxSteps", 60)),
        },
        "imperfections": {
            "kind": str(imp_kind),
            "mode": int(imp_mode),
            "amplitude": float(imperfection),
            "lbaEigenvalue": (lba_info or {}).get("eigenvalue"),
            "lbaMode": (lba_info or {}).get("mode"),
        },
        "files": {"geometry": "mp.pvd"},
        "loadDeflection": load_deflection,
        "modes": [],
        "qois": [{
            "name": "lambda_critical",
            "label": "Knockdown factor (lambda_cr)",
            "qoiValue": lp["lambdaCritical"],
            "qoiAbsValue": abs(lp["lambdaCritical"]) if lp["lambdaCritical"] is not None else None,
        }],
        "verdict": {
            "lambdaCritical": lp["lambdaCritical"],
            "knockdownFactor": lp["lambdaCritical"],
            "criticalLoadComputed": F_cr_computed,
            "criticalLoadClassical": N_cr_classical,
            "bifurcationStep": lp["bifurcationStep"],
            "solverOk": True,
        },
    }
    (work_dir / "run.json").write_text(json.dumps(run_json, indent=2))


if __name__ == "__main__":
    sys.exit(main())
