// Triangle quadrature for the BB element (Aeris BB Phase 3, C++ port).
//
// VERBATIM C++ port of bb/bb_triangle_quadrature.py (Phase 2): collapsed
// (Duffy) Gauss-Legendre over the SAME hard-coded 1D GL tables. Same
// rationale as the Python module (see its docstring): verifiable from
// first principles, positive weights, strictly interior, exact to total
// degree 2(p-1), no nonlinear optimisation. Real-valued (double).
#pragma once
#include <vector>
#include <array>
#include <cmath>
#include <stdexcept>

namespace aeris {

// 1D Gauss-Legendre nodes/weights on [-1,1], 16 digits. Same literals as
// the Python module; verifiable vs closed forms (n<=3) + monomial test.
inline void gl_pm1(int n, std::vector<double>& x, std::vector<double>& w) {
    switch (n) {
    case 1: x={0.0}; w={2.0}; break;
    case 2: x={-0.5773502691896257, 0.5773502691896257}; w={1.0,1.0}; break;
    case 3: x={-0.7745966692414834,0.0,0.7745966692414834};
            w={0.5555555555555556,0.8888888888888888,0.5555555555555556}; break;
    case 4: x={-0.8611363115940526,-0.3399810435848563,
               0.3399810435848563,0.8611363115940526};
            w={0.3478548451374538,0.6521451548625461,
               0.6521451548625461,0.3478548451374538}; break;
    case 5: x={-0.9061798459386640,-0.5384693101056831,0.0,
               0.5384693101056831,0.9061798459386640};
            w={0.2369268850561891,0.4786286704993665,0.5688888888888889,
               0.4786286704993665,0.2369268850561891}; break;
    case 6: x={-0.9324695142031521,-0.6612093864662645,-0.2386191860831969,
               0.2386191860831969,0.6612093864662645,0.9324695142031521};
            w={0.1713244923791704,0.3607615730481386,0.4679139345726910,
               0.4679139345726910,0.3607615730481386,0.1713244923791704}; break;
    case 7: x={-0.9491079123427585,-0.7415311855993945,-0.4058451513773972,
               0.0,0.4058451513773972,0.7415311855993945,0.9491079123427585};
            w={0.1294849661688697,0.2797053914892766,0.3818300505051189,
               0.4179591836734694,0.3818300505051189,0.2797053914892766,
               0.1294849661688697}; break;
    case 8: x={-0.9602898564975363,-0.7966664774136267,-0.5255324099163290,
               -0.1834346424956498,0.1834346424956498,0.5255324099163290,
               0.7966664774136267,0.9602898564975363};
            w={0.1012285362903763,0.2223810344533745,0.3137066458778873,
               0.3626837833783620,0.3626837833783620,0.3137066458778873,
               0.2223810344533745,0.1012285362903763}; break;
    default: throw std::invalid_argument("no GL table for this n (have 1..8)");
    }
}
constexpr int GL_MAX_N = 8;

// n-point GL on [0,1]: x'=(x+1)/2, w'=w/2. sum(w')==1.
inline void gl_unit(int n, std::vector<double>& x, std::vector<double>& w) {
    gl_pm1(n, x, w);
    for (auto& xi : x) xi = 0.5 * (xi + 1.0);
    for (auto& wi : w) wi *= 0.5;
}

inline int points_for_degree(int degree) {
    if (degree < 0) throw std::invalid_argument("degree must be >= 0");
    int n = (degree + 2 + 1) / 2;          // ceil((degree+2)/2)
    return n < 1 ? 1 : n;
}

struct QPoint { double xi1, xi2, w; };

// Reference-triangle rule exact to total polynomial `degree`. sum(w)==1/2.
inline std::vector<QPoint> quad_triangle(int degree) {
    int n = points_for_degree(degree);
    if (n > GL_MAX_N)
        throw std::invalid_argument("degree needs more GL points than tabulated");
    std::vector<double> un, uw, vn, vw;
    gl_unit(n, un, uw); gl_unit(n, vn, vw);
    std::vector<QPoint> pts;
    pts.reserve(n * n);
    for (size_t jv = 0; jv < vn.size(); ++jv) {
        double v = vn[jv], jac = 1.0 - v;
        for (size_t iu = 0; iu < un.size(); ++iu)
            pts.push_back({ un[iu] * (1.0 - v), v, uw[iu] * vw[jv] * jac });
    }
    return pts;
}

inline double triangle_area2d(const std::array<double,2>& p0,
                              const std::array<double,2>& p1,
                              const std::array<double,2>& p2) {
    double ax=p1[0]-p0[0], ay=p1[1]-p0[1];
    double bx=p2[0]-p0[0], by=p2[1]-p0[1];
    return 0.5 * std::fabs(ax*by - ay*bx);
}

struct MappedQPoint { std::array<double,2> x; double w; };

// Domain-iterator stand-in: affine-map the reference rule onto a 2D
// triangle. sum(w)==area(triangle). Standalone hand-calc check only.
inline std::vector<MappedQPoint> map_rule_to_triangle(
        const std::array<double,2>& p0, const std::array<double,2>& p1,
        const std::array<double,2>& p2, int degree) {
    double scale = 2.0 * triangle_area2d(p0, p1, p2);  // |det J|, ref area 1/2
    std::vector<MappedQPoint> out;
    for (auto& q : quad_triangle(degree)) {
        std::array<double,2> x = {
            p0[0] + q.xi1*(p1[0]-p0[0]) + q.xi2*(p2[0]-p0[0]),
            p0[1] + q.xi1*(p1[1]-p0[1]) + q.xi2*(p2[1]-p0[1]) };
        out.push_back({ x, q.w * scale });
    }
    return out;
}

// exact integral over T_ref of xi1^a xi2^b = a! b! / (a+b+2)!
inline double monomial_integral_ref(int a, int b) {
    auto f=[](int n){ double r=1; for(int i=2;i<=n;++i) r*=i; return r; };
    return f(a) * f(b) / f(a + b + 2);
}

} // namespace aeris
