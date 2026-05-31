// Cylinder step 3c, part 1+2: CLOSED-cylinder seam closure + 6-rigid-nullmode GUARD
// (Aeris BB). gismo-linked (eval3D A/D + gsEigen). Gate BEFORE K_geom/LBA.
//
// Closed cylinder theta in [0,2pi). The DOF map merges xi=0/xi=2pi CPs by physical
// position (cyl(x,0)==cyl(x,2pi)) => displacement C0 across the seam automatically.
// The C1 (v-form) coupling is rewritten to match edges by PHYSICAL identity (sorted
// global-CP-index pair of the edge endpoints) with per-side sampling + explicit
// orientation, so EVERY interior edge INCLUDING the seam is C1-coupled uniformly.
//
// GUARD (user): closed cylinder, ONLY K_elastic, NO BC -> K_indep=C^T K C must have
// EXACTLY 6 zero modes (3 trans + 3 rot). A 7th near-null mode = the seam is a SLIT
// (merge/C1 failed at xi=0/xi=2pi) -> would seed a spurious low buckling mode. Only
// when this is green is the seam tight enough to put K_geom on it.
//
// Build:
//   g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//       -I/opt/gismo/external test_bb_cylinder_seam.cpp -L/opt/gismo/build/lib \
//       -lgismo -Wl,-rpath,/opt/gismo/build/lib -o tseam && ./tseam
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
#include <algorithm>
using namespace gismo;
using aeris::BBTriangleBasis; using aeris::BasisDerivs; using aeris::Bmat;
using aeris::analytic_B; using aeris::Geom; using aeris::V3; using aeris::flat_patch_cps;
using aeris::quad_triangle; using aeris::dot3; using aeris::cross3;
typedef gsEigen::Matrix<real_t,gsEigen::Dynamic,gsEigen::Dynamic> EMat;
static const double PI=3.14159265358979323846;

static void eval3D_ABD(const V3<double>&a1,const V3<double>&a2,double thick,double E,double nu,
                       gsMatrix<real_t>&A,gsMatrix<real_t>&D){
    gsMultiPatch<real_t> mp;mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));mp.embed(3);
    gsMatrix<real_t>&C=mp.patch(0).coefs();for(index_t r=0;r<C.rows();++r){double xi=C(r,0),eta=C(r,1);for(int i=0;i<3;++i)C(r,i)=xi*a1[i]+eta*a2[i];}
    gsFunctionExpr<real_t> t(std::to_string(thick),3),Ef(std::to_string(E),3),nuf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pars{&Ef,&nuf};gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,t,pars,o);gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);gsVector<real_t> pt(2);pt<<0.5,0.5;
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    A=ev.eval(ea.getCoeff(mmA),pt);A.resize(3,3);D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3);
}
static V3<double> cyl(double x,double th,double R){ return {R*std::cos(th),R*std::sin(th),x}; }
static V3<double> anormal(double th){ return {std::cos(th),std::sin(th),0.0}; }  // radial, periodic

int main(){
    const double E=1.0e6,nu=0.3,thick=0.05,R=1.0,L=1.0;
    int p=5; BBTriangleBasis<double> B(p); int nK=B.size();
    int Nx=2,Nt=8;                       // closed: Nt columns around the full circle
    printf("CLOSED cylinder seam-closure + 6-nullmode guard.  p=%d R=%g L=%g  Nx=%d Nt=%d (theta in [0,2pi))\n",p,R,L,Nx,Nt);

    // corner local indices: param-vertex 0->(p,0,0), 1->(0,p,0), 2->(0,0,p)
    int vc[3]={-1,-1,-1};
    for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
        if(a[0]==p&&a[1]==0&&a[2]==0)vc[0]=k; if(a[0]==0&&a[1]==p&&a[2]==0)vc[1]=k; if(a[0]==0&&a[1]==0&&a[2]==p)vc[2]=k;}

    struct Tri{ std::array<std::array<double,2>,3> pv; std::vector<V3<double>> X; };
    std::vector<Tri> tris;
    auto pvert=[&](int i,int j){return std::array<double,2>{i*L/Nx, (2*PI)*j/Nt};};  // j=Nt => theta=2pi (== 0 physically)
    for(int i=0;i<Nx;++i)for(int j=0;j<Nt;++j){
        std::array<std::array<double,2>,3> A1={{pvert(i,j),pvert(i+1,j),pvert(i+1,j+1)}};
        std::array<std::array<double,2>,3> A2={{pvert(i,j),pvert(i+1,j+1),pvert(i,j+1)}};
        for(auto&pv:{A1,A2}){ Tri T; T.pv=pv; T.X.resize(nK);
            for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
                double px=(a[0]*pv[0][0]+a[1]*pv[1][0]+a[2]*pv[2][0])/p;
                double pt=(a[0]*pv[0][1]+a[1]*pv[1][1]+a[2]*pv[2][1])/p;
                T.X[k]=cyl(px,pt,R); }
            tris.push_back(T);} }
    int nT=tris.size();
    // DOF map: merge by physical position -> auto-closes the xi=0/2pi seam
    std::vector<V3<double>> gpos; std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
    auto foa=[&](const V3<double>&P){for(size_t i=0;i<gpos.size();++i)if(std::hypot(std::hypot(gpos[i][0]-P[0],gpos[i][1]-P[1]),gpos[i][2]-P[2])<1e-9)return(int)i;gpos.push_back(P);return(int)gpos.size()-1;};
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(tris[k].X[a]);
    int nCP=gpos.size();

    auto baryParam=[&](const Tri&T,const std::array<double,2>&P){double a=T.pv[1][0]-T.pv[0][0],b=T.pv[2][0]-T.pv[0][0],c=T.pv[1][1]-T.pv[0][1],dd=T.pv[2][1]-T.pv[0][1],det=a*dd-b*c;double px=P[0]-T.pv[0][0],py=P[1]-T.pv[0][1];return std::array<double,2>{(dd*px-b*py)/det,(-c*px+a*py)/det};};
    // PHYSICAL edge identity: key = sorted global-CP-index pair of the edge endpoints.
    struct EdgeRef{int tri,e,g0,g1;};   // e = local edge (param vertex e -> e+1)
    std::map<std::pair<int,int>,std::vector<EdgeRef>> em;
    for(int k=0;k<nT;++k)for(int e=0;e<3;++e){ int g0=gmap[k][vc[e]],g1=gmap[k][vc[(e+1)%3]];
        std::pair<int,int> key=std::minmax(g0,g1); em[key].push_back({k,e,g0,g1}); }
    // v-form scalar C1 rows, sampled per-side along each side's OWN param edge.
    auto buildAsc=[&](){ std::vector<std::vector<double>> Asc;
        for(auto&kv:em){ if(kv.second.size()!=2)continue; const EdgeRef&M=kv.second[0],&S=kv.second[1];
            int gA=kv.first.first, gB=kv.first.second;   // edge globally oriented gA(min)->gB(max)
            for(int mm=0;mm<p;++mm){ double s=(mm+1.0)/(p+1.0);
                std::vector<double> row(nCP,0.0);
                for(int side=0;side<2;++side){ const EdgeRef&ER=(side==0?M:S); const Tri&T=tris[ER.tri]; double sign=(side==0?+1.0:-1.0);
                    // GLOBALLY-CONSISTENT orientation: A_end is the param vertex whose global == gA
                    std::array<double,2> Ae,Be;
                    if(ER.g0==gA){ Ae=T.pv[ER.e]; Be=T.pv[(ER.e+1)%3]; } else { Ae=T.pv[(ER.e+1)%3]; Be=T.pv[ER.e]; }
                    std::array<double,2> Pp={(1-s)*Ae[0]+s*Be[0], (1-s)*Ae[1]+s*Be[1]};   // param sample (for theta->anormal)
                    auto bcA=baryParam(T,Ae), bcB=baryParam(T,Be);                         // edge endpoints in REFERENCE coords
                    std::array<double,2> bc={(1-s)*bcA[0]+s*bcB[0],(1-s)*bcA[1]+s*bcB[1]};
                    auto d=BasisDerivs::at(B,bc[0],bc[1]); Geom<double> G=Geom<double>::build(T.X,d);
                    double t1=bcB[0]-bcA[0],t2=bcB[1]-bcA[1];                                // tangent gA->gB in REFERENCE coords
                    V3<double> AS{G.a1[0]*t1+G.a2[0]*t2,G.a1[1]*t1+G.a2[1]*t2,G.a1[2]*t1+G.a2[2]*t2};
                    double an=std::sqrt(dot3(AS,AS)); for(int i=0;i<3;++i)AS[i]/=an;
                    V3<double> A3a=anormal(Pp[1]); V3<double> AN=cross3(A3a,AS);
                    double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
                    double r1=dot3(AN,G.a1),r2=dot3(AN,G.a2); double v1=(a22*r1-a12*r2)/det,v2=(-a12*r1+a11*r2)/det;
                    for(int k=0;k<nK;++k) row[gmap[ER.tri][k]] += sign*(v1*d.N1[k]+v2*d.N2[k]);
                }
                Asc.push_back(row);
            } }
        return Asc; };
    auto nullsp=[&](const std::vector<std::vector<double>>& Ain,int ncols,std::vector<int>&fcl,int&rank)->std::vector<std::vector<double>>{
        std::vector<std::vector<double>> Rm=Ain;int m=Rm.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
        for(int c=0;c<ncols&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(Rm[r][c])>best){best=std::fabs(Rm[r][c]);pr=r;}if(pr<0)continue;std::swap(Rm[rr],Rm[pr]);double pv=Rm[rr][c];for(int j=0;j<ncols;++j)Rm[rr][j]/=pv;for(int r=0;r<m;++r)if(r!=rr){double f=Rm[r][c];if(f!=0)for(int j=0;j<ncols;++j)Rm[r][j]-=f*Rm[rr][j];}piv.push_back(c);++rr;}
        rank=piv.size();std::vector<char> ip(ncols,0);for(int c:piv)ip[c]=1;fcl.clear();for(int c=0;c<ncols;++c)if(!ip[c])fcl.push_back(c);int nFs=fcl.size();
        std::vector<std::vector<double>> Cs(ncols,std::vector<double>(nFs,0.0));for(int f=0;f<nFs;++f){Cs[fcl[f]][f]=1;for(int i=0;i<rank;++i)Cs[piv[i]][f]=-Rm[i][fcl[f]];} return Cs; };

    // pass 1: scalar C1 from cyl CP + analytic normal -> geom_C1 geometry
    std::vector<int> fcl0;int rank0; auto C0=nullsp(buildAsc(),nCP,fcl0,rank0); int nFs0=fcl0.size();
    std::vector<V3<double>> geomC1(nCP);
    for(int cp=0;cp<nCP;++cp)for(int c=0;c<3;++c){double s=0;for(int f=0;f<nFs0;++f)s+=C0[cp][f]*gpos[fcl0[f]][c];geomC1[cp][c]=s;}
    double geomerr=0;for(int cp=0;cp<nCP;++cp){double dx=geomC1[cp][0]-gpos[cp][0],dy=geomC1[cp][1]-gpos[cp][1],dz=geomC1[cp][2]-gpos[cp][2];geomerr=std::max(geomerr,std::sqrt(dx*dx+dy*dy+dz*dz));}
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)tris[k].X[a]=geomC1[gmap[k][a]];
    // pass 2: final scalar C1 on the C1 geometry -> 3-DOF block C
    std::vector<int> fcl;int rank; auto Asc=buildAsc(); auto Cs=nullsp(Asc,nCP,fcl,rank); int nFs=fcl.size();
    int nd=3*nCP, nF3=3*nFs;
    EMat C(nd,nF3); C.setZero();
    for(int cp=0;cp<nCP;++cp)for(int f=0;f<nFs;++f)for(int i=0;i<3;++i) C(3*cp+i,3*f+i)=Cs[cp][f];

    // G_lin: a global linear field must be C1 (in null(Asc))
    std::vector<double> ulin(nCP); for(int g=0;g<nCP;++g) ulin[g]=0.3*geomC1[g][0]-0.5*geomC1[g][1]+0.7*geomC1[g][2]+0.2;
    double e_lin=0; for(auto&row:Asc){double s=0;for(int c=0;c<nCP;++c)s+=row[c]*ulin[c];e_lin=std::max(e_lin,std::fabs(s));}

    // K_elastic (membrane+bending), NO BC
    EMat Kf=EMat::Zero(nd,nd);
    for(int k=0;k<nT;++k){ const Tri&T=tris[k];
        for(auto&q:quad_triangle(2*p)){ auto d=BasisDerivs::at(B,q.xi1,q.xi2); Geom<double> G=Geom<double>::build(T.X,d);
            gsMatrix<real_t> A,D; eval3D_ABD(G.a1,G.a2,thick,E,nu,A,D);
            double Jac=G.jbar; Bmat Bm,Bb; analytic_B(T.X,d,Bm,Bb);
            for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*gmap[k][a]+i;
                for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*gmap[k][b]+j;
                    double v=0; for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s2=0;s2<3;++s2){Am+=A(r,s2)*Bm.at(s2,3*b+j);Dm+=D(r,s2)*Bb.at(s2,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                    Kf(ga,gb)+=q.w*Jac*v; }}
        }}
    EMat Ke=C.transpose()*Kf*C;
    double e_sym=(Ke-Ke.transpose()).norm()/Ke.norm();
    gsEigen::SelfAdjointEigenSolver<EMat> es(Ke); auto ev=es.eigenvalues(); double scale=ev(nF3-1);
    int nzero=0; for(int i=0;i<nF3;++i) if(ev(i)<1e-8*scale) ++nzero;
    printf("  nT=%d nCP=%d  C1 scalar rank=%d indepDOF(scalar)=%d  3-DOF reduced=%d\n",nT,nCP,rank,nFs,nF3);
    printf("  geom_C1 fidelity: max|geom_C1 - cylinder CP| = %.3e\n",geomerr);
    printf("  [%s] G_lin closed-C1 linear precision ||A.u_lin|| = %.3e\n", e_lin<1e-9?"PASS":"FAIL", e_lin);
    printf("  [%s] K_indep symmetry = %.3e\n", e_sym<1e-10?"PASS":"FAIL", e_sym);
    printf("  smallest 10 eigenvalues / scale:");
    for(int i=0;i<std::min(10,nF3);++i) printf(" %.2e",ev(i)/scale); printf("\n");
    printf("  [%s] EXACTLY 6 zero modes (rigid) : found %d  (gap to 7th = %.3e)\n",
           nzero==6?"PASS":"FAIL", nzero, nF3>6?ev(6)/scale:0.0);
    bool ok=(e_lin<1e-9)&&(e_sym<1e-10)&&(nzero==6);
    printf("\n%s\n", ok
      ? "RESULT: PASS - closed-cylinder seam is TIGHT (merge + C1 across xi=0/2pi): exactly 6 rigid nullmodes, "
        "no seam slit. Ready for K_geom + axial LBA (cluster read vs sigma_cl)."
      : "RESULT: FAIL - a 7th near-null mode => seam slit (merge/C1 at xi=0/2pi) OR coupling bug. Inspect before LBA.");
    return ok?0:1;
}
