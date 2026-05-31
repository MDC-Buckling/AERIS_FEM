# Scordelis-Lo Roof — Multipatch (smooth G¹ moment transfer)

Static linear Kirchhoff-Love shell benchmark. Same problem as the
single-patch [`scordelis_lo`](../scordelis_lo/) case, but the roof is
built as **two patches with an internal seam**, coupled to a globally
smooth basis by `static_shell_multipatch_XML -m 0` (`gsSmoothInterfaces`).
**Status: PASS**, |err| = 0.016 % at r=5, seam C⁰ gap = 0.

## Why this benchmark exists

Until now the `gsSmoothInterfaces` G¹ coupling was validated **only under
buckling pre-stress** — the cylinder axial LBA brackets classical within
±1 % and returns clean sin/cos eigenvalue doublets. That proves moment
transfer across seams works when the seam sits in a geometric-stiffness
field. It does **not** prove it under a plain static bending load.

The single-patch Scordelis-Lo PASSES at 0.031 %, but by construction it
has **no seam** — it cannot test inter-patch moment transfer at all. This
benchmark closes that gap: it is the minimal decisive test of "does a
bending moment cross a smooth-coupled seam correctly under static load?"

It is the **Phase-0 gate** for the Bernstein-Bézier triangle programme,
which leans on the identical seam (`gsThinShellAssembler` +
`gsMappedBasis` + smooth coupling). If moment transfer were broken under
static bending, the whole BB plan would inherit the bug — so we de-risk
it here, with cheap existing machinery, before writing any BB code.

## Problem statement

Geometry, material, load, BCs, and reference value are **identical** to
the single-patch case (see [`../scordelis_lo/README.md`](../scordelis_lo/README.md)
for full provenance):

- `R = 25`, `L = 50`, `t = 0.25`, half-angle `φ = 40°`
- `E = 4.32×10⁸`, **`ν = 0` (exactly)**, Saint-Venant Kirchhoff
- Surface dead-load `(0, 0, -90)` per unit area
- Diaphragm ends (the two curved arcs): `u_y = u_z = 0`, `u_x` free
- Free eaves (the two straight edges): no BC
- Corner pin (one point): `u_x = 0`, removes the axial rigid-body mode
- QoI: vertical displacement `u_z` at the free-edge midpoint, parametric
  `(x = L/2, eave at v=1)`, physical `(25, -32.139, 0)`
- Reference: **`|u_z| = 0.3006`** for a Kirchhoff-Love (shear-rigid)
  shell — *not* the 0.3024 Reissner-Mindlin value

## The only design choice — where to put the seam

Split along the **length (x / u-direction)** at **x = L/3**.

- **Off the symmetry plane.** The barrel vault spans `L` between the two
  end diaphragms, so the longitudinal bending moment `M_x` and the
  longitudinal slope `dw/dx` are both **non-zero at x = L/3**. At the
  symmetry plane `x = L/2` the slope is zero by symmetry — a seam there
  could let a lost-continuity hinge hide behind the symmetry condition.
  At `x = L/3` a C⁰ hinge cannot hide: it would show up as a kink and a
  wrong displacement.
- **QoI off the seam.** The free-edge midpoint at `x = L/2` is **interior
  to patch 1**, never on the seam — so we measure the coupled solution,
  not a seam artefact.
- **Exact geometry.** The NURBS weights live only in the arc direction;
  the x-direction is polynomial. Splitting it at `u = 1/3` is an exact
  de-Casteljau subdivision, so a geometry-construction error can never be
  mistaken for a coupling bug in this gate.

```
        free eave (v=1)  ← QoI at x=L/2 (interior to patch 1)
   x=0 ┌────────────┬──────────────────────┐ x=L
diaph. │  patch 0   │       patch 1        │ diaph.
(side1)│  x∈[0,L/3] │     x∈[L/3, L]       │(side2)
       └────────────┴──────────────────────┘
        free eave (v=0)   ↑ seam at x=L/3 (off L/2 symmetry plane)
                          patch0 side2 ↔ patch1 side1, gsSmoothInterfaces
```

**Stronger follow-up:** a *circumferential* (arc-direction) split would
test transfer of the circumferential moment `M_θ` that dominates near the
free edge. It requires splitting the rational arc and is the natural next
multipatch case once this one is green.

## Result

`gsSmoothInterfaces` (`-m 0`) with one degree elevation (`-e 1`, native
biquadratic → degree 3, mirroring the validated cylinder-LBA smooth-basis
setup). Convergence sweep over h-refinement `r`:

| r | `\|u_z\|`    | err vs KL | seam C⁰ gap | wall ms |
|---|-------------|-----------|-------------|---------|
| 2 | 0.27978611  | +6.924 %  | 0.000e+00   |   328   |
| 3 | 0.29999769  | +0.200 %  | 0.000e+00   |   359   |
| 4 | 0.30053984  | +0.020 %  | 0.000e+00   |   492   |
| 5 | 0.30055167  | **+0.016 %** | 0.000e+00 |  1109   |

**Verdict: PASS** — `|u_z|(r=5) = 0.30055` vs reference `0.3006`,
relative error `0.016 %`, well inside the 2 % band.

### Interpretation

- **Agrees with single-patch.** The single-patch case converges to
  `0.30051`; this multipatch case converges to `0.30055`. The two agree
  to ~0.013 % — the seam introduces no measurable error. That agreement
  **is** the test: moment transfer across the smooth-coupled seam under
  static bending is correct.
- **Seam stays joined.** The C⁰ gap — the Euclidean distance between the
  two patches' deformed positions at the shared `(v=1)` seam endpoint —
  is exactly `0` at every refinement. The basis is continuous across the
  seam; there is no hinge.
- **Monotone from below.** Like the single-patch case, coarse meshes are
  too stiff (under-predict), converging up onto `0.3006` as the basis
  resolves the bending field. No soft mode (which would overshoot) and no
  locking (which would stall below). The degree-3 smooth basis reaches
  4-digit accuracy by `r=4`, faster than the single-patch degree-2 basis
  (which needed `r=6`).

This is the first confirmation that `gsSmoothInterfaces` transfers a
bending moment across a seam under a **static** load, not just under
buckling pre-stress. The seam used here parallels the seams a future
BB-triangle mesh will carry.

## How to run

From the repo root (Docker Desktop running, `aeris/gismo:v25.07.0` built):

```powershell
docker run --rm -v "${PWD}/benchmarks:/benchmarks:rw" `
  aeris/gismo:v25.07.0 `
  python3 /benchmarks/scordelis_lo_multipatch/scordelis_lo_multipatch.py
```

Quick smoke test (single `-r 3` run):

```powershell
docker run --rm -v "${PWD}/benchmarks:/benchmarks:rw" `
  aeris/gismo:v25.07.0 `
  python3 /benchmarks/scordelis_lo_multipatch/scordelis_lo_multipatch.py --quick
```

The sweep prints a per-`r` table with the seam C⁰ gap as a continuity
diagnostic, then a PASS/FAIL verdict and an explicit single-patch
comparison.

## References

Same as the single-patch case — Belytschko et al. (1985), Scordelis & Lo
(1964), MacNeal & Harder (1985). Smooth multipatch coupling:
`gsUnstructuredSplines::gsSmoothInterfaces` → `gsMappedBasis` →
`gsThinShellAssembler::setSpaceBasis`.
