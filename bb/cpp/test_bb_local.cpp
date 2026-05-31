// C++ proof suite for the ported BB basis + triangle quadrature
// (Aeris BB Phase 3). Re-runs the SAME checks the Python Phase-1/2 gates
// ran, to prove the verbatim C++ port is faithful before the basis meets
// the assembler. Dependency-free: g++ -std=c++17 -O2 test_bb_local.cpp.
//
//   Basis  : T1 partition-of-unity (value/grad/hess), T2 linear precision,
//            T3 deriv vs complex-step(eval), T4 deriv2 vs complex-step(deriv)
//            [rigorous], T5 deriv2 vs Richardson FD(eval) [independent],
//            T6 mixed-partial symmetry.
//   Quad   : Q1 weight-sum==area, Q2 positivity, Q3 interiority,
//            Q4 monomial exactness to 2(p-1), Q6 domain-iter vs hand calc.
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include <complex>
#include <vector>
#include <array>
#include <random>
#include <cmath>
#include <cstdio>
#include <algorithm>

using aeris::BBTriangleBasis;
using cd = std::complex<double>;

static const double H_CS = 1e-200;
static bool g_ok = true;
static void check(const char* name, double err, double tol) {
    bool ok = (err <= tol);
    g_ok &= ok;
    std::printf("  [%s] %-30s max|err| = %.3e   (tol %.0e)\n",
                ok ? "PASS" : "FAIL", name, err, tol);
}
static void check_bool(const char* name, bool ok) {
    g_ok &= ok;
    std::printf("  [%s] %-30s\n", ok ? "PASS" : "FAIL", name);
}

static std::vector<std::array<double,2>> interior_points(int n, unsigned seed) {
    std::mt19937 rng(seed);
    std::uniform_real_distribution<double> U(0.0, 1.0);
    std::vector<std::array<double,2>> pts;
    while ((int)pts.size() < n) {
        double a = U(rng), b = U(rng);
        if (a + b < 0.999 && a > 1e-3 && b > 1e-3) pts.push_back({a, b});
    }
    for (auto p : {std::array<double,2>{1e-4,1e-4}, {0.498,0.498},
                   {0.9,0.05}, {0.05,0.9}, {1.0/3,1.0/3}})
        pts.push_back(p);
    return pts;
}

int main() {
    // ---------- BASIS ----------
    double w_pou_v=0, w_pou_g=0, w_pou_h=0, w_lin=0, w_dcs=0, w_d2cs=0,
           w_d2fd=0, w_symm=0;
    for (int p = 1; p <= 6; ++p) {
        BBTriangleBasis<double> B(p);
        BBTriangleBasis<cd>    Bc(p);
        int n = B.size();
        auto pts = interior_points(40, 1000u + p);
        for (auto& q : pts) {
            double x1=q[0], x2=q[1];
            // T1 PoU
            double sv=0,sg1=0,sg2=0,sh1=0,sh2=0,sh3=0;
            for (int a=0;a<n;++a){
                sv += B.eval_one(a,x1,x2);
                auto d=B.deriv_one(a,x1,x2); sg1+=d[0]; sg2+=d[1];
                auto h=B.deriv2_one(a,x1,x2); sh1+=h[0]; sh2+=h[1]; sh3+=h[2];
            }
            w_pou_v=std::max(w_pou_v,std::fabs(sv-1.0));
            w_pou_g=std::max({w_pou_g,std::fabs(sg1),std::fabs(sg2)});
            w_pou_h=std::max({w_pou_h,std::fabs(sh1),std::fabs(sh2),std::fabs(sh3)});
            // T2 linear precision
            double lp1=0,lp2=0;
            for (int a=0;a<n;++a){
                lp1 += (B.alpha()[a][1]/(double)p)*B.eval_one(a,x1,x2);
                lp2 += (B.alpha()[a][2]/(double)p)*B.eval_one(a,x1,x2);
            }
            w_lin=std::max({w_lin,std::fabs(lp1-x1),std::fabs(lp2-x2)});
            // per-function derivative checks
            for (int a=0;a<n;++a){
                auto d  = B.deriv_one(a,x1,x2);
                auto h  = B.deriv2_one(a,x1,x2);
                // T3 deriv vs complex-step of eval
                double cs_d1 = Bc.eval_one(a, cd(x1,H_CS), cd(x2,0)).imag()/H_CS;
                double cs_d2 = Bc.eval_one(a, cd(x1,0), cd(x2,H_CS)).imag()/H_CS;
                w_dcs=std::max({w_dcs,std::fabs(d[0]-cs_d1),std::fabs(d[1]-cs_d2)});
                // T4 deriv2 vs complex-step of deriv (rigorous)
                auto dc_x1 = Bc.deriv_one(a, cd(x1,H_CS), cd(x2,0));   // d/dxi1
                auto dc_x2 = Bc.deriv_one(a, cd(x1,0), cd(x2,H_CS));   // d/dxi2
                double cs_d11 = dc_x1[0].imag()/H_CS;
                double cs_d22 = dc_x2[1].imag()/H_CS;
                double cs_d12 = dc_x1[1].imag()/H_CS;          // d/dxi1 of dN/dxi2
                w_d2cs=std::max({w_d2cs,std::fabs(h[0]-cs_d11),
                                 std::fabs(h[1]-cs_d22),std::fabs(h[2]-cs_d12)});
                // T6 symmetry: d/dxi2 of dN/dxi1 == cs_d12
                double cs_d12_alt = dc_x2[0].imag()/H_CS;
                w_symm=std::max(w_symm,std::fabs(cs_d12-cs_d12_alt));
                // T5 deriv2 vs Richardson central FD of eval (independent)
                auto richardson=[&](int dir){
                    auto d2=[&](double hh){
                        double xa1=x1, xa2=x2, xb1=x1, xb2=x2;
                        (dir==0?xa1:xa2)+=hh; (dir==0?xb1:xb2)-=hh;
                        return (B.eval_one(a,xa1,xa2)-2*B.eval_one(a,x1,x2)
                                +B.eval_one(a,xb1,xb2))/(hh*hh);
                    };
                    double aa=d2(1e-3), bb=d2(5e-4); return (4*bb-aa)/3.0;
                };
                auto rich_d12=[&](){
                    auto d2=[&](double hh){
                        return (B.eval_one(a,x1+hh,x2+hh)-B.eval_one(a,x1+hh,x2-hh)
                               -B.eval_one(a,x1-hh,x2+hh)+B.eval_one(a,x1-hh,x2-hh))
                               /(4*hh*hh);
                    };
                    double aa=d2(1e-3), bb=d2(5e-4); return (4*bb-aa)/3.0;
                };
                w_d2fd=std::max({w_d2fd,std::fabs(h[0]-richardson(0)),
                                 std::fabs(h[1]-richardson(1)),
                                 std::fabs(h[2]-rich_d12())});
            }
        }
    }
    std::printf("=== BASIS (p=1..6) — worst case over all degrees ===\n");
    check("T1 partition-of-unity value", w_pou_v, 1e-12);
    check("T1 partition-of-unity grad",  w_pou_g, 1e-10);
    check("T1 partition-of-unity hess",  w_pou_h, 1e-9);
    check("T2 linear precision",         w_lin,   1e-12);
    check("T3 deriv  vs complex-step",   w_dcs,   1e-10);
    check("T4 deriv2 vs complex-step",   w_d2cs,  1e-9);
    check("T5 deriv2 vs Richardson FD",  w_d2fd,  1e-6);
    check("T6 mixed-partial symmetry",   w_symm,  1e-10);

    // ---------- QUADRATURE ----------
    std::printf("=== QUADRATURE (D=2(p-1), p=1..6) ===\n");
    double w_wsum=0, w_exact=0; bool pos_ok=true, int_ok=true;
    for (int p = 1; p <= 6; ++p) {
        int D = 2*(p-1);
        auto pts = aeris::quad_triangle(D);
        double ws=0, minw=1e300, minb=1e300, ex=0;
        for (auto& q : pts){
            ws += q.w; minw=std::min(minw,q.w);
            minb=std::min({minb,q.xi1,q.xi2,1.0-q.xi1-q.xi2});
            if (q.w<=0) pos_ok=false;
            if (!(q.xi1>0 && q.xi2>0 && q.xi1+q.xi2<1)) int_ok=false;
        }
        for (int a=0;a<=D;++a) for (int b=0;b<=D-a;++b){
            double s=0; for (auto& q:pts) s += q.w*std::pow(q.xi1,a)*std::pow(q.xi2,b);
            ex=std::max(ex,std::fabs(s-aeris::monomial_integral_ref(a,b)));
        }
        w_wsum=std::max(w_wsum,std::fabs(ws-0.5));
        w_exact=std::max(w_exact,ex);
        std::printf("  p=%d D=%2d pts=%2zu  wsum_err=%.1e minw=%.2e minbary=%.2e exact=%.1e\n",
                    p,D,pts.size(),std::fabs(ws-0.5),minw,minb,ex);
    }
    check("Q1 weight-sum == 1/2", w_wsum, 1e-14);
    check_bool("Q2 positivity (all w>0)", pos_ok);
    check_bool("Q3 interiority (strict)", int_ok);
    check("Q4 monomial exactness 2(p-1)", w_exact, 1e-13);

    // Q6 domain iterator vs HAND calc on triangle (0,0),(4,0),(0,3), area 6.
    std::array<double,2> P0={0,0},P1={4,0},P2={0,3};
    struct HC{const char* n; double(*g)(double,double); double exact;};
    HC hand[]={
        {"int 1",  [](double,double){return 1.0;}, 6.0},
        {"int x",  [](double x,double){return x;}, 8.0},
        {"int y",  [](double,double y){return y;}, 6.0},
        {"int x^2",[](double x,double){return x*x;}, 16.0},
        {"int y^2",[](double,double y){return y*y;}, 9.0},
        {"int xy", [](double x,double y){return x*y;}, 6.0},
    };
    std::printf("Domain iterator on triangle (0,0),(4,0),(0,3) area=6:\n");
    double w_hand=0;
    for (auto& h : hand){
        double s=0;
        for (auto& mq : aeris::map_rule_to_triangle(P0,P1,P2,2))
            s += mq.w*h.g(mq.x[0],mq.x[1]);
        double e=std::fabs(s-h.exact); w_hand=std::max(w_hand,e);
        std::printf("    %-7s approx=%+.10f hand=%+.1f |err|=%.2e\n",h.n,s,h.exact,e);
    }
    check("Q6 domain iterator vs hand", w_hand, 1e-12);

    std::printf("\n%s\n", g_ok
        ? "RESULT: PASS — C++ port faithful (matches Python proofs). Phase-3 port step GREEN."
        : "RESULT: FAIL.");
    return g_ok ? 0 : 1;
}
