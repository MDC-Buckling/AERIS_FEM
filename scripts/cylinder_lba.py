"""Aeris — linear buckling of a perfect, clamped, axially-compressed cylinder.

Compares the first computed buckling eigenvalue from gsKLShell +
gsBucklingSolver (driven via the shipped ``buckling_shell_multipatch_XML``
C++ executable) against the classical analytical critical buckling stress

    sigma_cr_classical = E * t / (R * sqrt(3 * (1 - nu^2)))

which is the leading-order result for a thin, isotropic, perfect cylinder
under uniform axial compression — a textbook upper bound. A finite, clamped
cylinder lands NEAR this value, not exactly on it; we expect a few-percent
deviation that closes a bit with mesh refinement.

Usage (inside the aeris/gismo:v25.07.0 container):

    python3 /aeris/scripts/cylinder_lba.py

CLI is intentionally tiny — geometry params are pinned in DEFAULT_CASE.
"""
from __future__ import annotations

import argparse
import math
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


# ---------------------------------------------------------------------------
# Physics
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Case:
    R: float    # mid-surface radius           [length]
    L: float    # axial length                 [length]
    t: float    # shell thickness              [length]
    E: float    # Young's modulus              [force/length^2]
    nu: float   # Poisson ratio                [-]


DEFAULT_CASE = Case(R=1.0, L=1.0, t=0.01, E=1.0, nu=0.3)


def classical_sigma_cr(c: Case) -> float:
    """Classical critical axial buckling stress (Lorenz / Timoshenko 1908)."""
    return c.E * c.t / (c.R * math.sqrt(3.0 * (1.0 - c.nu ** 2)))


def classical_N_cr(c: Case) -> float:
    """Classical critical total axial force = sigma_cr * 2 * pi * R * t."""
    return 2.0 * math.pi * c.R * c.t * classical_sigma_cr(c)


# ---------------------------------------------------------------------------
# XML construction — 4-patch closed cylinder, mirrors filedata/pde/cylinder_4p.xml
# ---------------------------------------------------------------------------

def _quarter_coefs(R: float, L: float, quadrant: int) -> str:
    """Control points for one 90-deg quarter NURBS, 3x3 grid, geoDim=3.

    quadrant 0: theta in [0,    pi/2)
    quadrant 1: theta in [pi/2, pi)
    quadrant 2: theta in [pi,   3pi/2)
    quadrant 3: theta in [3pi/2,2pi)

    Corner control points: P0 = (R cos a, R sin a), P2 = (R cos b, R sin b).
    Middle CP is the intersection of the two tangent lines at P0 and P2,
    which for a 90-deg arc is at the corner of the local bounding box.
    """
    cs = [(1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)]
    a = cs[quadrant]
    b = cs[(quadrant + 1) % 4]
    p0 = (R * a[0], R * a[1])
    p2 = (R * b[0], R * b[1])
    # Middle CP for 90-deg quarter at canonical positions:
    p1 = (p0[0] + p2[0], p0[1] + p2[1])
    rows = []
    for z in (0.0, 0.5 * L, L):
        for (x, y) in (p0, p1, p2):
            rows.append(f"    {x} {y} {z}")
    return "\n".join(rows)


def _quarter_geometry(patch_id: int, R: float, L: float, quadrant: int) -> str:
    return f"""<Geometry type="TensorNurbs2" id="{patch_id}">
  <Basis type="TensorNurbsBasis2">
   <Basis type="TensorBSplineBasis2">
    <Basis type="BSplineBasis" index="0">
     <KnotVector degree="2">0 0 0 1 1 1 </KnotVector>
    </Basis>
    <Basis type="BSplineBasis" index="1">
     <KnotVector degree="2">0 0 0 1 1 1 </KnotVector>
    </Basis>
   </Basis>
   <weights>1
0.707106781186548
1
1
0.707106781186548
1
1
0.707106781186548
1
</weights>
  </Basis>
  <coefs geoDim="3">
{_quarter_coefs(R, L, quadrant)}
</coefs>
</Geometry>"""


def build_cylinder_xml(case: Case) -> str:
    """Emit a complete bvp XML for buckling_shell_multipatch_XML.

    BCs:
      - Bottom edge (boundary index 3 = v=0 = z=0 in our parameterisation):
        fully clamped (Dirichlet, all 3 components = 0).
      - Top edge (boundary index 4 = v=1 = z=L): laterally locked (x=0, y=0)
        with prescribed AXIAL SHORTENING (z = -1).
        This drives a uniform compressive axial membrane state; the LBA
        eigenvalue lambda_1 is the load factor on this -1 z displacement.

    Material: gsMaterialMatrixLinear<3> (Saint-Venant Kirchhoff for 3D
    ambient shells), Young's modulus = E, Poisson = nu, thickness = t.
    """
    patches = "\n\n".join(
        _quarter_geometry(9991 + q, case.R, case.L, q) for q in range(4)
    )

    # MultiPatch with interfaces stitching the four 90-deg patches around
    # the cylinder. Boundaries 3 & 4 of each patch are the top/bottom edges.
    multipatch = """<MultiPatch parDim="2" id="0">
<patches type="id_range">9991 9994</patches>
  <interfaces>0 1 3 2 0 1 0 1
0 2 1 1 0 1 0 1
1 2 2 1 0 1 0 1
2 2 3 1 0 1 0 1
</interfaces>
  <boundary>0 3
0 4
1 3
1 4
2 3
2 4
3 3
3 4
</boundary>
</MultiPatch>"""

    material = f"""<MaterialMatrix type="Linear3" id="10" TFT="false">
  <Thickness>
    <Function type="FunctionExpr" dim="3" index="0">{case.t}</Function>
  </Thickness>
  <Density>
    <Function type="FunctionExpr" dim="3" index="0">1</Function>
  </Density>
  <Parameters>
    <Function type="FunctionExpr" dim="3" index="0">{case.E}</Function>
    <Function type="FunctionExpr" dim="3" index="1">{case.nu}</Function>
  </Parameters>
</MaterialMatrix>"""

    # BC strategy — modeled on gsStructuralAnalysis/benchmarks/benchmark_Cylinder.cpp
    # (Kiendl et al. 2015):
    #
    #   Bottom (boundary 3 = v=0 = z=0):
    #     * Dirichlet u_x=u_y=u_z=0   (full displacement clamp)
    #     * Clamped on component 2    (KL shell normal-rotation = 0 — true
    #                                  engineering clamp; without it we have
    #                                  only "simply supported", which is what
    #                                  bit us on the first attempt)
    #   Top (boundary 4 = v=1 = z=L):
    #     * Neumann line force (0, 0, +t)  (tensile axial line force = +t)
    #
    # Tensile reference state was chosen so K_geom is positive-(semi)definite
    # and gsBucklingSolver returns POSITIVE eigenvalues; the smallest positive
    # is the load factor that drives the corresponding COMPRESSIVE buckling.
    #
    # The Neumann magnitude is set to `t` (thickness) so that the implied
    # uniform membrane axial stress is
    #   N_z / t = (traction * perimeter) / (perimeter * t * t) = ... actually
    #   N_z (force/length on edge) is the traction directly in KL shells;
    #   σ_z_mem = N_z / t = t / t = 1.   (so σ_ref = 1 → |λ_1| reads as σ_cr.)
    bcs = f"""<boundaryConditions id="20" multipatch="0">
  <Function type="FunctionExpr" dim="3" index="0">
  <c> 0 </c>
  <c> 0 </c>
  <c> 0 </c>
  </Function>
  <Function type="FunctionExpr" dim="3" index="1">
  <c> 0 </c>
  <c> 0 </c>
  <c> {case.t} </c>
  </Function>

  <bc type="Dirichlet" function="0" unknown="0" component="-1">
    0 3
    1 3
    2 3
    3 3
  </bc>
  <bc type="Clamped" function="0" unknown="0" component="2">
    0 3
    1 3
    2 3
    3 3
  </bc>
  <bc type="Neumann" function="1" unknown="0">
    0 4
    1 4
    2 4
    3 4
  </bc>
</boundaryConditions>"""

    # Zero body force and pressure; no point loads. Driving comes from the
    # prescribed Dirichlet displacement on the top edge.
    loads = """<Function type="FunctionExpr" id="21" tag="Loads" dim="3">
  <c> 0 </c>
  <c> 0 </c>
  <c> 0 </c>
</Function>
<Function type="FunctionExpr" id="22" tag="Loads" dim="3">0</Function>

<Matrix rows="2" cols="0" id="30" tag="Loads" ></Matrix>
<Matrix rows="3" cols="0" id="31" tag="Loads" ></Matrix>
<Matrix rows="1" cols="0" id="32" tag="Loads" ></Matrix>"""

    # Reference points — required by the exe (matrix shape!=0 needed for
    # cols match check). Single point at (0.5, 0.5) parametric on patch 0.
    refs = """<Matrix rows="2" cols="1" id="50" >
0.5
0.5
</Matrix>
<Matrix rows="1" cols="1" id="51" >0</Matrix>
<Matrix rows="0" cols="0" id="52" ></Matrix>"""

    # Buckling solver options — solver=3 selects Spectra's Buckling mode
    # (designed for K x = lambda K_g x with K positive-definite).
    # Spectra GEigsMode::Buckling (3) is the right tool for K_L v = lambda K_geom v
    # with K_L SPD and K_geom indefinite/negative-definite (compressive prestress).
    # It DEMANDS a non-zero shift; eigenvalues nearest the shift come back first.
    # Picking a shift smaller than the expected eigenvalue magnitude (~6e-3 for our
    # case) keeps us hunting near the smallest physical mode.
    # NOTE on XML tags: the gsOptionList XML reader uses tag names {int, real, bool,
    # everything-else-falls-through-to-string} — see gsOptionListXml.cpp:40 — so a
    # switch option must be written as <bool>, NOT <switch>.
    # Shift set near the expected eigenvalue magnitude. Spectra GEigsMode::Buckling
    # finds eigenvalues nearest the shift, so picking shift ~ classical_sigma_cr
    # tightens the search around the physically interesting band.
    expected = classical_sigma_cr(case)
    shift_val = max(expected, 1e-6)  # search around classical estimate
    bucking_opts = f"""<OptionList id="94">
<int label="solver" desc="Spectra eigen mode (3 = Buckling)" value="3"/>
<int label="selectionRule" desc="Spectra::SortRule (0 = LargestMagn — recommended with shift-invert)" value="0"/>
<int label="sortRule" desc="Spectra::SortRule for output (4 = SmallestMagn)" value="4"/>
<real label="shift" desc="Spectral shift near classical sigma_cr" value="{shift_val}"/>
<int label="ncvFac" desc="ncv multiplier" value="3"/>
<real label="tolerance" desc="Solver tolerance" value="1e-8"/>
<bool label="verbose" desc="Verbosity" value="0"/>
</OptionList>

<OptionList id="92">
<int label="Continuity" desc="Interface continuity" value="0"/>
<real label="IfcPenalty" desc="Penalty for weak C0/C1 coupling at multipatch interfaces" value="1e6"/>
</OptionList>"""

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<xml>
{multipatch}

{material}

{bcs}

{loads}

{refs}

{bucking_opts}

{patches}
</xml>
"""


# ---------------------------------------------------------------------------
# Solver invocation + output parsing
# ---------------------------------------------------------------------------

EXE = Path(os.environ.get(
    "AERIS_BUCKLING_EXE",
    # The MULTIPATCH driver builds a globally C1 basis via gsUnstructuredSplines
    # (method=0 / gsSmoothInterfaces for our regular 4-patch cylinder topology),
    # then `assembler.setSpaceBasis(bb2)` so the KL shell assembly sees a truly
    # smooth basis. The single-patch driver only does WEAK C0/C1 PENALTY coupling
    # via addWeakC0/addWeakC1 — sufficient for membrane-dominated modes but it
    # leaks spurious seam modes into the cluster (mode-pair splitting visible
    # as exploded localised renders at the 4 vertical seams). See Session 2.7.
    "/opt/gismo/build/bin/buckling_shell_multipatch_XML",
))

# Method picked for the multipatch coupling. 0 = gsSmoothInterfaces is the
# simplest construction; it gives identical eigenvalues to AlmostC1 (method=1)
# for our regular cylinder topology and runs much faster.
SMOOTH_METHOD = 0
# Smooth-basis degree/smoothness handed to the unstructured-splines builder.
SMOOTH_DEGREE = 3
SMOOTH_SMOOTHNESS = 2

# Solver prints eigenvalues like:
#   First 10 eigenvalues:
#       0.00612345...
#       0.0123...
EIG_LINE = re.compile(r"^\s+([-+0-9.eE]+)\s*$")


def run_buckling(xml_path: Path, r: int, e: int = 0, nmodes: int = 5,
                 timeout: int = 600,
                 plot_dir: Path | None = None) -> list[float]:
    """Invoke buckling_shell_XML and parse eigenvalues.

    If ``plot_dir`` is provided, the exe is run with --plot and -o pointing
    at a subdirectory of plot_dir, AND its working directory is set to
    plot_dir so the hard-coded "mp.pvd" geometry and "linearSolution.pvd"
    files land there too. Returns the parsed eigenvalues exactly as before
    regardless of plotting.
    """
    cmd = [str(EXE),
           "-i", str(xml_path),
           "-r", str(r),
           "-e", str(e),
           "-N", str(nmodes),
           "-m", str(SMOOTH_METHOD),
           "-p", str(SMOOTH_DEGREE),
           "-s", str(SMOOTH_SMOOTHNESS)]
    cwd = None
    if plot_dir is not None:
        plot_dir.mkdir(parents=True, exist_ok=True)
        modes_dir = plot_dir / "modes"
        modes_dir.mkdir(exist_ok=True)
        cmd += ["--plot", "-o", str(modes_dir)]
        cwd = str(plot_dir)
    res = subprocess.run(cmd, capture_output=True, text=True,
                         timeout=timeout, cwd=cwd)
    if res.returncode != 0:
        sys.stderr.write(res.stdout)
        sys.stderr.write(res.stderr)
        raise RuntimeError(f"{EXE.name} exited {res.returncode}")

    eigs: list[float] = []
    capture = False
    for line in res.stdout.splitlines():
        if "First" in line and "eigenvalues" in line:
            capture = True
            continue
        if not capture:
            continue
        m = EIG_LINE.match(line)
        if m:
            try:
                eigs.append(float(m.group(1)))
            except ValueError:
                pass
        else:
            if eigs:
                break
    if not eigs:
        sys.stderr.write(res.stdout[-2000:])
        raise RuntimeError("No eigenvalues parsed from solver output")
    return eigs


# ---------------------------------------------------------------------------
# Convergence study + reporting
# ---------------------------------------------------------------------------

def first_physical_positive(eigs: list[float], floor: float = 1e-10,
                             cluster_band: float = 3.0) -> float | None:
    """Pick the smallest strictly-positive eigenvalue in the dominant cluster.

    Spectra (in shift-invert / buckling mode) returns denormal (~1e-322),
    huge (~1e+196), non-finite, or spurious near-zero (~1e-6) values in
    the slots where it ran out of converged eigenvalues. We want the
    smallest member of the BUCKLING CLUSTER — the contiguous group of
    finite positives within a factor of `cluster_band` of each other.
    Anything that's an isolated singleton (no neighbours within `cluster_band`)
    is treated as noise and discarded.
    """
    pos = sorted(e for e in eigs
                 if math.isfinite(e) and abs(e) > floor and e > 0)
    if not pos:
        return None

    # Mark each eigenvalue as part of a cluster if it has at least one
    # neighbour within `cluster_band`x of it.
    in_cluster = [False] * len(pos)
    for i, val in enumerate(pos):
        for j, other in enumerate(pos):
            if i == j:
                continue
            r = max(val, other) / max(min(val, other), 1e-30)
            if r <= cluster_band:
                in_cluster[i] = True
                break

    clustered = [v for v, ok in zip(pos, in_cluster) if ok]
    return min(clustered) if clustered else min(pos)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", type=Path, default=None,
                   help="Path to a model.json (schema in aeris_model.py). Geometry "
                        "and material come from this file; --R/--L/--t/--E/--nu "
                        "override on top if also given. If not set, the validated "
                        "default case (R=1, L=1, t=0.01, E=1, nu=0.3) is used.")
    p.add_argument("--R", type=float, default=None)
    p.add_argument("--L", type=float, default=None)
    p.add_argument("--t", type=float, default=None)
    p.add_argument("--E", type=float, default=None)
    p.add_argument("--nu", type=float, default=None)
    p.add_argument("--refines", type=int, nargs="+", default=[3, 4, 5],
                   help="Mesh refinement levels (-r) to sweep")
    p.add_argument("--elevate", type=int, default=0,
                   help="Degree elevation (-e), same for all runs")
    p.add_argument("--nmodes", type=int, default=5)
    p.add_argument("--keep-xml", action="store_true",
                   help="Don't delete the generated XML")
    p.add_argument("--plot-dir", type=Path, default=None,
                   help="If set (and writable), run an extra pass at the finest "
                        "refinement with --plot to dump ParaView files there. "
                        "Defaults to /aeris-output if it exists, else skipped.")
    p.add_argument("--plot-modes", type=int, default=3,
                   help="Number of buckling eigenmodes to write to ParaView")
    p.add_argument("--no-plot", action="store_true",
                   help="Skip the ParaView export pass even if --plot-dir is set")
    args = p.parse_args(argv)

    # Start from a model — file if given, else the validated default — then let
    # scalar CLI flags override geometry/material on top. Other sections (mesh,
    # bcs, load, analysis) are read from the model and ignored at solve time
    # since their wiring lands in later sessions; only their presence in the
    # model.json is contract.
    from aeris_model import ModelConfig
    model = (
        ModelConfig.from_json_file(args.model)
        if args.model
        else ModelConfig()
    )
    cyl = model.geometry["cylinder"]
    if args.R is not None: cyl["R"] = args.R
    if args.L is not None: cyl["L"] = args.L
    if args.t is not None: cyl["t"] = args.t
    # Schema v2: --E/--nu edit materials[0]. ModelConfig.case() resolves it
    # via the shell_full assignment → section → material_ref → materials[].
    if args.E is not None: model.materials[0]["E"] = args.E
    if args.nu is not None: model.materials[0]["nu"] = args.nu
    case = model.case()

    print("=" * 70)
    print("Aeris cylinder LBA — classical vs gsKLShell")
    print("=" * 70)
    print(f"Geometry : R={case.R}, L={case.L}, t={case.t}")
    print(f"Material : E={case.E}, nu={case.nu}")
    print(f"Slenderness  R/t = {case.R / case.t:.0f}")
    print(f"Aspect ratio L/R = {case.L / case.R:.2f}")
    print()
    sigma_cr_ref = classical_sigma_cr(case)
    N_cr_ref = classical_N_cr(case)
    print(f"Classical sigma_cr = E*t / (R * sqrt(3(1-nu^2))) = {sigma_cr_ref:.8e}")
    print(f"Classical N_cr     = 2 pi R t sigma_cr            = {N_cr_ref:.8e}")
    print()
    print("Reference loading state (driving the LBA):")
    print(f"  Neumann line force on top edge: T = (0, 0, +t) = (0, 0, +{case.t})")
    print(f"  Implied axial membrane stress sigma_ref = T_z / t = +1 (tensile)")
    print("  -> LBA eigenvalue lambda is the load factor; compressive critical")
    print("     stress corresponds to lambda_1 of opposite sign convention,")
    print("     i.e. sigma_cr_computed = |lambda_1| * sigma_ref = |lambda_1|.")
    print()

    xml_text = build_cylinder_xml(case)
    with tempfile.NamedTemporaryFile("w", suffix=".xml", delete=False,
                                     dir="/tmp") as f:
        f.write(xml_text)
        xml_path = Path(f.name)
    print(f"XML written to {xml_path}  ({len(xml_text):,} bytes)")
    print(f"Solver exe: {EXE}")
    print()

    print("Convergence sweep:")
    print(f"  {'-r':>4}  {'#modes':>6}  {'lambda_1':>16}  "
          f"{'sigma_cr_computed':>20}  {'% vs classical':>16}")
    print(f"  {'-' * 70}")

    table: list[tuple[int, float, float, float]] = []
    for r in args.refines:
        eigs = run_buckling(xml_path, r=r, e=args.elevate, nmodes=args.nmodes)
        lam1 = first_physical_positive(eigs)
        if lam1 is None:
            print(f"  {r:>4}  {len(eigs):>6}  NO POSITIVE EIGENVALUE; raw = {eigs}")
            continue
        # Reference state = Neumann line force T_z = t at the top, so the
        # implied uniform membrane axial stress σ_ref = T_z / t = 1 (independent
        # of geometry). λ_1 is the load factor on this reference, so the
        # critical compressive stress is just |λ_1|.
        # (Old buggy line did `lam1 * E / L`; that's correct iff E=L=1, which
        # was the validated default — so the audit caught the bug at L=3.)
        sigma_computed = abs(lam1)
        pct = 100.0 * (sigma_computed - sigma_cr_ref) / sigma_cr_ref
        print(f"  {r:>4}  {len(eigs):>6}  {lam1:>16.8e}  "
              f"{sigma_computed:>20.8e}  {pct:>+15.2f}%")
        # Show all raw eigenvalues for transparency (filter garbage for clarity)
        clean = [f"{e:+.4e}" for e in eigs
                 if math.isfinite(e) and abs(e) > 1e-10]
        print(f"        raw physical eigs: {clean}")
        table.append((r, lam1, sigma_computed, pct))

    # ----- ParaView export pass (one extra solve at the FINEST refinement) ----
    # Defaults to /aeris-output if it exists (standard host-mount target) so
    # the user gets visuals without extra flags. Skipped if --no-plot.
    if args.plot_dir is None:
        default = Path("/aeris-output")
        plot_dir = default if default.exists() else None
    else:
        plot_dir = args.plot_dir

    if plot_dir is not None and not args.no_plot and table:
        r_finest = args.refines[-1]
        print()
        print("=" * 70)
        print(f"ParaView export — re-running at r={r_finest} with --plot")
        print("=" * 70)
        print(f"Writing to {plot_dir}/ (host-mounted)")
        try:
            run_buckling(
                xml_path,
                r=r_finest,
                e=args.elevate,
                nmodes=max(args.nmodes, args.plot_modes),
                plot_dir=plot_dir,
            )
            written = sorted(p.name for p in plot_dir.iterdir() if p.is_file())
            modes_dir = plot_dir / "modes"
            mode_files = sorted(p.name for p in modes_dir.iterdir()
                                if p.is_file()) if modes_dir.exists() else []
            print(f"Top-level files in {plot_dir}/:")
            for n in written:
                print(f"  {n}")
            print(f"Mode files in {plot_dir}/modes/:")
            for n in mode_files[:20]:
                print(f"  {n}")
            if len(mode_files) > 20:
                print(f"  ... ({len(mode_files) - 20} more)")
            print()
            print("To view: open ParaView, File -> Open the .pvd files listed")
            print("above. Eigenmode shapes are stored as the vector field")
            print("'SolutionField' (3-component). Use Filters -> 'Warp by")
            print("Vector' with that field to amplify the deformation; the")
            print("modes are normalised so |u_z|_max = 1 in the exe.")
        except Exception as e:
            print(f"Plot export failed: {e}")
            print("(Numerical results above are unaffected.)")

    if not args.keep_xml:
        try:
            xml_path.unlink()
        except OSError:
            pass

    if not table:
        print("\nFAIL — no positive eigenvalues at any refinement level.")
        return 1

    print()
    print("=" * 70)
    print("Verdict")
    print("=" * 70)
    sigma_finest = table[-1][2]
    pct_finest = table[-1][3]
    print(f"Finest mesh sigma_cr_computed = {sigma_finest:.6e}")
    print(f"Classical sigma_cr            = {sigma_cr_ref:.6e}")
    print(f"Relative deviation            = {pct_finest:+.2f}%")
    if abs(pct_finest) < 25.0:
        print("\nORDER OF MAGNITUDE OK — gap within expected finite-length /")
        print("clamped vs classical-infinite-cylinder envelope (~ +/- 25%).")
        return 0
    print("\nDEVIATION TOO LARGE — check BCs / units / sign / refinement.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
