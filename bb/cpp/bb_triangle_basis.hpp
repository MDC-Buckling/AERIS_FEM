// Bernstein-Bezier triangle basis — local evaluation (Aeris BB Phase 3, C++ port).
//
// VERBATIM C++ port of bb/bb_triangle_basis.py (Phase 1). Same formulas,
// same multi-index ordering, same G+Smo-style result layout. Templated on
// the scalar type T so the test can instantiate with std::complex<double>
// for complex-step differentiation (exactly as the Python proof did).
//
// Ludwig (2018) Eq. 5.1:
//   N_ijk = p!/(i! j! k!) * lam0^i * lam1^j * lam2^k,  i+j+k = p,
//   lam0 = 1 - xi1 - xi2, lam1 = xi1, lam2 = xi2.
// Derivatives via the affine xi->lam map (see the Python module docstring
// for the full derivation; reproduced in the comments below).
//
// This header is dependency-free (only <vector>,<array>,<stdexcept>) so it
// compiles standalone with g++ -std=c++17, and drops into the gsBasis
// subclass later without change to the math.
#pragma once
#include <vector>
#include <array>
#include <stdexcept>

namespace aeris {

inline long long ifactorial(int n) {
    long long r = 1;
    for (int i = 2; i <= n; ++i) r *= i;
    return r;
}

// integer power with non-negative exponent; works for real or complex T
template <class T>
inline T ipow(T base, int e) {
    T r = T(1);
    for (int i = 0; i < e; ++i) r *= base;
    return r;
}

// (i,j,k) multi-indices with i+j+k=p, fixed order: i=p..0, j=p-i..0, k=p-i-j.
inline std::vector<std::array<int,3>> multi_indices(int p) {
    std::vector<std::array<int,3>> out;
    for (int i = p; i >= 0; --i)
        for (int j = p - i; j >= 0; --j)
            out.push_back({i, j, p - i - j});
    return out;
}

template <class T>
class BBTriangleBasis {
public:
    explicit BBTriangleBasis(int degree) : p_(degree) {
        if (degree < 1) throw std::invalid_argument("degree must be >= 1");
        alpha_ = multi_indices(degree);
        long long fp = ifactorial(degree);
        coeff_.reserve(alpha_.size());
        for (auto& a : alpha_)
            coeff_.push_back(static_cast<double>(
                fp / (ifactorial(a[0]) * ifactorial(a[1]) * ifactorial(a[2]))));
    }

    int size()   const { return static_cast<int>(alpha_.size()); }   // (p+1)(p+2)/2
    int dim()    const { return 2; }
    int degree() const { return p_; }
    const std::vector<std::array<int,3>>& alpha() const { return alpha_; }

    // barycentric coords (lam0, lam1, lam2)
    static std::array<T,3> bary(T xi1, T xi2) {
        return { T(1) - xi1 - xi2, xi1, xi2 };
    }

    // coeff_int * lam0^a lam1^b lam2^c ; 0 when the integer coeff is 0
    // (which is exactly when some exponent would be negative).
    static T term(double c, const std::array<T,3>& l, int a, int b, int cc) {
        if (c == 0.0) return T(0);
        return T(c) * ipow(l[0], a) * ipow(l[1], b) * ipow(l[2], cc);
    }

    T eval_one(int idx, T xi1, T xi2) const {
        auto l = bary(xi1, xi2);
        const auto& a = alpha_[idx];
        return T(coeff_[idx]) * ipow(l[0], a[0]) * ipow(l[1], a[1]) * ipow(l[2], a[2]);
    }

    // (dN/dxi1, dN/dxi2)
    std::array<T,2> deriv_one(int idx, T xi1, T xi2) const {
        auto l = bary(xi1, xi2);
        const auto& a = alpha_[idx]; int i=a[0], j=a[1], k=a[2];
        double C = coeff_[idx];
        T Mim1 = term(i, l, i-1, j, k);   // i * M(i-1,j,k)
        T Mjm1 = term(j, l, i, j-1, k);   // j * M(i,j-1,k)
        T Mkm1 = term(k, l, i, j, k-1);   // k * M(i,j,k-1)
        return { T(C) * (-Mim1 + Mjm1), T(C) * (-Mim1 + Mkm1) };
    }

    // (d2N/dxi1^2, d2N/dxi2^2, d2N/dxi1dxi2)
    std::array<T,3> deriv2_one(int idx, T xi1, T xi2) const {
        auto l = bary(xi1, xi2);
        const auto& a = alpha_[idx]; int i=a[0], j=a[1], k=a[2];
        double C = coeff_[idx];
        T A = term((double)i*(i-1), l, i-2, j, k);
        T B = term((double)j*(j-1), l, i, j-2, k);
        T Cc= term((double)k*(k-1), l, i, j, k-2);
        T D = term((double)i*j,     l, i-1, j-1, k);
        T E = term((double)i*k,     l, i-1, j, k-1);
        T F = term((double)j*k,     l, i, j-1, k-1);
        return { T(C)*(A + B - T(2)*D),
                 T(C)*(A + Cc - T(2)*E),
                 T(C)*(A - D - E + F) };
    }

private:
    int p_;
    std::vector<std::array<int,3>> alpha_;
    std::vector<double> coeff_;
};

} // namespace aeris
