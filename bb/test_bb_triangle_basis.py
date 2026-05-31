"""Proof tests for the BB triangle basis (Aeris BB Phase 1 gate).

Run: python3 test_bb_triangle_basis.py   (pure stdlib, no numpy)

The gate: deriv2_into must be PROVEN correct before anything touches the
assembler. We prove it three independent ways so a bug in one harness
cannot mask a bug in the basis:

  T1  Partition of unity          sum_a N = 1, sum_a dN = 0, sum_a d2N = 0
  T2  Linear precision            sum_a (j/p) N = xi1 ,  sum_a (k/p) N = xi2
  T3  deriv   vs complex-step of eval            (exact, ~1e-13)
  T4  deriv2  vs complex-step of deriv           (exact, ~1e-12)   <- rigorous
  T5  deriv2  vs Richardson central-FD of eval   (independent method, ~1e-9)
  T6  mixed-partial symmetry: d12 from d/dxi1 of dN/dxi2 equals
      d/dxi2 of dN/dxi1 (two complex-step routes agree)

Complex-step differentiation: for analytic f, f'(x) = Im(f(x+ih))/h with
NO subtractive cancellation, so with h=1e-200 it is correct to machine
precision. The basis is written to accept complex xi precisely so this
works. Richardson (T5) uses only real arithmetic and a totally different
estimator, so T4 and T5 share no machinery.

Acceptance (per the Phase-1 spec): deriv2 < 1e-8. We assert tighter where
the method allows and report the worst case at the end.
"""
from __future__ import annotations

import math
import random
import sys

from bb_triangle_basis import BBTriangleBasis

H_CS = 1e-200          # complex-step (no cancellation -> can be tiny)
DEGREES = [1, 2, 3, 4, 5, 6]
N_PTS = 40

# Acceptance thresholds
TOL_POU_VAL = 1e-12
TOL_POU_GRAD = 1e-10
TOL_POU_HESS = 1e-9
TOL_LINPREC = 1e-12
TOL_DERIV_CS = 1e-10
TOL_DERIV2_CS = 1e-9           # rigorous complex-step-of-deriv
TOL_DERIV2_FD = 1e-6           # independent Richardson FD cross-check
TOL_SYMM = 1e-10


def _interior_points(n: int, seed: int) -> list[tuple[float, float]]:
    """n points strictly inside the reference triangle, plus a few near
    the edges/vertices where the basis stresses hardest."""
    rng = random.Random(seed)
    pts = []
    while len(pts) < n:
        x1 = rng.random()
        x2 = rng.random()
        if x1 + x2 < 0.999 and x1 > 1e-3 and x2 > 1e-3:
            pts.append((x1, x2))
    # deterministic stress points near boundary (still interior)
    pts += [(1e-4, 1e-4), (0.498, 0.498), (0.9, 0.05), (0.05, 0.9),
            (1.0 / 3.0, 1.0 / 3.0)]
    return pts


def _cs_first(f, x1, x2, which: int) -> float:
    """Complex-step first derivative of scalar f(x1,x2) w.r.t. xi[which]."""
    if which == 0:
        v = f(complex(x1, H_CS), x2)
    else:
        v = f(x1, complex(x2, H_CS))
    return v.imag / H_CS


def _richardson_d11(f, x1, x2) -> float:
    """Richardson-extrapolated central 2nd difference d2f/dxi1^2."""
    def d2(h):
        return (f(x1 + h, x2) - 2 * f(x1, x2) + f(x1 - h, x2)) / (h * h)
    h = 1e-3
    a = d2(h)
    b = d2(h / 2)
    return (4 * b - a) / 3.0     # O(h^4) Richardson


def _richardson_d22(f, x1, x2) -> float:
    def d2(h):
        return (f(x1, x2 + h) - 2 * f(x1, x2) + f(x1, x2 - h)) / (h * h)
    h = 1e-3
    a, b = d2(h), d2(h / 2)
    return (4 * b - a) / 3.0


def _richardson_d12(f, x1, x2) -> float:
    def d2(h):
        return (f(x1 + h, x2 + h) - f(x1 + h, x2 - h)
                - f(x1 - h, x2 + h) + f(x1 - h, x2 - h)) / (4 * h * h)
    h = 1e-3
    a, b = d2(h), d2(h / 2)
    return (4 * b - a) / 3.0


def run() -> int:
    worst = {}
    overall_ok = True

    for p in DEGREES:
        basis = BBTriangleBasis(p)
        pts = _interior_points(N_PTS, seed=1000 + p)
        n = basis.size
        assert n == (p + 1) * (p + 2) // 2

        e_pou_v = e_pou_g = e_pou_h = 0.0
        e_lin = 0.0
        e_d_cs = e_d2_cs = e_d2_fd = e_symm = 0.0

        for (x1, x2) in pts:
            # ---- T1 partition of unity ----
            sv = sum(basis.eval_one(a, x1, x2) for a in range(n))
            e_pou_v = max(e_pou_v, abs(sv - 1.0))
            sg1 = sum(basis.deriv_one(a, x1, x2)[0] for a in range(n))
            sg2 = sum(basis.deriv_one(a, x1, x2)[1] for a in range(n))
            e_pou_g = max(e_pou_g, abs(sg1), abs(sg2))
            sh = [0.0, 0.0, 0.0]
            for a in range(n):
                d11, d22, d12 = basis.deriv2_one(a, x1, x2)
                sh[0] += d11; sh[1] += d22; sh[2] += d12
            e_pou_h = max(e_pou_h, abs(sh[0]), abs(sh[1]), abs(sh[2]))

            # ---- T2 linear precision (Bernstein identity) ----
            lp1 = sum((basis.alpha[a][1] / p) * basis.eval_one(a, x1, x2)
                      for a in range(n))
            lp2 = sum((basis.alpha[a][2] / p) * basis.eval_one(a, x1, x2)
                      for a in range(n))
            e_lin = max(e_lin, abs(lp1 - x1), abs(lp2 - x2))

            for a in range(n):
                fval = lambda y1, y2, _a=a: basis.eval_one(_a, y1, y2)
                fd1 = lambda y1, y2, _a=a: basis.deriv_one(_a, y1, y2)[0]
                fd2 = lambda y1, y2, _a=a: basis.deriv_one(_a, y1, y2)[1]

                ad1, ad2 = basis.deriv_one(a, x1, x2)
                ad11, ad22, ad12 = basis.deriv2_one(a, x1, x2)

                # ---- T3 deriv vs complex-step of eval ----
                e_d_cs = max(e_d_cs,
                             abs(ad1 - _cs_first(fval, x1, x2, 0)),
                             abs(ad2 - _cs_first(fval, x1, x2, 1)))

                # ---- T4 deriv2 vs complex-step of deriv (rigorous) ----
                cs_d11 = _cs_first(fd1, x1, x2, 0)   # d/dxi1 of dN/dxi1
                cs_d22 = _cs_first(fd2, x1, x2, 1)   # d/dxi2 of dN/dxi2
                cs_d12 = _cs_first(fd2, x1, x2, 0)   # d/dxi1 of dN/dxi2
                e_d2_cs = max(e_d2_cs, abs(ad11 - cs_d11),
                              abs(ad22 - cs_d22), abs(ad12 - cs_d12))

                # ---- T6 mixed-partial symmetry ----
                cs_d12_alt = _cs_first(fd1, x1, x2, 1)   # d/dxi2 of dN/dxi1
                e_symm = max(e_symm, abs(cs_d12 - cs_d12_alt))

                # ---- T5 deriv2 vs Richardson FD of eval (independent) ----
                e_d2_fd = max(e_d2_fd,
                              abs(ad11 - _richardson_d11(fval, x1, x2)),
                              abs(ad22 - _richardson_d22(fval, x1, x2)),
                              abs(ad12 - _richardson_d12(fval, x1, x2)))

        checks = [
            ("T1 partition-of-unity value", e_pou_v, TOL_POU_VAL),
            ("T1 partition-of-unity grad",  e_pou_g, TOL_POU_GRAD),
            ("T1 partition-of-unity hess",  e_pou_h, TOL_POU_HESS),
            ("T2 linear precision",         e_lin,   TOL_LINPREC),
            ("T3 deriv  vs complex-step",   e_d_cs,  TOL_DERIV_CS),
            ("T4 deriv2 vs complex-step",   e_d2_cs, TOL_DERIV2_CS),
            ("T5 deriv2 vs Richardson FD",  e_d2_fd, TOL_DERIV2_FD),
            ("T6 mixed-partial symmetry",   e_symm,  TOL_SYMM),
        ]
        print(f"\n=== degree p={p}  (|K|={n})  pts={len(pts)} ===")
        for name, err, tol in checks:
            ok = err <= tol
            overall_ok &= ok
            worst[name] = max(worst.get(name, 0.0), err)
            print(f"  [{'PASS' if ok else 'FAIL'}] {name:32s} "
                  f"max|err| = {err:.3e}   (tol {tol:.0e})")

    print("\n" + "=" * 68)
    print("WORST CASE ACROSS ALL DEGREES")
    print("=" * 68)
    for name, err in worst.items():
        print(f"  {name:32s} {err:.3e}")
    print("=" * 68)
    if overall_ok:
        print("RESULT: PASS — deriv2_into proven correct. Phase 1 gate GREEN.")
        return 0
    print("RESULT: FAIL — do NOT proceed to the assembler hookup.")
    return 1


if __name__ == "__main__":
    sys.exit(run())
