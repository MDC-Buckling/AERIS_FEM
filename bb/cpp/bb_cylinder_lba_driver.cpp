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
#include <gsSpectra/gsSpectra.h>
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include "bb_kl_strains.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <map>
#include <climits>
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
typedef gsSparseMatrix<real_t> SpMat;
typedef gsEigen::Triplet<real_t> Trip;
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

// --- minimal VTK XML UnstructuredGrid writer (match aeris-gui parseVtu/parsePvd) -
// Writes the ACTUAL BB triangle mesh: each of the nT BB elements is sub-tessellated
// into `sub^2` flat display triangles (so the degree-p curvature + the mode shape
// render smoothly while the mesh stays genuinely triangular — the user SEES the
// triangle elements, especially with the viewport's edge overlay). Points are
// duplicated per element (one contiguous block of nSub points each); cells are
// VTK type 5 (triangle). `disp` (per-point 3-vector, already normalised) is written
// as SolutionField for the warpable mode shape, or null for bare geometry.
static void write_vtu(const std::string&path,const std::vector<double>&pts,
                      const std::vector<double>*disp,int nT,int nSub,
                      const std::vector<std::array<int,3>>&subTri){
    int NP=pts.size()/3; long nCells=(long)nT*subTri.size();
    std::ofstream f(path);
    f<<"<?xml version=\"1.0\"?>\n";
    f<<"<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\">\n";
    f<<"  <UnstructuredGrid>\n";
    f<<"    <Piece NumberOfPoints=\""<<NP<<"\" NumberOfCells=\""<<nCells<<"\">\n";
    f<<"      <Points>\n";
    f<<"        <DataArray type=\"Float32\" NumberOfComponents=\"3\" format=\"ascii\">\n";
    for(size_t i=0;i<pts.size();i+=3) f<<pts[i]<<" "<<pts[i+1]<<" "<<pts[i+2]<<"\n";
    f<<"        </DataArray>\n      </Points>\n";
    f<<"      <Cells>\n";
    f<<"        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"ascii\">\n";
    for(int k=0;k<nT;++k){int base=k*nSub;for(auto&t:subTri)f<<base+t[0]<<" "<<base+t[1]<<" "<<base+t[2]<<"\n";}
    f<<"        </DataArray>\n";
    f<<"        <DataArray type=\"Int32\" Name=\"offsets\" format=\"ascii\">\n";
    for(long c=1;c<=nCells;++c)f<<3*c<<" ";
    f<<"\n        </DataArray>\n";
    f<<"        <DataArray type=\"UInt8\" Name=\"types\" format=\"ascii\">\n";
    for(long c=0;c<nCells;++c)f<<"5 ";
    f<<"\n        </DataArray>\n      </Cells>\n";
    if(disp){
        f<<"      <PointData>\n";
        f<<"        <DataArray type=\"Float32\" Name=\"SolutionField\" NumberOfComponents=\"3\" format=\"ascii\">\n";
        for(size_t i=0;i<disp->size();i+=3) f<<(*disp)[i]<<" "<<(*disp)[i+1]<<" "<<(*disp)[i+2]<<"\n";
        f<<"        </DataArray>\n      </PointData>\n";
    }
    f<<"    </Piece>\n  </UnstructuredGrid>\n</VTKFile>\n";
}
static void write_pvd(const std::string&path,const std::string&fileRel){
    std::ofstream f(path);
    f<<"<?xml version=\"1.0\"?>\n";
    f<<"<VTKFile type=\"Collection\" version=\"0.1\" byte_order=\"LittleEndian\">\n";
    f<<"  <Collection>\n";
    f<<"    <DataSet timestep=\"0\" part=\"0\" file=\""<<fileRel<<"\"/>\n";
    f<<"  </Collection>\n</VTKFile>\n";
}

// SPARSE incomplete-Gauss null-space, ROW-BASED + min-degree fill control. Same
// null-space as the dense Gauss (genuine: A*Cs=0, correct dim) but each basis
// function stays LOCAL -> nnz(Cs) ~ O(n) MESH-INDEPENDENT (~10/col), vs the dense
// free-pivot's global spread (947/col at R/t=20, growing). Verified == dense in
// test_bb_c1_sparse_local. Returns Cs[f] = sparse column f (col->val map).
typedef std::map<int,double> SRow;
static std::vector<SRow> sparse_nullsp(const std::vector<SRow>& Ain,
        int ncols, std::vector<int>&fcl, int&rank){
    int m=Ain.size(); std::vector<SRow> Rm(m);
    for(int r=0;r<m;++r) for(auto&kv:Ain[r]) if(std::fabs(kv.second)>1e-14) Rm[r][kv.first]=kv.second;
    const double TOL=1e-9;
    std::vector<int> pivrow, pivcol; std::vector<char> usedRow(m,0), pivotedCol(ncols,0);
    std::vector<int> colCnt(ncols,0); std::vector<std::vector<int>> colRows(ncols);
    for(int r=0;r<m;++r) for(auto&kv:Rm[r]){ colCnt[kv.first]++; colRows[kv.first].push_back(r); }
    int remaining=m;
    while(remaining>0){
        int br=-1; size_t blen=SIZE_MAX;
        for(int r=0;r<m;++r){ if(usedRow[r])continue; if(Rm[r].empty()){usedRow[r]=1;--remaining;continue;}
            if(Rm[r].size()<blen){blen=Rm[r].size();br=r;} }
        if(br<0) break;
        int pc=-1; int bestdeg=INT_MAX;
        for(auto&kv:Rm[br]) if(!pivotedCol[kv.first] && std::fabs(kv.second)>TOL && colCnt[kv.first]<bestdeg){bestdeg=colCnt[kv.first];pc=kv.first;}
        if(pc<0){ usedRow[br]=1; --remaining; continue; }
        double pv=Rm[br][pc]; for(auto&kv:Rm[br]) kv.second/=pv;
        usedRow[br]=1; --remaining; pivotedCol[pc]=1; pivrow.push_back(br); pivcol.push_back(pc);
        for(auto&kv:Rm[br]) colCnt[kv.first]--;
        std::vector<int> rows=colRows[pc];
        for(int r:rows){ if(r==br) continue; auto it=Rm[r].find(pc); if(it==Rm[r].end()) continue;
            double f=it->second; if(f==0) continue; bool live=!usedRow[r];
            for(auto&kv:Rm[br]){ int c=kv.first; double add=-f*kv.second; auto jt=Rm[r].find(c);
                if(jt==Rm[r].end()){ if(std::fabs(add)>1e-14){ Rm[r][c]=add; colRows[c].push_back(r); if(live)colCnt[c]++; } }
                else { jt->second+=add; if(std::fabs(jt->second)<1e-14){ Rm[r].erase(jt); if(live)colCnt[c]--; } } }
        }
    }
    rank=pivrow.size();
    fcl.clear(); for(int c=0;c<ncols;++c) if(!pivotedCol[c]) fcl.push_back(c);
    int nFs=fcl.size(); std::vector<int> colToFree(ncols,-1); for(int f=0;f<nFs;++f) colToFree[fcl[f]]=f;
    std::vector<SRow> Cs(nFs); for(int f=0;f<nFs;++f) Cs[f][fcl[f]]=1.0;
    for(int i=0;i<rank;++i){ int pr=pivrow[i], pcl=pivcol[i];
        for(auto&kv:Rm[pr]){ int c=kv.first; if(c==pcl) continue; int f=colToFree[c];
            if(f>=0 && std::fabs(kv.second)>1e-14) Cs[f][pcl]=-kv.second; } }
    return Cs;
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
    auto buildAsc=[&](){ std::vector<SRow> Asc;       // sparse rows: each touches only ~2·nK CPs
        for(auto&kv:em){ if(kv.second.size()!=2)continue; const EdgeRef&M=kv.second[0],&S=kv.second[1];
            int gA=kv.first.first,gB=kv.first.second;
            for(int mm=0;mm<p;++mm){ double s=(mm+1.0)/(p+1.0); SRow row;
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
                } Asc.push_back(std::move(row));
            } } return Asc; };
    // pass1: scalar C1 -> geom_C1
    std::vector<int> fcl0;int rank0; auto C0=sparse_nullsp(buildAsc(),nCP,fcl0,rank0); int nFs0=fcl0.size();
    std::vector<V3<double>> geomC1(nCP,V3<double>{0,0,0});
    for(int f=0;f<nFs0;++f){ const V3<double>&P=gpos[fcl0[f]]; for(auto&kv:C0[f]){ int cp=kv.first; double v=kv.second; geomC1[cp][0]+=v*P[0];geomC1[cp][1]+=v*P[1];geomC1[cp][2]+=v*P[2]; } }
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)tris[k].X[a]=geomC1[gmap[k][a]];
    // pass2: joint 3-DOF constraint = scalar C1 (x3 comps) + SS-end BC
    auto Asc=buildAsc(); int nd=3*nCP; out_nd=nd;
    std::vector<SRow> A3;                          // sparse: scalar C1 row -> 3 component rows + pins
    for(auto&row:Asc) for(int i=0;i<3;++i){ SRow r3; for(auto&kv:row) r3[3*kv.first+i]=kv.second; A3.push_back(std::move(r3)); }
    auto pin=[&](int cp,int comp){ SRow r3; r3[3*cp+comp]=1.0; A3.push_back(std::move(r3)); };
    int firstEnd=-1;
    for(int cp=0;cp<nCP;++cp){ double z=geomC1[cp][2];
        if(std::fabs(z)<1e-7||std::fabs(z-L)<1e-7){ pin(cp,0); pin(cp,1); if(firstEnd<0)firstEnd=cp; } }  // SS: x,y pinned at both ends
    if(firstEnd>=0) pin(firstEnd,2);   // kill axial rigid translation
    std::vector<int> fcl;int rank; auto Cs=sparse_nullsp(A3,nd,fcl,rank); int nF=fcl.size(); out_nF=nF;
    std::vector<Mode> out;     // result modes (declared early so a Spectra-fail can return it)
    // SPARSE C (nd × nF) directly from the sparse null-space columns Cs[f].
    SpMat C(nd,nF); { std::vector<Trip> tc; for(int f=0;f<nF;++f) for(auto&kv:Cs[f]) tc.emplace_back(kv.first,f,kv.second); C.setFromTriplets(tc.begin(),tc.end()); }
    fprintf(stderr,"  [C density] nnz(C)=%ld avg %.1f/col  (nd=%d nF=%d) [sparse min-degree]\n",
            (long)C.nonZeros(),(double)C.nonZeros()/std::max(nF,1),nd,nF);
    // SPARSE K_e, K_geom (uniform axial N_xx=1) — same per-quad math, emitted as triplets.
    std::vector<Trip> tF,tG; V3<double> tax{0,0,1};
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
                    tF.emplace_back(ga,gb,q.w*Jac*v); if(i==j)tG.emplace_back(ga,gb,q.w*Jac*g[a]*g[b]); }}
        }}
    SpMat Kf(nd,nd),Kg(nd,nd); Kf.setFromTriplets(tF.begin(),tF.end()); Kg.setFromTriplets(tG.begin(),tG.end());
    SpMat Ke=(C.transpose()*Kf*C); Ke.makeCompressed();
    SpMat Kge=(C.transpose()*Kg*C); Kge.makeCompressed();
    out_kemin=0.0;   // (dense Ke condition diagnostic skipped on the sparse path)
    // SPARSE Spectra Buckling shift-invert: Ke x = lam Kge x ; smallest positive lam = N_cr.
    // Shift 0.8·sigma_cl·t sits BELOW the lowest mode (~0.9 sigma_cl) so shift-invert
    // catches the true lowest cluster (validated == dense in test_bb_cylinder_lba_sparse).
    double sigma_cl_loc=E*thick/(R*std::sqrt(3.0*(1-nu*nu)));
    double shift=0.8*sigma_cl_loc*thick;
    int nev=std::min(std::max(nmodes+6,14),nF-1), ncv=std::min(3*nev,nF);
    gsMatrix<real_t> vals, vecs; bool spok=false;
    try{
        gsSpectraGenSymShiftSolver<SpMat,Spectra::GEigsMode::Buckling> solver(Ke,Kge,nev,ncv,shift);
        solver.compute(Spectra::SortRule::LargestMagn,1000,1e-10,Spectra::SortRule::SmallestMagn);
        spok=(solver.info()==Spectra::CompInfo::Successful);
        if(spok){ vals=solver.eigenvalues(); vecs=solver.eigenvectors(); }
    }catch(...){ spok=false; }
    if(!spok){ fprintf(stderr,"  [Spectra] FAILED to converge (nF=%d nev=%d ncv=%d) — try a coarser mesh.\n",nF,nev,ncv); return out; }
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

    // ParaView export of the ACTUAL BB triangle mesh: sub-tessellate each element
    // into sub^2 display triangles. The parametric sub-lattice + basis values are
    // identical for every element, so precompute them once; per element only the
    // control points X[] (geometry) and the CP displacements (mode) differ.
    bool wantViz = !outdir.empty();
    const int sub=4;                      // display subdivisions per element edge
    std::vector<std::array<int,2>> latt; std::map<std::pair<int,int>,int> lidx;
    for(int j=0;j<=sub;++j)for(int i=0;i<=sub-j;++i){lidx[{i,j}]=(int)latt.size();latt.push_back({i,j});}
    int nSub=(int)latt.size();
    std::vector<std::vector<double>> subN(nSub,std::vector<double>(nK,0.0));
    for(int s=0;s<nSub;++s){double l1=latt[s][0]/(double)sub,l2=latt[s][1]/(double)sub;for(int a=0;a<nK;++a)subN[s][a]=B.eval_one(a,l1,l2);}
    std::vector<std::array<int,3>> subTri;     // local sub-triangles within one element
    for(int j=0;j<sub;++j)for(int i=0;i<sub-j;++i){
        int A=lidx[{i,j}],Bx=lidx[{i+1,j}],C=lidx[{i,j+1}]; subTri.push_back({A,Bx,C});
        if(i<sub-1-j){int Dd=lidx[{i+1,j+1}]; subTri.push_back({Bx,Dd,C});} }
    std::vector<double> geomPts;          // undeformed positions, nT*nSub points × 3
    if(wantViz){
        ::mkdir(outdir.c_str(),0777); std::string md=outdir+"/modes"; ::mkdir(md.c_str(),0777);
        geomPts.resize((size_t)nT*nSub*3);
        for(int k=0;k<nT;++k)for(int s=0;s<nSub;++s){double X=0,Y=0,Z=0;
            for(int a=0;a<nK;++a){const V3<double>&P=tris[k].X[a];double w=subN[s][a];X+=w*P[0];Y+=w*P[1];Z+=w*P[2];}
            size_t idx=((size_t)k*nSub+s)*3; geomPts[idx]=X;geomPts[idx+1]=Y;geomPts[idx+2]=Z;}
        write_vtu(outdir+"/mp.vtu",geomPts,nullptr,nT,nSub,subTri);
        write_pvd(outdir+"/mp.pvd","mp.vtu");
    }

    // Iterate the sparse eigenpairs in ascending lam (= N_cr); the smallest
    // positive ones are the lowest Koiter cluster. Classify (m,n) + write viz.
    std::vector<int> ord; for(int i=0;i<vals.rows();++i) ord.push_back(i);
    std::sort(ord.begin(),ord.end(),[&](int a,int b){return vals(a,0)<vals(b,0);});
    for(int t:ord){ double lam=vals(t,0); if(!(lam>1e-9)) continue;
        gsMatrix<real_t> uf=C*vecs.col(t);
        // radial scalar on classification grid -> (m,n)
        std::vector<double> w(gx.size(),0.0);
        for(size_t s=0;s<gx.size();++s){const Loc&Lc=loc[s];if(Lc.tri<0)continue;V3<double>rd=radial(Lc.th);double ww=0;
            for(int k=0;k<nK;++k){int cp=gmap[Lc.tri][k];ww+=Lc.N[k]*(uf(3*cp,0)*rd[0]+uf(3*cp+1,0)*rd[1]+uf(3*cp+2,0)*rd[2]);}w[s]=ww;}
        int mm,nn; wavenums(w,mm,nn);
        Mode M; M.sig=lam/thick; M.m=mm; M.n=nn; M.pvd="-";
        if(wantViz){
            // displacement on the sub-tessellated mesh, normalised so |u|_max=1
            std::vector<double> disp((size_t)nT*nSub*3,0.0); double mx=0;
            for(int k=0;k<nT;++k)for(int s=0;s<nSub;++s){double ux=0,uy=0,uz=0;
                for(int a=0;a<nK;++a){int cp=gmap[k][a];double w=subN[s][a];ux+=w*uf(3*cp,0);uy+=w*uf(3*cp+1,0);uz+=w*uf(3*cp+2,0);}
                size_t idx=((size_t)k*nSub+s)*3; disp[idx]=ux;disp[idx+1]=uy;disp[idx+2]=uz;
                mx=std::max(mx,std::sqrt(ux*ux+uy*uy+uz*uz));}
            if(mx>0)for(auto&d:disp)d/=mx;
            int mi=(int)out.size();
            write_vtu(outdir+"/modes/mode"+std::to_string(mi)+".vtu",geomPts,&disp,nT,nSub,subTri);
            write_pvd(outdir+"/modes/mode"+std::to_string(mi)+".pvd","mode"+std::to_string(mi)+".vtu");
            M.pvd="modes/mode"+std::to_string(mi)+".pvd";
        }
        out.push_back(M);
        if((int)out.size()>=nmodes) break;
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
