"""Independent NURBS-panel LBA reference for the BB curved-segment buckling test.

Same geometry + BC as test_bb_segment_lba.cpp:
  open cylinder panel  R=1, L=1, theta in [-phi,+phi] (phi=0.6),  t=0.05, E=1e6, nu=0.3
  BC: bottom arc (x=0, side 3) Dirichlet u=0 (all comps); top (x=L, side 4) Neumann
      axial line force Tz = t*E (tensile reference => sigma_ref = E); sides (1,2) free.

Driven through the SHIPPED, validated single-patch driver
  /opt/gismo/build/bin/buckling_shell_XML
which assembles K_L, does the prebuckling solve, assembles K_NL at the deformed
config, and runs gsBucklingSolver -> K_geom = K_NL - K_L is gismo's OWN (shares
no code with the BB element). sigma_cr = |lambda_1| * E ;  N_cr = sigma_cr * t.

Geometry is an EXACT cylinder panel: quadratic rational Bezier arc in u (theta),
linear in v (axial), middle-CP weight = cos(phi). Driver degree-elevates (-e) and
h-refines (-r); we sweep -r to converge the reference.

Run (in aeris/gismo:v25.07.0):
  docker run --rm -v "${PWD}/bb:/bb:rw" -w /bb/cpp aeris/gismo:v25.07.0 \
    python3 segment_panel_nurbs_lba.py
"""
import math, re, subprocess, sys, tempfile
from pathlib import Path

R, L, phi = 1.0, 1.0, 0.6
E, nu = 1.0e6, 0.3
EXE = "/opt/gismo/build/bin/buckling_shell_XML"

c, s = math.cos(phi), math.sin(phi)
# CP grid, u (theta) fastest then v (axial). Arc: P0@-phi, P1=tangent intersection, P2@+phi.
cps = [  # v=0 (z=0)
    (R * c, -R * s, 0.0), (R / c, 0.0, 0.0), (R * c, R * s, 0.0),
    # v=1 (z=L)
    (R * c, -R * s, L), (R / c, 0.0, L), (R * c, R * s, L),
]
wts = [1.0, c, 1.0, 1.0, c, 1.0]

coefs = "\n".join(f"    {x} {y} {z}" for (x, y, z) in cps)
weights = "\n".join(str(w) for w in wts)

multipatch = """<MultiPatch parDim="2" id="0">
<patches type="id_range">9991 9991</patches>
  <interfaces>
</interfaces>
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
     <KnotVector degree="2">0 0 0 1 1 1 </KnotVector>
    </Basis>
    <Basis type="BSplineBasis" index="1">
     <KnotVector degree="1">0 0 1 1 </KnotVector>
    </Basis>
   </Basis>
   <weights>{weights}
</weights>
  </Basis>
  <coefs geoDim="3">
{coefs}
</coefs>
</Geometry>"""

loads = """<Function type="FunctionExpr" id="21" tag="Loads" dim="3">
  <c> 0 </c><c> 0 </c><c> 0 </c>
</Function>
<Matrix rows="2" cols="0" id="30" tag="Loads" ></Matrix>
<Matrix rows="3" cols="0" id="31" tag="Loads" ></Matrix>
<Matrix rows="1" cols="0" id="32" tag="Loads" ></Matrix>"""

refs = """<Matrix rows="2" cols="1" id="50" >
0.5
0.5
</Matrix>
<Matrix rows="1" cols="1" id="51" >0</Matrix>
<Matrix rows="0" cols="0" id="52" ></Matrix>"""

def build_xml(t, shift):
    Tz = t * E  # tensile axial line force => uniform sigma_ref = E
    material = f"""<MaterialMatrix type="Linear3" id="10" TFT="false">
  <Thickness><Function type="FunctionExpr" dim="3" index="0">{t}</Function></Thickness>
  <Density><Function type="FunctionExpr" dim="3" index="0">1</Function></Density>
  <Parameters>
    <Function type="FunctionExpr" dim="3" index="0">{E}</Function>
    <Function type="FunctionExpr" dim="3" index="1">{nu}</Function>
  </Parameters>
</MaterialMatrix>"""
    bcs = f"""<boundaryConditions id="20" multipatch="0">
  <Function type="FunctionExpr" dim="3" index="0">
  <c> 0 </c><c> 0 </c><c> 0 </c>
  </Function>
  <Function type="FunctionExpr" dim="3" index="1">
  <c> 0 </c><c> 0 </c><c> {Tz} </c>
  </Function>
  <bc type="Dirichlet" function="0" unknown="0" component="-1">
    0 3
  </bc>
  <bc type="Neumann" function="1" unknown="0">
    0 4
  </bc>
</boundaryConditions>"""
    opts = f"""<OptionList id="94">
<int label="solver" desc="Spectra buckling mode" value="3"/>
<int label="selectionRule" desc="LargestMagn" value="0"/>
<int label="sortRule" desc="SmallestMagn for output" value="4"/>
<real label="shift" desc="spectral shift" value="{shift}"/>
<int label="ncvFac" desc="ncv multiplier" value="3"/>
<real label="tolerance" desc="solver tol" value="1e-10"/>
<bool label="verbose" desc="verbosity" value="0"/>
</OptionList>

<OptionList id="92">
<int label="Continuity" desc="iface continuity" value="0"/>
<real label="IfcPenalty" desc="penalty" value="1e6"/>
</OptionList>"""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<xml>
{multipatch}

{geometry}

{material}

{bcs}

{loads}

{refs}

{opts}
</xml>
"""


EIG = re.compile(r"^\s+([-+0-9.eE]+)\s*$")


def run(xml_path, r, e, nmodes=12):
    cmd = [EXE, "-i", str(xml_path), "-r", str(r), "-e", str(e), "-N", str(nmodes)]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if res.returncode != 0:
        sys.stderr.write(res.stdout[-3000:]); sys.stderr.write(res.stderr[-3000:])
        raise RuntimeError(f"driver exited {res.returncode}")
    eigs, cap = [], False
    for line in res.stdout.splitlines():
        if "First" in line and "eigenvalues" in line:
            cap = True; continue
        if not cap:
            continue
        m = EIG.match(line)
        if m:
            try: eigs.append(float(m.group(1)))
            except ValueError: pass
        elif eigs:
            break
    return eigs


def smallest_positive(eigs, floor=1e-9):
    pos = sorted(x for x in eigs if math.isfinite(x) and x > floor)
    return pos[0] if pos else None


def sigma_cr_at(t, r, e_elev=2):
    # shift ~ expected normalised eigenvalue; scale with t (sigma_cr ~ t for these
    # panels) so Spectra hunts near the smallest physical mode at every thickness.
    shift = max(2.0e-3 * (t / 0.05), 1e-5)
    with tempfile.NamedTemporaryFile("w", suffix=".xml", delete=False, dir="/tmp") as f:
        f.write(build_xml(t, shift)); xml_path = Path(f.name)
    try:
        eigs = run(xml_path, r=r, e=e_elev)
    finally:
        xml_path.unlink()
    lam = smallest_positive(eigs)
    return (None, None) if lam is None else (abs(lam) * E, abs(lam) * E * t)


def main():
    r = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    print("NURBS panel LBA (independent reference) — gsThinShellAssembler + gsBucklingSolver")
    print(f"  R={R} L={L} phi={phi} E={E:g} nu={nu}.  Bottom arc Dirichlet u=0; top Neumann Tz=t*E; sides free")
    print(f"  SLENDERNESS SWEEP at r={r}, degree elevation e=2 (base degree (4,3))\n")
    print(f"  {'t':>6} {'R/t':>6} {'sigma_cl':>12} {'sigma_cr(NURBS)':>16} {'N_cr=s*t':>14}")
    for t in (0.2, 0.1, 0.05, 0.02):
        sigma_cl = E * t / (R * math.sqrt(3 * (1 - nu**2)))
        sig, Ncr = sigma_cr_at(t, r)
        if sig is None:
            print(f"  {t:>6g} {R/t:>6.0f} {sigma_cl:>12.6g}  NO POSITIVE EIGENVALUE")
            continue
        print(f"  {t:>6g} {R/t:>6.0f} {sigma_cl:>12.6g} {sig:>16.8g} {Ncr:>14.8g}")
    print("\nThis sigma_cr / N_cr is the absolute panel target for the BB segment LBA at each R/t.")


if __name__ == "__main__":
    main()
