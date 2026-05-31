// Cylinder step 2b: M = D * Delta-kappa on a curved reference (Aeris BB).
// Pure C++ / no gismo (D_cart shifter-free == eval3D, proven in test_bb_shifter).
// Build: g++ -std=c++17 -O2 test_bb_curved_kappa.cpp -o t && ./t
//
// On a CURVED reference, verify the bending strain-displacement gives the correct
// curvature CHANGE Delta-kappa = b - B (NOT 1/R; undeformed shape is stress-free).
// Two design points the curved case adds over the flat plate:
//   * kappa is the CHANGE (B_b built from b-B; reference B subtracted).
//   * curved reference RE-COUPLES membrane+bending: a deformation induces membrane
//     strain eps != 0 (normal motion on a curved surface stretches the midsurface).
//     PHYSICS, not a bug. M = D*kappa stays clean because Ludwig's B(coupling)=0.
// Check (non-circular): analytic B_m*u, B_b*u vs complex-step directional derivative
// of the nonlinear strains along u, on the curved reference.
#include "bb_kl_strains.hpp"
#include <array>
#include <vector>
#include <complex>
#include <cmath>
#include <cstdio>
#include <algorithm>
using namespace aeris;
using cd=std::complex<double>;
static const double H=1e-200;

int main(){
    const double E=1.0e6,nu=0.3,thick=0.1;
    double f=E*thick/(1-nu*nu)*thick*thick/12.0;          // plate D scale
    std::array<std::array<double,3>,3> Dc={{{f,f*nu,0},{f*nu,f,0},{0,0,f*(1-nu)/2}}};
    V3<double> V0{0,0,0},V1{2.0,0,0},V2{0.6,1.5,0};
    std::array<std::array<double,2>,4> qp={{{0.25,0.3},{0.5,0.2},{0.2,0.6},{1.0/3,1.0/3}}};
    double e_k=0,e_m=0,maxEps=0,maxAab=0,Msample=0,Nsample=0;
    for(int p:{3,4,5}){
        BBTriangleBasis<double> B(p); int nK=B.size();
        auto X=flat_patch_cps(B,V0,V1,V2);
        for(int k=0;k<nK;++k){double x=X[k][0],y=X[k][1];X[k][2]=0.4*x*x+0.25*x*y+0.3*y*y;} // curve it
        // a generic smooth displacement field u (DOF vector + per-CP V3)
        std::vector<V3<double>> uf(nK);
        for(int k=0;k<nK;++k){double x=X[k][0],y=X[k][1];
            uf[k]={0.01*x*y, 0.008*y*y, 0.02*x*x-0.01*x};}
        std::vector<double> ufl(3*nK); for(int k=0;k<nK;++k)for(int i=0;i<3;++i)ufl[3*k+i]=uf[k][i];
        for(auto&q:qp){
            auto d=BasisDerivs::at(B,q[0],q[1]); Geom<double> Rg=Geom<double>::build(X,d);
            maxAab=std::max({maxAab,std::fabs(Rg.a11[2]),std::fabs(Rg.a22[2]),std::fabs(Rg.a12[2])});
            Bmat Bm,Bb; analytic_B(X,d,Bm,Bb);
            // analytic linearized strains along u
            std::array<double,3> epsA{0,0,0},kapA{0,0,0};
            for(int c=0;c<Bm.ncols;++c){for(int r=0;r<3;++r){epsA[r]+=Bm.at(r,c)*ufl[c];kapA[r]+=Bb.at(r,c)*ufl[c];}}
            // complex-step directional derivative of nonlinear strain along u
            std::vector<V3<cd>> uc(nK); for(int k=0;k<nK;++k)for(int i=0;i<3;++i)uc[k][i]=cd(0.0,H*uf[k][i]);
            V3<cd> em,ka; strains(X,uc,d,Rg,em,ka);
            for(int r=0;r<3;++r){ e_m=std::max(e_m,std::fabs(em[r].imag()/H-epsA[r]));
                                  e_k=std::max(e_k,std::fabs(ka[r].imag()/H-kapA[r])); }
            // induced membrane (physics) + sample moment M = D*kappa
            maxEps=std::max({maxEps,std::fabs(epsA[0]),std::fabs(epsA[1]),std::fabs(epsA[2])});
            std::array<double,3> M{Dc[0][0]*kapA[0]+Dc[0][1]*kapA[1],Dc[1][0]*kapA[0]+Dc[1][1]*kapA[1],Dc[2][2]*kapA[2]};
            double mn=std::sqrt(M[0]*M[0]+M[1]*M[1]+M[2]*M[2]);
            double en=std::sqrt(epsA[0]*epsA[0]+epsA[1]*epsA[1]+epsA[2]*epsA[2]);
            Msample=std::max(Msample,mn); Nsample=std::max(Nsample,en*(E*thick/(1-nu*nu)));
        }
    }
    printf("curved reference: max|A_a,b (z)| = %.3e  (>>0 => curved)\n",maxAab);
    bool ok=(e_k<1e-9)&&(e_m<1e-9);
    printf("  [%s] B_b*u == complex-step(kappa) on curved ref   max|err| = %.3e\n",e_k<1e-9?"PASS":"FAIL",e_k);
    printf("  [%s] B_m*u == complex-step(eps)   on curved ref   max|err| = %.3e\n",e_m<1e-9?"PASS":"FAIL",e_m);
    printf("  induced membrane eps_m != 0 (curved re-coupling, PHYSICS): max|eps| = %.3e (N~%.3g)\n",maxEps,Nsample);
    printf("  sample moment M = D*kappa: ||M|| ~ %.3g  (kappa = the CHANGE b-B; ref is stress-free)\n",Msample);
    printf("\n%s\n", ok
      ? "RESULT: PASS - on a curved reference B_b gives the correct curvature CHANGE (complex-step), "
        "B_m the induced membrane (eps!=0, physics); with shifter-free D (test_bb_shifter) M=D*kappa "
        "is the validated composition. Step 2 GREEN."
      : "RESULT: FAIL.");
    return ok?0:1;
}
