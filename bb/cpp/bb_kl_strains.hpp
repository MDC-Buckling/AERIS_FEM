// KL-shell strain-displacement for the BB triangle element (Aeris BB Phase 3).
// Implements Ludwig 4.54-4.61 per bb/SPEC_b_matrices.md (typos in 4.54/4.59
// corrected). Membrane eps_m + bending kappa (strains), and the analytic
// strain-displacement matrices B_m, B_b INCLUDING the normal variation dn
// (3.3). Templated on T so the strains accept std::complex<double> for
// complex-step validation of B (exactly the Phase-1 discipline).
//
// Voigt order [11, 22, 12] with factor 2 on the shear/twist row. Bending
// b_ab = -a_a,b . a3 ; kappa_ab = b_ab - B_ab (def - ref). The SIGN/metric
// convention is pinned against gismo (_getBcov / E_f) only at Gate 5/6,
// which need gismo; the standalone gates here prove INTERNAL consistency
// (analytic B == complex-step of the strain) + frame invariance.
#pragma once
#include "bb_triangle_basis.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <complex>   // so std::sqrt resolves for std::complex<double> (complex-step)

namespace aeris {

template <class T> using V3 = std::array<T,3>;

template <class T> inline T dot3(const V3<T>& a, const V3<T>& b) {
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}
template <class T> inline V3<T> cross3(const V3<T>& a, const V3<T>& b) {
    return { a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0] };
}

// Per-quad-point real basis derivatives (computed once from BBTriangleBasis<double>).
struct BasisDerivs {
    std::vector<double> N1, N2, N11, N22, N12;   // size |K|
    static BasisDerivs at(const BBTriangleBasis<double>& B, double xi1, double xi2) {
        BasisDerivs d; int n = B.size();
        d.N1.resize(n); d.N2.resize(n);
        d.N11.resize(n); d.N22.resize(n); d.N12.resize(n);
        for (int k = 0; k < n; ++k) {
            auto g = B.deriv_one(k, xi1, xi2);
            auto h = B.deriv2_one(k, xi1, xi2);
            d.N1[k]=g[0]; d.N2[k]=g[1];
            d.N11[k]=h[0]; d.N22[k]=h[1]; d.N12[k]=h[2];
        }
        return d;
    }
};

// Geometry at a quad point for a given configuration coefs c_k (= X_k or X_k+u_k).
template <class T>
struct Geom {
    V3<T> a1{}, a2{}, a11{}, a22{}, a12{}, abar3{}, a3{};
    T jbar{};   // ||abar3||
    static Geom build(const std::vector<V3<T>>& c, const BasisDerivs& d) {
        Geom G;
        for (size_t k = 0; k < c.size(); ++k) {
            for (int i = 0; i < 3; ++i) {
                G.a1[i]  += d.N1[k]  * c[k][i];
                G.a2[i]  += d.N2[k]  * c[k][i];
                G.a11[i] += d.N11[k] * c[k][i];
                G.a22[i] += d.N22[k] * c[k][i];
                G.a12[i] += d.N12[k] * c[k][i];
            }
        }
        G.abar3 = cross3(G.a1, G.a2);
        using std::sqrt;                       // picks complex overload via ADL/overload set
        G.jbar  = sqrt(dot3(G.abar3, G.abar3));
        for (int i = 0; i < 3; ++i) G.a3[i] = G.abar3[i] / G.jbar;
        return G;
    }
};

// coefs c_k = X_k + u_k  (X real, u of type T)
template <class T>
inline std::vector<V3<T>> deform(const std::vector<V3<double>>& X,
                                 const std::vector<V3<T>>& u) {
    std::vector<V3<T>> c(X.size());
    for (size_t k = 0; k < X.size(); ++k)
        for (int i = 0; i < 3; ++i) c[k][i] = T(X[k][i]) + u[k][i];
    return c;
}

// Membrane (eps_m) + bending (kappa) Voigt strains [11,22,2*12].
// refGeom is the (u=0) reference geometry, passed in as doubles (constants).
template <class T>
inline void strains(const std::vector<V3<double>>& X,
                    const std::vector<V3<T>>& u,
                    const BasisDerivs& d,
                    const Geom<double>& R,        // reference geometry
                    V3<T>& eps_m, V3<T>& kappa) {
    auto c = deform(X, u);
    Geom<T> G = Geom<T>::build(c, d);
    T E11 = T(0.5)*(dot3(G.a1,G.a1) - dot3(R.a1,R.a1));
    T E22 = T(0.5)*(dot3(G.a2,G.a2) - dot3(R.a2,R.a2));
    T E12 = T(0.5)*(dot3(G.a1,G.a2) - dot3(R.a1,R.a2));
    eps_m = { E11, E22, T(2)*E12 };
    // b_ab = -a_a,b . a3   ;  B_ab = -A_a,b . A3 (reference)
    T b11 = -dot3(G.a11, G.a3), b22 = -dot3(G.a22, G.a3), b12 = -dot3(G.a12, G.a3);
    double B11 = -dot3(R.a11, R.a3), B22 = -dot3(R.a22, R.a3), B12 = -dot3(R.a12, R.a3);
    kappa = { b11 - B11, b22 - B22, T(2)*(b12 - B12) };
}

// ---- Analytic strain-displacement matrices at a real configuration u0 ----
// Layout: 3 rows (Voigt) x (3*|K|) cols, col(k,i) = 3*k + i. Row-major flat.
struct Bmat { int ncols; std::vector<double> v;     // 3 x ncols
    double& at(int r, int c){ return v[r*ncols + c]; }
    double  at(int r, int c) const { return v[r*ncols + c]; } };

inline Bmat make_B(int nK){ Bmat B; B.ncols=3*nK; B.v.assign(3*B.ncols,0.0); return B; }

// Build B_m and B_b at configuration coefs c (deformed). Includes the dn term.
inline void analytic_B(const std::vector<V3<double>>& c, const BasisDerivs& d,
                       Bmat& Bm, Bmat& Bb) {
    int nK = (int)c.size();
    Geom<double> G = Geom<double>::build(c, d);
    Bm = make_B(nK); Bb = make_B(nK);
    for (int k = 0; k < nK; ++k) {
        for (int i = 0; i < 3; ++i) {
            int col = 3*k + i;
            // --- membrane (Eq 4.59): rows N1*a1i, N2*a2i, N1*a2i+N2*a1i ---
            Bm.at(0,col) = d.N1[k]*G.a1[i];
            Bm.at(1,col) = d.N2[k]*G.a2[i];
            Bm.at(2,col) = d.N1[k]*G.a2[i] + d.N2[k]*G.a1[i];
            // --- bending (Eq 4.61): -N_k,ab a3i - a_a,b . da3 ---
            // da_bar3/du_ki = N1[k]*(e_i x a2) + N2[k]*(a1 x e_i)   (Eq 4.56)
            V3<double> ei{0,0,0}; ei[i]=1.0;
            V3<double> dabar = {0,0,0};
            { V3<double> t1 = cross3(ei, G.a2), t2 = cross3(G.a1, ei);
              for (int j=0;j<3;++j) dabar[j] = d.N1[k]*t1[j] + d.N2[k]*t2[j]; }
            // da3 = (1/jbar)(I - a3 a3^T) dabar   (Eq 4.55)
            double proj = dot3(G.a3, dabar);
            V3<double> da3;
            for (int j=0;j<3;++j) da3[j] = (dabar[j] - proj*G.a3[j]) / G.jbar;
            Bb.at(0,col) = -d.N11[k]*G.a3[i] - dot3(G.a11, da3);
            Bb.at(1,col) = -d.N22[k]*G.a3[i] - dot3(G.a22, da3);
            Bb.at(2,col) = 2.0*( -d.N12[k]*G.a3[i] - dot3(G.a12, da3) );
        }
    }
}

// ---- Flat affine BB-triangle patch: CP_ijk = (i*V0 + j*V1 + k*V2)/p ----
// (exact degree-1 geometry in degree-p Bezier form => A_a,b == 0).
inline std::vector<V3<double>> flat_patch_cps(const BBTriangleBasis<double>& B,
        const V3<double>& V0, const V3<double>& V1, const V3<double>& V2) {
    std::vector<V3<double>> X(B.size());
    double p = (double)B.degree();
    for (int k = 0; k < B.size(); ++k) {
        const auto& a = B.alpha()[k];        // (i,j,kk) <-> (lam0,lam1,lam2)
        for (int c = 0; c < 3; ++c)
            X[k][c] = (a[0]*V0[c] + a[1]*V1[c] + a[2]*V2[c]) / p;
    }
    return X;
}

} // namespace aeris
