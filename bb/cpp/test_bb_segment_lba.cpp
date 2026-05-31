// Cylinder step 3b-LBA: linear buckling of the curved BB C1 segment under a
// DIRECTLY-IMPOSED uniform axial membrane prestress (Aeris BB). gismo-linked
// (eval3D A/D + gsEigen generalized eigensolver).
//
// Builds on test_bb_curved_assembly (3-DOF curved K_full + curved v-form C1,
// 6-nullmode-gated) and test_bb_buckle_plate (K_geom + generalized eig, flat).
// New machinery here = the 3-DOF geometric stiffness on a CURVED reference:
//
//   K_geom[3a+i][3b+j] = delta_ij * N_xx * int (t_ax . grad N_a)(t_ax . grad N_b) dA
//
// t_ax = global axial unit vector (0,0,1) for cyl(x,th)=(R cos th, R sin th, x);
// grad N_a = a^1 N_a,1 + a^2 N_a,2 (contravariant surface gradient). The full-3D
// block-delta_ij form contracts the AXIAL directional derivative of every
// displacement component with the imposed uniform N_xx.
//
// HONEST physics note (refines the "curvature term in K_geom" framing):
//   for AXIAL prestress on a cylinder the axial direction is the DEVELOPABLE
//   (straight) one -> da3/dx = 0 -> K_geom is curvature-BLIND (same form as the
//   flat plate). The classical R-dependence of N_cr enters through K_e: the
//   membrane<->normal coupling on the curved reference (the eps!=0 re-coupling
//   pinned pointwise in step 2b). So this LBA gates the ASSEMBLED curved K_e +
//   axial K_geom TOGETHER against gismo; a miss localises in the assembled
//   curved K_e (K_geom-axial is flat-validated in 3a).
//
// Reference state: imposed uniform N_xx = 1 (compressive force/length). The
// smallest positive generalized eigenvalue lambda = N_cr (critical axial force
// per unit length); sigma_cr = N_cr / t. Compared (next file) against a NURBS
// panel LBA with the SAME geometry+BC whose K_geom comes from gismo's own
// prebuckling route (K_NL - K_L) -> independent.
//
// BC (axially compressed curved panel; pinned bottom arc kills all 6 rigid
// modes; free top + free sides => prebuckling membrane state is uniform N_xx,
// free sides => N_th=N_xth=0; matches the NURBS reference exactly):
//   x=0 (z=0)  : u_x=u_y=u_z=0     (fixed support arc)
//   x=L (z=L)  : FREE (axial-mobile under the imposed prestress)
//   th=+-phi   : FREE
//
// Build (in aeris/gismo:v25.07.0):
//   g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//       -I/opt/gismo/external test_bb_segment_lba.cpp -L/opt/gismo/build/lib \
//       -lgismo -Wl,-rpath,/opt/gismo/build/lib -o t && ./t
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

// eval3D A,B,D from tangents (flat surrogate, shifter-free == exact, proven 2a)
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

// AERIS_FLAT: same panel dims (L x 2*phi*R) but flat -> isolates curved-K_e/locking
#ifdef AERIS_FLAT
static V3<double> cyl(double x,double th,double R){ return {x, R*th, 0.0}; }
static V3<double> anormal(double,double){ return {0.0,0.0,1.0}; }
static const V3<double> TAX{1.0,0.0,0.0};   // axial = global x
static const int AXC=0;                      // BC axial coordinate index
#else
static V3<double> cyl(double x,double th,double R){ return {R*std::cos(th),R*std::sin(th),x}; }
static V3<double> anormal(double,double th){ return {std::cos(th),std::sin(th),0.0}; }  // radial
static const V3<double> TAX{0.0,0.0,1.0};   // axial = global z (cyl axis)
static const int AXC=2;                      // BC axial coordinate index
#endif

// One mesh level -> critical axial membrane force per length N_cr (imposed N_xx=1).
static double run_level(int Nx,int Nt,double R,double L,double phi,
                        double E,double nu,double thick,int p,int& out_nF,bool& ok,int* out_null=nullptr){
    BBTriangleBasis<double> B(p); int nK=B.size();
    struct Tri{ std::array<std::array<double,2>,3> pv; std::vector<V3<double>> X; };
    std::vector<Tri> tris;
    auto pvert=[&](int i,int j){return std::array<double,2>{i*L/Nx, -phi + j*(2*phi)/Nt};};
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
    // 3D DOF map (merge CPs by physical position)
    std::vector<V3<double>> gpos; std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
    auto foa=[&](const V3<double>&P){for(size_t i=0;i<gpos.size();++i)if(std::hypot(std::hypot(gpos[i][0]-P[0],gpos[i][1]-P[1]),gpos[i][2]-P[2])<1e-9)return(int)i;gpos.push_back(P);return(int)gpos.size()-1;};
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(tris[k].X[a]);
    int nCP=gpos.size();

    // ---- shared param edges for the v-form C1 ----
    auto pkey=[&](const std::array<double,2>&p){return std::make_pair((long long)llround(p[0]*1e7),(long long)llround(p[1]*1e7));};
    std::map<std::pair<std::pair<long long,long long>,std::pair<long long,long long>>,std::vector<int>> em;
    for(int k=0;k<nT;++k)for(int e=0;e<3;++e){auto a=pkey(tris[k].pv[e]),b=pkey(tris[k].pv[(e+1)%3]);if(b<a)std::swap(a,b);em[{a,b}].push_back(k);}
    auto baryParam=[&](const Tri&T,const std::array<double,2>&P){double a=T.pv[1][0]-T.pv[0][0],b=T.pv[2][0]-T.pv[0][0],c=T.pv[1][1]-T.pv[0][1],dd=T.pv[2][1]-T.pv[0][1],det=a*dd-b*c;double px=P[0]-T.pv[0][0],py=P[1]-T.pv[0][1];return std::array<double,2>{(dd*px-b*py)/det,(-c*px+a*py)/det};};
    auto buildAsc=[&](){ std::vector<std::vector<double>> Asc;
        for(auto&kv:em){ if(kv.second.size()!=2)continue; int mt=kv.second[0],st=kv.second[1];
            std::vector<std::array<double,2>> sh; for(auto&Pm:tris[mt].pv)for(auto&Ps:tris[st].pv)if(std::hypot(Pm[0]-Ps[0],Pm[1]-Ps[1])<1e-9)sh.push_back(Pm);
            std::array<double,2> Pa=sh[0],Pb=sh[1];
            for(int mm=0;mm<p;++mm){ double s=(mm+1.0)/(p+1.0);
                std::array<double,2> Pp={(1-s)*Pa[0]+s*Pb[0],(1-s)*Pa[1]+s*Pb[1]};
                std::vector<double> row(nCP,0.0);
                for(int side=0;side<2;++side){ const Tri&T=tris[side==0?mt:st]; double sign=(side==0?+1.0:-1.0);
                    auto bc=baryParam(T,Pp); auto d=BasisDerivs::at(B,bc[0],bc[1]); Geom<double> G=Geom<double>::build(T.X,d);
                    auto bca=baryParam(T,Pa),bcb=baryParam(T,Pb); double t1=bcb[0]-bca[0],t2=bcb[1]-bca[1];
                    V3<double> AS{G.a1[0]*t1+G.a2[0]*t2,G.a1[1]*t1+G.a2[1]*t2,G.a1[2]*t1+G.a2[2]*t2};
                    double an=std::sqrt(dot3(AS,AS)); for(int i=0;i<3;++i)AS[i]/=an;
                    V3<double> A3a=anormal(Pp[0],Pp[1]); V3<double> AN=cross3(A3a,AS);
                    double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
                    double r1=dot3(AN,G.a1),r2=dot3(AN,G.a2); double v1=(a22*r1-a12*r2)/det,v2=(-a12*r1+a11*r2)/det;
                    for(int k=0;k<nK;++k) row[gmap[side==0?mt:st][k]] += sign*(v1*d.N1[k]+v2*d.N2[k]);
                }
                Asc.push_back(row);
            }
        }
        return Asc; };
    // generic null-space over `ncols` columns of a row list (incomplete Gauss, slave-pivot)
    auto nullsp=[&](const std::vector<std::vector<double>>& Ain,int ncols,std::vector<int>&fcl,int&rank)->std::vector<std::vector<double>>{
        std::vector<std::vector<double>> Rm=Ain;int m=Rm.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
        for(int c=0;c<ncols&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(Rm[r][c])>best){best=std::fabs(Rm[r][c]);pr=r;}if(pr<0)continue;std::swap(Rm[rr],Rm[pr]);double pv=Rm[rr][c];for(int j=0;j<ncols;++j)Rm[rr][j]/=pv;for(int r=0;r<m;++r)if(r!=rr){double f=Rm[r][c];if(f!=0)for(int j=0;j<ncols;++j)Rm[r][j]-=f*Rm[rr][j];}piv.push_back(c);++rr;}
        rank=piv.size();std::vector<char> ip(ncols,0);for(int c:piv)ip[c]=1;fcl.clear();for(int c=0;c<ncols;++c)if(!ip[c])fcl.push_back(c);int nFs=fcl.size();
        std::vector<std::vector<double>> Cs(ncols,std::vector<double>(nFs,0.0));for(int f=0;f<nFs;++f){Cs[fcl[f]][f]=1;for(int i=0;i<rank;++i)Cs[piv[i]][f]=-Rm[i][fcl[f]];} return Cs; };

    // pass 1: scalar C1 from initial cyl CP + analytic normal -> geom_C1 geometry
    std::vector<int> fcl0;int rank0; auto C0=nullsp(buildAsc(),nCP,fcl0,rank0); int nFs0=fcl0.size();
    std::vector<V3<double>> geomC1(nCP);
    for(int cp=0;cp<nCP;++cp)for(int c=0;c<3;++c){double s=0;for(int f=0;f<nFs0;++f)s+=C0[cp][f]*gpos[fcl0[f]][c];geomC1[cp][c]=s;}
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)tris[k].X[a]=geomC1[gmap[k][a]];

    // ---- joint 3-DOF constraint: C1 (block per component) + panel BC ----
    auto Asc=buildAsc();                       // scalar C1 rows on the C1 geometry
    int nd=3*nCP;
    std::vector<std::vector<double>> A3;
    for(auto&row:Asc) for(int i=0;i<3;++i){ std::vector<double> r3(nd,0.0); for(int cp=0;cp<nCP;++cp) if(row[cp]!=0) r3[3*cp+i]=row[cp]; A3.push_back(r3); }
    // panel BC from physical CP positions (z = axial)
    auto pinRow=[&](int cp,int comp){ std::vector<double> r3(nd,0.0); r3[3*cp+comp]=1.0; A3.push_back(r3); };
    int nBC=0;
    for(int cp=0;cp<nCP;++cp){ double z=geomC1[cp][AXC];
        if(std::fabs(z)<1e-7){ pinRow(cp,0);pinRow(cp,1);pinRow(cp,2); nBC+=3; }      // x=0 : fixed (kills all 6 rigid modes)
        // x=L FREE + sides free => uniform axial prestress (matches NURBS prebuckling)
    }
    std::vector<int> fcl;int rank; auto Cs=nullsp(A3,nd,fcl,rank); int nF=fcl.size();
    out_nF=nF;
    EMat C(nd,nF); for(int i=0;i<nd;++i)for(int f=0;f<nF;++f)C(i,f)=Cs[i][f];

    // ---- K_full (membrane+bending) and K_geom (axial) on the C1 geometry ----
    EMat Kf=EMat::Zero(nd,nd), Kg=EMat::Zero(nd,nd);
    V3<double> tax=TAX;                           // global axial unit
    double Hsum=0,Ksum=0,wsum=0;                  // curvature diagnostic (geom_C1 fidelity)
    for(int k=0;k<nT;++k){ const Tri&T=tris[k];
        for(auto&q:quad_triangle(2*p)){ auto d=BasisDerivs::at(B,q.xi1,q.xi2); Geom<double> G=Geom<double>::build(T.X,d);
            { double g11=dot3(G.a1,G.a1),g12=dot3(G.a1,G.a2),g22=dot3(G.a2,G.a2),dg=g11*g22-g12*g12;
              double b11=-dot3(G.a11,G.a3),b12=-dot3(G.a12,G.a3),b22=-dot3(G.a22,G.a3),db=b11*b22-b12*b12;
              double Hc=0.5*(g11*b22-2*g12*b12+g22*b11)/dg, Kc=db/dg;   // mean & Gaussian curvature
              Hsum+=q.w*G.jbar*std::fabs(Hc); Ksum+=q.w*G.jbar*std::fabs(Kc); wsum+=q.w*G.jbar; }
            gsMatrix<real_t> A,Bc,D; eval3D_ABD(G.a1,G.a2,thick,E,nu,A,Bc,D);
            double Jac=G.jbar; Bmat Bm,Bb; analytic_B(T.X,d,Bm,Bb);
            // axial directional derivative kernel g_a = (tax.a^1)N1 + (tax.a^2)N2
            double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
            double ta1=dot3(tax,G.a1),ta2=dot3(tax,G.a2);
            double c1=(a22*ta1-a12*ta2)/det, c2=(a11*ta2-a12*ta1)/det;   // tax . a^alpha
            std::vector<double> g(nK); for(int a=0;a<nK;++a) g[a]=c1*d.N1[a]+c2*d.N2[a];
            for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*gmap[k][a]+i;
                for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*gmap[k][b]+j;
                    double v=0; for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s2=0;s2<3;++s2){Am+=A(r,s2)*Bm.at(s2,3*b+j);Dm+=D(r,s2)*Bb.at(s2,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                    Kf(ga,gb)+=q.w*Jac*v;
                    if(i==j) Kg(ga,gb)+=q.w*Jac*g[a]*g[b];   // block-delta_ij, N_xx=1
                }}
        }}
    // ---- reduce + generalized eigenvalue ----
    EMat Ke=C.transpose()*Kf*C, Kge=C.transpose()*Kg*C;
    double e_sym=(Ke-Ke.transpose()).norm()/Ke.norm();
    // elastic-spectrum mechanism guard (exact zero-energy mode => contaminated eigenvalue)
    gsEigen::SelfAdjointEigenSolver<EMat> esKe(Ke);
    auto evKe=esKe.eigenvalues(); double keScale=evKe(nF-1);
    int keNull=0; for(int i=0;i<nF;++i) if(evKe(i)<1e-9*keScale) ++keNull;
    if(out_null)*out_null=keNull;
    gsEigen::GeneralizedSelfAdjointEigenSolver<EMat> ges(Kge,Ke);   // Kg v = mu Ke v ; lambda=1/mu_max
    auto mu=ges.eigenvalues();
    double mumax=mu(nF-1); double Ncr=1.0/mumax;
    static bool once=false;
    if(!once){ once=true;
        printf("    [geom diag] mean curv |H|=%.5f (exact 1/2R=%.5f, err %.2f%%)  |K_gauss|=%.3e (exact 0)\n",
               Hsum/wsum, 1.0/(2*R), 100*std::fabs(Hsum/wsum-1.0/(2*R))/(1.0/(2*R)), Ksum/wsum); }
    ok=(e_sym<1e-9)&&(mumax>0)&&std::isfinite(Ncr)&&(keNull==0);
    return Ncr;
}

int main(int argc,char**argv){
    const double E=1.0e6,nu=0.3,R=1.0,L=1.0,phi=0.6;
    int p=5;
    int Nn = (argc>1)? std::atoi(argv[1]) : 4;      // mesh level (Nx=Nt)
    printf("BB curved-segment LBA (axial, direct uniform N_xx=1).  p=%d  R=%g L=%g phi=%g  mesh Nx=Nt=%d\n",p,R,L,phi,Nn);
    printf("  SLENDERNESS SWEEP: membrane locking scales with R/t -> ratio BB/NURBS should -> 1 as the shell thickens.\n\n");
    printf("  %6s %6s %6s %6s %16s %16s\n","t","R/t","nF","null","N_cr(force/len)","sigma_cr=N/t");
    for(double thick:{0.2,0.1,0.05,0.02}){
        int nF=0,nn=0; bool ok=false;
        double Ncr=run_level(Nn,Nn,R,L,phi,E,nu,thick,p,nF,ok,&nn);
        printf("  %6g %6.0f %6d %6d %16.8g %16.8g\n",thick,R/thick,nF,nn,Ncr,Ncr/thick);
    }
    printf("\nCompare to NURBS panel LBA (segment_panel_nurbs_lba.py) at the same R/t. Gap shrinking with thickness => membrane locking.\n");
    return 0;
}
