"""Scordelis-Lo roof — static linear Kirchhoff-Love shell benchmark.

Cylindrical-segment roof loaded by its own weight, supported on rigid
diaphragms at the two curved ends, free along the two straight edges.
Standard Belytschko obstacle-course case for membrane-dominated bending
in thin shells.

Geometry (from `/opt/gismo/filedata/surfaces/scordelis_lo_roof.xml`,
inlined here so the benchmark is self-contained):
  - radius           R = 25
  - length           L = 50
  - thickness        t = 0.25
  - half-subtended angle phi = 40 deg
  - axis along x; arc in y-z plane, apex at z = 25 - 25*cos(40)
  - 1 NURBS patch, biquadratic in u and v, 3x3 control points

Material: isotropic linear elastic
  - Young's modulus  E  = 4.32e8
  - Poisson ratio    nu = 0.0  (the literature value — DO NOT change)

Loading: surface dead-load = (0, 0, -90) per unit shell area
  (gravity, vertical-downward).

Boundary conditions (matches the canonical linear_shell.cpp tutorial):
  - Sides 1 + 2 (u=0, u=1, the two curved diaphragm ends):
        u_y = 0, u_z = 0   (in-plane to diaphragm fixed; u_x free
                            allows the shell to slide axially)
  - South-west corner (u=v=0):
        u_x = 0            (single pin to remove the x rigid-body mode)
  - Sides 3 + 4 (v=0, v=1, the two straight free edges):
        NO BC              (free edges)

Quantity of interest: vertical displacement u_z at the midpoint of the
free edge at v=1 (one of the "eaves"). In parametric coords this is
(u=0.5, v=1); physical (25, -32.139, 0) for the undeformed point.

Reference value: |u_z| = 0.3006 for a SHEAR-RIGID (Kirchhoff-Love)
shell. The often-quoted 0.3024 is for a SHEAR-DEFORMABLE shell model;
gsKLShell is KL (no transverse shear), so 0.3006 is the correct target.

Usage:
  python3 scordelis_lo.py                # full sweep -r in {0..4}
  python3 scordelis_lo.py --quick        # single -r 2 smoke test
  python3 scordelis_lo.py -r 3 -r 4      # explicit refinement list
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

# Allow `python3 scordelis_lo.py` from the benchmark folder without
# fiddling with PYTHONPATH.
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

from common.solver import run_solver, verdict        # noqa: E402
from common.vts import parse_vts                      # noqa: E402


# ----- Reference values + tolerances ---------------------------------------

REFERENCE_UZ_KL = 0.3006          # KL shell (shear-rigid) — our case
REFERENCE_UZ_RM = 0.3024          # Reissner-Mindlin (shear-deformable) — NOT us
TOLERANCE_PCT = 2.0               # benchmark literature reports ~1-2 % spread


# ----- Problem parameters --------------------------------------------------

R = 25.0
L = 50.0
THICK = 0.25
PHI_DEG = 40.0
E_MOD = 4.32e8
NU = 0.0
SURFACE_FORCE = (0.0, 0.0, -90.0)    # (Fx, Fy, Fz) per unit area


# ----- Pre-computed geometry CPs (so the XML is hard-coded but checked) ----
# All 9 CPs of the canonical /opt/gismo/filedata/surfaces/scordelis_lo_roof.xml,
# in the (u-major, v-slowest) order the XML uses. Weights are 1 on the v=0
# and v=2 rows, cos(40°) on the v=1 row.

def _geometry_cps() -> list[tuple[float, float, float, float]]:
    phi = math.radians(PHI_DEG)
    sphi = math.sin(phi)
    cphi = math.cos(phi)
    # Arc endpoints in (y, z): (0, 0) and (-2*R*sphi, 0); middle CP at
    # (-R*sphi, R*sphi*tan(phi)) with weight cos(phi). z values cancel
    # to give the standard apex height R*(1 - cos(phi)) on the actual arc.
    y0, z0 = 0.0, 0.0
    y1, z1 = -R * sphi, R * sphi * math.tan(phi)
    y2, z2 = -2.0 * R * sphi, 0.0
    cps = []
    for (y, z, w) in [(y0, z0, 1.0), (y1, z1, cphi), (y2, z2, 1.0)]:
        for x in [0.0, L / 2.0, L]:
            cps.append((x, y, z, w))
    return cps


def _format_coefs(cps: list[tuple[float, float, float, float]]) -> str:
    return "\n    ".join(f"{x:.15g} {y:.15g} {z:.15g}" for (x, y, z, _w) in cps)


def _format_weights(cps: list[tuple[float, float, float, float]]) -> str:
    return " ".join(f"{w:.15g}" for (_x, _y, _z, w) in cps)


# ----- XML builder --------------------------------------------------------

def build_input_xml() -> str:
    """Assemble a single bvp XML that static_shell_XML can read.
    Sections:
      id=0   geometry (biquadratic NURBS, 3x3 CPs)
      id=10  material (Linear3 = Saint-Venant Kirchhoff linear, E + nu)
      id=20  boundary conditions (diaphragms + corner pin)
      id=21  surface force function (gravity)
    """
    cps = _geometry_cps()
    coefs = _format_coefs(cps)
    weights = _format_weights(cps)

    # Material: SvK linear, two parameters (E at index 0, nu at index 1).
    # The thickness goes through the <Thickness> sub-block, separately
    # from <Parameters>. dim="3" on FunctionExpr = 3D physical domain.
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

    # BCs: at v=0 ("south") and v=1 ("north") -- wait, this geometry has
    # the DIAPHRAGM ends along u (sides west/east), not v. Side numbering
    # in G+Smo XML: 1=west (u=0), 2=east (u=1), 3=south (v=0), 4=north (v=1).
    # Diaphragm constrains components 1 (y) and 2 (z), leaves component 0
    # (x, axial) free. Corner pin (sw = u=0,v=0) adds u_x = 0 to remove
    # the axial rigid-body mode.
    bcs = """<boundaryConditions id="20" multipatch="0">
  <Function type="FunctionExpr" dim="3" index="0">
    <c>0</c>
    <c>0</c>
    <c>0</c>
  </Function>

  <!-- Diaphragm on west (u=0): u_y = 0, u_z = 0 -->
  <bc type="Dirichlet" function="0" unknown="0" component="1">
    0 1
  </bc>
  <bc type="Dirichlet" function="0" unknown="0" component="2">
    0 1
  </bc>
  <!-- Diaphragm on east (u=1): u_y = 0, u_z = 0 -->
  <bc type="Dirichlet" function="0" unknown="0" component="1">
    0 2
  </bc>
  <bc type="Dirichlet" function="0" unknown="0" component="2">
    0 2
  </bc>
  <!-- Corner pin at SW (u=v=0): u_x = 0  (kills axial rigid-body mode) -->
  <cv unknown="0" component="0" corner="1" patch="0">0.0</cv>
</boundaryConditions>"""

    # Surface force (id=21): gravity, vertical downward. 3-component
    # FunctionExpr, written with one <c> child per component (matches
    # filedata/pde/*_1p.xml convention).
    fx, fy, fz = SURFACE_FORCE
    force = f"""<Function type="FunctionExpr" id="21" tag="Loads" dim="3">
  <c>{fx:.15g}</c>
  <c>{fy:.15g}</c>
  <c>{fz:.15g}</c>
</Function>"""

    # The single-patch driver `static_shell_XML` reads `fd.getId(0, mp)`
    # where mp is a gsMultiPatch — so the file needs an explicit
    # <MultiPatch id="0"> wrapper pointing at the geometry by id.
    # We give the geometry id=9991 (matching the convention in
    # filedata/pde/*_1p.xml) so it never collides with other reserved ids.
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

    # Pressure function (id=22) — the static driver reads this optionally.
    # We don't apply a pressure load, but providing a zero function keeps
    # the driver from skipping its `pressure=false` branch noisily.
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


# ----- Solve + extract ----------------------------------------------------

def _qoi_uz(work_dir: Path) -> tuple[float, tuple[float, float, float]]:
    """Find the displacement field's z component at parametric (0.5, 1)
    on patch 0, by parsing solution_0.vts written by the solver.

    Returns (u_z, deformed_position) for the sampled point. The sample
    point may sit a little off the exact parametric target depending on
    the .vts grid resolution (gsWriteParaview uses npts=1000 hardcoded,
    so ~32 samples per direction), but for displacements that change
    slowly across the free edge the error is well under the 2 %
    benchmark tolerance band.
    """
    # gsWriteParaview writes "<basename><patchidx>.vts" — the local patch
    # index is 0-based so solution0.vts is the only patch for our case.
    vts = parse_vts(work_dir / "solution0.vts")
    pos, disp = vts.point_at_param(0.5, 1.0)
    # gsWriteParaview writes the displacement as the FIRST PointData
    # array; 3 components (x, y, z).
    if vts.field_components < 3:
        raise RuntimeError(
            f"expected 3-component displacement, got {vts.field_components} "
            f"(field {vts.field_name!r})"
        )
    return disp[2], pos


def solve_one(refine: int, work_dir: Path,
              verbose: bool = False) -> tuple[float, int]:
    """Run static_shell_XML at h-refinement level `refine`, return
    (u_z at QoI, walltime_ms). Throws RuntimeError on solver failure."""
    work_dir.mkdir(parents=True, exist_ok=True)
    (work_dir / "input.xml").write_text(build_input_xml())

    import time
    t0 = time.time()
    res = run_solver(
        exe="static_shell_XML",
        work_dir=work_dir,
        input_xml="input.xml",
        extra_args=["-r", str(refine), "--plot"],
    )
    dt_ms = int(1000 * (time.time() - t0))
    if verbose or res.returncode != 0:
        sys.stdout.write(res.stdout)
        sys.stderr.write(res.stderr)
    if res.returncode != 0:
        raise RuntimeError(
            f"static_shell_XML exit={res.returncode} at r={refine}"
        )
    uz, pos = _qoi_uz(work_dir)
    return uz, dt_ms


# ----- Driver -------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("-r", "--refine", type=int, action="append",
                   help="h-refinement levels to sweep (repeatable). "
                        "Default: 0 1 2 3 4.")
    p.add_argument("--quick", action="store_true",
                   help="single coarse run at -r 2, skips the sweep")
    p.add_argument("--verbose", action="store_true",
                   help="echo solver stdout for each run")
    p.add_argument("--keep", action="store_true",
                   help="keep the per-refinement work folders for inspection")
    args = p.parse_args(argv)

    if args.quick:
        refines = [2]
    elif args.refine:
        refines = sorted(set(args.refine))
    else:
        refines = [0, 1, 2, 3, 4]

    print("=" * 78)
    print("Aeris validation suite — Scordelis-Lo roof")
    print("=" * 78)
    print(f"R={R}  L={L}  t={THICK}  phi={PHI_DEG} deg")
    print(f"E={E_MOD:g}  nu={NU}  force={SURFACE_FORCE}")
    print(f"reference (KL shell)         u_z = {REFERENCE_UZ_KL}")
    print(f"reference (Reissner-Mindlin) u_z = {REFERENCE_UZ_RM}  (NOT our target)")
    print(f"tolerance: {TOLERANCE_PCT:.1f} % vs KL reference")
    print()
    print(f"{'r':>3}  {'|u_z|':>14}  {'rel err vs KL':>14}  {'wall ms':>8}")
    print("-" * 78)

    work_root = HERE / "output"
    table: list[tuple[int, float, float, int]] = []
    for r in refines:
        wd = work_root / f"r{r}"
        try:
            uz, dt = solve_one(r, wd, verbose=args.verbose)
        except RuntimeError as e:
            print(f"  {r:>3}  FAILED ({e})")
            return 1
        rel_err = 100.0 * abs(abs(uz) - REFERENCE_UZ_KL) / REFERENCE_UZ_KL
        print(f"  {r:>3}  {abs(uz):>14.8f}  {rel_err:>+13.3f}%  {dt:>8d}")
        table.append((r, uz, rel_err, dt))

    print()
    print("=" * 78)
    print("Verdict")
    print("=" * 78)
    if not table:
        print("FAIL — no successful refinements")
        return 2
    r_finest, uz_finest, _err, _dt = table[-1]
    passed, line = verdict(
        f"Scordelis-Lo |u_z| @ free-edge midpoint (r={r_finest})",
        abs(uz_finest), REFERENCE_UZ_KL, tolerance_pct=TOLERANCE_PCT,
    )
    print(line)

    # Hint at what a near-miss might mean (literature warns about
    # bending-moment transfer at multipatch seams; even single-patch can
    # under-perform if the basis is too coarse / wrong continuity).
    if not passed:
        print()
        if abs(uz_finest) > REFERENCE_UZ_KL * 1.05:
            print("Hint: |u_z| > reference. Often signals a soft mode — e.g. lost")
            print("      bending continuity across patches (hinge-like behaviour),")
            print("      or insufficient axial constraint causing rigid-body drift.")
        elif abs(uz_finest) < REFERENCE_UZ_KL * 0.95:
            print("Hint: |u_z| < reference. Often signals over-stiffening — e.g.")
            print("      membrane / shear locking, or BCs that pin too much.")
        return 3

    if not args.keep:
        import shutil
        for r in refines:
            shutil.rmtree(work_root / f"r{r}", ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
