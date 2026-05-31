"""Proof tests for the BB triangle quadrature (Aeris BB Phase 2 gate).

Run: python3 test_bb_triangle_quadrature.py   (pure stdlib, no numpy)

Standalone rule-correctness gate. NOTE (per the Phase-2 brief): monomial
exactness is the rule's UNIT test. It is NOT the physical acceptance
criterion — the KL integrand is non-polynomial (sqrt in ||a3||), so the
real test is "integration error dominated by discretisation error",
which only appears in the Phase-3 convergence study. Here we prove only
what is provable standalone:

  Q1  weight sum            sum(w) == area(T_ref) == 1/2
  Q2  positivity            every weight > 0
  Q3  interiority           every point strictly inside T_ref
  Q4  monomial EXACTNESS    rule of degree D integrates xi1^a xi2^b
                            (a+b<=D) to a!b!/(a+b+2)!  -> ~1e-15
  Q5  (informational only)  the degree-(D+1) "overshoot" error, printed
                            as a diagnostic. NOT a gate: sharpness is not
                            a correctness property, and a collapsed-GL
                            rule's exact degree can legitimately exceed
                            the nominal one (e.g. the 1-point centroid
                            rule is degree-1 exact). Reported, not asserted.
  Q6  domain iterator       map onto a concrete triangle, compare to
                            HAND-computed integrals (constant, linear,
                            quadratic) — the only standalone check the
                            iterator gets; the gsBasis/makeDomainIterator
                            contract is validated in Phase 3.

Degrees exercised: the stiffness-binding 2(p-1) for p=1..6 (i.e. D up to
10), the membrane-binding limit the BB element will actually request.
"""
from __future__ import annotations

import sys

from bb_triangle_quadrature import (
    quad_triangle, map_rule_to_triangle, monomial_integral_ref,
    points_for_degree, triangle_area,
)

TOL_WSUM = 1e-14
TOL_EXACT = 1e-13
TOL_HANDCALC = 1e-12


def _quad(pts, f) -> float:
    return sum(w * f(x1, x2) for (x1, x2, w) in pts)


def _max_monomial_err(pts, D: int) -> float:
    worst = 0.0
    for a in range(D + 1):
        for b in range(D + 1 - a):
            approx = _quad(pts, lambda x1, x2, _a=a, _b=b: x1 ** _a * x2 ** _b)
            exact = monomial_integral_ref(a, b)
            worst = max(worst, abs(approx - exact))
    return worst


def _max_overshoot_err(pts, D: int) -> float:
    """Largest error among the degree-(D+1) monomials — informational
    only. Large => the rule is genuinely not exact one degree higher;
    ~machine-eps => it happens to over-resolve. Not a correctness gate."""
    Dp = D + 1
    worst = 0.0
    for a in range(Dp + 1):
        b = Dp - a
        approx = _quad(pts, lambda x1, x2, _a=a, _b=b: x1 ** _a * x2 ** _b)
        exact = monomial_integral_ref(a, b)
        worst = max(worst, abs(approx - exact))
    return worst


def run() -> int:
    overall_ok = True
    worst = {}

    def record(name, err, tol, passed=None):
        nonlocal overall_ok
        ok = (err <= tol) if passed is None else passed
        overall_ok &= ok
        worst[name] = max(worst.get(name, 0.0), err)
        return ok

    # ---- Q1..Q5 on the reference triangle, degrees 2(p-1) for p=1..6 ----
    for p in range(1, 7):
        D = 2 * (p - 1)                       # 0,2,4,6,8,10
        pts = quad_triangle(D)
        n = points_for_degree(D)

        wsum = sum(w for (_1, _2, w) in pts)
        e_wsum = abs(wsum - 0.5)

        min_w = min(w for (_1, _2, w) in pts)
        pos_ok = min_w > 0.0

        interior_ok = all(
            (x1 > 0.0 and x2 > 0.0 and (x1 + x2) < 1.0)
            for (x1, x2, _w) in pts
        )
        min_bary = min(min(x1, x2, 1.0 - x1 - x2) for (x1, x2, _w) in pts)

        e_exact = _max_monomial_err(pts, D)
        overshoot = _max_overshoot_err(pts, D)   # informational only

        ok1 = record(f"Q1 weight-sum (p={p},D={D})", e_wsum, TOL_WSUM)
        ok2 = record(f"Q2 positivity (p={p},D={D})", 0.0, 0.0, passed=pos_ok)
        ok3 = record(f"Q3 interiority (p={p},D={D})", 0.0, 0.0, passed=interior_ok)
        ok4 = record(f"Q4 monomial-exact (p={p},D={D})", e_exact, TOL_EXACT)

        print(f"p={p}  D={D}  n={n}  pts={len(pts):3d}  "
              f"[{'P' if ok1 else 'F'}] wsum={e_wsum:.1e}  "
              f"[{'P' if ok2 else 'F'}] minw={min_w:.3e}  "
              f"[{'P' if ok3 else 'F'}] minbary={min_bary:.3e}  "
              f"[{'P' if ok4 else 'F'}] exact={e_exact:.1e}  "
              f"(Q5 deg-{D+1} overshoot={overshoot:.1e}, info)")

    # ---- Q6 domain iterator vs HAND calculation -------------------------
    # Triangle A=(0,0), B=(4,0), C=(0,3): area = 1/2*|4*3| = 6.
    # Hand integrals over this triangle:
    #   int 1   dA = area                       = 6
    #   int x   dA = centroid_x * area = (4/3)*6 = 8
    #   int y   dA = centroid_y * area = (1)*6   = 6      (centroid_y=3/3=1)
    #   int x^2 dA = (A/6)*(x0^2+x1^2+x2^2 + x0x1+x1x2+x2x0)
    #              = (6/6)*(0+16+0 + 0+0+0) = 16
    #   int y^2 dA = (6/6)*(0+0+9 + 0+0+0) = 9
    #   int xy  dA = (A/12)*(2(x0y0+x1y1+x2y2)+ x0y1+x1y0+x1y2+x2y1+x2y0+x0y2)
    #              with x=(0,4,0), y=(0,0,3):
    #              x0y0..=0; cross terms: x0y1=0,x1y0=0,x1y2=12,x2y1=0,
    #              x2y0=0,x0y2=0 -> sum=12; *(6/12)=6
    P0, P1, P2 = (0.0, 0.0), (4.0, 0.0), (0.0, 3.0)
    print()
    print(f"Domain iterator on triangle {P0},{P1},{P2}  area={triangle_area(P0,P1,P2)}")
    hand = [
        ("int 1",   lambda x, y: 1.0,      6.0),
        ("int x",   lambda x, y: x,        8.0),
        ("int y",   lambda x, y: y,        6.0),
        ("int x^2", lambda x, y: x * x,    16.0),
        ("int y^2", lambda x, y: y * y,    9.0),
        ("int xy",  lambda x, y: x * y,    6.0),
    ]
    for label, g, exact in hand:
        approx = sum(w * g(pt[0], pt[1])
                     for pt, w in map_rule_to_triangle(P0, P1, P2, degree=2))
        err = abs(approx - exact)
        ok = record(f"Q6 {label}", err, TOL_HANDCALC)
        print(f"  [{'PASS' if ok else 'FAIL'}] {label:8s} "
              f"approx={approx:+.10f}  hand={exact:+.1f}  |err|={err:.2e}")

    print("\n" + "=" * 64)
    print("WORST CASE")
    print("=" * 64)
    for name, err in worst.items():
        if err > 0.0:
            print(f"  {name:34s} {err:.3e}")
    print("=" * 64)
    if overall_ok:
        print("RESULT: PASS — triangle quadrature rule-correct. Phase 2 gate GREEN.")
        return 0
    print("RESULT: FAIL.")
    return 1


if __name__ == "__main__":
    sys.exit(run())
