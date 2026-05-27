# Scordelis-Lo Roof

Static linear Kirchhoff-Love shell benchmark from the Belytschko
"obstacle course" (Belytschko, Stolarski, Liu, Carpenter, Ong 1985).
**Status: PASS**, |err| = 0.031 % at r=6.

## Problem statement

A cylindrical-segment roof loaded by its own weight, supported on rigid
diaphragms at the two curved ends, free along the two straight side
edges ("eaves"). Tests membrane-dominated bending with significant
bending near the free edges — the canonical cross-check that a thin
shell formulation handles mixed membrane/bending response, not just
pure membrane or pure bending.

### Geometry

- Radius `R = 25`, length `L = 50`, thickness `t = 0.25`
- Half-subtended angle `φ = 40°` (full arc spans 80°)
- Axis along `x`, arc in `y-z` plane
- 1 NURBS patch, biquadratic in `u` and `v`, 3×3 control points
  (the canonical `/opt/gismo/filedata/surfaces/scordelis_lo_roof.xml`)
- `aspect ratio L/R = 2`, `R/t = 100`

### Material

- Isotropic linear elastic, `E = 4.32×10⁸`, **`ν = 0` (exactly)**
- Saint-Venant Kirchhoff (`gsMaterialMatrixLinear`)

### Loading

- Surface dead-load `(0, 0, -90)` per unit shell area (gravity,
  vertical-downward)

### Boundary conditions

- **Diaphragm ends** (sides west + east, `u=0` + `u=1`):
  `u_y = u_z = 0` — constrains motion in the diaphragm plane, allows
  axial sliding.
- **Corner pin** at south-west (`u=v=0`): `u_x = 0` — single point
  constraint to remove the axial rigid-body translation that the
  diaphragm BCs leave free.
- **Free edges** (sides south + north, `v=0` + `v=1`): no BC.

### Quantity of interest

Vertical displacement `u_z` at the midpoint of the free edge at `v=1`
("south eave"), parametric `(u=0.5, v=1)`, undeformed physical
`(25, -32.139, 0)`.

### Reference value

- **`|u_z| = 0.3006` for Kirchhoff-Love shells** — our target,
  because `gsKLShell` is shear-rigid.
- `|u_z| = 0.3024` for Reissner-Mindlin (shear-deformable) shells —
  **not** our target, even though it's the more commonly cited
  number. Mixing the two reference values is the easy way to chase
  a phantom 0.6 % error that's actually a model-class confusion.

## Result

Convergence sweep over h-refinement levels `r` (each `+1` halves the
element size in both directions; biquadratic NURBS basis throughout).

| r | `|u_z|`     | err vs KL | wall ms |
|---|-------------|-----------|---------|
| 0 | 0.02339328  | +92.218 % |    192  |
| 1 | 0.02776285  | +90.764 % |    185  |
| 2 | 0.07344063  | +75.569 % |    203  |
| 3 | 0.24150531  | +19.659 % |    202  |
| 4 | 0.29580975  |  +1.594 % |    259  |
| 5 | 0.30015339  |  +0.149 % |    498  |
| 6 | 0.30050637  |  +0.031 % |   2139  |

**Verdict: PASS** — `|u_z|(r=6) = 0.30051` vs reference `0.3006`,
relative error `0.031 %`, well inside the 2 % tolerance band.

### Interpretation

Convergence is monotonic from below — the coarse-mesh solution is
**too stiff** (under-predicts the displacement), which is the expected
behaviour for a biquadratic NURBS basis on a curved geometry with a
free edge. At low `r` the basis cannot resolve the bending wavelength
near the free edge, so the shell appears stiffer than it is. As `r`
grows the basis captures the bending mode, the membrane stress
redistributes correctly, and `u_z` settles onto 0.3006.

What this test **does not show** (because it's single-patch):

- Multipatch C¹ continuity under bending. The Belytschko obstacle
  course is famous for distinguishing element classes that pass
  single-patch tests but fail under realistic geometries with seams.
  A planned multipatch variant of this benchmark (split the arc into
  4 patches in `v`) will be the cross-check that our `gsSmoothInterfaces`
  coupling transfers bending moment correctly across seams. The
  Session-2.7 `cylinder_lba.py` validation showed the coupling works
  under buckling; a Scordelis-Lo-multipatch will show it works under
  pure static bending.

What this test **does show**:

- The static linear KL-shell solve path (`static_shell_XML` driver,
  `gsThinShellAssembler` + `gsMaterialMatrixLinear`, default
  `gsStaticNewton` linear solver) is wired correctly.
- The membrane / bending split, the Poisson-free isotropic material,
  the surface body force, and the mixed Dirichlet / free BC pattern
  all give the right physical response.
- IGA convergence rates kick in around `r=4` and reach 4-digit
  accuracy by `r=6` — the algorithm is sound, no shear / membrane
  locking in this geometry.

## How to run

From the repo root, host-side (Docker Desktop running, `aeris/gismo`
image built):

```powershell
docker run --rm -v "$(pwd)/benchmarks:/benchmarks:rw" `
  aeris/gismo:v25.07.0 `
  python3 /benchmarks/scordelis_lo/scordelis_lo.py
```

Quick smoke test (single coarse run, ~0.2 s):

```powershell
docker run --rm -v "$(pwd)/benchmarks:/benchmarks:rw" `
  aeris/gismo:v25.07.0 `
  python3 /benchmarks/scordelis_lo/scordelis_lo.py --quick
```

Custom refinement list:

```powershell
docker run --rm -v "$(pwd)/benchmarks:/benchmarks:rw" `
  aeris/gismo:v25.07.0 `
  python3 /benchmarks/scordelis_lo/scordelis_lo.py -r 4 -r 5 -r 6
```

## References

- Belytschko, T., Stolarski, H., Liu, W.K., Carpenter, N., Ong, J.S.J.
  (1985). "Stress projection for membrane and shear locking in shell
  finite elements." *Computer Methods in Applied Mechanics and
  Engineering* 51(1-3), 221-258.
- Scordelis, A.C. and Lo, K.S. (1964). "Computer analysis of cylindrical
  shells." *J. Am. Concrete Inst.* 61, 539-561.
- MacNeal, R.H. and Harder, R.L. (1985). "A proposed standard set of
  problems to test finite element accuracy." *Finite Elements in
  Analysis and Design* 1(1), 3-20.
- G+Smo canonical example: `optional/gsKLShell/tutorials/linear_shell.cpp`
- G+Smo geometry file: `filedata/surfaces/scordelis_lo_roof.xml`
