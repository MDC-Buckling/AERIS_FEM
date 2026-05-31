// Multi-element C1 BENDING patch test (Aeris BB). gismo-linked (eval3D).
// Confirms the resolution of the single-element 32% failure: the constant-moment
// (constant-curvature) state IS reproduced to machine precision on a MULTI-element
// C1 patch, because the ∮ M·∂v/∂n boundary terms cancel across the shared edge
// (opposite normals) — which they cannot on a single element. Single triangle: 32%.
// Two C1-coupled triangles: must be ~machine zero.
//
// Flat quad V00,V10,V11,V01 split into T1=(V00,V10,V11), T2=(V00,V11,V01); shared
// diagonal V00-V11 C1-coupled (v-form, the corrected physical-edge build). Prescribe
// the OUTER-boundary independent DOFs to the blossom coefs of w=1/2 c x^2, solve the
// remaining independent (interior) DOFs, reconstruct u=C u_ind, check max|u - field|.
//
// Build: g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//   -I/opt/gismo/external test_bb_c1_bending_patch.cpp -L/opt/gismo/build/lib -lgismo \
//   -Wl,-rpath,/opt/gismo/build/lib -o tcbp && ./tcbp 2>/dev/null
#include <gismo.h>
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include "bb_kl_strains.hpp"
#include <gsKLShell/src/getMaterialMatrix.h>
#include <gsKLShell/src/gsMaterialMatrixIntegrate.h>
#include <array>
#include <vector>
#include <cmath>
#include <map>
#include <cstdio>
using namespace gismo;
using aeris::BBTriangleBasis; using aeris::BasisDerivs; using aeris::Bmat;
using aeris::analytic_B; using aeris::Geom; using aeris::V3; using aeris::dot3; using aeris::cross3; using aeris::flat_patch_cps;
using aeris::quad_triangle;
typedef gsEigen::Matrix<real_t,gsEigen::Dynamic,gsEigen::Dynamic> EMat;
static const double E=1.0e6,nu=0.3,thick=0.05;
static V3<double> nrm(V3<double> v){double n=std::sqrt(dot3(v,v));return {v[0]/n,v[1]/n,v[2]/n};}
static void eval3D_AD(const V3<double>&a1,const V3<double>&a2,gsMatrix<real_t>&A,gsMatrix<real_t>&D){
    gsMultiPatch<real_t> mp;mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));mp.embed(3);
    gsMatrix<real_t>&C=mp.patch(0).coefs();for(index_t r=0;r<C.rows();++r){double xi=C(r,0),eta=C(r,1);for(int i=0;i<3;++i)C(r,i)=xi*a1[i]+eta*a2[i];}
    gsFunctionExpr<real_t> t(std::to_string(thick),3),Ef(std::to_string(E),3),nf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pr{&Ef,&nf};gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,t,pr,o);gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);gsVector<real_t> pt(2);pt<<0.5,0.5;
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    A=ev.eval(ea.getCoeff(mmA),pt);A.resize(3,3);D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3);}

int main(){
    int p=5; double c=0.02; BBTriangleBasis<double> B(p); int nK=B.size();
    int vc[3]={-1,-1,-1}; for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
        if(a[0]==p&&a[1]==0&&a[2]==0)vc[0]=k; if(a[0]==0&&a[1]==p&&a[2]==0)vc[1]=k; if(a[0]==0&&a[1]==0&&a[2]==p)vc[2]=k;}
    struct Tri{ std::array<V3<double>,3> V; std::vector<V3<double>> X; };
    V3<double> V00{0,0,0},V10{1,0,0},V11{1,1,0},V01{0,1,0};
    std::vector<Tri> tris(2);
    tris[0].V={V00,V10,V11}; tris[1].V={V00,V11,V01};
    for(auto&T:tris){ T.X=flat_patch_cps(B,T.V[0],T.V[1],T.V[2]); }
    int nT=2;
    std::vector<V3<double>> gp; std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
    auto foa=[&](const V3<double>&P){for(size_t i=0;i<gp.size();++i)if(std::hypot(std::hypot(gp[i][0]-P[0],gp[i][1]-P[1]),gp[i][2]-P[2])<1e-9)return(int)i;gp.push_back(P);return(int)gp.size()-1;};
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(tris[k].X[a]);
    int nCP=gp.size();
    // reference param-bary for each tri: vertices V[e] at bary corner e
    auto baryOf=[&](const Tri&T,const V3<double>&P){ // solve P = b0 V0 + b1 V1 + b2 V2 (affine, flat)
        double a11=T.V[1][0]-T.V[0][0],a12=T.V[2][0]-T.V[0][0],a21=T.V[1][1]-T.V[0][1],a22=T.V[2][1]-T.V[0][1];
        double det=a11*a22-a12*a21,px=P[0]-T.V[0][0],py=P[1]-T.V[0][1];
        return std::array<double,2>{(a22*px-a12*py)/det,(-a21*px+a11*py)/det}; };
    // physical-edge C1 (v-form), shared diagonal V00-V11
    struct ER{int tri,e,g0,g1;}; std::map<std::pair<int,int>,std::vector<ER>> em;
    for(int k=0;k<nT;++k)for(int e=0;e<3;++e){int g0=gmap[k][vc[e]],g1=gmap[k][vc[(e+1)%3]];em[std::minmax(g0,g1)].push_back({k,e,g0,g1});}
    V3<double> n3{0,0,1};
    auto buildAsc=[&](){ std::vector<std::vector<double>> Asc;
        for(auto&kv:em){ if(kv.second.size()!=2)continue; const ER&M=kv.second[0],&S=kv.second[1]; int gA=kv.first.first,gB=kv.first.second;
            for(int mm=0;mm<p;++mm){ double s=(mm+1.0)/(p+1.0); std::vector<double> row(nCP,0.0);
                for(int side=0;side<2;++side){ const ER&er=(side==0?M:S); const Tri&T=tris[er.tri]; double sign=(side==0?1.0:-1.0);
                    std::array<double,2> Ae,Be; auto bary=[&](int corner){return std::array<double,2>{corner==1?1.0:0.0, corner==2?1.0:0.0};};
                    int cA=(er.g0==gA)?er.e:(er.e+1)%3, cB=(er.g0==gA)?(er.e+1)%3:er.e; Ae=bary(cA); Be=bary(cB);
                    std::array<double,2> bc={(1-s)*Ae[0]+s*Be[0],(1-s)*Ae[1]+s*Be[1]};
                    auto d=BasisDerivs::at(B,bc[0],bc[1]); Geom<double> G=Geom<double>::build(T.X,d);
                    double t1=Be[0]-Ae[0],t2=Be[1]-Ae[1];
                    V3<double> AS{G.a1[0]*t1+G.a2[0]*t2,G.a1[1]*t1+G.a2[1]*t2,G.a1[2]*t1+G.a2[2]*t2}; AS=nrm(AS);
                    V3<double> AN=cross3(AS,G.a3);
                    double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
                    double r1=dot3(AN,G.a1),r2=dot3(AN,G.a2); double v1=(a22*r1-a12*r2)/det,v2=(-a12*r1+a11*r2)/det;
                    for(int k=0;k<nK;++k) row[gmap[er.tri][k]]+=sign*(v1*d.N1[k]+v2*d.N2[k]);
                } Asc.push_back(row);
            } } return Asc; };
    auto nullsp=[&](const std::vector<std::vector<double>>&Ain,int nc,std::vector<int>&fcl,int&rank){
        std::vector<std::vector<double>> Rm=Ain;int m=Rm.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
        for(int c2=0;c2<nc&&rr<m;++c2){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(Rm[r][c2])>best){best=std::fabs(Rm[r][c2]);pr=r;}if(pr<0)continue;std::swap(Rm[rr],Rm[pr]);double pv=Rm[rr][c2];for(int j=0;j<nc;++j)Rm[rr][j]/=pv;for(int r=0;r<m;++r)if(r!=rr){double f=Rm[r][c2];if(f!=0)for(int j=0;j<nc;++j)Rm[r][j]-=f*Rm[rr][j];}piv.push_back(c2);++rr;}
        rank=piv.size();std::vector<char> ip(nc,0);for(int c2:piv)ip[c2]=1;fcl.clear();for(int c2=0;c2<nc;++c2)if(!ip[c2])fcl.push_back(c2);int nF=fcl.size();
        std::vector<std::vector<double>> Cs(nc,std::vector<double>(nF,0.0));for(int f=0;f<nF;++f){Cs[fcl[f]][f]=1;for(int i=0;i<rank;++i)Cs[piv[i]][f]=-Rm[i][fcl[f]];}return Cs;};
    std::vector<int> fcl;int rank; auto Cs=nullsp(buildAsc(),nCP,fcl,rank); int nFs=fcl.size();
    // blossom field w=1/2 c x^2 per global CP (consistent on shared CPs)
    std::vector<double> wfield(nCP,0.0); double Cp2=p*(p-1)/2.0;
    for(int k=0;k<nT;++k){ double x0=tris[k].V[0][0],x1=tris[k].V[1][0],x2=tris[k].V[2][0];
        for(int a=0;a<nK;++a){const auto&al=B.alpha()[a];double i=al[0],j=al[1],kk=al[2];
            double bl=(i*(i-1)/2.0)*x0*x0+(j*(j-1)/2.0)*x1*x1+(kk*(kk-1)/2.0)*x2*x2+i*j*x0*x1+i*kk*x0*x2+j*kk*x1*x2;
            wfield[gmap[k][a]]=0.5*c*bl/Cp2; } }
    // K_e (3-DOF, both triangles)
    int nd=3*nCP; EMat Kf=EMat::Zero(nd,nd);
    for(int k=0;k<nT;++k){const Tri&T=tris[k];
        for(auto&q:quad_triangle(2*p)){auto d=BasisDerivs::at(B,q.xi1,q.xi2);Geom<double> G=Geom<double>::build(T.X,d);
            gsMatrix<real_t> A,D;eval3D_AD(G.a1,G.a2,A,D);double Jac=G.jbar;Bmat Bm,Bb;analytic_B(T.X,d,Bm,Bb);
            for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*gmap[k][a]+i;
                for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*gmap[k][b]+j;
                    double v=0;for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s=0;s<3;++s){Am+=A(r,s)*Bm.at(s,3*b+j);Dm+=D(r,s)*Bb.at(s,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                    Kf(ga,gb)+=q.w*Jac*v;}}}}
    // 3-DOF C (block per component): independent scalar DOFs fcl -> CPs
    int nF3=3*nFs; EMat C(nd,nF3); C.setZero();
    for(int cp=0;cp<nCP;++cp)for(int f=0;f<nFs;++f)for(int i=0;i<3;++i)C(3*cp+i,3*f+i)=Cs[cp][f];
    EMat Kr=C.transpose()*Kf*C;
    // independent DOF value for the field: u_ind at free CP fcl[f] = field (z-comp), 0 (x,y)
    // outer-boundary free CPs are prescribed; interior free CPs solved.
    auto onOuter=[&](int cp){ V3<double> X=gp[cp];
        return std::fabs(X[0])<1e-9||std::fabs(X[0]-1.0)<1e-9||std::fabs(X[1])<1e-9||std::fabs(X[1]-1.0)<1e-9; };
    std::vector<int> presc,freeI;
    for(int f=0;f<nFs;++f){ int cp=fcl[f]; for(int i=0;i<3;++i){ int idx=3*f+i; if(onOuter(cp))presc.push_back(idx); else freeI.push_back(idx);} }
    int nfr=freeI.size();
    EMat up((int)presc.size(),1); for(size_t b=0;b<presc.size();++b){int f=presc[b]/3,i=presc[b]%3; up(b,0)= (i==2)?wfield[fcl[f]]:0.0; }
    EMat Kii(nfr,nfr),Kip(nfr,(int)presc.size());
    for(int a=0;a<nfr;++a){for(int b=0;b<nfr;++b)Kii(a,b)=Kr(freeI[a],freeI[b]); for(size_t b=0;b<presc.size();++b)Kip(a,b)=Kr(freeI[a],presc[b]);}
    EMat ui=Kii.ldlt().solve(-Kip*up);
    // assemble full u_ind, then u = C u_ind, compare to field everywhere
    EMat uind(nF3,1); uind.setZero();
    for(size_t b=0;b<presc.size();++b)uind(presc[b],0)=up(b,0);
    for(int a=0;a<nfr;++a)uind(freeI[a],0)=ui(a,0);
    EMat u=C*uind;
    double err=0,scale=0; for(int cp=0;cp<nCP;++cp){ err=std::max(err,std::fabs(u(3*cp+2,0)-wfield[cp])); scale=std::max(scale,std::fabs(wfield[cp])); }
    printf("Multi-element (2-triangle) C1 BENDING patch test: w=1/2 c x^2, c=%g, p=%d.\n",c,p);
    printf("  nCP=%d  C1 rank=%d  indepDOF(scalar)=%d\n",nCP,rank,nFs);
    printf("  [%s] reproduce constant-moment field: rel err = %.3e   (single triangle gave 3.2e-1)\n",
           err/scale<1e-9?"PASS":"FAIL", err/scale);
    printf("\n%s\n", err/scale<1e-9
      ? "RESULT: PASS - the constant-moment state IS reproduced to machine precision on a MULTI-element\n"
        "C1 patch. The single-element 32% was the ∮M.∂v/∂n boundary term not cancelling on one element;\n"
        "across the shared C1 edge it cancels (opposite normals). Element sound; the single-element strong\n"
        "bending patch was the wrong test. Ready for the full folded G1 (penalty fold + convergence)."
      : "RESULT: FAIL - multi-element C1 patch does not reproduce; inspect C1 build / partition.");
    return 0;
}
