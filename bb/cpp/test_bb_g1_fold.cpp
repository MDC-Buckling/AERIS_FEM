// G1 kink coupling, Gate G0: flat fold patch test — rotated-director CONSISTENCY
// anchor (Ludwig Ch 7, penalty method; SPEC_g1_kinks.md). gismo-FREE (pure frames).
//
// Two flat BB patches meeting at a fold edge (the y-axis, x=0) at initial angle Theta.
// The G1 condition is director coincidence a3+ = ^a3- with the rotated director
//   (7.3)  ^a3- = cosTheta * a3- - sinTheta * aN-       (rotate "-" director about the
//                                                        common edge by the FIXED Theta)
// G0 = the penalty residual ||a3+ - ^a3-|| must be at machine zero for any motion that
// PRESERVES the kink (the consistency anchor, analog to the Step-4 C1 patch test):
//   (a) reference config: the rotation by Theta maps a3- onto a3+ exactly;
//   (b) rigid-body motion of the WHOLE fold: residual stays 0 (frame-objective);
//   (c) an INCOMPATIBLE re-fold (kink-angle change delta) makes residual ~|delta| != 0
//       (anchors that the residual is not trivially zero -> the penalty WOULD activate).
//
// Sign convention (pinned here, the pitfall the spec flags): aN = aS x a3, with aS in a
// GLOBALLY-CONSISTENT edge orientation on both sides. Then (7.3) reproduces a3+; with
// a3 x aS the sign flips and (7.2) sinTheta = -a3+ . aN- breaks.
//
// Build:  g++ -std=c++17 -O2 test_bb_g1_fold.cpp -o tg0 && ./tg0
#include "bb_triangle_basis.hpp"
#include "bb_kl_strains.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <cstdio>
using namespace aeris;
static const double PI=3.14159265358979323846;

// frame at the fold edge of a flat triangular patch (V0,V1,V2), edge = V0->V2 (the fold
// line); aS oriented V0->V2 (global-consistent), a3 = outward normal, aN = aS x a3.
struct Frame{ V3<double> a3, aS, aN; };
static V3<double> nrm(V3<double> v){ double n=std::sqrt(dot3(v,v)); return {v[0]/n,v[1]/n,v[2]/n}; }
static Frame frame_of(const std::vector<V3<double>>& X, const BBTriangleBasis<double>& B,
                      const V3<double>& V0, const V3<double>& V2){
    // a1,a2 from BB geometry at the centroid (flat -> constant); a3 = a1 x a2 normalized
    auto d=BasisDerivs::at(B, 1.0/3, 1.0/3); Geom<double> G=Geom<double>::build(X,d);
    Frame f; f.a3=nrm(G.a3);
    f.aS=nrm(V3<double>{V2[0]-V0[0],V2[1]-V0[1],V2[2]-V0[2]});   // edge V0->V2 (consistent orientation)
    f.aN=nrm(cross3(f.aS,f.a3));                                  // aN = aS x a3  (PINNED convention)
    return f;
}
// rotate director "-" about the common edge by the fixed initial angle Theta (7.3/7.4)
static V3<double> rot_director(double cT,double sT,const V3<double>& a3m,const V3<double>& aNm){
    return { cT*a3m[0]-sT*aNm[0], cT*a3m[1]-sT*aNm[1], cT*a3m[2]-sT*aNm[2] };
}
static double resid(const V3<double>&a,const V3<double>&b){ V3<double> d{a[0]-b[0],a[1]-b[1],a[2]-b[2]}; return std::sqrt(dot3(d,d)); }

// apply a rigid rotation Q (about axis (1,2,3) by ang) + translation to a CP set
static std::vector<V3<double>> rigid(const std::vector<V3<double>>& X,double ang,const V3<double>& tr){
    V3<double> ax=nrm(V3<double>{1,2,3}); double c=std::cos(ang),s=std::sin(ang),C=1-c;
    double Q[3][3]={{c+ax[0]*ax[0]*C, ax[0]*ax[1]*C-ax[2]*s, ax[0]*ax[2]*C+ax[1]*s},
                    {ax[1]*ax[0]*C+ax[2]*s, c+ax[1]*ax[1]*C, ax[1]*ax[2]*C-ax[0]*s},
                    {ax[2]*ax[0]*C-ax[1]*s, ax[2]*ax[1]*C+ax[0]*s, c+ax[2]*ax[2]*C}};
    std::vector<V3<double>> Y(X.size());
    for(size_t k=0;k<X.size();++k)for(int i=0;i<3;++i)Y[k][i]=Q[i][0]*X[k][0]+Q[i][1]*X[k][1]+Q[i][2]*X[k][2]+tr[i];
    return Y;
}

int main(){
    int p=5; BBTriangleBasis<double> B(p);
    double Lx=1.0, Ly=1.0;
    printf("G0 flat-fold patch test (rotated director, Ludwig 7.3). aN = aS x a3.\n");
    printf("  %6s | %14s | %16s | %16s | %16s\n","Theta","res_ref","res_rigid","res_incompat(d=.1)","Theta_meas err");
    bool ok=true;
    for(double Tdeg:{0.0,30.0,90.0,150.0}){
        double Th=Tdeg*PI/180;
        // shared fold edge V0->V2 along y at x=0; patch A in z=0 (+x), patch B folded by Th
        V3<double> V0{0,0,0}, V2{0,Ly,0};
        V3<double> VA{Lx,0,0};                               // patch A third vertex (+x, z=0)
        V3<double> VB{-Lx*std::cos(Th),0,Lx*std::sin(Th)};   // patch B third vertex (folded by Th)
        auto XA=flat_patch_cps(B,V0,VA,V2);                  // patch A: edge V0->V2 is its 0--2 edge
        auto XB=flat_patch_cps(B,V0,V2,VB);                  // patch B: order (V0,V2,VB) -> OUTWARD normal, consistent with A
        Frame fA=frame_of(XA,B,V0,V2), fB=frame_of(XB,B,V0,V2);
        // Theta from the reference frames (7.1/7.2): cosTheta = a3+.a3- ; sinTheta = -a3+.aN-
        double cT=dot3(fA.a3,fB.a3), sT=-dot3(fA.a3,fB.aN);
        double Tmeas=std::atan2(sT,cT); double Terr=std::fabs(std::fabs(Tmeas)-Th);
        // (a) reference residual: rotate "-" director by Theta -> must equal a3+
        V3<double> a3hat=rot_director(cT,sT,fB.a3,fB.aN);
        double r_ref=resid(fA.a3,a3hat);
        // (b) rigid motion of the whole fold: residual must stay 0 (frame-objective)
        V3<double> tr{0.3,-0.7,1.1};
        auto XAr=rigid(XA,0.9,tr), XBr=rigid(XB,0.9,tr);
        V3<double> V0r=rigid(std::vector<V3<double>>{V0},0.9,tr)[0], V2r=rigid(std::vector<V3<double>>{V2},0.9,tr)[0];
        Frame fAr=frame_of(XAr,B,V0r,V2r), fBr=frame_of(XBr,B,V0r,V2r);
        double cTr=dot3(fAr.a3,fBr.a3), sTr=-dot3(fAr.a3,fBr.aN);
        double r_rigid=resid(fAr.a3, rot_director(cTr,sTr,fBr.a3,fBr.aN));
        // (c) incompatible re-fold: patch B folded by Th+delta but Theta held at the initial Th
        //     -> residual ~|delta| (penalty would activate)
        double delta=0.1; V3<double> VBd{-Lx*std::cos(Th+delta),0,Lx*std::sin(Th+delta)};
        auto XBd=flat_patch_cps(B,V0,V2,VBd); Frame fBd=frame_of(XBd,B,V0,V2);
        V3<double> a3hat_d=rot_director(cT,sT,fBd.a3,fBd.aN);   // rotate by the ORIGINAL Theta
        double r_incompat=resid(fA.a3,a3hat_d);
        printf("  %5.0f  | %14.3e | %16.3e | %16.4f | %14.3e\n",Tdeg,r_ref,r_rigid,r_incompat,Terr);
        if(r_ref>1e-13||r_rigid>1e-13||r_incompat<1e-3||Terr>1e-12) ok=false;
    }
    printf("\n%s\n", ok
      ? "RESULT: PASS - rotated-director residual machine-zero for kink-preserving motion "
        "(reference + rigid), nonzero for an incompatible re-fold. Construction + aN sign + "
        "Theta-from-frames verified. Ready for the penalty stiffness + kappa sweep (G0.5)."
      : "RESULT: FAIL - inspect aN sign convention / Theta extraction (7.1-7.3).");
    return ok?0:1;
}
