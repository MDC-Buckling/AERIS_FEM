// Cylinder axial LBA — SPARSE + Spectra (Aeris BB). gismo-linked. The scaling enabler:
// replaces the dense O(n^3) generalized eigensolver (wall ~nd 6000) with sparse Spectra
// Buckling shift-invert (lowest few modes, O(n*nev) per iter) -> reaches finer meshes /
// higher R/t (where the short-wave Koiter mode n_cr~sqrt(R/t) lives). Verifies vs the dense
// result at R/t=20, then pushes R/t up.
//
// CAVEAT (honest): the C1 null-space is still DENSE Gauss elimination -> the next wall at
// very fine meshes (R/t~330, Nt~50). This step lifts the EIGENVALUE wall; full R/t~330
// also needs the null-space sparsified (a later step). Reach here: nd ~ few x 10^4.
//
// Build: g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//   -I/opt/gismo/external test_bb_cylinder_lba_sparse.cpp -L/opt/gismo/build/lib -lgismo \
//   -Wl,-rpath,/opt/gismo/build/lib -o tcs && ./tcs 2>/dev/null
#include <gismo.h>
#include <gsSpectra/gsSpectra.h>
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
#include <chrono>
using namespace gismo;
using aeris::BBTriangleBasis; using aeris::BasisDerivs; using aeris::Bmat;
using aeris::analytic_B; using aeris::Geom; using aeris::V3; using aeris::dot3; using aeris::cross3;
using aeris::quad_triangle;
typedef gsSparseMatrix<real_t> SpMat; typedef gsEigen::Triplet<real_t> Trip;
static const double PI=3.14159265358979323846;
static const double R=1.0,L=1.0,E=1.0e6,nu=0.3;
// CLOSED-FORM metric-weighted KL constitutive (verified == gismo eval3D to 1e-16 in
// test_bb_material_closedform across axis/sheared/curved). No gismo machinery per call
// -> ~100x assembly speedup. A = membrane (Et/(1-nu^2)), D = (t^2/12) A; metric-weighted
// via the contravariant metric of (a1,a2). Voigt [11,22,12], factor 2 on shear strain.
static void eval3D_ABD(const V3<double>&a1,const V3<double>&a2,double thick,gsMatrix<real_t>&A,gsMatrix<real_t>&D){
    double a11=dot3(a1,a1),a22=dot3(a2,a2),a12=dot3(a1,a2),det=a11*a22-a12*a12;
    double c11=a22/det,c22=a11/det,c12=-a12/det,k0=E*thick/(1-nu*nu),h=(1-nu)/2.0;
    A.resize(3,3); D.resize(3,3);
    A(0,0)=k0*c11*c11; A(1,1)=k0*c22*c22;
    A(0,1)=A(1,0)=k0*(nu*c11*c22+(1-nu)*c12*c12);
    A(0,2)=A(2,0)=k0*c11*c12; A(1,2)=A(2,1)=k0*c22*c12;
    A(2,2)=k0*(nu*c12*c12+h*(c11*c22+c12*c12));
    double f=thick*thick/12.0; for(int i=0;i<3;++i)for(int j=0;j<3;++j)D(i,j)=f*A(i,j);}
static V3<double> cyl(double x,double th){ return {R*std::cos(th),R*std::sin(th),x}; }
static V3<double> radial(double th){ return {std::cos(th),std::sin(th),0.0}; }
struct Mode{ double sig; int m,n; };

static std::vector<Mode> run_lba(int Nx,int Nt,double thick,int p,int nmodes,int&out_nd,int&out_nF,double&t_asm,double&t_eig,bool&ok){
    BBTriangleBasis<double> B(p); int nK=B.size();
    int vc[3]={-1,-1,-1};for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];if(a[0]==p&&a[1]==0&&a[2]==0)vc[0]=k;if(a[0]==0&&a[1]==p&&a[2]==0)vc[1]=k;if(a[0]==0&&a[1]==0&&a[2]==p)vc[2]=k;}
    struct Tri{ std::array<std::array<double,2>,3> pv; std::vector<V3<double>> X; };
    std::vector<Tri> tris;
    auto pvert=[&](int i,int j){return std::array<double,2>{i*L/Nx,(2*PI)*j/Nt};};
    for(int i=0;i<Nx;++i)for(int j=0;j<Nt;++j){
        std::array<std::array<double,2>,3> A1={{pvert(i,j),pvert(i+1,j),pvert(i+1,j+1)}},A2={{pvert(i,j),pvert(i+1,j+1),pvert(i,j+1)}};
        for(auto&pv:{A1,A2}){ Tri T;T.pv=pv;T.X.resize(nK);
            for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];double px=(a[0]*pv[0][0]+a[1]*pv[1][0]+a[2]*pv[2][0])/p,pt=(a[0]*pv[0][1]+a[1]*pv[1][1]+a[2]*pv[2][1])/p;T.X[k]=cyl(px,pt);}tris.push_back(T);} }
    int nT=tris.size();
    std::vector<V3<double>> gpos;std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
    auto foa=[&](const V3<double>&P){for(size_t i=0;i<gpos.size();++i)if(std::hypot(std::hypot(gpos[i][0]-P[0],gpos[i][1]-P[1]),gpos[i][2]-P[2])<1e-9)return(int)i;gpos.push_back(P);return(int)gpos.size()-1;};
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(tris[k].X[a]);
    int nCP=gpos.size();
    auto baryParam=[&](const Tri&T,const std::array<double,2>&P){double a=T.pv[1][0]-T.pv[0][0],b=T.pv[2][0]-T.pv[0][0],c=T.pv[1][1]-T.pv[0][1],dd=T.pv[2][1]-T.pv[0][1],det=a*dd-b*c;double px=P[0]-T.pv[0][0],py=P[1]-T.pv[0][1];return std::array<double,2>{(dd*px-b*py)/det,(-c*px+a*py)/det};};
    struct EdgeRef{int tri,e,g0,g1;};std::map<std::pair<int,int>,std::vector<EdgeRef>> em;
    for(int k=0;k<nT;++k)for(int e=0;e<3;++e){int g0=gmap[k][vc[e]],g1=gmap[k][vc[(e+1)%3]];em[std::minmax(g0,g1)].push_back({k,e,g0,g1});}
    auto buildAsc=[&](){ std::vector<std::vector<double>> Asc;
        for(auto&kv:em){ if(kv.second.size()!=2)continue; const EdgeRef&M=kv.second[0],&S=kv.second[1];int gA=kv.first.first,gB=kv.first.second;
            for(int mm=0;mm<p;++mm){double s=(mm+1.0)/(p+1.0);std::vector<double> row(nCP,0.0);
                for(int side=0;side<2;++side){const EdgeRef&ER=(side==0?M:S);const Tri&T=tris[ER.tri];double sign=(side==0?1.0:-1.0);
                    std::array<double,2> Ae,Be;if(ER.g0==gA){Ae=T.pv[ER.e];Be=T.pv[(ER.e+1)%3];}else{Ae=T.pv[(ER.e+1)%3];Be=T.pv[ER.e];}
                    auto bcA=baryParam(T,Ae),bcB=baryParam(T,Be);std::array<double,2> bc={(1-s)*bcA[0]+s*bcB[0],(1-s)*bcA[1]+s*bcB[1]};
                    auto d=BasisDerivs::at(B,bc[0],bc[1]);Geom<double> G=Geom<double>::build(T.X,d);
                    std::array<double,2> Pp={(1-s)*Ae[0]+s*Be[0],(1-s)*Ae[1]+s*Be[1]};
                    double t1=bcB[0]-bcA[0],t2=bcB[1]-bcA[1];V3<double> AS{G.a1[0]*t1+G.a2[0]*t2,G.a1[1]*t1+G.a2[1]*t2,G.a1[2]*t1+G.a2[2]*t2};double an=std::sqrt(dot3(AS,AS));for(int i=0;i<3;++i)AS[i]/=an;
                    V3<double> A3a=radial(Pp[1]);V3<double> AN=cross3(A3a,AS);
                    double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;double r1=dot3(AN,G.a1),r2=dot3(AN,G.a2);double v1=(a22*r1-a12*r2)/det,v2=(-a12*r1+a11*r2)/det;
                    for(int k=0;k<nK;++k)row[gmap[ER.tri][k]]+=sign*(v1*d.N1[k]+v2*d.N2[k]);
                } Asc.push_back(row);
            } } return Asc; };
    auto nullsp=[&](const std::vector<std::vector<double>>&Ain,int nc,std::vector<int>&fcl,int&rank)->std::vector<std::vector<double>>{
        std::vector<std::vector<double>> Rm=Ain;int m=Rm.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
        for(int c=0;c<nc&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(Rm[r][c])>best){best=std::fabs(Rm[r][c]);pr=r;}if(pr<0)continue;std::swap(Rm[rr],Rm[pr]);double pv=Rm[rr][c];for(int j=0;j<nc;++j)Rm[rr][j]/=pv;for(int r=0;r<m;++r)if(r!=rr){double f=Rm[r][c];if(f!=0)for(int j=0;j<nc;++j)Rm[r][j]-=f*Rm[rr][j];}piv.push_back(c);++rr;}
        rank=piv.size();std::vector<char> ip(nc,0);for(int c:piv)ip[c]=1;fcl.clear();for(int c=0;c<nc;++c)if(!ip[c])fcl.push_back(c);int nFs=fcl.size();
        std::vector<std::vector<double>> Cs(nc,std::vector<double>(nFs,0.0));for(int f=0;f<nFs;++f){Cs[fcl[f]][f]=1;for(int i=0;i<rank;++i)Cs[piv[i]][f]=-Rm[i][fcl[f]];}return Cs;};
    std::vector<int> fcl0;int rank0;auto C0=nullsp(buildAsc(),nCP,fcl0,rank0);int nFs0=fcl0.size();
    std::vector<V3<double>> geomC1(nCP);
    for(int cp=0;cp<nCP;++cp)for(int c=0;c<3;++c){double s=0;for(int f=0;f<nFs0;++f)s+=C0[cp][f]*gpos[fcl0[f]][c];geomC1[cp][c]=s;}
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)tris[k].X[a]=geomC1[gmap[k][a]];
    auto Asc=buildAsc();int nd=3*nCP;out_nd=nd;
    std::vector<std::vector<double>> A3;
    for(auto&row:Asc)for(int i=0;i<3;++i){std::vector<double> r3(nd,0.0);for(int cp=0;cp<nCP;++cp)if(row[cp]!=0)r3[3*cp+i]=row[cp];A3.push_back(r3);}
    auto pin=[&](int cp,int comp){std::vector<double> r3(nd,0.0);r3[3*cp+comp]=1.0;A3.push_back(r3);};
    int firstEnd=-1;for(int cp=0;cp<nCP;++cp){double z=geomC1[cp][2];if(std::fabs(z)<1e-7||std::fabs(z-L)<1e-7){pin(cp,0);pin(cp,1);if(firstEnd<0)firstEnd=cp;}}
    if(firstEnd>=0)pin(firstEnd,2);
    std::vector<int> fcl;int rank;auto Cs=nullsp(A3,nd,fcl,rank);int nF=fcl.size();out_nF=nF;
    auto tA0=std::chrono::steady_clock::now();
    auto NOW=[](){return std::chrono::steady_clock::now();};
    auto SEC=[](auto a,auto b){return std::chrono::duration<double>(b-a).count();};
    // SPARSE C (nd x nF)
    SpMat C(nd,nF);{std::vector<Trip> tc;for(int row=0;row<nd;++row)for(int f=0;f<nF;++f)if(Cs[row][f]!=0)tc.emplace_back(row,f,Cs[row][f]);C.setFromTriplets(tc.begin(),tc.end());}  // Cs is already (nd x nF)
    auto tC=NOW();
    // SPARSE K_e, K_geom (uniform axial N_xx=1)
    std::vector<Trip> tF,tG; V3<double> tax{0,0,1};
    for(int k=0;k<nT;++k){const Tri&T=tris[k];
        for(auto&q:quad_triangle(2*p)){auto d=BasisDerivs::at(B,q.xi1,q.xi2);Geom<double> G=Geom<double>::build(T.X,d);
            gsMatrix<real_t> A,D;eval3D_ABD(G.a1,G.a2,thick,A,D);double Jac=G.jbar;Bmat Bm,Bb;analytic_B(T.X,d,Bm,Bb);
            double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12,ta1=dot3(tax,G.a1),ta2=dot3(tax,G.a2);
            double c1=(a22*ta1-a12*ta2)/det,c2=(a11*ta2-a12*ta1)/det;std::vector<double> g(nK);for(int a=0;a<nK;++a)g[a]=c1*d.N1[a]+c2*d.N2[a];
            for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*gmap[k][a]+i;
                for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*gmap[k][b]+j;
                    double v=0;for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s2=0;s2<3;++s2){Am+=A(r,s2)*Bm.at(s2,3*b+j);Dm+=D(r,s2)*Bb.at(s2,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                    tF.emplace_back(ga,gb,q.w*Jac*v); if(i==j)tG.emplace_back(ga,gb,q.w*Jac*g[a]*g[b]);}}
        }}
    SpMat Kf(nd,nd),Kg(nd,nd);Kf.setFromTriplets(tF.begin(),tF.end());Kg.setFromTriplets(tG.begin(),tG.end());
    auto tK=NOW();
    SpMat Ke=(C.transpose()*Kf*C); Ke.makeCompressed(); SpMat Kge=(C.transpose()*Kg*C); Kge.makeCompressed();
    auto tT=NOW();
    t_asm=SEC(tA0,tT);
    fprintf(stderr,"   [asm subphases] Cbuild=%.1f  Kassemble=%.1f  tripleProduct(C^T K C)=%.1f  | nnz(C)=%ld nnz(Kf)=%ld nnz(Ke)=%ld\n",
            SEC(tA0,tC),SEC(tC,tK),SEC(tK,tT),(long)C.nonZeros(),(long)Kf.nonZeros(),(long)Ke.nonZeros());
    // SPARSE Spectra Buckling: K_e x = lambda K_geom x ; smallest positive lambda = N_cr
    double sigma_cl=E*thick/(R*std::sqrt(3.0*(1-nu*nu)));double shift=0.8*sigma_cl*thick;   // BELOW the expected lowest (~0.9 sigma_cl) so shift-invert catches the true lowest cluster
    int nev=std::min(14,nF-1), ncv=std::min(3*nev,nF);
    auto tE0=std::chrono::steady_clock::now();
    std::vector<Mode> out;
    try{
        gsSpectraGenSymShiftSolver<SpMat,Spectra::GEigsMode::Buckling> solver(Ke,Kge,nev,ncv,shift);
        solver.compute(Spectra::SortRule::LargestMagn,1000,1e-10,Spectra::SortRule::SmallestMagn);
        ok = (solver.info()==Spectra::CompInfo::Successful);
        t_eig=std::chrono::duration<double>(std::chrono::steady_clock::now()-tE0).count();
        if(!ok) return out;
        gsMatrix<real_t> vals=solver.eigenvalues(), vecs=solver.eigenvectors();
        // grid + mode (m,n)
        const int NXS=9,NTS=33;std::vector<double> gx,gth;for(int ia=0;ia<NXS;++ia)for(int it=0;it<NTS;++it){gx.push_back(L*ia/(NXS-1));gth.push_back(2*PI*it/(NTS-1));}
        struct Loc{int tri;std::vector<double>N;double th;};std::vector<Loc> loc(gx.size());
        for(size_t s=0;s<gx.size();++s){std::array<double,2>P{gx[s],gth[s]};int f=-1;std::array<double,2>bc{};
            for(int k=0;k<nT;++k){auto b=baryParam(tris[k],P);double b0=1-b[0]-b[1];if(b[0]>=-1e-7&&b[1]>=-1e-7&&b0>=-1e-7){f=k;bc=b;break;}}
            Loc Lc;Lc.tri=f;Lc.th=gth[s];Lc.N.assign(nK,0.0);if(f>=0)for(int k=0;k<nK;++k)Lc.N[k]=B.eval_one(k,bc[0],bc[1]);loc[s]=Lc;}
        auto wavenums=[&](const std::vector<double>&w,int&m,int&n){double mx=0;for(double v:w)mx=std::max(mx,std::fabs(v));double tol=0.1*mx;
            n=0;for(int ia=0;ia<NXS;++ia){int sc=0;double pv=0;for(int it=0;it<NTS;++it){double v=w[ia*NTS+it];if(std::fabs(v)<tol)continue;if(pv!=0&&(v>0)!=(pv>0))++sc;pv=v;}n=std::max(n,sc);}
            m=0;for(int it=0;it<NTS;++it){int sc=0;double pv=0;for(int ia=0;ia<NXS;++ia){double v=w[ia*NTS+it];if(std::fabs(v)<tol)continue;if(pv!=0&&(v>0)!=(pv>0))++sc;pv=v;}m=std::max(m,sc);}};
        // sort eigenvalues ascending, take positives
        std::vector<int> idx;for(int i=0;i<vals.rows();++i)idx.push_back(i);
        std::sort(idx.begin(),idx.end(),[&](int a,int b){return vals(a,0)<vals(b,0);});
        for(int t : idx){ double lam=vals(t,0); if(!(lam>1e-9))continue;
            gsMatrix<real_t> uf=C*vecs.col(t);
            std::vector<double> w(gx.size(),0.0);
            for(size_t s=0;s<gx.size();++s){const Loc&Lc=loc[s];if(Lc.tri<0)continue;V3<double>rd=radial(Lc.th);double ww=0;for(int k=0;k<nK;++k){int cp=gmap[Lc.tri][k];ww+=Lc.N[k]*(uf(3*cp,0)*rd[0]+uf(3*cp+1,0)*rd[1]+uf(3*cp+2,0)*rd[2]);}w[s]=ww;}
            int mm,nn;wavenums(w,mm,nn);out.push_back({lam/thick,mm,nn}); if((int)out.size()>=nmodes)break; }
    }catch(...){ ok=false; t_eig=std::chrono::duration<double>(std::chrono::steady_clock::now()-tE0).count(); }
    return out;
}

int main(int argc,char**argv){
    int p=5,nmodes=8;
    printf("CLOSED cylinder axial LBA — SPARSE + Spectra Buckling.  read lowest CLUSTER + (m,n) vs sigma_cl.\n\n");
    // (t, Nx, Nt): finer Nt for thinner shells (n_cr~sqrt(R/t)). R/t=20 verifies vs dense.
    std::vector<std::array<int,3>> cases; // store as {R/t-ish, Nx, Nt} via t below
    std::vector<std::array<double,3>> runs = {{0.05,4,20},{0.05,5,24},{0.02,5,28},{0.01,6,40},{0.005,8,56}};
    if(argc>3) runs={{std::atof(argv[1]),(double)std::atoi(argv[2]),(double)std::atoi(argv[3])}};
    printf("  %5s %5s %4s %4s %8s %8s %9s %9s  %s\n","t","R/t","Nx","Nt","nd","nF","asm[s]","eig[s]","lowest cluster sigma/sigma_cl [m,n]");
    for(auto&rc:runs){ double thick=rc[0];int Nx=(int)rc[1],Nt=(int)rc[2];
        double sigma_cl=E*thick/(R*std::sqrt(3.0*(1-nu*nu)));
        int nd=0,nF=0;double ta=0,te=0;bool ok=false;
        auto modes=run_lba(Nx,Nt,thick,p,nmodes,nd,nF,ta,te,ok);
        printf("  %5g %5.0f %4d %4d %8d %8d %9.2f %9.2f  ",thick,R/thick,Nx,Nt,nd,nF,ta,te);
        if(!ok){printf("[Spectra FAILED]\n");continue;}
        for(size_t i=0;i<modes.size()&&i<5;++i)printf("[%.3f m%d n%d] ",modes[i].sig/sigma_cl,modes[i].m,modes[i].n);
        printf("\n");
    }
    printf("\nSparse Spectra lifts the eigenvalue wall (dense was ~nd 6000). R/t=20 must match the dense result\n");
    printf("(lowest cluster ~0.90-1.0 sigma_cl, critical [m0,n8]); higher R/t reachable until the dense C1 null-space\n");
    printf("becomes the next wall (then sparsify the null-space).\n");
    return 0;
}
