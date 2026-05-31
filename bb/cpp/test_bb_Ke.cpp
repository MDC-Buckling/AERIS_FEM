// Phase-3 single-element K_e gate (Aeris BB). gismo-linked.
// Build (direct link):
//   g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional
//       -I/opt/gismo/external test_bb_Ke.cpp -L/opt/gismo/build/lib -lgismo
//       -Wl,-rpath,/opt/gismo/build/lib -o test_bb_Ke && ./test_bb_Ke
//
// Builds the element stiffness K_e for ONE flat (sheared) BB triangle and
// gates the PHYSICS on a single element — no seam, so no C1 needed (the
// multi-triangle SS-plate is the Phase-4 gate, since a C0 mesh would hinge).
//
//   K1 K_e symmetry                         ||K-K^T|| ~ machine
//   K2 6 rigid-body zero-energy modes        ||K d_rigid|| ~ 0  (3 trans + 3 rot;
//       rotations are linear fields, exactly represented; tests B_b null space too)
//   K3 membrane energy/convention (Gate 6)   U_FE = 1/2 d^T K_e d  ==  U_analytic
//       for a constant in-plane strain (linear field, exact d[k]=field(X_k)),
//       on a SHEARED element. Non-circular: U_FE uses my covariant B_m + gismo's
//       metric-weighted A; U_analytic is the textbook Cartesian energy.
//   K4 bending energy/convention (Gate 5)    same, constant curvature (quadratic w),
//       exact Bezier coefs via degree elevation; pins D + the bending pairing.
//
// eval3D bridge: the constitutive depends only on the metric (1st fundamental
// form), so a flat affine gismo quad with tangents = my element's a1,a2 yields
// the correct metric-weighted A/D (proven metric-weighted in probe_material_frame).
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

// ---- eval3D bridge: tangents (a1,a2) -> metric-weighted A, B, D (3x3) ----
static void eval3D_ABD(const V3<double>& a1, const V3<double>& a2,
                       double thick, double E, double nu,
                       gsMatrix<real_t>& A, gsMatrix<real_t>& B, gsMatrix<real_t>& D) {
    gsMultiPatch<real_t> mp;
    mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));
    mp.embed(3);
    // parallelogram X(xi,eta) = P0 + xi*a1 + eta*a2 -> tangents a1,a2 (constant)
    // BSplineSquare(1) CPs are the unit-square corners (0,0),(1,0),(0,1),(1,1).
    gsMatrix<real_t>& C = mp.patch(0).coefs();
    for (index_t r = 0; r < C.rows(); ++r) {
        double xi = C(r,0), eta = C(r,1);
        for (int i = 0; i < 3; ++i) C(r,i) = xi*a1[i] + eta*a2[i];
    }
    gsFunctionExpr<real_t> t(std::to_string(thick),3), Ef(std::to_string(E),3),
                           nuf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pars{&Ef,&nuf};
    gsOptionList opts;
    opts.addInt("Material","",0); opts.addSwitch("Compressibility","",false);
    opts.addInt("Implementation","",1);
    auto mat = getMaterialMatrix<3,real_t>(mp,t,pars,opts);
    gsExprAssembler<> ea(1,1); gsExprEvaluator<> ev(ea);
    gsVector<real_t> pt(2); pt<<0.5,0.5;
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixB> mmB(mat.get(),&mp);
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    A = ev.eval(ea.getCoeff(mmA),pt); A.resize(3,3);
    B = ev.eval(ea.getCoeff(mmB),pt); B.resize(3,3);
    D = ev.eval(ea.getCoeff(mmD),pt); D.resize(3,3);
}

// ---- exact triangular-Bezier degree elevation (q -> q+1) ----
static int idx_of(int q,int i,int j){ // index in multi_indices(q) of (i,j,q-i-j)
    int n=0; for(int ii=q;ii>=0;--ii)for(int jj=q-ii;jj>=0;--jj){ if(ii==i&&jj==j)return n; ++n;} return -1;
}
static std::vector<double> elevate(const std::vector<double>& cq,int q){
    auto idq=aeris::multi_indices(q); auto idq1=aeris::multi_indices(q+1);
    std::vector<double> c1(idq1.size(),0.0);
    for(size_t a=0;a<idq1.size();++a){int i=idq1[a][0],j=idq1[a][1],k=idq1[a][2];
        double v=0;
        if(i>0) v+=i*cq[idx_of(q,i-1,j)];
        if(j>0) v+=j*cq[idx_of(q,i,j-1)];
        if(k>0) v+=k*cq[idx_of(q,i,j)];     // (i,j,k-1): same i,j at degree q
        c1[a]=v/(q+1);
    }
    return c1;
}
// exact degree-p Bezier coefs of a quadratic field f(x,y) on triangle V0,V1,V2
static std::vector<double> quad_field_coefs(int p, std::function<double(double,double)> f,
        const V3<double>& V0,const V3<double>& V1,const V3<double>& V2){
    auto P=[&](double l0,double l1,double l2){ // barycentric -> physical (x,y)
        return std::array<double,2>{l0*V0[0]+l1*V1[0]+l2*V2[0], l0*V0[1]+l1*V1[1]+l2*V2[1]}; };
    // degree-2 coefs (order of multi_indices(2): (2,0,0)(1,1,0)(1,0,1)(0,2,0)(0,1,1)(0,0,2))
    auto fV=[&](std::array<double,2> q){return f(q[0],q[1]);};
    double c200=fV(P(1,0,0)), c020=fV(P(0,1,0)), c002=fV(P(0,0,1));
    double m01=fV(P(0.5,0.5,0)), m02=fV(P(0.5,0,0.5)), m12=fV(P(0,0.5,0.5));
    double c110=2*m01-0.5*c200-0.5*c020;
    double c101=2*m02-0.5*c200-0.5*c002;
    double c011=2*m12-0.5*c020-0.5*c002;
    std::vector<double> c2={c200,c110,c101,c020,c011,c002}; // matches multi_indices(2)
    std::vector<double> c=c2; for(int q=2;q<p;++q) c=elevate(c,q);
    return c;
}

static gsMatrix<real_t> Bmat_to_gs(const Bmat& Bm){
    gsMatrix<real_t> M(3,Bm.ncols);
    for(int r=0;r<3;++r)for(int c=0;c<Bm.ncols;++c) M(r,c)=Bm.at(r,c);
    return M;
}

int main(){
    const double E=1.0e6, nu=0.3, thick=0.1;
    // sheared FLAT triangle in xy-plane (non-orthogonal metric, b_ab=0)
    V3<double> V0{0,0,0}, V1{2.0,0,0}, V2{0.7,1.5,0};
    V3<double> a1{V1[0]-V0[0],V1[1]-V0[1],V1[2]-V0[2]};
    V3<double> a2{V2[0]-V0[0],V2[1]-V0[1],V2[2]-V0[2]};
    double Jac=std::sqrt(std::pow(a1[1]*a2[2]-a1[2]*a2[1],2)
                        +std::pow(a1[2]*a2[0]-a1[0]*a2[2],2)
                        +std::pow(a1[0]*a2[1]-a1[1]*a2[0],2));
    double area=0.5*Jac;

    gsMatrix<real_t> A,Bc,D; eval3D_ABD(a1,a2,thick,E,nu,A,Bc,D);
    gsInfo<<"||B coupling|| = "<<Bc.norm()<<" (expect ~0)\n";

    // textbook Cartesian (for the analytic energies)
    double f=E*thick/(1-nu*nu);
    gsMatrix<real_t> Acart(3,3); Acart<<f,f*nu,0, f*nu,f,0, 0,0,f*(1-nu)/2;
    gsMatrix<real_t> Dcart=Acart*(thick*thick/12.0);

    bool ok=true;
    for(int p:{3,4,5}){
        BBTriangleBasis<double> Bbasis(p);
        int nK=Bbasis.size(), nd=3*nK;
        auto X=flat_patch_cps(Bbasis,V0,V1,V2);
        gsMatrix<real_t> Ke(nd,nd); Ke.setZero();
        for(auto& q:aeris::quad_triangle(2*(p-1))){
            auto d=BasisDerivs::at(Bbasis,q.xi1,q.xi2);
            Bmat Bm,Bb; analytic_B(X,d,Bm,Bb);   // at reference (c=X)
            gsMatrix<real_t> Bmg=Bmat_to_gs(Bm), Bbg=Bmat_to_gs(Bb);
            Ke += q.w*Jac*( Bmg.transpose()*A*Bmg + Bbg.transpose()*D*Bbg );
        }
        // K1 symmetry
        double e_sym=(Ke-Ke.transpose()).norm()/Ke.norm();
        // K2 rigid-body (3 trans + 3 rot)
        double e_rig=0;
        for(int dir=0;dir<3;++dir){ gsVector<real_t> d(nd); d.setZero();
            for(int k=0;k<nK;++k) d(3*k+dir)=1.0;
            e_rig=std::max(e_rig,(Ke*d).norm()/Ke.norm()); }
        for(int ax=0;ax<3;++ax){ gsVector<real_t> d(nd); d.setZero();
            V3<double> th{0,0,0}; th[ax]=1.0;
            for(int k=0;k<nK;++k){ // theta x X_k
                d(3*k+0)=th[1]*X[k][2]-th[2]*X[k][1];
                d(3*k+1)=th[2]*X[k][0]-th[0]*X[k][2];
                d(3*k+2)=th[0]*X[k][1]-th[1]*X[k][0]; }
            e_rig=std::max(e_rig,(Ke*d).norm()/Ke.norm()); }
        // K3 membrane energy: constant strain field u=(gxx x+gxy y, gxy x+gyy y,0)
        double gxx=1.3e-3,gyy=-0.7e-3,gxy=0.9e-3;
        gsVector<real_t> dm(nd); dm.setZero();
        for(int k=0;k<nK;++k){ dm(3*k+0)=gxx*X[k][0]+gxy*X[k][1];
                               dm(3*k+1)=gxy*X[k][0]+gyy*X[k][1]; }
        double U_FE_m=0.5*(dm.transpose()*Ke*dm)(0,0);
        gsVector<real_t> eps(3); eps<<gxx,gyy,2*gxy;
        double U_an_m=0.5*area*(eps.transpose()*Acart*eps)(0,0);
        double e_mem=std::fabs(U_FE_m-U_an_m)/std::fabs(U_an_m);
        // K4 bending energy: constant curvature w=1/2(cxx x^2+2cxy xy+cyy y^2)
        double cxx=2.0e-3,cyy=-1.1e-3,cxy=0.6e-3;
        auto w=[&](double x,double y){return 0.5*(cxx*x*x+2*cxy*x*y+cyy*y*y);};
        auto wc=quad_field_coefs(p,w,V0,V1,V2);
        gsVector<real_t> db(nd); db.setZero();
        for(int k=0;k<nK;++k) db(3*k+2)=wc[k];
        double U_FE_b=0.5*(db.transpose()*Ke*db)(0,0);
        gsVector<real_t> kap(3); kap<<cxx,cyy,2*cxy;
        double U_an_b=0.5*area*(kap.transpose()*Dcart*kap)(0,0);
        double e_ben=std::fabs(U_FE_b-U_an_b)/std::fabs(U_an_b);

        bool p_ok=(e_sym<1e-12)&&(e_rig<1e-9)&&(e_mem<1e-9)&&(e_ben<1e-9);
        ok&=p_ok;
        gsInfo<<"p="<<p<<" nd="<<nd
              <<"  K1 sym="<<e_sym<<"  K2 rigid="<<e_rig
              <<"  K3 membrane="<<e_mem<<"  K4 bending="<<e_ben
              <<"  ["<<(p_ok?"PASS":"FAIL")<<"]\n";
    }
    gsInfo<<"\n"<<(ok
      ? "RESULT: PASS - K_e correct; eval3D metric-weighted reuse HOLDS in K_e practice "
        "(membrane+bending convention pinned vs Cartesian on a sheared element)."
      : "RESULT: FAIL.")<<"\n";
    return ok?0:1;
}
