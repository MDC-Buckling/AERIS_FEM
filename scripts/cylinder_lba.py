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

def _quarter_coefs(R: float, z_lo: float, z_hi: float, quadrant: int) -> str:
    """Control points for one 90-deg quarter NURBS spanning z ∈ [z_lo, z_hi].

    quadrant 0: theta in [0,    pi/2)
    quadrant 1: theta in [pi/2, pi)
    quadrant 2: theta in [pi,   3pi/2)
    quadrant 3: theta in [3pi/2,2pi)

    Corner control points: P0 = (R cos a, R sin a), P2 = (R cos b, R sin b).
    Middle CP is the intersection of the two tangent lines at P0 and P2,
    which for a 90-deg arc is at the corner of the local bounding box.

    For homogeneous cylinders, (z_lo, z_hi) = (0, L); for stepped cylinders
    one band per axial slice.
    """
    cs = [(1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)]
    a = cs[quadrant]
    b = cs[(quadrant + 1) % 4]
    p0 = (R * a[0], R * a[1])
    p2 = (R * b[0], R * b[1])
    p1 = (p0[0] + p2[0], p0[1] + p2[1])
    z_mid = 0.5 * (z_lo + z_hi)
    rows = []
    for z in (z_lo, z_mid, z_hi):
        for (x, y) in (p0, p1, p2):
            rows.append(f"    {x} {y} {z}")
    return "\n".join(rows)


def _quarter_geometry(patch_id: int, R: float, z_lo: float, z_hi: float,
                      quadrant: int) -> str:
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
{_quarter_coefs(R, z_lo, z_hi, quadrant)}
</coefs>
</Geometry>"""


def _material_xml(case: Case, mat_id: int, thickness: float,
                  extra_attrs: str = "") -> str:
    """Single <MaterialMatrix type="Linear3"> block, parameterised by t."""
    return f"""<MaterialMatrix type="Linear3" id="{mat_id}"{extra_attrs} TFT="false">
  <Thickness>
    <Function type="FunctionExpr" dim="3" index="0">{thickness}</Function>
  </Thickness>
  <Density>
    <Function type="FunctionExpr" dim="3" index="0">1</Function>
  </Density>
  <Parameters>
    <Function type="FunctionExpr" dim="3" index="0">{case.E}</Function>
    <Function type="FunctionExpr" dim="3" index="1">{case.nu}</Function>
  </Parameters>
</MaterialMatrix>"""


def build_cylinder_xml(model) -> str:
    """Emit a complete bvp XML for buckling_shell_multipatch_XML.

    Geometry is built as `n_bands` axial bands × 4 circumferential quarters
    = 4·n_bands patches. `n_bands = len(model.geometry.cylinder.partitions) + 1`.
    For a homogeneous cylinder (no partitions) this is exactly 4 patches —
    bit-identical to the Session-2.7 validated XML.

    BCs:
      - Bottom band (band 0), all 4 quarters, boundary side 3 (v=0 = z=0):
        full Dirichlet clamp + KL `Clamped` (zero normal rotation).
      - Top band (band n_bands-1), all 4 quarters, boundary side 4 (v=1 = z=L):
        Neumann line force (0, 0, +t·E)  — E-scaling avoids the K_NL-K_L
        catastrophic cancellation at large E (see comment below).
      - All intermediate band boundaries (side 4 of band i, side 3 of band
        i+1) are INTERNAL interfaces, not boundary edges.

    Material:
      - Single band → one `<MaterialMatrix id="10">` (legacy path, exactly
        what Session 2.7 validated).
      - N+1 bands → one `<MaterialMatrixContainer id="11">` carrying one
        inline `<MaterialMatrix>` per unique thickness, plus `<group>` rows
        mapping (band_quarters) → material index.

    Saint-Venant Kirchhoff linear isotropic everywhere (only `model:"linear"`
    is wired; nonlinear families come later).
    """
    case = model.case()
    bands = model.band_z_ranges()                # [(z_lo, z_hi), ...]
    n_bands = len(bands)
    n_patches = 4 * n_bands

    # --- patch geometry: id 9991 + patch_index, ordered band-major --------
    # patch_index(band b, quadrant q) = 4*b + q
    # → patches 0..3 = band 0, patches 4..7 = band 1, etc.
    patches = "\n\n".join(
        _quarter_geometry(9991 + 4 * b + q, case.R, z_lo, z_hi, q)
        for b, (z_lo, z_hi) in enumerate(bands)
        for q in range(4)
    )

    # --- interfaces -------------------------------------------------------
    # (a) theta seams within each band: 4 per band (u-direction = circumference).
    #     The single-band layout `0 1 3 2 / 0 2 1 1 / 1 2 2 1 / 2 2 3 1` is
    #     reused, just offset by 4*b for each band.
    # (b) z seams between adjacent bands: 4 per partition (v-direction).
    #     For each quarter q ∈ {0..3}, stitch (band b, side 4) ↔ (band b+1, side 3).
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

    # --- boundaries: only outer top + outer bottom ------------------------
    bnd_lines = []
    for q in range(4):
        bnd_lines.append(f"{q} 3")                                 # bottom band, side 3
        bnd_lines.append(f"{4 * (n_bands - 1) + q} 4")              # top band, side 4
    boundary = "\n".join(bnd_lines)

    multipatch = (
        f'<MultiPatch parDim="2" id="0">\n'
        f'<patches type="id_range">9991 {9991 + n_patches - 1}</patches>\n'
        f'  <interfaces>{interfaces}\n</interfaces>\n'
        f'  <boundary>{boundary}\n</boundary>\n'
        f'</MultiPatch>'
    )

    # --- material(s) ------------------------------------------------------
    if n_bands == 1:
        # Single-thickness legacy path → keep the exact MaterialMatrix id=10
        # the validated Session-2.7 / 3.3 XML used. Bit-identical regression.
        material = _material_xml(case, mat_id=10, thickness=case.t)
    else:
        # Stepped path → MaterialMatrixContainer id=11 with one MaterialMatrix
        # per UNIQUE thickness, plus <group> rows mapping patches to material
        # index. Buckling_shell_multipatch_XML reads id=11 if present (else
        # falls back to id=10), so it preferentially uses our container.
        band_t = [model.band_thickness(b) for b in range(n_bands)]
        unique_t = []
        for t in band_t:
            if not any(abs(t - u) < 1e-12 for u in unique_t):
                unique_t.append(t)
        # Index map: which material index does each band point at?
        band_to_mat = [
            next(i for i, u in enumerate(unique_t) if abs(t - u) < 1e-12)
            for t in band_t
        ]
        # Inventory of inline <MaterialMatrix index="i" ...> blocks
        inventory = "\n".join(
            _material_xml(case, mat_id=10 + i, thickness=t,
                          extra_attrs=f' index="{i}"')
            for i, t in enumerate(unique_t)
        )
        # Patch groups: for each material i, the 4 patches per band in band order
        groups = []
        for i in range(len(unique_t)):
            patches_for_mat = [
                4 * b + q for b in range(n_bands) if band_to_mat[b] == i
                for q in range(4)
            ]
            groups.append(
                f'  <group material="{i}">{" ".join(map(str, patches_for_mat))}</group>'
            )
        material = (
            f'<MaterialMatrixContainer id="11" size="{n_patches}">\n'
            f'{inventory}\n'
            + "\n".join(groups) + "\n"
            f'</MaterialMatrixContainer>'
        )

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
    # The Neumann magnitude is set to `t * E` (NOT just `t`). Picking
    # T_z = t makes the implied uniform membrane axial stress σ_z = T_z/t = 1
    # in E's units — clean for E ~ O(1), but at large E (e.g. steel in MPa
    # where E ≈ 2e5) the gsBucklingSolver hits CATASTROPHIC CANCELLATION
    # inside `m_B = K_NL - K_L`:
    #   K_L = O(E),  K_NL = O(E),  K_geom = K_NL - K_L = O(1)
    # subtracts away ~log10(E) significant digits, returning garbage
    # eigenvalues (~1e+28 etc.) — exactly what the Session-3.3 audit caught.
    #
    # Fix: set T_z = t · E so the implied σ_ref = E. Then:
    #   K_geom ∝ σ_ref = E,  same order as K_L, no cancellation.
    #   Eigenvalues λ' are normalised: σ_cr_physical = |λ'| · E.
    #
    # At E=1 this is bit-identical to the old `T_z = t` convention (since
    # multiplying by 1 is a no-op), so the Session-2.7 validated default
    # case stays at -1.02 % at r=4.
    # Neumann line force scales with band-local thickness × E. For a stepped
    # cylinder the TOP band's thickness is what the load sees (it's applied
    # on the top band's outer edge), so we use the top band's `t` here.
    # For a homogeneous cylinder that's just `case.t` (= cylinder.t).
    top_band_thickness = model.band_thickness(n_bands - 1)
    neumann_Tz_const = top_band_thickness * case.E
    bottom_patches = "\n    ".join(f"{q} 3" for q in range(4))
    top_off = 4 * (n_bands - 1)
    top_patches = "\n    ".join(f"{top_off + q} 4" for q in range(4))

    # Load-case dispatch — picks the Tz function on the top edge.
    #
    # axial:    Tz(x) = T_max (constant)
    #             → uniform tensile membrane stress σ_z = E everywhere
    #             → smallest-positive eigenvalue = uniform compressive buckling load
    #
    # bending:  Tz(x) = T_max · x / R  (cos(θ) on the top circle)
    #             → linear x-dependence on top edge: tension at +x, compression at -x
    #             → membrane stress σ_z(x) = (E/R)·x; |σ_max| = E at x = ±R
    #             → smallest-positive eigenvalue = bending-induced compressive
    #               buckling on the -x half-cylinder. The classical reference
    #               (perfect-shell LBA, no Brazier effect at thin shells) is the
    #               same σ_cr as axial — knockdown for bending is an
    #               imperfection-sensitivity story, not LBA.
    #
    # K_geom is positive-(semi)definite for axial (everywhere tension) and
    # INDEFINITE for bending (tension on +x, compression on -x). Spectra's
    # Buckling mode handles indefinite K_geom; we still extract λ_1 > 0 as the
    # load factor that drives the corresponding compressive buckling.
    load_kind = model.load.get("kind", "axial")
    if load_kind == "axial":
        neumann_components = (
            f"  <c> 0 </c>\n"
            f"  <c> 0 </c>\n"
            f"  <c> {neumann_Tz_const} </c>"
        )
        load_summary = (
            f"axial · Tz = {neumann_Tz_const}  (uniform tensile reference; "
            f"σ_ref = E)"
        )
    elif load_kind == "bending":
        Tz_slope = neumann_Tz_const / case.R     # = E·t/R, gives σ_max = E at x=±R
        neumann_components = (
            f"  <c> 0 </c>\n"
            f"  <c> 0 </c>\n"
            f"  <c> {Tz_slope} * x </c>"
        )
        load_summary = (
            f"bending · Tz(x) = {Tz_slope} · x  (cos(θ) on top edge; "
            f"|σ_max| = E at x = ±R)"
        )
    else:
        raise NotImplementedError(
            f"load.kind '{load_kind}' not yet wired in build_cylinder_xml; "
            "supported today: axial, bending"
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

    # Stash a one-liner so main() can echo what the LBA is actually loaded by.
    build_cylinder_xml._last_load_summary = load_summary  # type: ignore[attr-defined]

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
    # Eigenvalues are NORMALISED (the Neumann load was scaled by E above), so
    # they live in dimensionless O(1) territory regardless of E. Shift to
    # the normalised classical estimate: classical_sigma_cr / E.
    expected_normalised = classical_sigma_cr(case) / max(case.E, 1e-30)
    shift_val = max(expected_normalised, 1e-9)
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

# DEFAULT mesh parameters. The model.mesh block in model.json is the
# authoritative source; these constants are only fallbacks if no model is
# loaded AND no CLI override is given. Values match the Session-2.7
# validated path so the regression case still passes with no inputs at all.
SMOOTH_METHOD = 0            # 0 = gsSmoothInterfaces (regular topology)
SMOOTH_DEGREE = 3            # cubic NURBS after p-elevation
SMOOTH_SMOOTHNESS = 2        # C^2 inside each patch (one less than degree)

# Maps the schema-level `mesh.coupling` string onto the integer the
# multipatch driver expects (-m flag). Order intentionally matches the
# values in the model-tree dropdown so a future "5 = …" choice can be
# added by appending here + extending the GUI dropdown — no other touch.
COUPLING_METHOD = {
    "gsSmoothInterfaces":   0,
    "gsAlmostC1":           1,
    "gsDPatch":             2,
    "gsApproxC1Spline":     3,
}

# Solver prints eigenvalues like:
#   First 10 eigenvalues:
#       0.00612345...
#       0.0123...
EIG_LINE = re.compile(r"^\s+([-+0-9.eE]+)\s*$")


def run_buckling(xml_path: Path, r: int, e: int = 0, nmodes: int = 5,
                 method: int = SMOOTH_METHOD,
                 degree: int = SMOOTH_DEGREE,
                 smoothness: int = SMOOTH_SMOOTHNESS,
                 timeout: int = 600,
                 plot_dir: Path | None = None) -> list[float]:
    """Invoke buckling_shell_XML and parse eigenvalues.

    `method` (-m), `degree` (-p), `smoothness` (-s) are forwarded to the
    multipatch driver's unstructured-splines builder. Defaults pin the
    Session-2.7 validated combination so passing nothing reproduces the
    regression case bit-identically.

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
           "-m", str(method),
           "-p", str(degree),
           "-s", str(smoothness)]
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
    # Mesh-block overrides — pulled from model.mesh by default, CLI wins
    # if given. None sentinel preserves "use whatever the model says" so a
    # missing flag never silently downgrades the model's value to a CLI
    # default.
    p.add_argument("--degree", type=int, default=None,
                   help="Spline degree (-p). Overrides model.mesh.degree")
    p.add_argument("--smoothness", type=int, default=None,
                   help="Inter-element smoothness inside a patch (-s). "
                        "Overrides model.mesh.smoothness. Must be < degree.")
    p.add_argument("--coupling", type=str, default=None,
                   choices=tuple(COUPLING_METHOD.keys()),
                   help="Multipatch coupling strategy (-m mapped via "
                        f"{COUPLING_METHOD}). Overrides model.mesh.coupling.")
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
    # scalar CLI flags override geometry/material/mesh on top. Other sections
    # (bcs, load, analysis) are read from the model and ignored at solve time
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

    # Mesh-block resolution: model.json → CLI override → hardcoded fallback.
    # The defaults in DEFAULT_MESH already match Session 2.7 so the no-args
    # path stays bit-identical to the validated case.
    mesh = model.mesh
    degree     = args.degree     if args.degree     is not None else int(mesh.get("degree", SMOOTH_DEGREE))
    smoothness = args.smoothness if args.smoothness is not None else int(mesh.get("smoothness", SMOOTH_SMOOTHNESS))
    coupling_name = args.coupling if args.coupling is not None else str(mesh.get("coupling", "gsSmoothInterfaces"))
    if coupling_name not in COUPLING_METHOD:
        raise SystemExit(
            f"unknown coupling '{coupling_name}'; expected one of "
            f"{list(COUPLING_METHOD)}"
        )
    method = COUPLING_METHOD[coupling_name]
    if smoothness >= degree:
        raise SystemExit(
            f"mesh.smoothness ({smoothness}) must be < mesh.degree ({degree}) "
            "— smoothness is the C^k continuity inside a patch, which is "
            "capped at one less than the polynomial degree."
        )

    load_kind = model.load.get("kind", "axial")

    print("=" * 70)
    print("Aeris cylinder LBA — classical vs gsKLShell")
    print("=" * 70)
    print(f"Geometry : R={case.R}, L={case.L}, t={case.t}")
    print(f"Material : E={case.E}, nu={case.nu}")
    print(f"Mesh     : degree={degree}, smoothness={smoothness}, "
          f"coupling={coupling_name} (-m {method})")
    print(f"Load     : {load_kind}")
    print(f"Slenderness  R/t = {case.R / case.t:.0f}")
    print(f"Aspect ratio L/R = {case.L / case.R:.2f}")
    print()
    sigma_cr_ref = classical_sigma_cr(case)
    N_cr_ref = classical_N_cr(case)
    print(f"Classical sigma_cr = E*t / (R * sqrt(3(1-nu^2))) = {sigma_cr_ref:.8e}")
    if load_kind == "axial":
        print(f"Classical N_cr     = 2 pi R t sigma_cr            = {N_cr_ref:.8e}")
    elif load_kind == "bending":
        # Pure-bending classical: same critical local membrane stress as
        # axial for a perfect-shell LBA (Stein & Mayers; Brazier-effect is
        # negligible for R/t in the thin-shell regime we work in). The
        # corresponding bending moment is M_cr = pi · R^2 · t · sigma_cr.
        M_cr_ref = math.pi * case.R**2 * case.t * sigma_cr_ref
        print(f"Classical M_cr     = pi R^2 t sigma_cr            = {M_cr_ref:.8e}")
        print( "  (perfect-shell LBA — bending knockdown is an imperfection")
        print( "   sensitivity story, not LBA)")
    print()

    xml_text = build_cylinder_xml(model)
    print("Reference loading state (driving the LBA):")
    print(f"  {build_cylinder_xml._last_load_summary}")
    print( "  E-scaling keeps K_NL and K_geom of comparable magnitude →")
    print( "  no catastrophic cancellation at large E. Eigenvalues are NORMALISED,")
    print(f"  recover physical stress as  sigma_cr_computed = |lambda_1| · E.")
    print()
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
        eigs = run_buckling(xml_path, r=r, e=args.elevate, nmodes=args.nmodes,
                            method=method, degree=degree, smoothness=smoothness)
        lam1 = first_physical_positive(eigs)
        if lam1 is None:
            print(f"  {r:>4}  {len(eigs):>6}  NO POSITIVE EIGENVALUE; raw = {eigs}")
            continue
        # Reference state = Neumann line force T_z = case.t · case.E at the
        # top, so the implied uniform membrane axial stress σ_ref = T_z/t = E
        # (the E-scaling avoids catastrophic cancellation in K_NL - K_L at
        # large E — see build_cylinder_xml comment). λ_1 from the solver is
        # NORMALISED, so physical critical stress = |λ_1| · E.
        # At E=1 this collapses to |λ_1| — bit-identical to the validated
        # Session-2.7 path.
        sigma_computed = abs(lam1) * case.E
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
                method=method, degree=degree, smoothness=smoothness,
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

    # ABAQUS-style LBA convention: report the buckling LOAD in the user's
    # units, scaled by load.magnitude. For magnitude=1 the eigenvalue itself
    # reads as the critical load (F or M); for any other magnitude the load
    # factor (= F_cr / F_applied) is printed too. The eigenvalue is
    # invariant under this scaling — magnitude only affects the verdict
    # output, the XML Neumann is independently E-scaled for conditioning.
    magnitude = float(model.load.get("magnitude", 1.0))
    A_axial = 2.0 * math.pi * case.R * case.t
    I_bend  = math.pi * case.R**3 * case.t
    if load_kind == "axial":
        applied_label, applied_symbol, applied_unit = "axial force", "F", ""
        F_cr_computed = sigma_finest * A_axial
        F_cr_classical = sigma_cr_ref * A_axial
        critical = F_cr_computed
        critical_classical = F_cr_classical
    elif load_kind == "bending":
        applied_label, applied_symbol, applied_unit = "bending moment", "M", ""
        # sigma_max = M·R/I  →  M = sigma_max · I / R = sigma_max · π·R²·t
        M_cr_computed = sigma_finest * I_bend / case.R
        M_cr_classical = sigma_cr_ref * I_bend / case.R
        critical = M_cr_computed
        critical_classical = M_cr_classical
    else:
        critical = critical_classical = None

    if critical is not None:
        print()
        print(f"Applied {applied_label:<14}: {applied_symbol} = {magnitude:.6g}{applied_unit}")
        print(f"Critical (computed)  : {applied_symbol}_cr = {critical:.6e}{applied_unit}")
        print(f"Critical (classical) : {applied_symbol}_cr = {critical_classical:.6e}{applied_unit}")
        if magnitude != 1.0 and magnitude != 0.0:
            print(f"Load factor          : {applied_symbol}_cr / {applied_symbol}_applied = "
                  f"{critical / magnitude:.6e}")

    if abs(pct_finest) < 25.0:
        print("\nORDER OF MAGNITUDE OK — gap within expected finite-length /")
        print("clamped vs classical-infinite-cylinder envelope (~ +/- 25%).")
        return 0
    print("\nDEVIATION TOO LARGE — check BCs / units / sign / refinement.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
