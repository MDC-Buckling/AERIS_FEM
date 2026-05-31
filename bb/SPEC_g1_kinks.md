# Aeris BB — G¹ Kink Coupling Spec (Ludwig Ch 7)

Formula-exact, anchored to Thomas Ludwig (2018), Ch 7 *"Geometric Coupling and
Boundary Conditions"*. Companion to `SPEC_c1_coupling.md` (Ch 6, smooth regions).
Target: kinks / junctions — cone–cylinder, stiffener↔skin, folds.

---

## 0. CRITICAL — method choice: PENALTY, not static condensation

Ludwig presents **four** geometric-coupling methods for kinks:
7.1 Pure Penalty · 7.2 Static Condensation · 7.3 Mortar · 7.4 Nitsche.

The "recycle the C¹ master–slave congruence with a rotation R(β)" architecture is
Ludwig's **7.2 Static Condensation** (constrained control points + incomplete
Gauss elimination — exactly the Ch 6 machinery + a frame transform).

> **7.2 intro, verbatim intent:** the static-condensation method *"cannot be
> applied to shells or non-linear analysis: the coupling constraints are
> ill-conditioned."* It is restricted to **plates** (linear / free-vibration /
> linearized buckling of stiffened plates).

Cone–cylinder junctions are curved **shells** → master–slave recycling is the
WRONG method (ill-conditioned). For shells (and non-linear, and shell buckling)
use the **Pure Penalty method (7.1)** — this spec. Nitsche (7.4) is the
variationally-consistent alternative; see §7.

The penalty does **not** use a congruence transform CᵀKC or dependent-constraint
removal. It **adds** a penalty stiffness to K. What IS reused from the smooth
element is the per-edge frame and the director variation ∂a₃/∂u (= the Step-5 δn).

---

## 1. Kink geometry — rotated shell director (7.1.3)

"+" = first element, "−" = second. Per-side orthonormal edge frame:
`A_S` (common-side tangent), `A_N` (in-surface normal to the edge), `A₃` (surface
normal).

Θ = initial angle between the two surface normals (the kink angle β).
θ = deformed angle. φ = θ − Θ = angle change. **G¹ ⟺ φ = 0** (the kink angle is
preserved through deformation).

Continuity built on cos/sin (no inverse trig):

```
(7.1)   cosΘ = A₃⁺·A₃⁻                          cosθ = a₃⁺·a₃⁻
(7.2)   sinΘ = (A₃⁻×A₃⁺)·A_S = −A₃⁺·A_N⁻         sinθ = (a₃⁻×a₃⁺)·a_S = −a₃⁺·a_N⁻
```

Rotated shell director — rotate the "−" director about the common side by the
FIXED initial angle Θ:

```
(7.3)   Â₃⁻ = cosΘ·A₃⁻ − sinΘ·A_N⁻      [initial; = A₃⁺, since A₃⁺·Â₃⁻ = cos²Θ+sin²Θ = 1]
(7.4)   â₃⁻ = cosΘ·a₃⁻ − sinΘ·a_N⁻      [deformed; Θ is the FIXED initial angle]
(7.5)   a₃⁺ − â₃⁻ = 0                   [G¹ CONTINUITY CONDITION]
```

**SIGN / FRAME CONVENTION (pinned + verified in G0)**: use `a_N = a_S × a₃`, with
`a_S` in a GLOBALLY-CONSISTENT edge orientation on both sides (gA→gB, the same
discipline as the Step-9 seam), and BOTH surface normals oriented consistently
OUTWARD. Then (7.3) reproduces a₃⁺ exactly (the cosΘ·sinΘ terms cancel, the normal
component is cos²Θ+sin²Θ=1). With `a₃ × a_S` the sign of (7.2) flips and the
residual is corrupted; with an inconsistently-oriented slave normal Θ comes out as
π−Θ (the penalty would then enforce the wrong continuity). G0 gates both.

C⁰ (position continuity) is separate, via shared edge control points — as in the
smooth seam (Step 9). G¹ adds **only** the director coincidence (7.5).

---

## 2. Penalty enforcement (7.1.4)

Augment the energy with a penalty potential per internal side s:

```
(7.6)   Π^PENALTY = Σ_{e∈𝔼} Π_e + Σ_{s∈𝕊} Π_s
(7.7)   Π_s = ∫_L (κ/2) ‖a₃⁺ − â₃⁻‖² dL          [κ = penalty param, dL along the edge]
```

ℙ = control points involved in (7.7); k,l ∈ ℙ, i,j ∈ {1,2,3} (displacement comps):

```
(7.8)   ∂Π_s/∂u_ki   = ∫_L κ (∂a₃⁺/∂u_ki − ∂â₃⁻/∂u_ki)·(a₃⁺ − â₃⁻) dL        → internal force
(7.9)   ∂²Π_s/∂u_ki∂u_lj ≈ ∫_L κ (∂a₃⁺/∂u_ki − ∂â₃⁻/∂u_ki)·(∂a₃⁺/∂u_lj − ∂â₃⁻/∂u_lj) dL → tangent stiffness
```

(7.9) is **consistent for linear analysis** (the LBA-K case). For non-linear the
geometric (second-order) term is dropped — Ludwig reports no effect on Newton
convergence.

Director variation: ∂a₃/∂u_ki **is the Step-5 δn**. The rotated one follows by
differentiating (7.4) with Θ fixed:

```
∂â₃⁻/∂u_ki = cosΘ · ∂a₃⁻/∂u_ki − sinΘ · ∂a_N⁻/∂u_ki
```

(so the penalty also needs ∂a_N/∂u — a small extension of the δn apparatus: a_N =
a_S × a₃, ∂a_N/∂u = a_S × ∂a₃/∂u for a fixed edge tangent a_S, plus the ∂a_S/∂u
term if the edge tangent varies with u.)

K_penalty,s (from 7.9) is symmetric PSD, a small dense block on the ℙ DOFs,
**added** to global K. No dependent-constraint removal, no congruence — simpler
than the C¹ master–slave assembly.

**LBA note**: K_penalty goes into K_elastic (it is elastic continuity), NOT
K_geom. A too-large κ pollutes the spectrum with high-frequency penalty modes, so
the κ plateau (§3 / G0.5) must be read at the EIGENVALUE level for G3, not just
statically.

---

## 3. Penalty parameter (7.1.5)

```
(7.12)  κ = P · min(η⁺, η⁻)
(7.13)  η = C_T^{N3N3} · t · ε        [ε = t/R  cylindrical shells | t/L plates;
                                        C_T^{N3N3} = thickness-integrated transverse-shear
                                        modulus normal to the common side]
(7.14)  η = μ t³ / L                  [isotropic; μ = Lamé 2nd parameter, L = length measure]
```

P = non-dimensional scaling factor, set **once** by the analyst, applied to all
pairs. The ε factor makes P thickness-independent; η's force units make Π_s an
energy (unit-invariant, P needs no per-problem retuning).

---

## 4. Quadrature (7.1.6)

Gauss–Legendre along the edge, **p points** (p = max poly degree of the shape
functions at the side); exact to 2p−1. Integrand is non-polynomial but the error
is small (more points didn't change Ludwig's results). Reuses the Step-2 1D GL.

---

## 5. Reuse vs new

**REUSE (already built + validated):**
- per-edge orthonormal frame a_S, a_N, a₃  (v-form basis, Step 4/7)
- director variation ∂a₃/∂u  (the δn term, Step 5)
- per-edge GL quadrature  (Step 2)
- C⁰ shared-edge control points  (the seam mechanism, Step 9)

**NEW:**
- the fixed-Θ rotated director â₃⁻ = cosΘ a₃⁻ − sinΘ a_N⁻ (7.3–7.5) + its variation
- the penalty potential / force / stiffness (7.6–7.9), **additive to K**
- the penalty parameter κ = P·min(η⁺,η⁻) (7.12–7.14)

**NOT used** (vs the C¹ master–slave instinct): congruence CᵀKC, incomplete Gauss
elimination, dependent-constraint removal — those are the static-condensation
method (7.2), plates-only.

**Frame-invariance note**: the over-constraining-to-C¹ pitfall (7.2.3, the DOF
transform T=[a_S;a_N;a₃]) is specific to the *constraint* method — picking
discrete constraints from the derivatives can over-pick (X-aligned → 1 constraint,
rotated → 2 → accidentally C¹). The penalty acts on the **full vector residual**
a₃⁺−â₃⁻, which is frame-objective: it enforces the 2-DOF director coincidence (both
are unit vectors) = G¹, with no over-constraint. So the T transform is NOT needed
for the penalty.

---

## 6. Phase plan (mirrors the C¹ gate discipline)

- **G0 — flat fold patch test**: ✅ GREEN (`bb/cpp/test_bb_g1_fold.cpp`). Two flat
  patches at angle Θ; the rotated-director residual ‖a₃⁺−â₃⁻‖ is machine-zero for a
  kink-preserving motion (reference + rigid-body), nonzero for an incompatible
  re-fold; Θ-from-frames = fold angle (consistent outward normals); aN=aS×a₃ sign
  verified. Across Θ ∈ {0,30,90,150}°. Fold analog of Step-4 consistency.
- **G0.5 — penalty-parameter sweep (penalty-specific gate)**: vary P over decades;
  the result must **plateau** over a range (too low → continuity not enforced,
  residual gap; too high → ill-conditioning). The penalty method's analog of a
  convergence gate; no equivalent in master–slave. Read at the eigenvalue level for
  buckling (see §2 LBA note). Needs the penalty stiffness assembly (7.9 + ∂a_N/∂u).
- **G1 — moment transfer across the kink**: applied bending moment on "+" → correct
  reaction on "−" (moment equilibrium across Θ), vs analytic/NURBS reference.
- **G2 — cone–cylinder junction**: static convergence vs NURBS-multipatch reference
  (the Scordelis-multipatch analog). The real shell test — exactly where
  static-condensation would ill-condition; the penalty should be clean.
- **G3 — junction LBA** (stiffened shells / anisogrid): vs NURBS-LBA, with the
  dense-cluster reading discipline.

---

## 7. Open question (resolve before the production method)

Penalty (7.1) is the **baseline** shell method (most-documented; works for shells /
non-linear / buckling). Nitsche (7.4, incl. 7.4.3 for rotation-free KL) is the
variationally-consistent alternative (no penalty-parameter tuning, more complex).
Ludwig compares all four numerically in Ch 8 (8.1.5, 8.2.7, 8.3).

**Recommendation**: build penalty through G0–G2 (simplest, unblocks cone–cylinder),
then decide penalty-vs-Nitsche from Ludwig's Ch 8 comparison for the production
method. (Read 8.1.5 / 8.2.7 for his verdict at that fork.)
