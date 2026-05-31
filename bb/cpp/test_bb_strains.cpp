// Phase-3 strain-displacement gates (Ludwig 4.54-4.61), pure C++ / no gismo.
// Build: g++ -std=c++17 -O2 test_bb_strains.cpp -o t && ./t
//
// Gates (per bb/SPEC_b_matrices.md §7, the gismo-free subset):
//   G1  membrane rigid translation -> eps_m = 0   (PoU: sum N_k,a = 0)
//   G2  B_m  vs complex-step of eps_m             (rigorous, ~machine)
//   G3  rigid-body (finite translation + rotation) -> eps_m = 0 AND kappa = 0
//       on the FLAT patch (frame invariance; independent of complex-step)
//   G4  B_b  vs complex-step of kappa             (rigorous; exercises dn at
//       a deformed state, where a_a,b != 0 even on a flat reference)
//
// Two INDEPENDENT angles per matrix: complex-step (G2,G4) vs frame
// invariance (G1,G3). The geometric dn check on a CURVED reference (rigid
// rotation with A_a,b != 0) is staged for the cylinder LBA per the spec;
// here complex-step at a deformed flat state validates the dn FORMULA.
#include "bb_kl_strains.hpp"
#include <complex>
#include <random>
#include <cstdio>
#include <algorithm>

using namespace aeris;
using cd = std::complex<double>;
static const double H = 1e-200;
static bool g_ok = true;
static void rep(const char* n, double e, double tol){
    bool ok=e<=tol; g_ok&=ok;
    std::printf("  [%s] %-34s max|err|=%.3e (tol %.0e)\n", ok?"PASS":"FAIL", n, e, tol);
}

// finite rotation (Rodrigues) about axis (1,2,3)/sqrt(14), angle 0.37 rad
static std::array<std::array<double,3>,3> rotation() {
    double ax[3]={1,2,3}, nn=std::sqrt(14.0); for(double&x:ax)x/=nn;
    double th=0.37, c=std::cos(th), s=std::sin(th), C=1-c;
    return {{ {c+ax[0]*ax[0]*C, ax[0]*ax[1]*C-ax[2]*s, ax[0]*ax[2]*C+ax[1]*s},
              {ax[1]*ax[0]*C+ax[2]*s, c+ax[1]*ax[1]*C, ax[1]*ax[2]*C-ax[0]*s},
              {ax[2]*ax[0]*C-ax[1]*s, ax[2]*ax[1]*C+ax[0]*s, c+ax[2]*ax[2]*C} }};
}

int main(){
    // a generic (non-degenerate, non-axis-aligned) flat triangle in 3D
    V3<double> V0{0.3,-0.2,0.5}, V1{2.1,0.4,0.7}, V2{0.6,1.7,0.2};
    std::array<std::array<double,2>,5> qpts =
        {{ {0.2,0.3},{0.5,0.25},{0.1,0.8},{1.0/3,1.0/3},{0.05,0.05} }};
    auto Rm = rotation();

    double e_g1=0, e_g2=0, e_g3=0, e_g4=0, maxAab=0;

    for (int p : {2,3,4,5}) {
        BBTriangleBasis<double> B(p);
        int nK = B.size();
        auto X = flat_patch_cps(B, V0, V1, V2);
        std::mt19937 rng(700u+p);
        std::uniform_real_distribution<double> U(-0.05,0.05);

        for (auto& q : qpts) {
            auto d = BasisDerivs::at(B, q[0], q[1]);
            Geom<double> Rg = Geom<double>::build(X, d);   // reference geometry
            // info: confirm A_a,b == 0 on the flat affine patch
            maxAab = std::max({maxAab,
                std::fabs(Rg.a11[0]),std::fabs(Rg.a11[1]),std::fabs(Rg.a11[2]),
                std::fabs(Rg.a22[0]),std::fabs(Rg.a22[1]),std::fabs(Rg.a22[2]),
                std::fabs(Rg.a12[0]),std::fabs(Rg.a12[1]),std::fabs(Rg.a12[2])});

            // ---- G1: rigid translation -> eps_m = 0 ----
            {
                V3<double> t{0.13,-0.27,0.41};
                std::vector<V3<double>> u(nK, t);
                V3<double> em, ka; strains(X,u,d,Rg,em,ka);
                e_g1=std::max({e_g1,std::fabs(em[0]),std::fabs(em[1]),std::fabs(em[2])});
            }
            // ---- G3: finite rigid translation + rotation -> eps_m=0 AND kappa=0 ----
            {
                V3<double> t{-0.2,0.35,0.1};
                std::vector<V3<double>> u(nK);
                for (int k=0;k<nK;++k){
                    V3<double> Xr{};
                    for(int i=0;i<3;++i) Xr[i]=Rm[i][0]*X[k][0]+Rm[i][1]*X[k][1]+Rm[i][2]*X[k][2];
                    for(int i=0;i<3;++i) u[k][i]=Xr[i]+t[i]-X[k][i];     // a_k = R X_k + t
                }
                V3<double> em, ka; strains(X,u,d,Rg,em,ka);
                e_g3=std::max({e_g3,std::fabs(em[0]),std::fabs(em[1]),std::fabs(em[2]),
                                    std::fabs(ka[0]),std::fabs(ka[1]),std::fabs(ka[2])});
            }
            // ---- G2 + G4: analytic B vs complex-step, at u=0 AND a random u0 ----
            for (int trial=0; trial<2; ++trial) {
                std::vector<V3<double>> u0(nK, V3<double>{0,0,0});
                if (trial==1) for (int k=0;k<nK;++k) for(int i=0;i<3;++i) u0[k][i]=U(rng);
                auto c0 = deform(X, u0);
                Bmat Bm, Bb; analytic_B(c0, d, Bm, Bb);

                for (int k=0;k<nK;++k) for (int i=0;i<3;++i) {
                    // complex-step: perturb u_ki by i*H
                    std::vector<V3<cd>> uc(nK);
                    for(int kk=0;kk<nK;++kk) for(int ii=0;ii<3;++ii)
                        uc[kk][ii]=cd(u0[kk][ii], (kk==k&&ii==i)?H:0.0);
                    // reference geom as complex constants (u=0)
                    V3<cd> em, ka; strains(X,uc,d,Rg,em,ka);
                    int col=3*k+i;
                    for (int r=0;r<3;++r){
                        double cs_m = em[r].imag()/H, cs_b = ka[r].imag()/H;
                        e_g2=std::max(e_g2,std::fabs(cs_m - Bm.at(r,col)));
                        e_g4=std::max(e_g4,std::fabs(cs_b - Bb.at(r,col)));
                    }
                }
            }
        }
    }

    std::printf("=== Phase-3 strain-displacement gates (p=2..5, flat patch) ===\n");
    std::printf("  (info) max|A_a,b| on flat affine patch = %.2e  (expect ~0)\n", maxAab);
    rep("G1 membrane rigid translation->0", e_g1, 1e-12);
    rep("G2 B_m vs complex-step",           e_g2, 1e-8);
    rep("G3 rigid-body (trans+rot)->0",     e_g3, 1e-11);
    rep("G4 B_b vs complex-step (incl dn)", e_g4, 1e-8);
    std::printf("\n%s\n", g_ok
        ? "RESULT: PASS - B_m and B_b (incl dn) proven standalone. Ready for K_e (needs gismo)."
        : "RESULT: FAIL.");
    return g_ok?0:1;
}
