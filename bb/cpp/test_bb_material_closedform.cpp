// Closed-form metric-weighted KL constitutive (A,D) vs gismo eval3D (Aeris BB).
// eval3D (proven in Step 3 probe + K4) returns the METRIC-WEIGHTED curvilinear plane-
// stress constitutive. Rebuilding the gismo machinery PER QUAD POINT is the assembly
// bottleneck (~1257s at R/t=200). Replace it with the closed form below — but VERIFY
// it matches eval3D to machine precision first (don't guess the convention).
//
//   contravariant metric a^ab = inv(a_ab),  a_ab = a_a . a_b
//   C^abgd = (Et/(1-nu^2)) [ nu a^ab a^gd + (1-nu)/2 (a^ag a^bd + a^ad a^bg) ]
//   Voigt [11,22,12] (factor 2 on shear strain): A = membrane (Et/(1-nu^2)), D = (t^2/12) A
//
// Build: g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//   -I/opt/gismo/external test_bb_material_closedform.cpp -L/opt/gismo/build/lib -lgismo \
//   -Wl,-rpath,/opt/gismo/build/lib -o tmc && ./tmc 2>/dev/null
#include <gismo.h>
#include "bb_kl_strains.hpp"
#include <gsKLShell/src/getMaterialMatrix.h>
#include <gsKLShell/src/gsMaterialMatrixIntegrate.h>
#include <array>
#include <cstdio>
#include <cmath>
using namespace gismo;
using aeris::V3; using aeris::dot3;

// gismo reference (per-quad-point machinery)
static void eval3D_gismo(const V3<double>&a1,const V3<double>&a2,double thick,double E,double nu,gsMatrix<real_t>&A,gsMatrix<real_t>&D){
    gsMultiPatch<real_t> mp;mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));mp.embed(3);
    gsMatrix<real_t>&C=mp.patch(0).coefs();for(index_t r=0;r<C.rows();++r){double xi=C(r,0),eta=C(r,1);for(int i=0;i<3;++i)C(r,i)=xi*a1[i]+eta*a2[i];}
    gsFunctionExpr<real_t> t(std::to_string(thick),3),Ef(std::to_string(E),3),nf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pr{&Ef,&nf};gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,t,pr,o);gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);gsVector<real_t> pt(2);pt<<0.5,0.5;
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    A=ev.eval(ea.getCoeff(mmA),pt);A.resize(3,3);D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3);}

// CLOSED FORM: A,D from the metric (a1,a2) directly, no gismo machinery
static void eval3D_closed(const V3<double>&a1,const V3<double>&a2,double thick,double E,double nu,double A[3][3],double D[3][3]){
    double a11=dot3(a1,a1),a22=dot3(a2,a2),a12=dot3(a1,a2),det=a11*a22-a12*a12;
    double c11=a22/det, c22=a11/det, c12=-a12/det;        // contravariant metric
    double k0=E*thick/(1-nu*nu), h=(1-nu)/2.0;
    A[0][0]=k0*c11*c11;
    A[1][1]=k0*c22*c22;
    A[0][1]=A[1][0]=k0*(nu*c11*c22 + (1-nu)*c12*c12);
    A[0][2]=A[2][0]=k0*c11*c12;
    A[1][2]=A[2][1]=k0*c22*c12;
    A[2][2]=k0*(nu*c12*c12 + h*(c11*c22 + c12*c12));
    double f=thick*thick/12.0;
    for(int i=0;i<3;++i)for(int j=0;j<3;++j)D[i][j]=f*A[i][j];
}

int main(){
    double E=1.0e6,nu=0.3;
    printf("Closed-form metric-weighted A,D vs gismo eval3D (must match to machine precision).\n\n");
    printf("  %-22s %6s  %12s %12s\n","metric (a1;a2)","t","relErr(A)","relErr(D)");
    struct Case{ V3<double> a1,a2; double t; const char*tag; };
    std::vector<Case> cases={
        {{1,0,0},{0,1,0},0.05,"axis-aligned"},
        {{2,0,0},{0,0.5,0},0.05,"stretched"},
        {{1,0,0},{0.6,1.5,0},0.05,"sheared (2D)"},
        {{0.8,0.1,0.3},{0.2,1.1,0.4},0.1,"curved/3D-embedded"},
        {{1.3,-0.2,0.5},{-0.4,0.9,-0.6},0.02,"curved thin"},
    };
    bool ok=true;
    for(auto&c:cases){
        gsMatrix<real_t> Ag,Dg; eval3D_gismo(c.a1,c.a2,c.t,E,nu,Ag,Dg);
        double Ac[3][3],Dc[3][3]; eval3D_closed(c.a1,c.a2,c.t,E,nu,Ac,Dc);
        double eA=0,nA=0,eD=0,nD=0;
        for(int i=0;i<3;++i)for(int j=0;j<3;++j){eA+=std::pow(Ac[i][j]-Ag(i,j),2);nA+=Ag(i,j)*Ag(i,j);eD+=std::pow(Dc[i][j]-Dg(i,j),2);nD+=Dg(i,j)*Dg(i,j);}
        double rA=std::sqrt(eA/nA),rD=std::sqrt(eD/nD);
        printf("  %-22s %6g  %12.3e %12.3e  [%s]\n",c.tag,c.t,rA,rD,(rA<1e-10&&rD<1e-10)?"PASS":"FAIL");
        if(rA>1e-10||rD>1e-10)ok=false;
    }
    printf("\n%s\n", ok
      ? "RESULT: PASS - closed form == gismo eval3D (metric-weighted curvilinear constitutive). Safe to replace\n"
        "the per-quad-point gismo machinery with the closed form -> ~100x assembly speedup, no convention guess."
      : "RESULT: FAIL - convention mismatch; do NOT replace until reconciled.");
    return ok?0:1;
}
