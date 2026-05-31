// Phase-3 plumbing gates (Aeris BB). gismo-linked.
// Build: g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional
//   -I/opt/gismo/external test_bb_plumbing.cpp -L/opt/gismo/build/lib -lgismo
//   -Wl,-rpath,/opt/gismo/build/lib -o test_bb_plumbing && ./test_bb_plumbing
//
// Validates the SOLVER WIRING + GLOBAL ASSEMBLY (distinct from element physics,
// already pinned in test_bb_Ke). Single element => no seam => no C1 needed; the
// multi-element part is gated ONLY on "assembles correctly" (symmetry + rigid-body),
// NOT bending convergence (a C0 mesh hinges; convergence is the Phase-4 gate).
//
//   P1 single-element membrane patch test: prescribe boundary CPs to a constant-
//      strain (linear) field, zero load, solve interior, reproduce EXACTLY.
//      Tests Dirichlet partition + linear solve. (membrane block; flat plate
//      decouples membrane/bending so this isolates the in-plane solve.)
//   P2 two-triangle global assembly: shared-edge DOF map (C0), scatter into global
//      K. Gate: global K symmetry + 6 rigid-body zero-energy modes. NO convergence.
#include <gismo.h>
#include <gsKLShell/src/getMaterialMatrix.h>
#include <gsKLShell/src/gsMaterialMatrixIntegrate.h>
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include "bb_kl_strains.hpp"
#include <vector>
#include <array>
#include <cmath>

using namespace gismo;
using aeris::BBTriangleBasis; using aeris::BasisDerivs; using aeris::Bmat;
using aeris::analytic_B; using aeris::flat_patch_cps; using aeris::V3;

static void eval3D_ABD(const V3<double>& a1,const V3<double>& a2,double thick,double E,double nu,
                       gsMatrix<real_t>& A,gsMatrix<real_t>& B,gsMatrix<real_t>& D){
    gsMultiPatch<real_t> mp; mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1)); mp.embed(3);
    gsMatrix<real_t>& C=mp.patch(0).coefs();
    for(index_t r=0;r<C.rows();++r){ double xi=C(r,0),eta=C(r,1);
        for(int i=0;i<3;++i) C(r,i)=xi*a1[i]+eta*a2[i]; }
    gsFunctionExpr<real_t> t(std::to_string(thick),3),Ef(std::to_string(E),3),nuf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pars{&Ef,&nuf};
    gsOptionList o; o.addInt("Material","",0); o.addSwitch("Compressibility","",false); o.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,t,pars,o);
    gsExprAssembler<> ea(1,1); gsExprEvaluator<> ev(ea); gsVector<real_t> pt(2); pt<<0.5,0.5;
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixB> mmB(mat.get(),&mp);
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    A=ev.eval(ea.getCoeff(mmA),pt); A.resize(3,3);
    B=ev.eval(ea.getCoeff(mmB),pt); B.resize(3,3);
    D=ev.eval(ea.getCoeff(mmD),pt); D.resize(3,3);
}

static gsMatrix<real_t> Bmat_to_gs(const Bmat& Bm){
    gsMatrix<real_t> M(3,Bm.ncols); for(int r=0;r<3;++r)for(int c=0;c<Bm.ncols;++c) M(r,c)=Bm.at(r,c); return M;
}

// element stiffness for a flat triangle (vertices V0,V1,V2)
static gsMatrix<real_t> assemble_Ke(const BBTriangleBasis<double>& Bb,
        const std::vector<V3<double>>& X, double thick,double E,double nu){
    // tangents a_alpha = sum N_k,alpha X_k (constant for the affine flat patch)
    auto d0=BasisDerivs::at(Bb,1.0/3,1.0/3);
    V3<double> A1{0,0,0},A2{0,0,0};
    for(int k=0;k<Bb.size();++k)for(int i=0;i<3;++i){A1[i]+=d0.N1[k]*X[k][i];A2[i]+=d0.N2[k]*X[k][i];}
    double Jac=std::sqrt(std::pow(A1[1]*A2[2]-A1[2]*A2[1],2)+std::pow(A1[2]*A2[0]-A1[0]*A2[2],2)
                        +std::pow(A1[0]*A2[1]-A1[1]*A2[0],2));
    gsMatrix<real_t> A,B,D; eval3D_ABD(A1,A2,thick,E,nu,A,B,D);
    int nd=3*Bb.size(); gsMatrix<real_t> Ke(nd,nd); Ke.setZero();
    for(auto& q:aeris::quad_triangle(2*(Bb.degree()-1))){
        auto d=BasisDerivs::at(Bb,q.xi1,q.xi2); Bmat Bm,Bbm; analytic_B(X,d,Bm,Bbm);
        gsMatrix<real_t> Bmg=Bmat_to_gs(Bm),Bbg=Bmat_to_gs(Bbm);
        Ke += q.w*Jac*( Bmg.transpose()*A*Bmg + Bbg.transpose()*D*Bbg );
    }
    return Ke;
}

int main(){
    const double E=1.0e6,nu=0.3,thick=0.1;
    bool ok=true;

    // ===================== P1: single-element membrane patch test =====================
    gsInfo<<"--- P1 single-element membrane patch test ---\n";
    {
        V3<double> V0{0,0,0},V1{2.0,0,0},V2{0.7,1.5,0};
        for(int p:{3,4,5}){
            BBTriangleBasis<double> Bb(p); int nK=Bb.size(), nd=3*nK;
            auto X=flat_patch_cps(Bb,V0,V1,V2);
            gsMatrix<real_t> Ke=assemble_Ke(Bb,X,thick,E,nu);
            // constant-strain linear field u=(gxx x+gxy y, gxy x+gyy y, 0) -> exact d[k]=field(X_k)
            double gxx=1.3e-3,gyy=-0.7e-3,gxy=0.9e-3;
            gsVector<real_t> dex(nd); dex.setZero();
            for(int k=0;k<nK;++k){ dex(3*k+0)=gxx*X[k][0]+gxy*X[k][1]; dex(3*k+1)=gxy*X[k][0]+gyy*X[k][1]; }
            // partition: boundary CP (any bary index ==0) prescribed; interior (all>0) free
            std::vector<int> freeDof, presDof;
            for(int k=0;k<nK;++k){ const auto& a=Bb.alpha()[k];
                bool boundary=(a[0]==0||a[1]==0||a[2]==0);
                for(int i=0;i<3;++i)(boundary?presDof:freeDof).push_back(3*k+i); }
            int nf=freeDof.size(), np=presDof.size();
            gsMatrix<real_t> Kff(nf,nf),Kfp(nf,np);
            for(int r=0;r<nf;++r){ for(int c=0;c<nf;++c) Kff(r,c)=Ke(freeDof[r],freeDof[c]);
                                   for(int c=0;c<np;++c) Kfp(r,c)=Ke(freeDof[r],presDof[c]); }
            gsVector<real_t> up(np); for(int c=0;c<np;++c) up(c)=dex(presDof[c]);
            gsVector<real_t> rhs=-(Kfp*up);
            gsVector<real_t> uf=Kff.partialPivLu().solve(rhs);
            double err=0; for(int r=0;r<nf;++r) err=std::max(err,std::fabs(uf(r)-dex(freeDof[r])));
            bool g=(err<1e-9); ok&=g;
            gsInfo<<"  p="<<p<<" nf="<<nf<<" np="<<np<<"  reproduce|err|="<<err<<"  ["<<(g?"PASS":"FAIL")<<"]\n";
        }
    }

    // ===================== P2: two-triangle global assembly =====================
    gsInfo<<"--- P2 two-triangle global assembly (C0 shared edge) ---\n";
    {
        // shared edge V0-V1; T1 on one side (V2), T2 on the other (V3)
        V3<double> V0{0,0,0},V1{2.0,0,0},V2{0.7,1.5,0},Vd{1.3,-1.4,0};
        for(int p:{3,4,5}){
            BBTriangleBasis<double> Bb(p); int nK=Bb.size();
            auto X1=flat_patch_cps(Bb,V0,V1,V2);
            auto X2=flat_patch_cps(Bb,V0,V1,Vd);
            // global map: T1 -> 0..nK-1. T2 edge CPs (3rd bary index k==0, the V2/V3 weight)
            // share with T1's same (i,j); T2 non-edge get new ids.
            std::vector<int> g2(nK); int nextG=nK;
            for(int k=0;k<nK;++k){ const auto& a=Bb.alpha()[k];
                if(a[2]==0) g2[k]=k;             // (i,j,0): same local index in T1 (shared edge V0V1)
                else        g2[k]=nextG++; }
            int nGcp=nextG, nd=3*nGcp;
            std::vector<V3<double>> Xg(nGcp);
            for(int k=0;k<nK;++k) Xg[k]=X1[k];                 // T1 positions (incl shared edge)
            for(int k=0;k<nK;++k) if(Bb.alpha()[k][2]!=0) Xg[g2[k]]=X2[k];
            gsMatrix<real_t> Ke1=assemble_Ke(Bb,X1,thick,E,nu);
            gsMatrix<real_t> Ke2=assemble_Ke(Bb,X2,thick,E,nu);
            gsMatrix<real_t> Kg(nd,nd); Kg.setZero();
            auto scatter=[&](const gsMatrix<real_t>& Ke,const std::vector<int>& gmap){
                for(int a=0;a<nK;++a)for(int b=0;b<nK;++b)for(int i=0;i<3;++i)for(int j=0;j<3;++j)
                    Kg(3*gmap[a]+i,3*gmap[b]+j)+=Ke(3*a+i,3*b+j); };
            std::vector<int> g1(nK); for(int k=0;k<nK;++k) g1[k]=k;
            scatter(Ke1,g1); scatter(Ke2,g2);
            // gate: symmetry
            double e_sym=(Kg-Kg.transpose()).norm()/Kg.norm();
            // gate: 6 rigid-body zero-energy modes on the GLOBAL K
            double e_rig=0;
            for(int dir=0;dir<3;++dir){ gsVector<real_t> d(nd); d.setZero();
                for(int g=0;g<nGcp;++g) d(3*g+dir)=1.0; e_rig=std::max(e_rig,(Kg*d).norm()/Kg.norm()); }
            for(int ax=0;ax<3;++ax){ gsVector<real_t> d(nd); d.setZero(); V3<double> th{0,0,0}; th[ax]=1;
                for(int g=0;g<nGcp;++g){ d(3*g+0)=th[1]*Xg[g][2]-th[2]*Xg[g][1];
                                         d(3*g+1)=th[2]*Xg[g][0]-th[0]*Xg[g][2];
                                         d(3*g+2)=th[0]*Xg[g][1]-th[1]*Xg[g][0]; }
                e_rig=std::max(e_rig,(Kg*d).norm()/Kg.norm()); }
            bool g=(e_sym<1e-12)&&(e_rig<1e-9); ok&=g;
            gsInfo<<"  p="<<p<<" globalCP="<<nGcp<<" (shared="<<(p+1)<<")  K_sym="<<e_sym
                  <<"  rigid="<<e_rig<<"  ["<<(g?"PASS":"FAIL")<<"]\n";
        }
    }

    gsInfo<<"\n"<<(ok
      ? "RESULT: PASS - solver wiring (Dirichlet+solve) + global C0 assembly (DOF map, "
        "symmetry, 6 rigid-body modes) correct. Phase-3 plumbing GREEN; DOF-space ready for "
        "the Phase-4 C1 map C."
      : "RESULT: FAIL.")<<"\n";
    return ok?0:1;
}
