// G1 kink coupling, Gate G0.5 Part A: penalty STIFFNESS null-space patch test
// (Ludwig 7.1.4 / SPEC_g1_kinks). gismo-FREE (pure director variations).
//
// G0 checked the penalty RESIDUAL/force (a3+ - ^a3- = 0 for kink-preserving motion).
// This checks the penalty STIFFNESS: the 6 rigid-body modes of the folded two-patch
// system must lie in null(K_penalty) -> the penalty must not stiffen a compatible
// (kink-preserving) motion.
//   K_penalty[(k,i),(l,j)] = kappa * sum_GL w*dL * D_ki . D_lj,   D = d a3+/du - d ^a3-/du
//   ^a3- = cosTheta a3- - sinTheta aN-   (Theta FIXED) ->  d^a3-/du = cosTheta da3- - sinTheta daN-
//   daN = daS x a3 + aS x da3    [FULL, = d R(Theta)/du, linear-consistent]
//
// Translations are trivially in the null space (a3 is translation-invariant).
// ROTATIONS test the FULL daN incl. the daS x a3 term: a rigid rotation keeps the
// kink (a3+ - ^a3- stays 0), so D^T u_rot = 0 IFF daN is assembled correctly. Dropping
// daS x a3 (the "aS x da3 only" approximation) should make the rotation modes leak.
// We assemble BOTH (FULL and PARTIAL) and report which kills the rigid modes.
//
// Build:  g++ -std=c++17 -O2 test_bb_g1_penalty.cpp -o tg05a && ./tg05a
#include "bb_triangle_basis.hpp"
#include "bb_kl_strains.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <cstdio>
using namespace aeris;
static const double PI=3.14159265358979323846;

// 5-point Gauss-Legendre on [0,1]
static const double GL5x[5]={0.046910077030668,0.230765344947158,0.5,0.769234655052842,0.953089922969332};
static const double GL5w[5]={0.118463442528095,0.239314335249683,0.284444444444444,0.239314335249683,0.118463442528095};

static V3<double> nrm(V3<double> v){double n=std::sqrt(dot3(v,v));return {v[0]/n,v[1]/n,v[2]/n};}

// da3/du_ki at a quad point (the Step-5 dn): returns 3-vector for CP k, component i.
static V3<double> dn(const BasisDerivs&d,const Geom<double>&G,int k,int i){
    V3<double> ei{0,0,0}; ei[i]=1.0;
    V3<double> dabar; { V3<double> t1=cross3(ei,G.a2), t2=cross3(G.a1,ei);
        for(int j=0;j<3;++j) dabar[j]=d.N1[k]*t1[j]+d.N2[k]*t2[j]; }
    double proj=dot3(G.a3,dabar); V3<double> r;
    for(int j=0;j<3;++j) r[j]=(dabar[j]-proj*G.a3[j])/G.jbar;
    return r;
}
// daS/du_ki : aS = normalize(a1 t1 + a2 t2);  d(ehat)=(N1 t1 + N2 t2) ei
static V3<double> dS(const BasisDerivs&d,const Geom<double>&G,double t1,double t2,
                     const V3<double>&aS,double es,int k,int i){
    double coef=d.N1[k]*t1+d.N2[k]*t2; V3<double> dehat{0,0,0}; dehat[i]=coef;
    double proj=dot3(aS,dehat); V3<double> r;
    for(int j=0;j<3;++j) r[j]=(dehat[j]-proj*aS[j])/es;
    return r;
}

int main(){
    int p=5; BBTriangleBasis<double> B(p); int nK=B.size();
    double Lx=1.0,Ly=1.0;
    printf("G0.5 Part A: penalty-stiffness null-space patch test (FULL vs PARTIAL daN).\n");
    printf("  6 rigid modes of the folded 2-patch system must be in null(K_penalty).\n");
    printf("  %6s | %22s | %22s\n","Theta","FULL daN: max|K.u_rigid|","PARTIAL (drop daS x a3)");
    bool okFull=true;
    for(double Tdeg:{30.0,90.0,150.0}){
        double Th=Tdeg*PI/180;
        V3<double> V0{0,0,0},V2{0,Ly,0},VA{Lx,0,0},VB{-Lx*std::cos(Th),0,Lx*std::sin(Th)};
        auto XA=flat_patch_cps(B,V0,VA,V2);   // patch A: shared edge V0-V2 is xi1=0
        auto XB=flat_patch_cps(B,V0,V2,VB);   // patch B: shared edge V0-V2 is xi2=0 (outward normal)
        // DOF map (merge shared edge CPs by physical position)
        std::vector<V3<double>> gp; std::vector<int> gA(nK),gB(nK);
        auto foa=[&](const V3<double>&P){for(size_t i=0;i<gp.size();++i)if(std::hypot(std::hypot(gp[i][0]-P[0],gp[i][1]-P[1]),gp[i][2]-P[2])<1e-9)return(int)i;gp.push_back(P);return(int)gp.size()-1;};
        for(int k=0;k<nK;++k)gA[k]=foa(XA[k]); for(int k=0;k<nK;++k)gB[k]=foa(XB[k]);
        int nCP=gp.size(), nd=3*nCP;
        // assemble K_penalty (FULL and PARTIAL) ; kappa=1 (null space is kappa-independent)
        std::vector<std::vector<double>> Kf(nd,std::vector<double>(nd,0.0)), Kp(nd,std::vector<double>(nd,0.0));
        for(int g=0;g<5;++g){ double s=GL5x[g], w=GL5w[g]*Ly;   // dL = Ly ds
            BasisDerivs dA=BasisDerivs::at(B,0.0,s);  Geom<double> GA=Geom<double>::build(XA,dA);  // patch A edge xi1=0
            BasisDerivs dB=BasisDerivs::at(B,s,0.0);  Geom<double> GB=Geom<double>::build(XB,dB);  // patch B edge xi2=0
            double tA1=0,tA2=1, tB1=1,tB2=0;          // edge ref-directions V0->V2
            V3<double> ehA{GA.a1[0]*tA1+GA.a2[0]*tA2,GA.a1[1]*tA1+GA.a2[1]*tA2,GA.a1[2]*tA1+GA.a2[2]*tA2};
            V3<double> ehB{GB.a1[0]*tB1+GB.a2[0]*tB2,GB.a1[1]*tB1+GB.a2[1]*tB2,GB.a1[2]*tB1+GB.a2[2]*tB2};
            double esA=std::sqrt(dot3(ehA,ehA)), esB=std::sqrt(dot3(ehB,ehB));
            V3<double> aSA=nrm(ehA), aSB=nrm(ehB);
            double cT=dot3(GA.a3,GB.a3), sT=-dot3(GA.a3, nrm(cross3(aSB,GB.a3)));   // (7.1/7.2)
            // build Dmat_full, Dmat_part : (nd x 3)
            std::vector<std::array<double,3>> Df(nd,{0,0,0}), Dp(nd,{0,0,0});
            for(int k=0;k<nK;++k)for(int i=0;i<3;++i){
                // "+" side (patch A): + da3+
                V3<double> da3A=dn(dA,GA,k,i);
                for(int c=0;c<3;++c){ Df[3*gA[k]+i][c]+=da3A[c]; Dp[3*gA[k]+i][c]+=da3A[c]; }
                // "-" side (patch B): - ^da3- ; ^da3- = cT da3B - sT daNB
                V3<double> da3B=dn(dB,GB,k,i);
                V3<double> daSB=dS(dB,GB,tB1,tB2,aSB,esB,k,i);
                V3<double> daNB_full, daNB_part;
                { V3<double> t1=cross3(daSB,GB.a3), t2=cross3(aSB,da3B);
                  for(int c=0;c<3;++c){ daNB_full[c]=t1[c]+t2[c]; daNB_part[c]=t2[c]; } }
                V3<double> dh_full, dh_part;
                for(int c=0;c<3;++c){ dh_full[c]=cT*da3B[c]-sT*daNB_full[c]; dh_part[c]=cT*da3B[c]-sT*daNB_part[c]; }
                for(int c=0;c<3;++c){ Df[3*gB[k]+i][c]-=dh_full[c]; Dp[3*gB[k]+i][c]-=dh_part[c]; }
            }
            for(int a=0;a<nd;++a)for(int b=0;b<nd;++b){ double sf=0,sp=0; for(int c=0;c<3;++c){sf+=Df[a][c]*Df[b][c]; sp+=Dp[a][c]*Dp[b][c];}
                Kf[a][b]+=w*sf; Kp[a][b]+=w*sp; }
        }
        // 6 rigid modes (translations + rotations) of the folded structure
        auto Kmul=[&](std::vector<std::vector<double>>&K,std::vector<double>&u){ double mx=0; for(int a=0;a<nd;++a){double s=0;for(int b=0;b<nd;++b)s+=K[a][b]*u[b]; mx=std::max(mx,std::fabs(s));} return mx; };
        double Knorm=0; for(int a=0;a<nd;++a)for(int b=0;b<nd;++b)Knorm=std::max(Knorm,std::fabs(Kf[a][b]));
        double worstFull=0,worstPart=0;
        for(int mode=0;mode<6;++mode){ std::vector<double> u(nd,0.0);
            for(int cp=0;cp<nCP;++cp){ V3<double> X=gp[cp];
                if(mode<3){ u[3*cp+mode]=1.0; }                                  // translation
                else{ int ax=mode-3; V3<double> w{0,0,0}; w[ax]=1; V3<double> r=cross3(w,X);
                      for(int i=0;i<3;++i)u[3*cp+i]=r[i]; } }                     // rotation about axis ax
            double un=0; for(double v:u)un+=v*v; un=std::sqrt(un);
            worstFull=std::max(worstFull, Kmul(Kf,u)/(Knorm*un));
            worstPart=std::max(worstPart, Kmul(Kp,u)/(Knorm*un));
        }
        printf("  %5.0f  | %22.3e | %22.3e\n",Tdeg,worstFull,worstPart);
        if(worstFull>1e-12) okFull=false;
    }
    printf("\n%s\n", okFull
      ? "RESULT: PASS (FULL) - the 6 rigid modes are in null(K_penalty) with the FULL daN "
        "(daS x a3 + aS x da3). If PARTIAL is also ~0, the daS x a3 term is negligible here; "
        "if PARTIAL leaks (rotations), the term BITES and FULL is required."
      : "RESULT: FAIL - FULL daN does not null the rigid modes; inspect dn / daS / Theta sign.");
    return okFull?0:1;
}
