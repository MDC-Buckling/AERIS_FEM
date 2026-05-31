# Aeris — Bernstein-Bézier triangle elements (BB programme)

Adding Ludwig/Hühne (2018) Bernstein-Bézier triangle shell elements to
Aeris's G+Smo KL-shell stack. Methodology: Ludwig, *Bernstein-Bézier FE
Formulation for Anisogrid-Stiffened Shells*, Diss. TU Braunschweig.

The assembler (`gsThinShellAssembler`), material, and all solvers are
basis-generic at the `setSpaceBasis(gsFunctionSet&)` seam (no tensor
down-cast) — so the work is a new local basis + triangle quadrature + a
global C¹ map exported as a `gsMappedBasis`, NOT a new assembler. What is
absent from G+Smo v25.07.0 and must be built: any simplex `gsBasis`,
triangle quadrature, barycentric Bernstein evaluation (`gsBernsteinBasis`
is forward-declared only). Default degree **p = 5** (Ludwig 9.3.2:
p ≥ 5 avoids membrane locking on arbitrary triangulations).

## Phase status

| Phase | What | Status |
|---|---|---|
| 0 | GATE — Scordelis-Lo **multipatch** (smooth-coupled seam under static bending) | ✅ **GREEN** — `benchmarks/scordelis_lo_multipatch/`, 0.016 % at r=5, seam C⁰ gap 0 |
| 1 | SPIKE — local BB basis eval/deriv/**deriv2** (standalone, proven) | ✅ **GREEN** — this dir; see below |
| 2 | Triangle quadrature + domain iterator (rule correctness, standalone) | ✅ **GREEN** — this dir; see below |
| 3 | **Custom BB-element assembler** — basis port, K_e, plumbing | ✅ **GREEN** (single-element physics + solver wiring + C⁰ assembly) |
| 4 | Global C¹ map (Cᵀ K C) → multi-triangle SS-plate | ✅ **GREEN** — SS-plate converges at optimal O(h^(p+1)); C¹ coupling proven (flat) |
| 5 | Triangle geometry XML I/O | — |
| 6 | Benchmarks + Code_Aster (DKT/DKTG) cross-check | — |

## Phase 1 — local basis (DONE)

`bb_triangle_basis.py` — pure-stdlib (no numpy), accepts real OR complex
`xi` so derivatives can be verified by complex-step. Provides per-function
(`eval_one`/`deriv_one`/`deriv2_one`) and batched G+Smo-layout
(`eval_into`/`deriv_into`/`deriv2_into`) APIs. Analytic 1st + 2nd
derivatives via the affine `xi -> (lam0,lam1,lam2)` map; the deriv2
formulas are in the module docstring (port them verbatim to C++ in
Phase 3 and re-run this same suite).

`test_bb_triangle_basis.py` — the proof gate. Run (no host Python; use
the container's python3):

```powershell
docker run --rm -v "${PWD}/bb:/bb:rw" -w /bb aeris/gismo:v25.07.0 `
  python3 test_bb_triangle_basis.py
```

Proven correct for **p = 1..6**, worst case across all degrees:

| check | worst \|err\| |
|---|---|
| T1 partition-of-unity (value / grad / hess) | 4e-16 / 1e-15 / 9e-15 |
| T2 linear precision (Bernstein identity) | 2e-16 |
| T3 `deriv` vs complex-step of `eval` | 9e-16 |
| **T4 `deriv2` vs complex-step of `deriv`** (rigorous) | **1.4e-14** |
| T5 `deriv2` vs Richardson FD of `eval` (independent) | 3.1e-09 |
| T6 mixed-partial symmetry | 7e-15 |

T4 (machine precision) and T5 (independent estimator, < 1e-8 acceptance)
agree → `deriv2_into` is proven.

## Phase 2 — triangle quadrature (DONE)

`bb_triangle_quadrature.py` — pure stdlib. **Collapsed-coordinate (Duffy)
Gauss-Legendre** rule over hard-coded 1D GL tables (n=1..8), NOT minimal-
symmetric Xiao-Gimbutas. Rationale: the symmetric minimal rules come from
a nonlinear moment-matching optimisation and can't be reconstructed to
working precision by hand, so a mis-typed digit would fail the monomial
test with no oracle. The 1D GL table IS verifiable (closed forms for
n<=3 + the monomial test) and ports verbatim to C++. The Duffy rule meets
every hard requirement — positive weights, strictly interior points,
exact to total degree 2(p-1) (the membrane-binding limit for stiffness),
no optimisation. Trade-off: more points (n^2 vs the symmetric minimum)
and no S3 symmetry — a point-count/symmetry concern, not correctness.
Dropping Ludwig's symmetric tables in later is a same-interface swap
gated by this same monomial test.

`test_bb_triangle_quadrature.py` — the gate. Proven for p=1..6
(D = 2(p-1) up to 10):

| check | result |
|---|---|
| Q1 weight-sum == area(1/2) | ~1e-16 |
| Q2 positivity (min weight) | > 0 (>= 2.5e-4) |
| Q3 interiority (min barycentric) | > 0 (>= 1.1e-3) |
| Q4 monomial exactness to 2(p-1) | ~1e-16 |
| Q6 domain iterator vs hand calc | ~1e-15 |

Q5 (degree overshoot) is informational, not a gate — sharpness is not a
correctness property and the collapsed rule's exact degree can exceed
the nominal (the 1-pt centroid rule is degree-1 exact).

**Caveat carried to Phase 3 (per the brief):** the KL integrand is NON-
polynomial even on flat elements (sqrt in the normal normalisation
||a3||), so monomial exactness is the rule's UNIT test, not the physical
acceptance criterion. The real acceptance — integration error dominated
by discretisation error — only appears in the Phase-3 convergence study;
if an integration-error plateau shows there, the one-degree-higher rule
is the lever. Start at 2(p-1).

**Phases 1 + 2 gates GREEN.**

## Phase 3 — architecture verdict + C++ port (in progress)

### Verdict: custom element assembler (NOT through gsThinShellAssembler)

Reconnaissance of the real source (image) decided the A-vs-B question:

- `gsExprAssembler::assemble()` integrates every cell by
  `QuRule->mapTo(domIt.lowerCorner(), domIt.upperCorner(), ...)` — an
  affine map of a reference rule onto an axis-aligned **box**.
- `gsQuadrature::getPtr(basis,...)` returns ONLY tensor rules
  (Gauss/Lobatto/Patch), sized from `numNodes(domain,...)`. No hook to
  inject a triangle rule, no non-box `mapTo`.
- There is no simplex `gsDomain`. G+Smo's "unstructured" path lays a
  smooth `gsMappedBasis` over **quad** patches and still integrates on
  quad boxes — which is exactly why it composes with the assembler and
  why triangles do not.

So a triangle element cannot ride `gsThinShellAssembler` without invasive
surgery on validated gismo core (rejected: fork/maintenance/upstream
divergence). The collapsed-quad alternative reintroduces the Jacobian
singularity Ludwig's triangle BB exists to avoid (rejected).

**§0 correction:** the row "reuse gsThinShellAssembler unchanged" was too
optimistic. Corrected reuse boundary:

| piece | reuse? |
|---|---|
| material law `gsMaterialMatrixLinear::eval3D_matrix` (A/B/D point-wise) | ✅ reuse, basis-agnostic |
| solvers (linear/eigen/arc-length) | ✅ reuse (consume assembled K/M) |
| C¹ map (Ludwig 6.3) as congruence Cᵀ K C on assembled K | ✅ compose from outside — the custom loop is the natural place |
| `gsThinShellAssembler` element loop (gsExprAssembler) | ❌ box/tensor-only |
| KL strain-displacement B_m, B_b | ❌ **build** — this is the BB element |

Strain helpers in `gsThinShellFunctions.hpp` are expression-template
bound (`E_m = 0.5*(flat(jac(def).tr()*jac(def))-...)`, evaluated lazily by
`gsExprEvaluator`) → not point-wise extractable. BUT the point-wise metric
toolkit in `gsMaterialMatrixBaseDim` (`_getAcov/_getBcov/_getncov`,
covariant 1st/2nd fundamental form + normal) is the convention to
**reproduce** in the element so strains and the `eval3D_matrix` A/B/D
share one metric convention (sign consistency).

### C++ port step — DONE (GREEN)

`cpp/bb_triangle_basis.hpp` (templated on T for complex-step) +
`cpp/bb_triangle_quadrature.hpp` — verbatim port of the Phase-1/2 Python.
`cpp/test_bb_local.cpp` re-runs the SAME proof suites; build + run:

```powershell
docker run --rm -v "${PWD}/bb:/bb:rw" -w /bb/cpp aeris/gismo:v25.07.0 `
  bash -c "g++ -std=c++17 -O2 test_bb_local.cpp -o t && ./t"
```

All checks PASS at machine precision, matching the Python proofs (deriv2
vs complex-step 7e-15, vs Richardson 5e-9; monomial exactness 1e-16;
domain-iterator hand-calc 2e-15). The port is faithful.

### B-matrices (B_m, B_b incl. dn) — DONE (GREEN), gismo-free

Spec: `SPEC_b_matrices.md` (Ludwig 4.54–4.61, two thesis typos corrected:
4.54 δ²i→δ³i, 4.59 a_βj→a_βi). Code: `cpp/bb_kl_strains.hpp` (templated on
T for complex-step) + `cpp/test_bb_strains.cpp`. Build:

```powershell
docker run --rm -v "${PWD}/bb:/bb:rw" -w /bb/cpp aeris/gismo:v25.07.0 `
  bash -c "g++ -std=c++17 -O2 test_bb_strains.cpp -o t && ./t"
```

Gates GREEN, p=2..5, two independent methods (machine precision):
- G1 membrane rigid translation → eps_m=0 (2e-15)
- G2 B_m vs complex-step (9e-16)
- G3 finite rigid translation+rotation → eps_m=0 AND kappa=0 (3e-15, frame
  invariance — independent of complex-step)
- G4 B_b vs complex-step INCL. dn (4e-15) — validated at u=0 (dn inert)
  AND at a deformed state (a_α,β≠0 → dn active). The dn FORMULA is proven
  standalone; the geometric dn check (rigid rotation on a CURVED reference,
  A_α,β≠0) stays staged for the cylinder LBA.

(info) max|A_α,β| on the flat affine patch = 5e-15 → confirms the staging:
dn machinery inert at the flat reference, B_b = −N_k,αβ a₃i there.

### Material-frame convention — PROBED (DECISIVE)

`cpp/probe_material_frame.cpp` — first gismo-linked build. Direct g++ link
works (no CMake-glob needed):
```powershell
docker run --rm -v "${PWD}/bb:/bb:rw" -w /bb/cpp aeris/gismo:v25.07.0 bash -c `
 'g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional `
  -I/opt/gismo/external probe_material_frame.cpp -L/opt/gismo/build/lib -lgismo `
  -Wl,-rpath,/opt/gismo/build/lib -o p && ./p'
```
**eval3D_matrix returns the METRIC-WEIGHTED curvilinear constitutive**, NOT
the orthonormal/Cartesian matrix. Evidence: on an axis-aligned patch A ==
textbook plane-stress (4e-11); on a SHEARED flat patch A is fully populated
and != textbook (||err||=1.1e5). (My source-reading guess of "Cartesian"
from the cartcov/cartcon snippet was WRONG — that snippet is the Nitsche
stabilization helper, not the main pairing. The probe corrected it; the
sheared patch was what forced the difference out, axis-aligned hides it.)

Consequence: pair eval3D's A/D **directly with the covariant Voigt strains
E_αβ, κ_αβ — no frame transform.** And since the constitutive depends only
on the first fundamental form (metric), I can feed eval3D a flat affine
gismo quad whose tangents a_1,a_2 match my element's metric and get correct
A/D even for a CURVED element — gismo never represents the triangle, only
its metric. Residual cylinder check: whether eval3D's D carries a
through-thickness shifter (∝ z·b, O(t/R)); irrelevant on the flat plate.

### Element stiffness K_e — DONE (GREEN), single element

`cpp/test_bb_Ke.cpp` (gismo-linked). Per element: flat gismo quad with
tangents = my a_1,a_2 → eval3D A/B/D (metric-weighted) → paired DIRECTLY
with covariant B_m,B_b → K_e = ∫(B_mᵀA B_m + B_bᵀD B_b) (B coupling = 0,
symmetric layer). Gates p=3,4,5, machine precision, on a SHEARED flat
element (non-trivial metric):
- K1 K_e symmetry (1e-16)
- K2 six rigid-body zero-energy modes — 3 trans + 3 rot (1e-16; rotations
  are linear fields, exactly represented; confirms B_b null space in K_e)
- K3 membrane energy U_FE = ½dᵀK_e d == analytic Cartesian (1e-16)  ← Gate 6
- K4 bending energy == analytic Cartesian (1e-16)  ← Gate 5
  (exact quadratic Bezier coefs via degree-elevation recurrence)

Non-circular: FE side uses my covariant B + gismo's metric-weighted C;
analytic side is the textbook Cartesian energy. **VERDICT: the eval3D
metric-weighted reuse HOLDS in K_e practice** — pair A/D directly with
covariant strains, no frame transform. The element PHYSICS is pinned.

### Plumbing — DONE (GREEN)

`cpp/test_bb_plumbing.cpp` (gismo-linked). p=3,4,5:
- P1 single-element membrane patch test: prescribe boundary CPs to a
  constant-strain (linear) field, zero load, solve interior → reproduces
  EXACTLY (~1e-18). Validates Dirichlet partition + linear solve.
- P2 two-triangle global assembly: shared-edge C⁰ DOF map (p+1 edge CPs
  identified by (i,j)) + scatter → global K symmetric (~2e-16) + 6
  rigid-body zero-energy modes (~1e-16). globalCP = 2·nK−(p+1). Gated on
  assembly-correctness ONLY (NOT convergence — a C⁰ mesh hinges).

**Phase 3 COMPLETE.** The global DOF map exists → the space the Phase-4
C¹ map C lives in is ready.

### Phase 4 — C¹ map (spec `SPEC_c1_coupling.md`, Ludwig 6.3)

C¹ map = congruence Cᵀ K_full C. Build order: continuity functional → C →
cross-check → gates → SS-plate.

**Step 1 — continuity functional g_k: DONE (GREEN), gismo-free.**
`cpp/test_bb_c1_continuity.cpp`. The C¹ condition (flat plate) is continuity
of the normal slope ∂w/∂ν across the shared edge; jump(s) = Σ(∇N_k⁺·ν)w_k⁺ −
Σ(∇N_k⁻·ν)w_k⁻ (= the spec's g_k). Anchored independently (self-corrects
sign/orientation/reversal): a global smooth quadratic → jump ~1e-15 (→0); a
kinked C⁰ field (slave linear in edge-distance) → jump = 1.5 exactly (≠0),
p=3,4,5. Consistent orientation handled: neighbours traverse the edge
oppositely → T⁺ samples (s,0), T⁻ samples (1−s,0); edge CP (i,j,0)⁺ ↔ (j,i,0)⁻.

**Step 2 — per-side C + cross-check: DONE (GREEN), gismo-free.**
`cpp/test_bb_c1_buildC.cpp`. C expresses slave adjacent-row DOFs (ℚ) via
edge+master-adj (ℙ): u_ℚ = −H_ℚℚ⁻¹H_ℚℙ. Partition FIXED to slave-row-dependent
(NOT free-pivot) so entries match Farin directly. Two independent builds:
- Weighted-Residual: H_kl = ∫_L g_k g_l (Gram of the slope-jump functional)
- Farin (geometric, no g_k): sadj[j] = u·edge[j]+v·edge[j+1]+w·madj[j],
  (u,v,w) = bary(Vd; V0,V1,V2)
p=3,4,5: ‖C_WR − C_Farin‖ ~1e-15 (entry-for-entry), H_ℚℚ SPD (minpiv>0,
diagnoses slave-row g_k independence), both reproduce a global smooth field
(~1e-15). Two routes share no machinery → strong independent cross-check.

**Step 3 — interior-vertex over-constraint (triangle fan): DONE (GREEN), gismo-free.**
`cpp/test_bb_c1_fan.cpp`. Closed valence-6 fan (Vc + ring, 6 tris, 6 spoke
edges meeting at Vc → constraint redundancy). Global constraint matrix A
(6·p collocation rows × nCP), incomplete Gauss (free pivot, tol 1e-9) →
null-space basis C. p=3,4,5: redundancy=2 (over-constraint exists + found,
degree-independent = vertex-compatibility count), A·u_smooth ~1e-15 +
A·u_random ~O(10²) (anchors A: smooth field in null(A), generic not),
**‖A·C‖ ~1e-14 over ALL original rows** (the positive C¹ check — incomplete
Gauss dropped ONLY the 2 redundant constraints, no latent hinge; pivot
tolerance pinned). Necessary-AND-sufficient (not just "K not singular").
Free-pivot Gauss used HERE (global), not in the per-side C (step 2).

**Step 4+5 — patch consistency + SS-plate convergence: DONE (GREEN) = THE Phase-4 gate.**
`cpp/test_bb_c1_plate.cpp` (pure C++; D_cart == eval3D proven in K4; flat plate sturm-frei
→ the rate measures the coupling directly). Full C¹-coupled pipeline: mesh → DOF map →
K_full (bending) → global C¹ constraints (all interior edges) + SS BC → incomplete-Gauss
null-space C → K_indep = Cᵀ K_full C → load → solve → u_full = C u_indep.
- Patch consistency: a global quadratic (constant curvature) is in the C¹ space,
  ‖A_C1 u_quad‖ = 2.4e-16 (necessary for convergence; no seam exclusion).
- SS-plate (square, sinusoidal load = 1st Navier mode, p=5), relative **L2** error (robust;
  single center-point sampling is even/odd-noisy), h-refinement N=2..6: rate → **6.26 ≈
  O(h^(p+1)) = O(h^6) = OPTIMAL.** Monotone, clean.

On the sturm-frei flat plate an optimal rate proves the C¹ coupling cleanly (no
locking/integration confounders) — parallel to Scordelis-Lo-multipatch for quad C¹.
**The whole BB-triangle C¹ shell element is verified on the flat plate.**

**NOT yet validated (honest):** curved-reference physics. The cylinder LBA is the next
convergence point — δn active (A_α,β≠0), eval3D-on-curved-geometry metric, the
through-thickness shifter (Ludwig-frei), shear/membrane locking, curved-metric integration
all arrive there. We enter with the C¹ coupling already excluded as a suspect. A green flat
plate ≠ "element fully validated". G¹ at kinks/junctions (Ludwig Kap.7) = separate later spec.

The Weighted-Residual C¹ map (Ludwig 6.3) is Phase 4 and is specced
against the real interface once the SS-plate gate is green.
