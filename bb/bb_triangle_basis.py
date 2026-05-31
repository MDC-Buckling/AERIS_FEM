"""Bernstein-Bezier triangle basis — local evaluation (Aeris BB Phase 1).

STANDALONE. No assembler, no G+Smo, no numpy — pure stdlib so it runs in
any python3 (host or container). The single job of this module is the
LOCAL basis on the reference triangle, with analytic first AND second
derivatives. deriv2 is the highest-risk / highest-information piece of
the whole BB element (the KL shell bending energy needs it), so it is
built and proven here in isolation before anything touches the assembler.

Methodology: Ludwig (2018), *Bernstein-Bezier FE Formulation for
Anisogrid-Stiffened Shells*, Diss. TU Braunschweig, Eq. 5.1:

    N_ijk(xi1, xi2) = p!/(i! j! k!) * lam0^i * lam1^j * lam2^k ,  i+j+k = p

on the reference triangle with barycentric coordinates
    lam0 = 1 - xi1 - xi2 ,  lam1 = xi1 ,  lam2 = xi2 ,
parametrised by (xi1, xi2) in {xi1>=0, xi2>=0, xi1+xi2<=1}.
Number of functions |K| = (p+1)(p+2)/2  (21 for p=5).

Derivatives (derived analytically; see the test module for proof):
  Let M(a,b,c) = lam0^a lam1^b lam2^c. With the affine map xi -> lam
  (Jacobian rows lam0,lam1,lam2 / cols xi1,xi2 = [[-1,-1],[1,0],[0,1]]):

  dN/dxi1 = C * ( -i*M(i-1,j,k) + j*M(i,j-1,k) )
  dN/dxi2 = C * ( -i*M(i-1,j,k) + k*M(i,j,k-1) )

  With g-Hessian entries
    a=i(i-1)M(i-2,j,k)  b=j(j-1)M(i,j-2,k)  c=k(k-1)M(i,j,k-2)
    d=i*j*M(i-1,j-1,k)  e=i*k*M(i-1,j,k-1)  f=j*k*M(i,j-1,k-1)
  and Hess_xi = J^T Hess_g J:
    d2N/dxi1^2     = C * ( a + b - 2d )
    d2N/dxi2^2     = C * ( a + c - 2e )
    d2N/dxi1 dxi2  = C * ( a - d - e + f )

Multi-index ordering (FIXED + documented; the global coupling map in
Phase 4 defines the assembly numbering, this is just the local order):
  i from p..0 (outer), j from p-i..0, k = p-i-j. So for p=2:
  (2,0,0) (1,1,0) (1,0,1) (0,2,0) (0,1,1) (0,0,2).

G+Smo gsBasis layout the C++ port (Phase 3) must emit (documented here so
the port is faithful), for nPts evaluation points and |K| functions:
  eval_into   : |K| x nPts          result[a][q] = N_a(xi_q)
  deriv_into  : (|K|*2) x nPts       rows a*2+0 = dN_a/dxi1, a*2+1 = dN_a/dxi2
  deriv2_into : (|K|*3) x nPts       rows a*3+0 = d2/dxi1^2,
                                          a*3+1 = d2/dxi2^2,
                                          a*3+2 = d2/dxi1 dxi2
This module exposes both a clean per-function API (eval_one/deriv_one/
deriv2_one) and the batched G+Smo-layout methods (eval_into/deriv_into/
deriv2_into). Everything is written to accept COMPLEX xi so the test
module can verify derivatives by complex-step differentiation.
"""
from __future__ import annotations

from math import factorial


def multi_indices(p: int) -> list[tuple[int, int, int]]:
    """The |K| triangle multi-indices (i,j,k), i+j+k=p, in the fixed order
    documented in the module docstring."""
    out = []
    for i in range(p, -1, -1):
        for j in range(p - i, -1, -1):
            out.append((i, j, p - i - j))
    return out


class BBTriangleBasis:
    """Degree-p Bernstein-Bezier basis on the reference triangle."""

    def __init__(self, degree: int):
        if degree < 1:
            raise ValueError("degree must be >= 1")
        self.p = degree
        self.alpha = multi_indices(degree)               # list of (i,j,k)
        # multinomial coefficients p!/(i! j! k!) as exact integers
        fp = factorial(degree)
        self.coeff = [
            fp // (factorial(i) * factorial(j) * factorial(k))
            for (i, j, k) in self.alpha
        ]

    # ----- sizes / gsBasis-contract scalars --------------------------------
    @property
    def size(self) -> int:
        return len(self.alpha)                           # |K| = (p+1)(p+2)/2

    @property
    def dim(self) -> int:
        return 2                                         # parametric dimension

    @property
    def degree(self) -> int:
        return self.p

    def num_active(self) -> int:
        # Single reference element -> every local function is active.
        return self.size

    def active(self) -> list[int]:
        return list(range(self.size))

    # ----- barycentric coords ---------------------------------------------
    @staticmethod
    def _bary(xi1, xi2):
        return (1 - xi1 - xi2, xi1, xi2)                 # (lam0, lam1, lam2)

    @staticmethod
    def _term(coeff_int, l0, l1, l2, a, b, c):
        """coeff_int * lam0^a lam1^b lam2^c, returning 0 when the integer
        coefficient is 0 (which is exactly when some exponent would be
        negative — so we never raise on lam**(-1))."""
        if coeff_int == 0:
            return 0.0
        return coeff_int * (l0 ** a) * (l1 ** b) * (l2 ** c)

    # ----- per-function evaluation (accepts real OR complex xi) ------------
    def eval_one(self, a_idx: int, xi1, xi2):
        l0, l1, l2 = self._bary(xi1, xi2)
        i, j, k = self.alpha[a_idx]
        return self.coeff[a_idx] * (l0 ** i) * (l1 ** j) * (l2 ** k)

    def deriv_one(self, a_idx: int, xi1, xi2):
        """(dN/dxi1, dN/dxi2)."""
        l0, l1, l2 = self._bary(xi1, xi2)
        i, j, k = self.alpha[a_idx]
        C = self.coeff[a_idx]
        M_im1 = self._term(i, l0, l1, l2, i - 1, j, k)   # i * M(i-1,j,k)
        M_jm1 = self._term(j, l0, l1, l2, i, j - 1, k)   # j * M(i,j-1,k)
        M_km1 = self._term(k, l0, l1, l2, i, j, k - 1)   # k * M(i,j,k-1)
        d_xi1 = C * (-M_im1 + M_jm1)
        d_xi2 = C * (-M_im1 + M_km1)
        return (d_xi1, d_xi2)

    def deriv2_one(self, a_idx: int, xi1, xi2):
        """(d2N/dxi1^2, d2N/dxi2^2, d2N/dxi1 dxi2)."""
        l0, l1, l2 = self._bary(xi1, xi2)
        i, j, k = self.alpha[a_idx]
        C = self.coeff[a_idx]
        a = self._term(i * (i - 1), l0, l1, l2, i - 2, j, k)
        b = self._term(j * (j - 1), l0, l1, l2, i, j - 2, k)
        c = self._term(k * (k - 1), l0, l1, l2, i, j, k - 2)
        d = self._term(i * j, l0, l1, l2, i - 1, j - 1, k)
        e = self._term(i * k, l0, l1, l2, i - 1, j, k - 1)
        f = self._term(j * k, l0, l1, l2, i, j - 1, k - 1)
        d11 = C * (a + b - 2 * d)
        d22 = C * (a + c - 2 * e)
        d12 = C * (a - d - e + f)
        return (d11, d22, d12)

    # ----- batched G+Smo-layout methods ------------------------------------
    def eval_into(self, pts: list[tuple]) -> list[list]:
        """result[a][q] = N_a(pts[q]).  Shape |K| x nPts."""
        return [[self.eval_one(a, x1, x2) for (x1, x2) in pts]
                for a in range(self.size)]

    def deriv_into(self, pts: list[tuple]) -> list[list]:
        """Flat G+Smo layout, shape (|K|*2) x nPts:
        rows a*2+0 = dN_a/dxi1, a*2+1 = dN_a/dxi2."""
        rows: list[list] = []
        for a in range(self.size):
            r1, r2 = [], []
            for (x1, x2) in pts:
                d1, d2 = self.deriv_one(a, x1, x2)
                r1.append(d1)
                r2.append(d2)
            rows.append(r1)
            rows.append(r2)
        return rows

    def deriv2_into(self, pts: list[tuple]) -> list[list]:
        """Flat G+Smo layout, shape (|K|*3) x nPts:
        rows a*3+0 = d2/dxi1^2, a*3+1 = d2/dxi2^2, a*3+2 = d2/dxi1 dxi2."""
        rows: list[list] = []
        for a in range(self.size):
            r11, r22, r12 = [], [], []
            for (x1, x2) in pts:
                d11, d22, d12 = self.deriv2_one(a, x1, x2)
                r11.append(d11)
                r22.append(d22)
                r12.append(d12)
            rows.append(r11)
            rows.append(r22)
            rows.append(r12)
        return rows
