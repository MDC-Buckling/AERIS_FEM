// Cylinder step 3b-foundation: full 3-DOF curved-shell assembly + curved C1
// (v-form) coupling, gated on the 6-rigid-body-nullmode test (Aeris BB).
// gismo-linked (eval3D A/D + gsEigen eigensolver).
//
// Jump from the scalar-w flat plate to the full curved shell:
//  * 3 DOF/CP (u_x,u_y,u_z); membrane+bending coupled through the geometry.
//  * C1 per component (Ludwig delta^ij): the scalar continuity g_k applied to
//    each of the 3 components -> block C = scalar C in each component block.
//  * curved C1 uses the v-FORM (Ludwig 6.13/6.14): A_N = A3 x A_S = v1 a1 + v2 a2
//    (solve metric [a_ab] v = [A_N . a_a]); g_k = v1 N_k,1 + v2 N_k,2. This is the
//    surface normal-slope derivative, correct on a curved (3D-embedded) patch
//    where the flat physical-gradient form (2x2 Jacobian) no longer applies.
//
// Gates (isolate the new machinery BEFORE K_geom/eigenvalue):
//  G_lin  curved C1 linear precision: a global LINEAR displacement is C1 ->
//         ||A_C1 . u_linear|| ~ 0 (anchors the curved v-form; non-rigid part).
//  G_null K_indep = C^T K_full C (open segment, no BC) has EXACTLY 6 zero modes
//         (3 trans + 3 rot). A 7th near-null mode = spurious (assembly/coupling
//         bug on curved geometry). Same guard structure as the 3c seam closure.
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

static int idx_of(int q,int i,int j){int n=0;for(int ii=q;ii>=0;--ii)for(int jj=q-ii;jj>=0;--jj){if(ii==i&&jj==j)return n;++n;}return -1;}

// eval3D A,B,D from tangents (flat surrogate, shifter-free == exact, proven)
static void eval3D_ABD(const V3<double>&a1,const V3<double>&a2,double thick,double E,double nu,
                       gsMatrix<real_t>&A,gsMatrix<real_t>&B,gsMatrix<real_t>&D){
    gsMultiPatch<real_t> mp;mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));mp.embed(3);
    gsMatrix<real_t>&C=mp.patch(0).coefs();for(index_t r=0;r<C.rows();++r){double xi=C(r,0),eta=C(r,1);for(int i=0;i<3;++i)C(r,i)=xi*a1[i]+eta*a2[i];}
    gsFunctionExpr<real_t> t(std::to_string(thick),3),Ef(std::to_string(E),3),nuf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pars{&Ef,&nuf};gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,t,pars,o);gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);gsVector<real_t> pt(2);pt<<0.5,0.5;
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixB> mmB(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    A=ev.eval(ea.getCoeff(mmA),pt);A.resize(3,3);B=ev.eval(ea.getCoeff(mmB),pt);B.resize(3,3);D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3);
}

// geometry map: param (x,theta) -> surface. FLAT if AERIS_FLAT defined (diagnosis).
static V3<double> cyl(double x,double th,double R){
#ifdef AERIS_FLAT
    return {x, R*th, 0.0};
#else
    return {R*std::cos(th),R*std::sin(th),x};
#endif
}
// ANALYTIC surface normal (a priori, exactly continuous) — anchors the v-form so C
// is well-posed without iterating out of the ill-posed C0-geometry state.
static V3<double> anormal(double /*x*/,double th){
#ifdef AERIS_FLAT
    return {0.0,0.0,1.0};
#else
    return {std::cos(th),std::sin(th),0.0};   // radial
#endif
}

int main(){
    const double E=1.0e6,nu=0.3,thick=0.05,R=1.0;
    int p=5; BBTriangleBasis<double> B(p); int nK=B.size();
    // open cylinder segment, param x in [0,L], theta in [-phi,phi]
    double L=1.0,phi=0.6; int Nx=2,Nt=2;
    // parameter-space triangles, CPs placed ON the cylinder
    struct Tri{ std::array<std::array<double,2>,3> pv; std::vector<V3<double>> X; };
    std::vector<Tri> tris;
    auto pvert=[&](int i,int j){return std::array<double,2>{i*L/Nx, -phi + j*(2*phi)/Nt};};
    for(int i=0;i<Nx;++i)for(int j=0;j<Nt;++j){
        std::array<std::array<double,2>,2> cells_lo={{pvert(i,j),pvert(i+1,j)}}; (void)cells_lo;
        std::array<std::array<double,2>,3> A1={{pvert(i,j),pvert(i+1,j),pvert(i+1,j+1)}};
        std::array<std::array<double,2>,3> A2={{pvert(i,j),pvert(i+1,j+1),pvert(i,j+1)}};
        for(auto&pv:{A1,A2}){ Tri T; T.pv=pv; T.X.resize(nK);
            for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
                double px=(a[0]*pv[0][0]+a[1]*pv[1][0]+a[2]*pv[2][0])/p;
                double pt=(a[0]*pv[0][1]+a[1]*pv[1][1]+a[2]*pv[2][1])/p;
                T.X[k]=cyl(px,pt,R); }
            tris.push_back(T);} }
    int nT=tris.size();
    // 3D DOF map (merge CPs by physical position)
    std::vector<V3<double>> gpos; std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
    auto foa=[&](const V3<double>&P){for(size_t i=0;i<gpos.size();++i)if(std::hypot(std::hypot(gpos[i][0]-P[0],gpos[i][1]-P[1]),gpos[i][2]-P[2])<1e-9)return(int)i;gpos.push_back(P);return(int)gpos.size()-1;};
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(tris[k].X[a]);
    int nCP=gpos.size();

    // ----- curved C1 (v-form) scalar constraint matrix over interior edges -----
    // shared param edges
    auto pkey=[&](const std::array<double,2>&p){return std::make_pair((long long)llround(p[0]*1e7),(long long)llround(p[1]*1e7));};
    std::map<std::pair<std::pair<long long,long long>,std::pair<long long,long long>>,std::vector<int>> em;
    for(int k=0;k<nT;++k)for(int e=0;e<3;++e){auto a=pkey(tris[k].pv[e]),b=pkey(tris[k].pv[(e+1)%3]);if(b<a)std::swap(a,b);em[{a,b}].push_back(k);}
    auto baryParam=[&](const Tri&T,const std::array<double,2>&P){double a=T.pv[1][0]-T.pv[0][0],b=T.pv[2][0]-T.pv[0][0],c=T.pv[1][1]-T.pv[0][1],dd=T.pv[2][1]-T.pv[0][1],det=a*dd-b*c;double px=P[0]-T.pv[0][0],py=P[1]-T.pv[0][1];return std::array<double,2>{(dd*px-b*py)/det,(-c*px+a*py)/det};};
    auto buildAsc=[&](){ std::vector<std::vector<double>> Asc;   // scalar C1 rows from CURRENT tris[].X + analytic normal
    for(auto&kv:em){ if(kv.second.size()!=2)continue; int mt=kv.second[0],st=kv.second[1];
        // shared param edge endpoints
        std::vector<std::array<double,2>> sh; for(auto&Pm:tris[mt].pv)for(auto&Ps:tris[st].pv)if(std::hypot(Pm[0]-Ps[0],Pm[1]-Ps[1])<1e-9)sh.push_back(Pm);
        std::array<double,2> Pa=sh[0],Pb=sh[1];
        for(int mm=0;mm<p;++mm){ double s=(mm+1.0)/(p+1.0);
            std::array<double,2> Pp={(1-s)*Pa[0]+s*Pb[0],(1-s)*Pa[1]+s*Pb[1]};
            std::vector<double> row(nCP,0.0);
            for(int side=0;side<2;++side){ const Tri&T=tris[side==0?mt:st]; double sign=(side==0?+1.0:-1.0);
                auto bc=baryParam(T,Pp); auto d=BasisDerivs::at(B,bc[0],bc[1]); Geom<double> G=Geom<double>::build(T.X,d);
                // edge tangent A_S (physical) = a1*tdir1 + a2*tdir2, tdir = param edge direction in T-local
                auto bca=baryParam(T,Pa),bcb=baryParam(T,Pb); double t1=bcb[0]-bca[0],t2=bcb[1]-bca[1];
                V3<double> AS{G.a1[0]*t1+G.a2[0]*t2,G.a1[1]*t1+G.a2[1]*t2,G.a1[2]*t1+G.a2[2]*t2};
                double an=std::sqrt(dot3(AS,AS)); for(int i=0;i<3;++i)AS[i]/=an;
                V3<double> A3a=anormal(Pp[0],Pp[1]);    // ANALYTIC normal (continuous)
                V3<double> AN=cross3(A3a,AS);            // in-tangent-plane normal, consistent both sides
                // v: [a_ab] v = [AN.a1; AN.a2]
                double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
                double r1=dot3(AN,G.a1),r2=dot3(AN,G.a2); double v1=(a22*r1-a12*r2)/det,v2=(-a12*r1+a11*r2)/det;
                for(int k=0;k<nK;++k) row[gmap[side==0?mt:st][k]] += sign*(v1*d.N1[k]+v2*d.N2[k]);
            }
            Asc.push_back(row);
        }
    }
    return Asc; };   // end buildAsc
    auto nullsp=[&](const std::vector<std::vector<double>>& Asc,std::vector<int>&fcl,int&nFs,int&rank){
        std::vector<std::vector<double>> Rm=Asc;int m=Rm.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
        for(int c=0;c<nCP&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(Rm[r][c])>best){best=std::fabs(Rm[r][c]);pr=r;}if(pr<0)continue;std::swap(Rm[rr],Rm[pr]);double pv=Rm[rr][c];for(int j=0;j<nCP;++j)Rm[rr][j]/=pv;for(int r=0;r<m;++r)if(r!=rr){double f=Rm[r][c];if(f!=0)for(int j=0;j<nCP;++j)Rm[r][j]-=f*Rm[rr][j];}piv.push_back(c);++rr;}
        rank=piv.size();std::vector<char> ip(nCP,0);for(int c:piv)ip[c]=1;fcl.clear();for(int c=0;c<nCP;++c)if(!ip[c])fcl.push_back(c);nFs=fcl.size();
        std::vector<std::vector<double>> Cs(nCP,std::vector<double>(nFs,0.0));for(int f=0;f<nFs;++f){Cs[fcl[f]][f]=1;for(int i=0;i<rank;++i)Cs[piv[i]][f]=-Rm[i][fcl[f]];} return Cs; };
    // pass 1: C from initial cylinder-CP geometry + ANALYTIC normal -> geom_C1
    std::vector<int> fcl0;int nFs0,rank0; auto C0=nullsp(buildAsc(),fcl0,nFs0,rank0);
    std::vector<V3<double>> geomC1(nCP);
    for(int cp=0;cp<nCP;++cp)for(int c=0;c<3;++c){double s=0;for(int f=0;f<nFs0;++f)s+=C0[cp][f]*gpos[fcl0[f]][c];geomC1[cp][c]=s;}
    double geomerr=0;for(int cp=0;cp<nCP;++cp){double dx=geomC1[cp][0]-gpos[cp][0],dy=geomC1[cp][1]-gpos[cp][1],dz=geomC1[cp][2]-gpos[cp][2];geomerr=std::max(geomerr,std::sqrt(dx*dx+dy*dy+dz*dz));}
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)tris[k].X[a]=geomC1[gmap[k][a]];   // use C1 geometry
    // pass 2: FINAL C from the now-C1 geometry + analytic normal ("~1 iteration"; analytic normal is the truth)
    std::vector<int> fcl;int nFs,rank; auto Asc=buildAsc(); auto Cs=nullsp(Asc,fcl,nFs,rank);
    printf("geom_C1 fidelity: max|geom_C1 - cylinder CP| = %.3e (C1-approx; geometry-error source for LBA rate)\n",geomerr);
    // G_lin: linear field at the C1 geometry positions must be in null(Asc)
    std::vector<double> ulin(nCP); for(int g=0;g<nCP;++g) ulin[g]=0.3*geomC1[g][0]-0.5*geomC1[g][1]+0.7*geomC1[g][2]+0.2;
    double e_lin=0; for(auto&row:Asc){double s=0;for(int c=0;c<nCP;++c)s+=row[c]*ulin[c];e_lin=std::max(e_lin,std::fabs(s));}
    // ----- 3-DOF K_full (B_m,B_b + eval3D A/D) on the C1 geometry -----
    int nd=3*nCP; std::vector<std::vector<double>> Kf(nd,std::vector<double>(nd,0.0));
    for(int k=0;k<nT;++k){ const Tri&T=tris[k];
        for(auto&q:quad_triangle(2*p)){ auto d=BasisDerivs::at(B,q.xi1,q.xi2); Geom<double> G=Geom<double>::build(T.X,d);
            V3<double> a1=G.a1,a2=G.a2; gsMatrix<real_t> A,Bc,D; eval3D_ABD(a1,a2,thick,E,nu,A,Bc,D);
            double Jac=G.jbar; Bmat Bm,Bb; analytic_B(T.X,d,Bm,Bb);
            for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*gmap[k][a]+i;
                for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*gmap[k][b]+j;
                    double v=0; for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s2=0;s2<3;++s2){Am+=A(r,s2)*Bm.at(s2,3*b+j);Dm+=D(r,s2)*Bb.at(s2,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                    Kf[ga][gb]+=q.w*Jac*v; }}
        }}
    // ----- 3-DOF C (block per component) and K_indep = C^T K C -----
    int nF3=3*nFs;
    auto Cval=[&](int row3,int col3)->double{int cp=row3/3,ci=row3%3,fr=col3/3,fi=col3%3;return (ci==fi)?Cs[cp][fr]:0.0;};
    typedef gsEigen::Matrix<real_t,gsEigen::Dynamic,gsEigen::Dynamic> EMat;
    std::vector<std::vector<double>> KC(nd,std::vector<double>(nF3,0.0));
    for(int i=0;i<nd;++i)for(int f=0;f<nF3;++f){double s=0;int fr=f/3,fi=f%3;for(int cp2=0;cp2<nCP;++cp2){double cval=Cs[cp2][fr];if(cval!=0)s+=Kf[i][3*cp2+fi]*cval;}KC[i][f]=s;}
    EMat Ki(nF3,nF3);
    for(int a=0;a<nF3;++a)for(int b2=0;b2<nF3;++b2){double s=0;int ar=a/3,ai=a%3;for(int cp2=0;cp2<nCP;++cp2){double cval=Cs[cp2][ar];if(cval!=0)s+=cval*KC[3*cp2+ai][b2];}Ki(a,b2)=s;}
    // symmetry
    double e_sym=(Ki-Ki.transpose()).norm()/Ki.norm();
    // eigenvalues -> count zeros (smallest)
    gsEigen::SelfAdjointEigenSolver<EMat> es(Ki);
    auto ev=es.eigenvalues(); double scale=ev(nF3-1);
    int nzero=0; for(int i=0;i<nF3;++i) if(ev(i)<1e-8*scale) ++nzero;
    printf("curved segment: nT=%d nCP=%d  C1 scalar rank=%d indepDOF(scalar)=%d  3-DOF reduced=%d\n",nT,nCP,rank,nFs,nF3);
    printf("  [%s] G_lin curved-C1 linear precision  ||A.u_lin|| = %.3e\n", e_lin<1e-9?"PASS":"FAIL", e_lin);
    printf("  [%s] K_indep symmetry                  = %.3e\n", e_sym<1e-10?"PASS":"FAIL", e_sym);
    printf("  smallest 8 eigenvalues / scale:");
    for(int i=0;i<std::min(8,nF3);++i) printf(" %.2e",ev(i)/scale); printf("\n");
    printf("  [%s] exactly 6 zero modes (rigid body) : found %d  (gap to 7th = %.2e)\n",
           nzero==6?"PASS":"FAIL", nzero, nF3>6?ev(6)/scale:0.0);
    bool ok=(e_lin<1e-9)&&(e_sym<1e-10)&&(nzero==6);
    printf("\n%s\n", ok
      ? "RESULT: PASS - 3-DOF curved-shell assembly + curved C1 (v-form) correct: linear precision, "
        "symmetric, EXACTLY 6 rigid nullmodes (no spurious). Ready for K_geom + segment eigenvalue."
      : "RESULT: FAIL - inspect curved C1 (v-form) / assembly (a 7th near-null mode = spurious).");
    return ok?0:1;
}
