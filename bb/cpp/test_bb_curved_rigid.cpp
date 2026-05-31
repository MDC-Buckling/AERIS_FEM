// Cylinder step 1: curved-reference rigid-rotation test = the geometric dn gate
// (Aeris BB). Pure C++ / no gismo. Build: g++ -std=c++17 -O2 test_bb_curved_rigid.cpp -o t && ./t
//
// On a CURVED reference (A_a,b != 0) the bending strain-displacement B_b applied
// to a rigid-body rotation field must vanish: B_b . u_rigid = 0. This is an
// EMERGENT cancellation the flat plate could NOT test (there A_a,b=0, so the dn
// term -a_a,b . da3 and the -N_k,ab a3i term are BOTH zero individually):
//   B_b.u_rot = -A3.(theta x A_a,b) - A_a,b.(theta x A3)
//             = -theta.(A_a,b x A3) + theta.(A_a,b x A3) = 0   (triple product)
// requires the two terms to cancel exactly -> same a3, same sign, consistent
// metric. A failure points at the RELATIVE convention of the two bending terms,
// not either alone (each was pinned standalone by complex-step in Phase 3).
//
// Isolation: rigid motion -> zero strain -> the constitutive (eval3D A/D) is
// never touched. Pure dn kinematics, no curved-metric confounding.
#include "bb_kl_strains.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <cstdio>
#include <algorithm>

using namespace aeris;

int main(){
    // curved BB-triangle patch: flat xy net + a genuine quadratic z-bulge => A_a,b != 0
    V3<double> V0{0.0,0.0,0.0}, V1{2.0,0.0,0.0}, V2{0.6,1.5,0.0};
    std::array<std::array<double,2>,5> qp={{ {0.2,0.3},{0.5,0.2},{0.15,0.7},{1.0/3,1.0/3},{0.05,0.05} }};
    // finite rotation (Rodrigues), axis (1,2,3)/sqrt14, angle 0.4
    auto Rmat=[&](){double ax[3]={1,2,3},n=std::sqrt(14.0);for(double&x:ax)x/=n;double th=0.4,c=std::cos(th),s=std::sin(th),C=1-c;
        return std::array<std::array<double,3>,3>{{ {c+ax[0]*ax[0]*C,ax[0]*ax[1]*C-ax[2]*s,ax[0]*ax[2]*C+ax[1]*s},
          {ax[1]*ax[0]*C+ax[2]*s,c+ax[1]*ax[1]*C,ax[1]*ax[2]*C-ax[0]*s},
          {ax[2]*ax[0]*C-ax[1]*s,ax[2]*ax[1]*C+ax[0]*s,c+ax[2]*ax[2]*C} }};}();

    double e_Bb=0,e_Bm=0,e_nl=0,maxAab=0;
    for(int p:{3,4,5}){
        BBTriangleBasis<double> B(p); int nK=B.size();
        auto X=flat_patch_cps(B,V0,V1,V2);
        for(int k=0;k<nK;++k){double x=X[k][0],y=X[k][1]; X[k][2]=0.4*x*x+0.25*x*y+0.3*y*y;} // curve it
        for(auto&q:qp){
            auto d=BasisDerivs::at(B,q[0],q[1]);
            Geom<double> Rg=Geom<double>::build(X,d);
            maxAab=std::max({maxAab,std::fabs(Rg.a11[2]),std::fabs(Rg.a22[2]),std::fabs(Rg.a12[2])});
            Bmat Bm,Bb; analytic_B(X,d,Bm,Bb);   // B at the CURVED reference (incl dn)
            // 3 rotations + 3 translations (infinitesimal; B is linear)
            for(int mode=0;mode<6;++mode){
                std::vector<double> u(3*nK,0.0);
                if(mode<3){ V3<double> th{0,0,0}; th[mode]=1.0;
                    for(int k=0;k<nK;++k){ // theta x X_k
                        u[3*k+0]=th[1]*X[k][2]-th[2]*X[k][1];
                        u[3*k+1]=th[2]*X[k][0]-th[0]*X[k][2];
                        u[3*k+2]=th[0]*X[k][1]-th[1]*X[k][0]; } }
                else { int dir=mode-3; for(int k=0;k<nK;++k) u[3*k+dir]=1.0; }
                for(int r=0;r<3;++r){ double sb=0,sm=0;
                    for(int c=0;c<Bb.ncols;++c){ sb+=Bb.at(r,c)*u[c]; sm+=Bm.at(r,c)*u[c]; }
                    e_Bb=std::max(e_Bb,std::fabs(sb)); e_Bm=std::max(e_Bm,std::fabs(sm)); }
            }
            // nonlinear strain frame-invariance: finite rotation u=(R-I)X -> eps=0,kappa=0
            std::vector<V3<double>> u(nK);
            for(int k=0;k<nK;++k){ V3<double> Xr{};
                for(int i=0;i<3;++i)Xr[i]=Rmat[i][0]*X[k][0]+Rmat[i][1]*X[k][1]+Rmat[i][2]*X[k][2];
                for(int i=0;i<3;++i)u[k][i]=Xr[i]-X[k][i]; }
            V3<double> em,ka; strains(X,u,d,Rg,em,ka);
            e_nl=std::max({e_nl,std::fabs(em[0]),std::fabs(em[1]),std::fabs(em[2]),
                                std::fabs(ka[0]),std::fabs(ka[1]),std::fabs(ka[2])});
        }
    }
    printf("curved patch: max|A_a,b (z)| = %.3e  (>>0 => curved, dn ACTIVE)\n",maxAab);
    bool ok=(e_Bb<1e-9)&&(e_Bm<1e-9)&&(e_nl<1e-9);
    printf("  [%s] B_b . u_rigid (dn vs -N_k,ab a3i cancellation)  max|.| = %.3e\n",e_Bb<1e-9?"PASS":"FAIL",e_Bb);
    printf("  [%s] B_m . u_rigid                                   max|.| = %.3e\n",e_Bm<1e-9?"PASS":"FAIL",e_Bm);
    printf("  [%s] nonlinear strain, finite rigid rotation -> 0    max|.| = %.3e\n",e_nl<1e-9?"PASS":"FAIL",e_nl);
    printf("\n%s\n", ok
      ? "RESULT: PASS - the dn term and the -N_k,ab a3i term cancel exactly on a CURVED reference. "
        "Geometric dn gate GREEN (the flat plate could not exercise this). dn fully validated."
      : "RESULT: FAIL - relative convention of the two bending terms (a3 / sign / metric).");
    return ok?0:1;
}
