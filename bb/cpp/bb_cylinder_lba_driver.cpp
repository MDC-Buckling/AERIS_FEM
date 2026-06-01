// Aeris GUI driver: CLOSED-cylinder axial LBA with the Bernstein-Bezier (BB)
// triangle KL-shell element. Derived VERBATIM from the validated dense test
// `test_bb_cylinder_lba.cpp` (Step 3c, GREEN: lowest cluster [m0,n8] ~0.90
// sigma_cl at R/t=20) — the validated test stays pristine as the reference;
// this is the parametrised, machine-readable, GUI-facing variant.
//
// Two deliberate changes vs the validated test, both already proven elsewhere:
//   (1) R,L,E,nu,thick,Nx,Nt,p,nmodes are read from argv (the test hard-coded
//       them). The validated default case is reproduced when no flags are given.
//   (2) eval3D_ABD is the CLOSED-FORM metric-weighted curvilinear KL constitutive
//       (verified ==gismo eval3D to 1e-16 in test_bb_material_closedform, used in
//       test_bb_cylinder_lba_sparse) instead of the per-quad gismo getMaterialMatrix
//       — same numbers, no gismo machinery in the hot loop (~100x faster assembly).
//   The eigensolver stays the DENSE GeneralizedSelfAdjointEigenSolver (validated,
//   robust, fast enough for R/t<=~50 — the first-sim regime). The penalty-C1 and
//   sparse paths are NOT used here (sparse = later scaling lever; penalty = a
//   documented NEGATIVE result for fine-mesh scaling).
//
// Output:
//   - machine-readable stdout (parsed by scripts/bb_cylinder_lba.py):
//       [BB-META] R=.. L=.. t=.. E=.. nu=.. Nx=.. Nt=.. p=.. nmodes=.. nd=.. nF=..
//       [BB-SIGMA-CL] <sigma_cl>
//       [BB-MODE] index=<i> m=<m> n=<n> sigma=<sigma_cr> ratio=<sigma/sigma_cl> lambda=<N_cr> pvd=<modes/modeI.pvd|->
//   - when --out <dir> is given: ParaView files for the post-processor
//       <dir>/mp.pvd + mp.vts                 (undeformed cylinder geometry)
//       <dir>/modes/mode<i>.pvd + mode<i>.vts (buckling mode shape, |u|_max=1)
//
// Build (container aeris/gismo:v25.07.0):
//   g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//       -I/opt/gismo/external bb_cylinder_lba_driver.cpp -L/opt/gismo/build/lib \
//       -lgismo -Wl,-rpath,/opt/gismo/build/lib -o bb_cylinder_lba_driver
#include <gismo.h>
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include "bb_kl_strains.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <map>
#include <string>
#include <cstring>
#include <cstdio>
#include <fstream>
#include <sys/stat.h>
#include <algorithm>
using namespace gismo;
using aeris::BBTriangleBasis; using aeris::BasisDerivs; using aeris::Bmat;
using aeris::analytic_B; using aeris::Geom; using aeris::V3; using aeris::dot3; using aeris::cross3;
using aeris::quad_triangle;
typedef gsEigen::Matrix<real_t,gsEigen::Dynamic,gsEigen::Dynamic> EMat;
static const double PI=3.14159265358979323846;

// Geometry/material — set from argv in main(). Defaults = validated case.
static double R=1.0,L=1.0,E=1.0e6,nu=0.3;

// CLOSED-FORM metric-weighted KL constitutive (verified == gismo eval3D to 1e-16
// in test_bb_material_closedform across axis/sheared/curved). A = membrane
// (Et/(1-nu^2)), D = (t^2/12) A; metric-weighted via the contravariant metric of
// (a1,a2). Voigt [11,22,12], factor 2 on shear strain. No gismo per call.
static void eval3D_ABD(const V3<double>&a1,const V3<double>&a2,double thick,
                       double A[3][3],double D[3][3]){
    double a11=dot3(a1,a1),a22=dot3(a2,a2),a12=dot3(a1,a2),det=a11*a22-a12*a12;
    double c11=a22/det,c22=a11/det,c12=-a12/det,k0=E*thick/(1-nu*nu),h=(1-nu)/2.0;
    A[0][0]=k0*c11*c11; A[1][1]=k0*c22*c22;
    A[0][1]=A[1][0]=k0*(nu*c11*c22+(1-nu)*c12*c12);
    A[0][2]=A[2][0]=k0*c11*c12; A[1][2]=A[2][1]=k0*c22*c12;
    A[2][2]=k0*(nu*c12*c12+h*(c11*c22+c12*c12));
    double f=thick*thick/12.0; for(int i=0;i<3;++i)for(int j=0;j<3;++j)D[i][j]=f*A[i][j];
}
static V3<double> cyl(double x,double th){ return {R*std::cos(th),R*std::sin(th),x}; }
static V3<double> radial(double th){ return {std::cos(th),std::sin(th),0.0}; }

struct Mode{ double sig; int m,n; std::string pvd; };

// --- minimal VTK XML StructuredGrid writers (match aeris-gui parseVts/parsePvd) -
static void write_vts(const std::string&path,int nx,int nt,
                      const std::vector<double>&pos,const std::vector<double>*disp){
    std::ofstream f(path);
    f<<"<?xml version=\"1.0\"?>\n";
    f<<"<VTKFile type=\"StructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\">\n";
    f<<"  <StructuredGrid WholeExtent=\"0 "<<nx-1<<" 0 "<<nt-1<<" 0 0\">\n";
    f<<"    <Piece Extent=\"0 "<<nx-1<<" 0 "<<nt-1<<" 0 0\">\n";
    f<<"      <Points>\n";
    f<<"        <DataArray type=\"Float32\" NumberOfComponents=\"3\" format=\"ascii\">\n";
    for(size_t i=0;i<pos.size();i+=3) f<<pos[i]<<" "<<pos[i+1]<<" "<<pos[i+2]<<"\n";
    f<<"        </DataArray>\n      </Points>\n";
    if(disp){
        f<<"      <PointData>\n";
        f<<"        <DataArray type=\"Float32\" Name=\"SolutionField\" NumberOfComponents=\"3\" format=\"ascii\">\n";
        for(size_t i=0;i<disp->size();i+=3) f<<(*disp)[i]<<" "<<(*disp)[i+1]<<" "<<(*disp)[i+2]<<"\n";
        f<<"        </DataArray>\n      </PointData>\n";
    }
    f<<"    </Piece>\n  </StructuredGrid>\n</VTKFile>\n";
}
static void write_pvd(const std::string&path,const std::string&vtsRel){
    std::ofstream f(path);
    f<<"<?xml version=\"1.0\"?>\n";
    f<<"<VTKFile type=\"Collection\" version=\"0.1\" byte_order=\"LittleEndian\">\n";
    f<<"  <Collection>\n";
    f<<"    <DataSet timestep=\"0\" part=\"0\" file=\""<<vtsRel<<"\"/>\n";
    f<<"  </Collection>\n</VTKFile>\n";
}

static std::vector<Mode> run_lba(int Nx,int Nt,double thick,int p,int nmodes,
                                 int&out_nd,int&out_nF,double&out_kemin,
                                 const std::string&outdir){
    BBTriangleBasis<double> B(p); int nK=B.size();
    int vc[3]={-1,-1,-1};
    for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
        if(a[0]==p&&a[1]==0&&a[2]==0)vc[0]=k; if(a[0]==0&&a[1]==p&&a[2]==0)vc[1]=k; if(a[0]==0&&a[1]==0&&a[2]==p)vc[2]=k;}
    struct Tri{ std::array<std::array<double,2>,3> pv; std::vector<V3<double>> X; };
    std::vector<Tri> tris;
    auto pvert=[&](int i,int j){return std::array<double,2>{i*L/Nx,(2*PI)*j/Nt};};
    for(int i=0;i<Nx;++i)for(int j=0;j<Nt;++j){
        std::array<std::array<double,2>,3> A1={{pvert(i,j),pvert(i+1,j),pvert(i+1,j+1)}};
        std::array<std::array<double,2>,3> A2={{pvert(i,j),pvert(i+1,j+1),pvert(i,j+1)}};
        for(auto&pv:{A1,A2}){ Tri T; T.pv=pv; T.X.resize(nK);
            for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
                double px=(a[0]*pv[0][0]+a[1]*pv[1][0]+a[2]*pv[2][0])/p;
                double pt=(a[0]*pv[0][1]+a[1]*pv[1][1]+a[2]*pv[2][1])/p;
                T.X[k]=cyl(px,pt); } tris.push_back(T);} }
    int nT=tris.size();
    std::vector<V3<double>> gpos; std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
    auto foa=[&](const V3<double>&P){for(size_t i=0;i<gpos.size();++i)if(std::hypot(std::hypot(gpos[i][0]-P[0],gpos[i][1]-P[1]),gpos[i][2]-P[2])<1e-9)return(int)i;gpos.push_back(P);return(int)gpos.size()-1;};
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(tris[k].X[a]);
    int nCP=gpos.size();
    auto baryParam=[&](const Tri&T,const std::array<double,2>&P){double a=T.pv[1][0]-T.pv[0][0],b=T.pv[2][0]-T.pv[0][0],c=T.pv[1][1]-T.pv[0][1],dd=T.pv[2][1]-T.pv[0][1],det=a*dd-b*c;double px=P[0]-T.pv[0][0],py=P[1]-T.pv[0][1];return std::array<double,2>{(dd*px-b*py)/det,(-c*px+a*py)/det};};
    struct EdgeRef{int tri,e,g0,g1;};
    std::map<std::pair<int,int>,std::vector<EdgeRef>> em;
    for(int k=0;k<nT;++k)for(int e=0;e<3;++e){int g0=gmap[k][vc[e]],g1=gmap[k][vc[(e+1)%3]];std::pair<int,int> key=std::minmax(g0,g1);em[key].push_back({k,e,g0,g1});}
    auto buildAsc=[&](){ std::vector<std::vector<double>> Asc;
        for(auto&kv:em){ if(kv.second.size()!=2)continue; const EdgeRef&M=kv.second[0],&S=kv.second[1];
            int gA=kv.first.first,gB=kv.first.second;
            for(int mm=0;mm<p;++mm){ double s=(mm+1.0)/(p+1.0); std::vector<double> row(nCP,0.0);
                for(int side=0;side<2;++side){ const EdgeRef&ER=(side==0?M:S); const Tri&T=tris[ER.tri]; double sign=(side==0?+1.0:-1.0);
                    std::array<double,2> Ae,Be; if(ER.g0==gA){Ae=T.pv[ER.e];Be=T.pv[(ER.e+1)%3];}else{Ae=T.pv[(ER.e+1)%3];Be=T.pv[ER.e];}
                    std::array<double,2> Pp={(1-s)*Ae[0]+s*Be[0],(1-s)*Ae[1]+s*Be[1]};
                    auto bcA=baryParam(T,Ae),bcB=baryParam(T,Be); std::array<double,2> bc={(1-s)*bcA[0]+s*bcB[0],(1-s)*bcA[1]+s*bcB[1]};
                    auto d=BasisDerivs::at(B,bc[0],bc[1]); Geom<double> G=Geom<double>::build(T.X,d);
                    double t1=bcB[0]-bcA[0],t2=bcB[1]-bcA[1];
                    V3<double> AS{G.a1[0]*t1+G.a2[0]*t2,G.a1[1]*t1+G.a2[1]*t2,G.a1[2]*t1+G.a2[2]*t2};
                    double an=std::sqrt(dot3(AS,AS)); for(int i=0;i<3;++i)AS[i]/=an;
                    V3<double> A3a=radial(Pp[1]); V3<double> AN=cross3(A3a,AS);
                    double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
                    double r1=dot3(AN,G.a1),r2=dot3(AN,G.a2); double v1=(a22*r1-a12*r2)/det,v2=(-a12*r1+a11*r2)/det;
                    for(int k=0;k<nK;++k) row[gmap[ER.tri][k]] += sign*(v1*d.N1[k]+v2*d.N2[k]);
                } Asc.push_back(row);
            } } return Asc; };
    auto nullsp=[&](const std::vector<std::vector<double>>& Ain,int ncols,std::vector<int>&fcl,int&rank)->std::vector<std::vector<double>>{
        std::vector<std::vector<double>> Rm=Ain;int m=Rm.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
        for(int c=0;c<ncols&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(Rm[r][c])>best){best=std::fabs(Rm[r][c]);pr=r;}if(pr<0)continue;std::swap(Rm[rr],Rm[pr]);double pv=Rm[rr][c];for(int j=0;j<ncols;++j)Rm[rr][j]/=pv;for(int r=0;r<m;++r)if(r!=rr){double f=Rm[r][c];if(f!=0)for(int j=0;j<ncols;++j)Rm[r][j]-=f*Rm[rr][j];}piv.push_back(c);++rr;}
        rank=piv.size();std::vector<char> ip(ncols,0);for(int c:piv)ip[c]=1;fcl.clear();for(int c=0;c<ncols;++c)if(!ip[c])fcl.push_back(c);int nFs=fcl.size();
        std::vector<std::vector<double>> Cs(ncols,std::vector<double>(nFs,0.0));for(int f=0;f<nFs;++f){Cs[fcl[f]][f]=1;for(int i=0;i<rank;++i)Cs[piv[i]][f]=-Rm[i][fcl[f]];} return Cs;};
    // pass1: scalar C1 -> geom_C1
    std::vector<int> fcl0;int rank0; auto C0=nullsp(buildAsc(),nCP,fcl0,rank0); int nFs0=fcl0.size();
    std::vector<V3<double>> geomC1(nCP);
    for(int cp=0;cp<nCP;++cp)for(int c=0;c<3;++c){double s=0;for(int f=0;f<nFs0;++f)s+=C0[cp][f]*gpos[fcl0[f]][c];geomC1[cp][c]=s;}
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)tris[k].X[a]=geomC1[gmap[k][a]];
    // pass2: joint 3-DOF constraint = scalar C1 (x3 comps) + SS-end BC
    auto Asc=buildAsc(); int nd=3*nCP; out_nd=nd;
    std::vector<std::vector<double>> A3;
    for(auto&row:Asc) for(int i=0;i<3;++i){ std::vector<double> r3(nd,0.0); for(int cp=0;cp<nCP;++cp) if(row[cp]!=0) r3[3*cp+i]=row[cp]; A3.push_back(r3); }
    auto pin=[&](int cp,int comp){ std::vector<double> r3(nd,0.0); r3[3*cp+comp]=1.0; A3.push_back(r3); };
    int firstEnd=-1;
    for(int cp=0;cp<nCP;++cp){ double z=geomC1[cp][2];
        if(std::fabs(z)<1e-7||std::fabs(z-L)<1e-7){ pin(cp,0); pin(cp,1); if(firstEnd<0)firstEnd=cp; } }  // SS: x,y pinned at both ends
    if(firstEnd>=0) pin(firstEnd,2);   // kill axial rigid translation
    std::vector<int> fcl;int rank; auto Cs=nullsp(A3,nd,fcl,rank); int nF=fcl.size(); out_nF=nF;
    EMat C(nd,nF); for(int i=0;i<nd;++i)for(int f=0;f<nF;++f)C(i,f)=Cs[i][f];
    // K_e + K_geom (uniform axial N_xx=1)
    EMat Kf=EMat::Zero(nd,nd), Kg=EMat::Zero(nd,nd);
    V3<double> tax{0,0,1};
    for(int k=0;k<nT;++k){ const Tri&T=tris[k];
        for(auto&q:quad_triangle(2*p)){ auto d=BasisDerivs::at(B,q.xi1,q.xi2); Geom<double> G=Geom<double>::build(T.X,d);
            double A[3][3],D[3][3]; eval3D_ABD(G.a1,G.a2,thick,A,D);
            double Jac=G.jbar; Bmat Bm,Bb; analytic_B(T.X,d,Bm,Bb);
            double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
            double ta1=dot3(tax,G.a1),ta2=dot3(tax,G.a2);
            double c1=(a22*ta1-a12*ta2)/det,c2=(a11*ta2-a12*ta1)/det;
            std::vector<double> g(nK); for(int a=0;a<nK;++a) g[a]=c1*d.N1[a]+c2*d.N2[a];
            for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*gmap[k][a]+i;
                for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*gmap[k][b]+j;
                    double v=0; for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s2=0;s2<3;++s2){Am+=A[r][s2]*Bm.at(s2,3*b+j);Dm+=D[r][s2]*Bb.at(s2,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                    Kf(ga,gb)+=q.w*Jac*v; if(i==j)Kg(ga,gb)+=q.w*Jac*g[a]*g[b]; }}
        }}
    EMat Ke=C.transpose()*Kf*C, Kge=C.transpose()*Kg*C;
    gsEigen::SelfAdjointEigenSolver<EMat> esKe(Ke); out_kemin=esKe.eigenvalues()(0)/esKe.eigenvalues()(nF-1);
    gsEigen::GeneralizedSelfAdjointEigenSolver<EMat> ges(Kge,Ke);
    auto mu=ges.eigenvalues(); auto V=ges.eigenvectors();
    // classification grid (VERBATIM from the validated test — keeps (m,n) bit-identical)
    const int NXS=9,NTS=33;
    std::vector<double> gx,gth; for(int ia=0;ia<NXS;++ia)for(int it=0;it<NTS;++it){gx.push_back(L*ia/(NXS-1));gth.push_back(2*PI*it/(NTS-1));}
    struct Loc{int tri;std::vector<double>N;double th;};
    std::vector<Loc> loc(gx.size());
    for(size_t s=0;s<gx.size();++s){std::array<double,2>P{gx[s],gth[s]};int f=-1;std::array<double,2>bc{};
        for(int k=0;k<nT;++k){auto b=baryParam(tris[k],P);double b0=1-b[0]-b[1];if(b[0]>=-1e-7&&b[1]>=-1e-7&&b0>=-1e-7){f=k;bc=b;break;}}
        Loc Lc;Lc.tri=f;Lc.th=gth[s];Lc.N.assign(nK,0.0);if(f>=0)for(int k=0;k<nK;++k)Lc.N[k]=B.eval_one(k,bc[0],bc[1]);loc[s]=Lc;}
    auto wavenums=[&](const std::vector<double>&w,int&m,int&n){double mx=0;for(double v:w)mx=std::max(mx,std::fabs(v));double tol=0.1*mx;
        n=0;for(int ia=0;ia<NXS;++ia){int sc=0;double pv=0;for(int it=0;it<NTS;++it){double v=w[ia*NTS+it];if(std::fabs(v)<tol)continue;if(pv!=0&&(v>0)!=(pv>0))++sc;pv=v;}n=std::max(n,sc);}
        m=0;for(int it=0;it<NTS;++it){int sc=0;double pv=0;for(int ia=0;ia<NXS;++ia){double v=w[ia*NTS+it];if(std::fabs(v)<tol)continue;if(pv!=0&&(v>0)!=(pv>0))++sc;pv=v;}m=std::max(m,sc);}};

    // viz grid (denser, for ParaView mode-shape export) + geometry write
    bool wantViz = !outdir.empty();
    int NXV = std::min(4*Nx+1, 41), NTV = std::min(4*Nt+1, 161);
    std::vector<double> vpos;            // (NXV*NTV)*3, i (axial) fastest then j (circ)
    std::vector<int> vtri(NXV*NTV,-1);
    std::vector<std::vector<double>> vN(NXV*NTV);
    if(wantViz){
        ::mkdir(outdir.c_str(),0777); std::string md=outdir+"/modes"; ::mkdir(md.c_str(),0777);
        vpos.resize((size_t)NXV*NTV*3);
        for(int jt=0;jt<NTV;++jt)for(int ia=0;ia<NXV;++ia){
            double x=L*ia/(NXV-1), th=2*PI*jt/(NTV-1);
            size_t idx=(size_t)jt*NXV+ia; V3<double> P=cyl(x,th);
            vpos[3*idx]=P[0];vpos[3*idx+1]=P[1];vpos[3*idx+2]=P[2];
            std::array<double,2> PP{x,th}; int f=-1; std::array<double,2> bc{};
            for(int k=0;k<nT;++k){auto b=baryParam(tris[k],PP);double b0=1-b[0]-b[1];if(b[0]>=-1e-7&&b[1]>=-1e-7&&b0>=-1e-7){f=k;bc=b;break;}}
            vtri[idx]=f; vN[idx].assign(nK,0.0); if(f>=0)for(int k=0;k<nK;++k)vN[idx][k]=B.eval_one(k,bc[0],bc[1]);
        }
        write_vts(outdir+"/mp.vts",NXV,NTV,vpos,nullptr);
        write_pvd(outdir+"/mp.pvd","mp.vts");
    }

    double sigma_cl=E*thick/(R*std::sqrt(3.0*(1-nu*nu)));
    std::vector<Mode> out;
    for(int i=0;i<nmodes;++i){int col=nF-1-i;if(col<0)break;double m=mu(col);if(!(m>0))continue;
        EMat phi=V.col(col); EMat uf=C*phi;
        // radial scalar on classification grid -> (m,n)
        std::vector<double> w(gx.size(),0.0);
        for(size_t s=0;s<gx.size();++s){const Loc&Lc=loc[s];if(Lc.tri<0)continue;V3<double>rd=radial(Lc.th);double ww=0;
            for(int k=0;k<nK;++k){int cp=gmap[Lc.tri][k];ww+=Lc.N[k]*(uf(3*cp,0)*rd[0]+uf(3*cp+1,0)*rd[1]+uf(3*cp+2,0)*rd[2]);}w[s]=ww;}
        int mm,nn; wavenums(w,mm,nn);
        Mode M; M.sig=(1.0/m)/thick; M.m=mm; M.n=nn; M.pvd="-";
        if(wantViz){
            // full 3-comp displacement on the viz grid, normalised so |u|_max=1
            std::vector<double> disp((size_t)NXV*NTV*3,0.0); double mx=0;
            for(size_t idx=0;idx<(size_t)NXV*NTV;++idx){int f=vtri[idx];if(f<0)continue;
                double ux=0,uy=0,uz=0;for(int k=0;k<nK;++k){int cp=gmap[f][k];double Nk=vN[idx][k];ux+=Nk*uf(3*cp,0);uy+=Nk*uf(3*cp+1,0);uz+=Nk*uf(3*cp+2,0);}
                disp[3*idx]=ux;disp[3*idx+1]=uy;disp[3*idx+2]=uz; mx=std::max(mx,std::sqrt(ux*ux+uy*uy+uz*uz));}
            if(mx>0)for(auto&d:disp)d/=mx;
            std::string vts="mode"+std::to_string((int)out.size())+".vts";
            write_vts(outdir+"/modes/"+vts,NXV,NTV,vpos,&disp);
            write_pvd(outdir+"/modes/mode"+std::to_string((int)out.size())+".pvd",vts);
            M.pvd="modes/mode"+std::to_string((int)out.size())+".pvd";
        }
        out.push_back(M);
    }
    return out;
}

static const char* argval(int argc,char**argv,const char*key,const char*def){
    for(int i=1;i+1<argc;++i) if(std::strcmp(argv[i],key)==0) return argv[i+1];
    return def;
}

int main(int argc,char**argv){
    R   = std::atof(argval(argc,argv,"--R","1.0"));
    L   = std::atof(argval(argc,argv,"--L","1.0"));
    double thick = std::atof(argval(argc,argv,"--t","0.05"));
    E   = std::atof(argval(argc,argv,"--E","1000000"));
    nu  = std::atof(argval(argc,argv,"--nu","0.3"));
    int Nx = std::atoi(argval(argc,argv,"--Nx","4"));
    int Nt = std::atoi(argval(argc,argv,"--Nt","20"));
    int p  = std::atoi(argval(argc,argv,"--p","5"));
    int nmodes = std::atoi(argval(argc,argv,"--nmodes","8"));
    std::string outdir = argval(argc,argv,"--out","");

    double sigma_cl=E*thick/(R*std::sqrt(3.0*(1-nu*nu)));
    fprintf(stderr,"BB cylinder axial LBA driver.  R=%g L=%g t=%g E=%g nu=%g  R/t=%.1f\n",R,L,thick,E,nu,R/thick);
    fprintf(stderr,"  Nx=%d Nt=%d p=%d nmodes=%d  sqrt(Rt)=%.3f  n_cr~sqrt(R/t)=%.1f  sigma_cl=%.6g\n",
            Nx,Nt,p,nmodes,std::sqrt(R*thick),std::sqrt(R/thick),sigma_cl);

    int nd=0,nF=0; double kemin=0;
    auto modes=run_lba(Nx,Nt,thick,p,nmodes,nd,nF,kemin,outdir);

    // machine-readable block (parsed by scripts/bb_cylinder_lba.py)
    printf("[BB-META] R=%g L=%g t=%g E=%g nu=%g Nx=%d Nt=%d p=%d nmodes=%d nd=%d nF=%d kecond=%.3e\n",
           R,L,thick,E,nu,Nx,Nt,p,nmodes,nd,nF,kemin);
    printf("[BB-SIGMA-CL] %.10g\n",sigma_cl);
    for(size_t i=0;i<modes.size();++i){
        double Ncr=modes[i].sig*thick;
        printf("[BB-MODE] index=%zu m=%d n=%d sigma=%.10g ratio=%.6f lambda=%.10g pvd=%s\n",
               i,modes[i].m,modes[i].n,modes[i].sig,modes[i].sig/sigma_cl,Ncr,modes[i].pvd.c_str());
    }
    fprintf(stderr,"\n  lowest cluster: ");
    for(auto&m:modes) fprintf(stderr,"[m%d n%d %.3f sig_cl] ",m.m,m.n,m.sig/sigma_cl);
    fprintf(stderr,"\n");
    return 0;
}
