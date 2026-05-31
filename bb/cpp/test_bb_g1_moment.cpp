// G1 kink coupling, Gate G1: moment transfer across the fold (Ludwig 7.1 penalty;
// SPEC_g1_kinks). gismo-linked (eval3D for K_e). Anchored to the analytic folded-plate.
//
// (1) MOMENT PATCH TEST (consistency, kappa-independent, Step-4-clean primary): a global
//     G1-compatible CONSTANT-MOMENT (constant-curvature) folded-bending state lies in the
//     penalty null space (slopes matched at the fold) AND is a homogeneous equilibrium
//     state (constant M => no distributed load). Prescribe it on the boundary CPs of both
//     plates, solve the interior -> must reproduce it to machine precision, at ANY kappa.
//     Field: u = 1/2 c s^2 * n_hat  (s = distance from fold along the plate, n_hat = plate
//     normal). Moment M = c*D continuous across the fold; rotation 0 at fold (symmetric) = G1.
//
// (2) kappa-TRANSFER: plate "-" rigid (clamped), a force COUPLE on plate "+" (rotation-free
//     moment = +F/-F on two adjacent CP rows). The transmitted moment = M by EQUILIBRIUM
//     (kappa-independent); the kappa-sensitive G1 quality is the KINK-ANGLE GAP phi ~ M/kappa
//     (linearized residual a3+ - ^a3- at the solution) and the fold curvature -> M/D. Sweep
//     kappa: phi -> 0 over the plateau; does the transfer fidelity bind kappa tighter than
//     the G0.5 deflection plateau?
//
// Build: g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//   -I/opt/gismo/external test_bb_g1_moment.cpp -L/opt/gismo/build/lib -lgismo \
//   -Wl,-rpath,/opt/gismo/build/lib -o tg1 && ./tg1 2>/dev/null
#include <gismo.h>
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include "bb_kl_strains.hpp"
#include <gsKLShell/src/getMaterialMatrix.h>
#include <gsKLShell/src/gsMaterialMatrixIntegrate.h>
#include <array>
#include <vector>
#include <cmath>
#include <cstdio>
using namespace gismo;
using aeris::BBTriangleBasis; using aeris::BasisDerivs; using aeris::Bmat;
using aeris::analytic_B; using aeris::Geom; using aeris::V3; using aeris::dot3; using aeris::cross3; using aeris::flat_patch_cps;
using aeris::quad_triangle;
typedef gsEigen::Matrix<real_t,gsEigen::Dynamic,gsEigen::Dynamic> EMat;
static const double PI=3.14159265358979323846;
static const double E=1.0e6,nu=0.3,thick=0.05;
static const double GL5x[5]={0.046910077030668,0.230765344947158,0.5,0.769234655052842,0.953089922969332};
static const double GL5w[5]={0.118463442528095,0.239314335249683,0.284444444444444,0.239314335249683,0.118463442528095};
static V3<double> nrm(V3<double> v){double n=std::sqrt(dot3(v,v));return {v[0]/n,v[1]/n,v[2]/n};}
static V3<double> dn_(const BasisDerivs&d,const Geom<double>&G,int k,int i){
    V3<double> ei{0,0,0}; ei[i]=1.0; V3<double> dabar;{V3<double> t1=cross3(ei,G.a2),t2=cross3(G.a1,ei);for(int j=0;j<3;++j)dabar[j]=d.N1[k]*t1[j]+d.N2[k]*t2[j];}
    double pr=dot3(G.a3,dabar);V3<double> r;for(int j=0;j<3;++j)r[j]=(dabar[j]-pr*G.a3[j])/G.jbar;return r;}
static V3<double> dS_(const BasisDerivs&d,const Geom<double>&G,double t1,double t2,const V3<double>&aS,double es,int k,int i){
    double cf=d.N1[k]*t1+d.N2[k]*t2;V3<double> de{0,0,0};de[i]=cf;double pr=dot3(aS,de);V3<double> r;for(int j=0;j<3;++j)r[j]=(de[j]-pr*aS[j])/es;return r;}
static void eval3D_AD(const V3<double>&a1,const V3<double>&a2,gsMatrix<real_t>&A,gsMatrix<real_t>&D){
    gsMultiPatch<real_t> mp;mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));mp.embed(3);
    gsMatrix<real_t>&C=mp.patch(0).coefs();for(index_t r=0;r<C.rows();++r){double xi=C(r,0),eta=C(r,1);for(int i=0;i<3;++i)C(r,i)=xi*a1[i]+eta*a2[i];}
    gsFunctionExpr<real_t> t(std::to_string(thick),3),Ef(std::to_string(E),3),nf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pr{&Ef,&nf};gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,t,pr,o);gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);gsVector<real_t> pt(2);pt<<0.5,0.5;
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    A=ev.eval(ea.getCoeff(mmA),pt);A.resize(3,3);D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3);}

int main(){
    int p=5; BBTriangleBasis<double> B(p); int nK=B.size();
    double Lx=1.0,Ly=1.0,Th=90.0*PI/180;
    double Dp=E*thick*thick*thick/(12*(1-nu*nu));      // plate cylindrical bending stiffness
    V3<double> V0{0,0,0},V2{0,Ly,0},VA{Lx,0,0},VB{-Lx*std::cos(Th),0,Lx*std::sin(Th)};
    auto XAp=flat_patch_cps(B,V0,VA,V2);   // plate + (z=0)
    auto XBm=flat_patch_cps(B,V0,V2,VB);   // plate - (folded), shared edge V0-V2 = xi2=0, outward normal
    V3<double> nP{0,0,1}, nM{std::sin(Th),0,std::cos(Th)};
    // global DOF map (merge shared fold CPs)
    std::vector<V3<double>> gp; std::vector<int> gA(nK),gB(nK);
    auto foa=[&](const V3<double>&P){for(size_t i=0;i<gp.size();++i)if(std::hypot(std::hypot(gp[i][0]-P[0],gp[i][1]-P[1]),gp[i][2]-P[2])<1e-9)return(int)i;gp.push_back(P);return(int)gp.size()-1;};
    for(int k=0;k<nK;++k)gA[k]=foa(XAp[k]); for(int k=0;k<nK;++k)gB[k]=foa(XBm[k]);
    int nCP=gp.size(), nd=3*nCP;
    double eta=(E/(2*(1+nu)))*thick*thick*thick/Ly;

    // ---- K_e (both plates) ----
    auto asmKe=[&](const std::vector<V3<double>>&X,const std::vector<int>&g,EMat&K){
        for(auto&q:quad_triangle(2*p)){auto d=BasisDerivs::at(B,q.xi1,q.xi2);Geom<double> G=Geom<double>::build(X,d);
            gsMatrix<real_t> A,D;eval3D_AD(G.a1,G.a2,A,D);double Jac=G.jbar;Bmat Bm,Bb;analytic_B(X,d,Bm,Bb);
            for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*g[a]+i;
                for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*g[b]+j;
                    double v=0;for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s=0;s<3;++s){Am+=A(r,s)*Bm.at(s,3*b+j);Dm+=D(r,s)*Bb.at(s,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                    K(ga,gb)+=q.w*Jac*v;}}}};
    EMat Ke=EMat::Zero(nd,nd); asmKe(XAp,gA,Ke); asmKe(XBm,gB,Ke);
    // ---- K_penalty per unit kappa (FULL daN, two-sided) ----
    EMat Kp1=EMat::Zero(nd,nd);
    for(int gq=0;gq<5;++gq){double s=GL5x[gq],w=GL5w[gq]*Ly;
        BasisDerivs dA=BasisDerivs::at(B,0.0,s); Geom<double> GA=Geom<double>::build(XAp,dA);  // + edge xi1=0
        BasisDerivs dB=BasisDerivs::at(B,s,0.0); Geom<double> GB=Geom<double>::build(XBm,dB);  // - edge xi2=0
        double tA1=0,tA2=1,tB1=1,tB2=0;
        V3<double> ehA{GA.a1[0]*tA1+GA.a2[0]*tA2,GA.a1[1]*tA1+GA.a2[1]*tA2,GA.a1[2]*tA1+GA.a2[2]*tA2};
        V3<double> ehB{GB.a1[0]*tB1+GB.a2[0]*tB2,GB.a1[1]*tB1+GB.a2[1]*tB2,GB.a1[2]*tB1+GB.a2[2]*tB2};
        double esA=std::sqrt(dot3(ehA,ehA)),esB=std::sqrt(dot3(ehB,ehB));V3<double> aSA=nrm(ehA),aSB=nrm(ehB);
        double cT=dot3(GA.a3,GB.a3),sT=-dot3(GA.a3,nrm(cross3(aSB,GB.a3)));
        std::vector<std::array<double,3>> Dm(nd,{0,0,0});
        for(int k=0;k<nK;++k)for(int i=0;i<3;++i){ V3<double> da3A=dn_(dA,GA,k,i);
            for(int c=0;c<3;++c)Dm[3*gA[k]+i][c]+=da3A[c];
            V3<double> da3B=dn_(dB,GB,k,i),daSB=dS_(dB,GB,tB1,tB2,aSB,esB,k,i);
            V3<double> daNB;{V3<double> u=cross3(daSB,GB.a3),v=cross3(aSB,da3B);for(int c=0;c<3;++c)daNB[c]=u[c]+v[c];}
            for(int c=0;c<3;++c)Dm[3*gB[k]+i][c]-=(cT*da3B[c]-sT*daNB[c]); }
        for(int a=0;a<nd;++a)for(int b=0;b<nd;++b){double sd=0;for(int c=0;c<3;++c)sd+=Dm[a][c]*Dm[b][c];Kp1(a,b)+=w*sd;}
    }
    // analytic G1 constant-moment field: u = 1/2 c s^2 n_hat
    double c_curv=0.02;
    auto ufield=[&](const V3<double>&X,bool plus)->V3<double>{
        double s = plus? X[0] : std::sqrt(X[0]*X[0]+X[2]*X[2]); V3<double> n= plus? nP:nM;
        double a=0.5*c_curv*s*s; return {a*n[0],a*n[1],a*n[2]}; };
    // u_analytic per global CP (shared fold CP: s=0 on both -> u=0, consistent)
    std::vector<V3<double>> uan(nCP,{0,0,0});
    for(int k=0;k<nK;++k){ uan[gA[k]]=ufield(XAp[k],true); uan[gB[k]]=ufield(XBm[k],false); }

    // boundary CPs = all EDGE CPs of either triangle (alpha has a zero); interior = face CPs
    auto isEdge=[&](int k){const auto&a=B.alpha()[k];return a[0]==0||a[1]==0||a[2]==0;};
    std::vector<char> bnd(nCP,0);
    for(int k=0;k<nK;++k){ if(isEdge(k))bnd[gA[k]]=1; if(isEdge(k))bnd[gB[k]]=1; }
    printf("G1 moment transfer (fold Theta=90, eta=%.4g, D=%.4g).  nCP=%d\n",eta,Dp,nCP);

    // ---- (1) MOMENT PATCH TEST at two kappa (must reproduce, kappa-independent) ----
    printf("\n(1) MOMENT PATCH TEST: prescribe G1 constant-moment field on boundary, solve interior.\n");
    printf("    %10s | %18s\n","P (kappa/eta)","max|u_int - analytic|");
    for(double P:{1e0,1e4}){ double kap=P*eta; EMat K=Ke+kap*Kp1;
        std::vector<int> fr,bd; for(int cp=0;cp<nCP;++cp)for(int i=0;i<3;++i){ if(bnd[cp])bd.push_back(3*cp+i); else fr.push_back(3*cp+i); }
        int nf=fr.size(); EMat Kii(nf,nf),Kib(nf,(int)bd.size());
        for(int a=0;a<nf;++a){for(int b=0;b<nf;++b)Kii(a,b)=K(fr[a],fr[b]); for(size_t b=0;b<bd.size();++b)Kib(a,b)=K(fr[a],bd[b]);}
        EMat ub((int)bd.size(),1); for(size_t b=0;b<bd.size();++b){int cp=bd[b]/3,i=bd[b]%3; ub(b,0)=uan[cp][i];}
        EMat ui=Kii.ldlt().solve(-Kib*ub);
        double err=0; for(int a=0;a<nf;++a){int cp=fr[a]/3,i=fr[a]%3; err=std::max(err,std::fabs(ui(a,0)-uan[cp][i]));}
        printf("    %10.0e | %18.3e\n",P,err);
    }

    // ---- (2) kappa-TRANSFER: plate - rigid, couple on plate +, measure phi(fold) ----
    // clamp ALL of plate - (rigid). couple on plate + far edge (xi1=1, alpha[0]==0? no: far edge is the
    // edge opposite the fold). For plate + (V0,VA,V2), fold = V0-V2 (xi1=0); far vertex VA (alpha (p,0,0)).
    // couple: +F transverse(z) on the VA-row, -F on the adjacent row, about y -> bending moment.
    printf("\n(2) kappa-TRANSFER: plate- rigid, couple on plate+. phi=kink-gap, kappa-sensitive (~M/kappa).\n");
    printf("    %10s %12s | %16s %16s\n","P","kappa","phi (kink-gap)","tip rotation");
    // identify couple CPs on plate +: rows by alpha[0] (distance from fold): row j has alpha[0]=j
    int kFar=-1,kAdj=-1; for(int k=0;k<nK;++k){const auto&a=B.alpha()[k]; if(a[0]==p)kFar=k; if(a[0]==p-1&&a[1]==1)kAdj=k;}
    std::vector<char> clamp(nCP,0); for(int k=0;k<nK;++k)clamp[gB[k]]=1;   // plate - fully clamped
    std::vector<int> fr; for(int cp=0;cp<nCP;++cp)if(!clamp[cp])for(int i=0;i<3;++i)fr.push_back(3*cp+i);
    int nf=fr.size();
    for(double P:{1e1,1e2,1e3,1e4,1e5,1e6}){ double kap=P*eta; EMat K=Ke+kap*Kp1;
        EMat Kr(nf,nf); for(int a=0;a<nf;++a)for(int b=0;b<nf;++b)Kr(a,b)=K(fr[a],fr[b]);
        EMat F=EMat::Zero(nf,1); double Fm=1.0;
        for(int a=0;a<nf;++a){ if(fr[a]==3*gA[kFar]+2)F(a,0)=+Fm; if(fr[a]==3*gA[kAdj]+2)F(a,0)=-Fm; }
        EMat u=Kr.ldlt().solve(F);
        std::vector<double> uf(nd,0.0); for(int a=0;a<nf;++a)uf[fr[a]]=u(a,0);
        // phi = linearized kink-gap at fold midpoint = sum_ki D_ki u_ki  (rebuild D at s=0.5)
        double s=0.5; BasisDerivs dA=BasisDerivs::at(B,0.0,s); Geom<double> GA=Geom<double>::build(XAp,dA);
        BasisDerivs dB=BasisDerivs::at(B,s,0.0); Geom<double> GB=Geom<double>::build(XBm,dB);
        V3<double> ehB{GB.a1[0],GB.a1[1],GB.a1[2]}; double esB=std::sqrt(dot3(ehB,ehB)); V3<double> aSB=nrm(ehB);
        double cT=dot3(GA.a3,GB.a3),sT=-dot3(GA.a3,nrm(cross3(aSB,GB.a3)));
        V3<double> phi{0,0,0};
        for(int k=0;k<nK;++k)for(int i=0;i<3;++i){ V3<double> da3A=dn_(dA,GA,k,i);
            for(int c=0;c<3;++c)phi[c]+=da3A[c]*uf[3*gA[k]+i];
            V3<double> da3B=dn_(dB,GB,k,i),daSB=dS_(dB,GB,1,0,aSB,esB,k,i);
            V3<double> daNB;{V3<double> u1=cross3(daSB,GB.a3),v1=cross3(aSB,da3B);for(int cc=0;cc<3;++cc)daNB[cc]=u1[cc]+v1[cc];}
            for(int c=0;c<3;++c)phi[c]-=(cT*da3B[c]-sT*daNB[c])*uf[3*gB[k]+i]; }
        double phin=std::sqrt(dot3(phi,phi));
        double tiprot=uf[3*gA[kFar]+2]-uf[3*gA[kAdj]+2];  // proxy for the + tip rotation
        printf("    %10.0e %12.4g | %16.6e %16.6e\n",P,kap,phin,tiprot);
    }
    printf("\nRead: (1) patch test ~machine zero at BOTH kappa => G1 constant-moment is in the penalty null space\n");
    printf("(consistency). (2) phi ~ M/kappa -> 0 over the plateau (the kappa-binding G1-transfer fidelity).\n");
    return 0;
}
