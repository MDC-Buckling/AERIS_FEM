"""Scordelis-Lo roof — MULTIPATCH static linear KL-shell benchmark.

Phase-0 gate for the Bernstein-Bezier triangle programme: the BB path
leans on the same seam (gsThinShellAssembler + a gsMappedBasis +
moment transfer across patch interfaces) that today is validated ONLY
under buckling pre-stress (cylinder LBA, +-1 %), NOT under pure static
bending. The single-patch Scordelis-Lo (benchmarks/scordelis_lo/)
PASSES at 0.031 %, but by construction it has no seam. This benchmark
adds the seam and asks: does gsSmoothInterfaces transfer bending moment
correctly across it under a static gravity load?

Same problem as the single-patch case (identical geometry, material,
load, BCs, reference value) — the ONLY change is that the roof is built
as TWO patches with an internal interface, coupled to a globally smooth
basis by `static_shell_multipatch_XML -m 0` (gsSmoothInterfaces).

Seam placement (the one design choice):
  - Split along the LENGTH (x / u-direction) at x = L/3.
  - x = L/3 is deliberately OFF the symmetry plane x = L/2. The barrel
    vault spans L between the two end diaphragms, so the longitudinal
    bending moment M_x is non-zero at x = L/3 and the longitudinal slope
    dw/dx is non-zero there (at x = L/2 it would be zero by symmetry —
    a seam there could mask a lost-continuity hinge). So a C0-hinge
    failure cannot hide behind symmetry.
  - The QoI (free-edge midpoint at x = L/2) stays INTERIOR to patch 1,
    not on the seam.
  - The x-direction is polynomial (the NURBS weights live only in the
    arc direction), so splitting it at u = 1/3 is an EXACT de-Casteljau
    subdivision — no geometry-construction risk to be mistaken for a
    coupling bug. A circumferential (arc-direction) split is the natural
    stronger follow-up; see README.

Geometry / material / load / BCs / reference: identical to
benchmarks/scordelis_lo/ (see that README for provenance).

Reference value: |u_z| = 0.3006 for a SHEAR-RIGID (Kirchhoff-Love)
shell at the free-edge midpoint. PASS = within 2 % AND converging to
it, AND no kink at the seam.

Usage:
  python3 scordelis_lo_multipatch.py                # sweep -r in {2..5}
  python3 scordelis_lo_multipatch.py --quick        # single -r 3
  python3 scordelis_lo_multipatch.py -r 4 -r 5      # explicit list
  python3 scordelis_lo_multipatch.py --keep --verbose
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

from common.solver import run_solver, verdict        # noqa: E402
from common.vts import parse_vts                      # noqa: E402


# ----- Reference values + tolerances ---------------------------------------

REFERENCE_UZ_KL = 0.3006          # KL shell (shear-rigid) — our case
REFERENCE_UZ_RM = 0.3024          # Reissner-Mindlin (shear-deformable) — NOT us
TOLERANCE_PCT = 2.0


# ----- Problem parameters (identical to single-patch Scordelis-Lo) ---------

R = 25.0
L = 50.0
THICK = 0.25
PHI_DEG = 40.0
E_MOD = 4.32e8
NU = 0.0
SURFACE_FORCE = (0.0, 0.0, -90.0)    # (Fx, Fy, Fz) per unit area

# Seam location as a fraction of the length, measured from x=0. 1/3 puts
# the seam off the x=L/2 symmetry plane (see module docstring).
SPLIT_FRACTION = 1.0 / 3.0

SMOOTH_METHOD = 0     # 0 = gsSmoothInterfaces (regular topology, NURBS-safe)
DEGREE_ELEVATE = 1    # native degree 2 -> degree 3, mirrors the validated
                      # cylinder-LBA smooth-basis setup (-p 3)


# ----- Geometry: two length-split patches sharing the arc cross-section ----

def _arc_rows() -> list[tuple[float, float, float]]:
    """The three arc control points (y, z, weight) of the biquadratic
    NURBS cross-section, in v-order (v=0 -> v=1). Identical to the
    single-patch case: endpoints at the two eaves (z=0), middle CP
    lifted with weight cos(phi). v=1 row is the QoI eave."""
    phi = math.radians(PHI_DEG)
    sphi = math.sin(phi)
    cphi = math.cos(phi)
    return [
        (0.0, 0.0, 1.0),                                   # v=0 eave
        (-R * sphi, R * sphi * math.tan(phi), cphi),       # v=0.5 apex CP
        (-2.0 * R * sphi, 0.0, 1.0),                       # v=1 eave (QoI)
    ]


def _x_cps_split(split_frac: float) -> tuple[list[float], list[float]]:
    """Exact de-Casteljau subdivision of the degree-2 x-direction Bezier
    (control points 0, L/2, L; represents x(u)=u*L) at u = split_frac.
    Returns (left_x_cps, right_x_cps), each a 3-list of x control points.

    Left patch covers x in [0, split_frac*L]; right covers the rest."""
    t = split_frac
    q0, q1, q2 = 0.0, L / 2.0, L
    r0 = (1 - t) * q0 + t * q1
    r1 = (1 - t) * q1 + t * q2
    s0 = (1 - t) * r0 + t * r1
    left = [q0, r0, s0]        # x: 0 .. split_frac*L
    right = [s0, r1, q2]       # x: split_frac*L .. L
    return left, right


def _patch_geometry(patch_id: int, x_cps: list[float]) -> str:
    """One biquadratic-NURBS patch: the shared arc cross-section extruded
    over the given three x control points. Coefs are emitted v-slowest /
    u-fastest, matching the single-patch convention so QoI parametric
    points carry over unchanged."""
    rows = _arc_rows()
    coef_lines = []
    weight_vals = []
    for (y, z, w) in rows:
        for x in x_cps:
            coef_lines.append(f"{x:.15g} {y:.15g} {z:.15g}")
            weight_vals.append(w)             # weight depends on arc row only
    coefs = "\n    ".join(coef_lines)
    weights = " ".join(f"{w:.15g}" for w in weight_vals)
    return f"""<Geometry type="TensorNurbs2" id="{patch_id}">
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


# ----- XML builder --------------------------------------------------------

def build_input_xml() -> str:
    """Two-patch bvp XML for static_shell_multipatch_XML.

      id=0    MultiPatch (2 patches, 1 interface, boundary edges)
      id=10   MaterialMatrix (Linear3 = SvK linear, E + nu)
      id=20   boundaryConditions (diaphragms + corner pin)
      id=21   surface force (gravity)
      id=22   pressure (zero)
      id=9991 patch 0 geometry (x in [0, L/3])
      id=9992 patch 1 geometry (x in [L/3, L])  <- carries the QoI

    Topology:
      - patches 0 and 1 share patch0 EAST (side 2, u=1) <-> patch1 WEST
        (side 1, u=0). Same orientation as the cylinder theta-seams.
      - Diaphragm ends: patch0 WEST (side 1, x=0) and patch1 EAST
        (side 2, x=L) — the two curved arcs.
      - Free eaves: sides 3 (v=0) and 4 (v=1) of BOTH patches.
      - Corner pin at patch0 corner 1 (u=v=0, the x=0 eave corner):
        u_x = 0, removes the axial rigid-body mode the diaphragm BCs
        leave free.
    """
    left_x, right_x = _x_cps_split(SPLIT_FRACTION)
    patch0 = _patch_geometry(9991, left_x)
    patch1 = _patch_geometry(9992, right_x)

    multipatch = """<MultiPatch parDim="2" id="0">
  <patches type="id_range">9991 9992</patches>
  <interfaces>
    0 2 1 1 0 1 0 1
  </interfaces>
  <boundary>
    0 1
    0 3
    0 4
    1 2
    1 3
    1 4
  </boundary>
</MultiPatch>"""

    material = f"""<MaterialMatrix type="Linear3" id="10" TFT="false">
  <Thickness>
    <Function type="FunctionExpr" dim="3" index="0">{THICK:.15g}</Function>
  </Thickness>
  <Density>
    <Function type="FunctionExpr" dim="3" index="0">1</Function>
  </Density>
  <Parameters>
    <Function type="FunctionExpr" dim="3" index="0">{E_MOD:.15g}</Function>
    <Function type="FunctionExpr" dim="3" index="1">{NU:.15g}</Function>
  </Parameters>
</MaterialMatrix>"""

    # Diaphragm: fix u_y (comp 1) and u_z (comp 2) on the two curved ends.
    # patch0 side 1 (west, x=0) and patch1 side 2 (east, x=L). u_x free.
    bcs = """<boundaryConditions id="20" multipatch="0">
  <Function type="FunctionExpr" dim="3" index="0">
    <c>0</c>
    <c>0</c>
    <c>0</c>
  </Function>

  <!-- Diaphragm on the x=0 curved end (patch 0, west / side 1) -->
  <bc type="Dirichlet" function="0" unknown="0" component="1">
    0 1
  </bc>
  <bc type="Dirichlet" function="0" unknown="0" component="2">
    0 1
  </bc>
  <!-- Diaphragm on the x=L curved end (patch 1, east / side 2) -->
  <bc type="Dirichlet" function="0" unknown="0" component="1">
    1 2
  </bc>
  <bc type="Dirichlet" function="0" unknown="0" component="2">
    1 2
  </bc>
  <!-- Corner pin at patch0 SW (u=v=0, the x=0 eave corner): u_x = 0 -->
  <cv unknown="0" component="0" corner="1" patch="0">0.0</cv>
</boundaryConditions>"""

    fx, fy, fz = SURFACE_FORCE
    force = f"""<Function type="FunctionExpr" id="21" tag="Loads" dim="3">
  <c>{fx:.15g}</c>
  <c>{fy:.15g}</c>
  <c>{fz:.15g}</c>
</Function>"""

    pressure_fn = (
        '<Function type="FunctionExpr" id="22" tag="Loads" dim="3">0</Function>'
    )

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<xml>
{multipatch}

{patch0}

{patch1}

{material}

{bcs}

{force}

{pressure_fn}
</xml>
"""


# ----- Solve + extract ----------------------------------------------------

def _patch_vts(work_dir: Path, patch_idx: int) -> Path:
    """Locate the per-patch solution .vts. gsWriteParaview's naming has
    bitten us before (underscore vs none), so probe both spellings."""
    for name in (f"solution{patch_idx}.vts", f"solution_{patch_idx}.vts"):
        p = work_dir / name
        if p.exists():
            return p
    found = sorted(work_dir.glob("solution*.vts"))
    raise FileNotFoundError(
        f"no solution{patch_idx}.vts / solution_{patch_idx}.vts in {work_dir}; "
        f"found: {[f.name for f in found]}"
    )


def _qoi_uz(work_dir: Path) -> tuple[float, tuple[float, float, float]]:
    """u_z at the free-edge midpoint. With the x=L/3 split, x=L/2 lands at
    parametric (u=0.25, v=1) on PATCH 1. Physical target (L/2, -2R sin(phi), 0)
    = (25, -32.139..., 0), identical to the single-patch QoI."""
    vts = parse_vts(_patch_vts(work_dir, 1))
    pos, disp = vts.point_at_param(0.25, 1.0)
    if vts.field_components < 3:
        raise RuntimeError(
            f"expected 3-component displacement, got {vts.field_components} "
            f"(field {vts.field_name!r})"
        )
    return disp[2], pos


def _seam_gap(work_dir: Path) -> float | None:
    """C0-continuity sanity check at the seam: the deformed position of
    the v=1 edge endpoint shared by both patches must agree. Patch 0's
    east end at (u=1, v=1) and patch 1's west end at (u=0, v=1) are the
    SAME physical point (x=L/3, eave). After the solve their deformed
    positions should coincide to within the grid-sampling tolerance.
    A large gap = the basis is not even C0 across the seam. Returns the
    Euclidean gap, or None if a patch file is missing."""
    try:
        v0 = parse_vts(_patch_vts(work_dir, 0))
        v1 = parse_vts(_patch_vts(work_dir, 1))
    except FileNotFoundError:
        return None
    p0, _ = v0.point_at_param(1.0, 1.0)
    p1, _ = v1.point_at_param(0.0, 1.0)
    return math.dist(p0, p1)


def solve_one(refine: int, work_dir: Path,
              verbose: bool = False) -> tuple[float, float | None, int]:
    """Run static_shell_multipatch_XML at h-level `refine`. Returns
    (u_z at QoI, seam_gap, walltime_ms)."""
    work_dir.mkdir(parents=True, exist_ok=True)
    (work_dir / "input.xml").write_text(build_input_xml())

    import time
    t0 = time.time()
    res = run_solver(
        exe="static_shell_multipatch_XML",
        work_dir=work_dir,
        input_xml="input.xml",
        extra_args=["-r", str(refine), "-e", str(DEGREE_ELEVATE),
                    "-m", str(SMOOTH_METHOD), "--plot"],
    )
    dt_ms = int(1000 * (time.time() - t0))
    if verbose or res.returncode != 0:
        sys.stdout.write(res.stdout)
        sys.stderr.write(res.stderr)
    if res.returncode != 0:
        raise RuntimeError(
            f"static_shell_multipatch_XML exit={res.returncode} at r={refine}"
        )
    uz, _pos = _qoi_uz(work_dir)
    gap = _seam_gap(work_dir)
    return uz, gap, dt_ms


# ----- Driver -------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("-r", "--refine", type=int, action="append",
                   help="h-refinement levels to sweep (repeatable). "
                        "Default: 2 3 4 5.")
    p.add_argument("--quick", action="store_true",
                   help="single run at -r 3, skips the sweep")
    p.add_argument("--verbose", action="store_true",
                   help="echo solver stdout for each run")
    p.add_argument("--keep", action="store_true",
                   help="keep the per-refinement work folders for inspection")
    args = p.parse_args(argv)

    if args.quick:
        refines = [3]
    elif args.refine:
        refines = sorted(set(args.refine))
    else:
        refines = [2, 3, 4, 5]

    print("=" * 78)
    print("Aeris validation suite — Scordelis-Lo roof (MULTIPATCH, smooth G1)")
    print("=" * 78)
    print(f"R={R}  L={L}  t={THICK}  phi={PHI_DEG} deg")
    print(f"E={E_MOD:g}  nu={NU}  force={SURFACE_FORCE}")
    print(f"patches=2  seam at x={SPLIT_FRACTION * L:.4f} (x/L={SPLIT_FRACTION:.4f}, "
          f"off symmetry plane L/2={L / 2:.1f})")
    print(f"coupling=gsSmoothInterfaces (-m {SMOOTH_METHOD})  "
          f"degreeElevate=-e {DEGREE_ELEVATE} (-> degree 3)")
    print(f"reference (KL shell)         u_z = {REFERENCE_UZ_KL}")
    print(f"reference (Reissner-Mindlin) u_z = {REFERENCE_UZ_RM}  (NOT our target)")
    print(f"tolerance: {TOLERANCE_PCT:.1f} % vs KL reference")
    print()
    print(f"{'r':>3}  {'|u_z|':>14}  {'rel err vs KL':>14}  {'seam gap':>12}  {'wall ms':>8}")
    print("-" * 78)

    work_root = HERE / "output"
    table: list[tuple[int, float, float, float | None, int]] = []
    for r in refines:
        wd = work_root / f"r{r}"
        try:
            uz, gap, dt = solve_one(r, wd, verbose=args.verbose)
        except (RuntimeError, FileNotFoundError) as e:
            print(f"  {r:>3}  FAILED ({e})")
            return 1
        rel_err = 100.0 * abs(abs(uz) - REFERENCE_UZ_KL) / REFERENCE_UZ_KL
        gap_str = f"{gap:.3e}" if gap is not None else "n/a"
        print(f"  {r:>3}  {abs(uz):>14.8f}  {rel_err:>+13.3f}%  {gap_str:>12}  {dt:>8d}")
        table.append((r, uz, rel_err, gap, dt))

    print()
    print("=" * 78)
    print("Verdict")
    print("=" * 78)
    if not table:
        print("FAIL — no successful refinements")
        return 2
    r_finest, uz_finest, _err, gap_finest, _dt = table[-1]
    passed, line = verdict(
        f"Scordelis-Lo MULTIPATCH |u_z| @ free-edge midpoint (r={r_finest})",
        abs(uz_finest), REFERENCE_UZ_KL, tolerance_pct=TOLERANCE_PCT,
    )
    print(line)

    # Compare against the single-patch result (0.031 % at r=6). The whole
    # point of this benchmark is that the multipatch value must AGREE with
    # the single-patch value — a divergence is the moment-transfer bug.
    print()
    print(f"Single-patch reference result: |u_z| = 0.30051 (0.031 % at r=6).")
    print(f"Multipatch must AGREE — divergence here = moment-transfer failure "
          f"across the seam.")
    if gap_finest is not None:
        if gap_finest < 1e-6 * R:
            print(f"Seam C0 gap = {gap_finest:.3e} (<< R) — patches stay joined.")
        else:
            print(f"Seam C0 gap = {gap_finest:.3e} — NON-NEGLIGIBLE; the basis "
                  f"may not be continuous across the seam (hinge).")

    if not passed:
        print()
        if abs(uz_finest) > REFERENCE_UZ_KL * 1.05:
            print("Hint: |u_z| > reference — a soft/hinge mode: bending continuity")
            print("      likely lost across the seam (the failure this test hunts).")
        elif abs(uz_finest) < REFERENCE_UZ_KL * 0.95:
            print("Hint: |u_z| < reference — over-stiffening (locking) or the seam")
            print("      coupling is artificially rigid; check convergence trend.")
        return 3

    if not args.keep:
        import shutil
        for r in refines:
            shutil.rmtree(work_root / f"r{r}", ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
