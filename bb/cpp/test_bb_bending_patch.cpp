// Bending (constant-curvature) PATCH TEST on a single BB triangle (Aeris BB).
// gismo-linked (eval3D). Isolates element bending-patch exactness from the G1 fold
// field-vs-element ambiguity.
//
// AXIS-ALIGNED triangle (param == physical, up to the per-axis scale): w = 1/2 c x^2 is
// UNAMBIGUOUSLY the constant-curvature (kappa_xx=c) homogeneous bending state (no load).
// Prescribe u=(0,0,w) on the boundary (edge CPs), solve the interior (face CPs):
//   reproduces to machine zero  => element bending patch is EXACT (the G1 patch-test ~1e-3
//                                  was my fold field, parametric-vs-physical; fix to phys coords);
//   NOT machine zero            => element bending-patch inexact (asymptotic consistency from
//                                  Step 4 does NOT guarantee exact reproduction) = an element finding.
// Also runs a SHEARED triangle with the metric-CONSISTENT physical-coordinate field
// w=1/2 c x_phys^2 (x_phys = the CP's actual global x) to confirm the fix transfers.
//
// Build: g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//   -I/opt/gismo/external test_bb_bending_patch.cpp -L/opt/gismo/build/lib -lgismo \
//   -Wl,-rpath,/opt/gismo/build/lib -o tbp && ./tbp 2>/dev/null
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
using aeris::analytic_B; using aeris::Geom; using aeris::V3; using aeris::dot3; using aeris::flat_patch_cps;
using aeris::quad_triangle;
typedef gsEigen::Matrix<real_t,gsEigen::Dynamic,gsEigen::Dynamic> EMat;
static const double E=1.0e6,nu=0.3,thick=0.05;
static void eval3D_AD(const V3<double>&a1,const V3<double>&a2,gsMatrix<real_t>&A,gsMatrix<real_t>&D){
    gsMultiPatch<real_t> mp;mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));mp.embed(3);
    gsMatrix<real_t>&C=mp.patch(0).coefs();for(index_t r=0;r<C.rows();++r){double xi=C(r,0),eta=C(r,1);for(int i=0;i<3;++i)C(r,i)=xi*a1[i]+eta*a2[i];}
    gsFunctionExpr<real_t> t(std::to_string(thick),3),Ef(std::to_string(E),3),nf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pr{&Ef,&nf};gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,t,pr,o);gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);gsVector<real_t> pt(2);pt<<0.5,0.5;
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    A=ev.eval(ea.getCoeff(mmA),pt);A.resize(3,3);D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3);}

static double patch(const V3<double>&V0,const V3<double>&V1,const V3<double>&V2,int p,double c,int fdeg){
    BBTriangleBasis<double> B(p); int nK=B.size(); int nd=3*nK;
    auto X=flat_patch_cps(B,V0,V1,V2);
    EMat K=EMat::Zero(nd,nd);
    for(auto&q:quad_triangle(2*p)){auto d=BasisDerivs::at(B,q.xi1,q.xi2);Geom<double> G=Geom<double>::build(X,d);
        gsMatrix<real_t> A,D;eval3D_AD(G.a1,G.a2,A,D);double Jac=G.jbar;Bmat Bm,Bb;analytic_B(X,d,Bm,Bb);
        for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*a+i;
            for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*b+j;
                double v=0;for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s=0;s<3;++s){Am+=A(r,s)*Bm.at(s,3*b+j);Dm+=D(r,s)*Bb.at(s,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                K(ga,gb)+=q.w*Jac*v;}}}
    // field w = 1/2 c x^2 : prescribe the BEZIER COEFFICIENTS (basis is NOT interpolatory),
    // via the blossom of x^2 over the triangle (vertices' x = x0,x1,x2):
    //   c_a = (1/2 c / C(p,2)) [ C(i,2)x0^2 + C(j,2)x1^2 + C(k,2)x2^2 + ij x0x1 + ik x0x2 + jk x1x2 ]
    double x0=V0[0],x1=V1[0],x2=V2[0], Cp2=p*(p-1)/2.0;
    std::vector<V3<double>> uan(nK,{0,0,0});
    for(int k=0;k<nK;++k){ const auto&a=B.alpha()[k]; double i=a[0],j=a[1],kk=a[2];
        if(fdeg==1){ uan[k]={0,0, c*X[k][0]}; }   // LINEAR w=c*x (Bezier=interpolatory): must reproduce
        else { double bl = (i*(i-1)/2.0)*x0*x0 + (j*(j-1)/2.0)*x1*x1 + (kk*(kk-1)/2.0)*x2*x2
                  + i*j*x0*x1 + i*kk*x0*x2 + j*kk*x1*x2;
            uan[k]={0,0,0.5*c*bl/Cp2}; } }   // QUADRATIC w=1/2 c x^2 (Bezier coefs)
    // ---- DIAGNOSTIC CUT (only for the quadratic field) ----
    if(fdeg==2){
        // full exact field vector
        std::vector<double> uvec(nd,0.0); for(int k=0;k<nK;++k)for(int i=0;i<3;++i)uvec[3*k+i]=uan[k][i];
        // (tightener) B_b . u_exact at quad points: must be CONSTANT (= analytic curvature)
        double kmin=1e300,kmax=-1e300;
        for(auto&q:quad_triangle(2*p)){auto d=BasisDerivs::at(B,q.xi1,q.xi2);Bmat Bm,Bb;analytic_B(X,d,Bm,Bb);
            double kxx=0; for(int k=0;k<nK;++k)for(int i=0;i<3;++i)kxx+=Bb.at(0,3*k+i)*uvec[3*k+i];
            kmin=std::min(kmin,kxx);kmax=std::max(kmax,kxx);}
        // (separator) residual r = K u_exact ; interior components must be ~0 if u is equilibrium
        std::vector<double> r(nd,0.0); for(int a=0;a<nd;++a){double s=0;for(int b=0;b<nd;++b)s+=K(a,b)*uvec[b]; r[a]=s;}
        auto isE=[&](int k){const auto&a=B.alpha()[k];return a[0]==0||a[1]==0||a[2]==0;};
        double rin=0,rbd=0; for(int k=0;k<nK;++k)for(int i=0;i<3;++i){ if(isE(k))rbd=std::max(rbd,std::fabs(r[3*k+i])); else rin=std::max(rin,std::fabs(r[3*k+i])); }
        printf("    [diag] B_b.u_exact (kappa_xx) range over quad pts: [%.4e, %.4e]  (must be CONSTANT)\n",kmin,kmax);
        printf("    [diag] |K u_exact|: interior=%.3e  boundary(reactions)=%.3e  ratio int/bd=%.3e\n",rin,rbd,rin/(rbd+1e-300));
        printf("           => interior>>0 : ASSEMBLY/K_b bug (A);  interior~0 but solve fails : PARTITION/SOLVE (B)\n");
    }
    // boundary = edge CPs (alpha has a zero), interior = face CPs
    auto isEdge=[&](int k){const auto&a=B.alpha()[k];return a[0]==0||a[1]==0||a[2]==0;};
    std::vector<int> fr,bd; for(int k=0;k<nK;++k)for(int i=0;i<3;++i){ if(isEdge(k))bd.push_back(3*k+i); else fr.push_back(3*k+i); }
    int nf=fr.size();
    EMat Kii(nf,nf),Kib(nf,(int)bd.size());
    for(int a=0;a<nf;++a){for(int b=0;b<nf;++b)Kii(a,b)=K(fr[a],fr[b]); for(size_t b=0;b<bd.size();++b)Kib(a,b)=K(fr[a],bd[b]);}
    EMat ub((int)bd.size(),1); for(size_t b=0;b<bd.size();++b){int k=bd[b]/3,i=bd[b]%3; ub(b,0)=uan[k][i];}
    EMat ui=Kii.ldlt().solve(-Kib*ub);
    double err=0,scale=0; for(int a=0;a<nf;++a){int k=fr[a]/3,i=fr[a]%3; err=std::max(err,std::fabs(ui(a,0)-uan[k][i])); scale=std::max(scale,std::fabs(uan[k][i]));}
    return err/scale;   // relative
}

int main(){
    int p=5; double c=0.02;
    printf("Single-triangle BENDING (constant-curvature) patch test: prescribe w=1/2 c x_phys^2,\n");
    printf("solve interior, check reproduction. c=%g, p=%d. (relative max error)\n\n",c,p);
    double e_lin=patch({0,0,0},{1.0,0,0},{0,1.0,0},p,c,1);
    printf("  [%s] LINEAR w=c*x (zero curvature, control):  rel err = %.3e\n", e_lin<1e-11?"PASS":"FAIL", e_lin);
    double e_axis=patch({0,0,0},{1.0,0,0},{0,1.0,0},p,c,2);
    printf("  [%s] QUADRATIC axis-aligned (const curvature): rel err = %.3e\n", e_axis<1e-11?"PASS":"FAIL", e_axis);
    double e_shear=patch({0,0,0},{1.0,0,0},{0.6,1.5,0},p,c,2);
    printf("  [%s] QUADRATIC sheared:                        rel err = %.3e\n", e_shear<1e-11?"PASS":"FAIL", e_shear);
    printf("\nRead: axis-aligned PASS => element bending patch exact => the G1 ~1e-3 was the fold FIELD\n");
    printf("(parametric-vs-physical); fix the fold field to physical coords. Axis FAIL => element finding.\n");
    return 0;
}
