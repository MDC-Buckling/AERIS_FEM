// G1 kink coupling, Gate G0.5 Part B: penalty-parameter kappa PLATEAU sweep
// (Ludwig 7.1.5 / SPEC_g1_kinks). gismo-linked (eval3D for K_e).
//
// Folded two-plate system: plate A fully CLAMPED (rigid reference), plate B a single
// BB triangle sharing the fold edge (C0 via shared clamped CPs). The fold penalty (FULL
// daN, Part-A-verified) couples B's rotated director to A's fixed one.
//   K_total(P) = K_e(B) + K_penalty(B, kappa),   kappa = P * eta,  eta = mu t^3 / L (7.14)
//
// At P->0 plate B is a MECHANISM (free rotation about the fold = the penalty analog of
// the seam-slit mode); the penalty restrains it. Two-sided bounded window:
//   STATIC (primary, clean): tip transverse load -> tip deflection. Small P -> hinge ->
//     huge deflection; rising P -> plateau at the G1-clamped-cantilever value; huge P ->
//     conditioning drift. The plateau is the robust-penalty window.
//   EIGENVALUE (refinement, binds G3): smallest eigenvalues of K_total. Small P -> a
//     near-zero hinge mode below the elastic modes; rising P lifts it; plateau where the
//     low spectrum is P-stable; huge P -> conditioning. Read the MODE, not just the value.
//
// Build:  g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//   -I/opt/gismo/external test_bb_g1_kappa.cpp -L/opt/gismo/build/lib -lgismo \
//   -Wl,-rpath,/opt/gismo/build/lib -o tg05b && ./tg05b 2>/dev/null
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
using aeris::analytic_B; using aeris::Geom; using aeris::V3; using aeris::dot3; using aeris::cross3;
using aeris::quad_triangle; using aeris::flat_patch_cps;
typedef gsEigen::Matrix<real_t,gsEigen::Dynamic,gsEigen::Dynamic> EMat;
static const double PI=3.14159265358979323846;
static const double E=1.0e6,nu=0.3,thick=0.05;
static const double GL5x[5]={0.046910077030668,0.230765344947158,0.5,0.769234655052842,0.953089922969332};
static const double GL5w[5]={0.118463442528095,0.239314335249683,0.284444444444444,0.239314335249683,0.118463442528095};
static V3<double> nrm(V3<double> v){double n=std::sqrt(dot3(v,v));return {v[0]/n,v[1]/n,v[2]/n};}
static V3<double> dn_(const BasisDerivs&d,const Geom<double>&G,int k,int i){
    V3<double> ei{0,0,0}; ei[i]=1.0; V3<double> dabar; { V3<double> t1=cross3(ei,G.a2),t2=cross3(G.a1,ei);
        for(int j=0;j<3;++j) dabar[j]=d.N1[k]*t1[j]+d.N2[k]*t2[j]; }
    double proj=dot3(G.a3,dabar); V3<double> r; for(int j=0;j<3;++j) r[j]=(dabar[j]-proj*G.a3[j])/G.jbar; return r; }
static V3<double> dS_(const BasisDerivs&d,const Geom<double>&G,double t1,double t2,const V3<double>&aS,double es,int k,int i){
    double coef=d.N1[k]*t1+d.N2[k]*t2; V3<double> dehat{0,0,0}; dehat[i]=coef; double proj=dot3(aS,dehat);
    V3<double> r; for(int j=0;j<3;++j) r[j]=(dehat[j]-proj*aS[j])/es; return r; }
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
    // plate B = single triangle, shares fold edge V0-V2 with the (clamped) plate A
    V3<double> V0{0,0,0},V2{0,Ly,0},VB{-Lx*std::cos(Th),0,Lx*std::sin(Th)};
    auto XB=flat_patch_cps(B,V0,V2,VB);              // edge V0-V2 is xi2=0 (outward normal)
    // plate A director at the fold (clamped, fixed): A in z=0, a3+ = (0,0,1)
    V3<double> a3p{0,0,1};
    // identify fold-edge CPs of B (xi2=0 -> alpha[2]=0) to clamp (C0 to plate A)
    std::vector<char> onFold(nK,0); for(int k=0;k<nK;++k) if(B.alpha()[k][2]==0) onFold[k]=1;
    int nd=3*nK;
    // K_e(B)
    EMat Ke=EMat::Zero(nd,nd);
    for(auto&q:quad_triangle(2*p)){ auto d=BasisDerivs::at(B,q.xi1,q.xi2); Geom<double> G=Geom<double>::build(XB,d);
        gsMatrix<real_t> A,D; eval3D_AD(G.a1,G.a2,A,D); double Jac=G.jbar; Bmat Bm,Bb; analytic_B(XB,d,Bm,Bb);
        for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*a+i;
            for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*b+j;
                double v=0;for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s=0;s<3;++s){Am+=A(r,s)*Bm.at(s,3*b+j);Dm+=D(r,s)*Bb.at(s,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                Ke(ga,gb)+=q.w*Jac*v; }}}
    // K_penalty(B) per unit kappa: D = - d^a3-/du (plate A fixed -> only B varies)
    EMat Kp1=EMat::Zero(nd,nd);
    for(int g=0;g<5;++g){ double s=GL5x[g], w=GL5w[g]*Ly;
        BasisDerivs d=BasisDerivs::at(B,s,0.0); Geom<double> G=Geom<double>::build(XB,d);
        double t1=1,t2=0; V3<double> eh{G.a1[0],G.a1[1],G.a1[2]}; double es=std::sqrt(dot3(eh,eh)); V3<double> aS=nrm(eh);
        double cT=dot3(a3p,G.a3), sT=-dot3(a3p,nrm(cross3(aS,G.a3)));
        std::vector<std::array<double,3>> Dm(nd,{0,0,0});
        for(int k=0;k<nK;++k)for(int i=0;i<3;++i){ V3<double> da3=dn_(d,G,k,i), daS=dS_(d,G,t1,t2,aS,es,k,i);
            V3<double> daN; { V3<double> u=cross3(daS,G.a3),v=cross3(aS,da3); for(int c=0;c<3;++c)daN[c]=u[c]+v[c]; }
            for(int c=0;c<3;++c) Dm[3*k+i][c] = -(cT*da3[c]-sT*daN[c]); }   // -d^a3-/du
        for(int a=0;a<nd;++a)for(int b=0;b<nd;++b){double sd=0;for(int c=0;c<3;++c)sd+=Dm[a][c]*Dm[b][c]; Kp1(a,b)+=w*sd;}
    }
    // free DOFs = B's non-fold CPs (fold CPs clamped, = C0 to plate A)
    std::vector<int> fr; for(int k=0;k<nK;++k)if(!onFold[k])for(int i=0;i<3;++i)fr.push_back(3*k+i);
    int nf=fr.size();
    // tip load at VB (the far vertex, alpha=(0,0,p)) in global z
    int ktip=-1; for(int k=0;k<nK;++k)if(B.alpha()[k][0]==0&&B.alpha()[k][1]==0&&B.alpha()[k][2]==p)ktip=k;
    double eta=(E/(2*(1+nu)))*thick*thick*thick/Ly;   // (7.14) mu t^3 / L
    printf("G0.5 Part B: kappa PLATEAU sweep (fold Theta=90deg, eta=%.4g, kappa=P*eta).\n",eta);
    printf("  STATIC: tip transverse load -> tip deflection. EIGEN: smallest 3 modes of K_total.\n");
    printf("  %8s %12s | %14s | %22s\n","P","kappa","tip_defl(z)","smallest 3 eig(K_total)");
    for(double P:{1e-3,1e-2,1e-1,1e0,1e1,1e2,1e3,1e4,1e5,1e6}){
        double kap=P*eta;
        EMat Kt=Ke+kap*Kp1;
        EMat Kr(nf,nf); for(int a=0;a<nf;++a)for(int b=0;b<nf;++b)Kr(a,b)=Kt(fr[a],fr[b]);
        // static: F = unit x at tip (TRANSVERSE to plate B = the hinge-sensitive direction)
        EMat F=EMat::Zero(nf,1); for(int a=0;a<nf;++a) if(fr[a]==3*ktip+0) F(a,0)=1.0;
        EMat u=Kr.ldlt().solve(F);
        double tip=0; for(int a=0;a<nf;++a) if(fr[a]==3*ktip+0) tip=u(a,0);
        gsEigen::SelfAdjointEigenSolver<EMat> es2(Kr); auto ev=es2.eigenvalues();
        printf("  %8.0e %12.4g | %14.6e | %10.3e %10.3e %10.3e\n",P,kap,tip,ev(0),ev(1),ev(2));
    }
    printf("\nRead: tip_defl drops from the hinge (small P) to a PLATEAU (G1 enforced), then drifts (cond.).\n");
    printf("smallest eig: the hinge mode (small P, near-zero) lifts with P; plateau where the low spectrum is P-stable.\n");
    return 0;
}
