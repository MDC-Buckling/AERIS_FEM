// Cylinder axial LBA — SPARSE via C1 PENALTY (Aeris BB). gismo-linked (Spectra).
// Kills the dense-null-space bottleneck (Step 14 measured: triple product C^T Kf C = 201s
// because the null-space C is dense, ~1400 nnz/row). REPLACES the hard C1 congruence with
// the PENALTY C1 coupling (sparse additive kappa*A^T A, the Step-12-validated machinery) ->
// NO dense C, NO triple product: K_total = K_elastic + kappa*K_c1pen (sparse), solved
// directly by sparse Spectra Buckling. SS BC by hard DOF deletion. Verify vs hard-C1
// ([m0,n8]=0.90 at R/t=20), find the kappa plateau, measure the speedup.
// (Pass-1 geometry smoothing still uses the scalar null-space; smaller, sparsify later.)
//
// Build: g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//   -I/opt/gismo/external test_bb_cylinder_lba_penalty.cpp -L/opt/gismo/build/lib -lgismo \
//   -Wl,-rpath,/opt/gismo/build/lib -o tcp && ./tcp
#include <gismo.h>
#include <gsSpectra/gsSpectra.h>
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include "bb_kl_strains.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <map>
#include <cstdio>
#include <chrono>
using namespace gismo;
using aeris::BBTriangleBasis; using aeris::BasisDerivs; using aeris::Bmat;
using aeris::analytic_B; using aeris::Geom; using aeris::V3; using aeris::dot3; using aeris::cross3; using aeris::quad_triangle;
typedef gsSparseMatrix<real_t> SpMat; typedef gsEigen::Triplet<real_t> Trip;
static const double PI=3.14159265358979323846;
static const double R=1.0,L=1.0,E=1.0e6,nu=0.3;
// closed-form metric-weighted A,D (verified ==gismo eval3D to 1e-16, Step 14)
static void matAD(const V3<double>&a1,const V3<double>&a2,double thick,double A[3][3],double D[3][3]){
    double a11=dot3(a1,a1),a22=dot3(a2,a2),a12=dot3(a1,a2),det=a11*a22-a12*a12;
    double c11=a22/det,c22=a11/det,c12=-a12/det,k0=E*thick/(1-nu*nu),h=(1-nu)/2.0;
    A[0][0]=k0*c11*c11;A[1][1]=k0*c22*c22;A[0][1]=A[1][0]=k0*(nu*c11*c22+(1-nu)*c12*c12);
    A[0][2]=A[2][0]=k0*c11*c12;A[1][2]=A[2][1]=k0*c22*c12;A[2][2]=k0*(nu*c12*c12+h*(c11*c22+c12*c12));
    double f=thick*thick/12.0;for(int i=0;i<3;++i)for(int j=0;j<3;++j)D[i][j]=f*A[i][j];}
static V3<double> cyl(double x,double th){ return {R*std::cos(th),R*std::sin(th),x}; }
static V3<double> radial(double th){ return {std::cos(th),std::sin(th),0.0}; }
struct Mode{ double sig; int m,n; };

static std::vector<Mode> run(int Nx,int Nt,double thick,int p,int nmodes,double Pc1,int&out_nd,int&out_nfree,double&t_asm,double&t_eig,bool&ok){
    BBTriangleBasis<double> B(p); int nK=B.size();
    int vc[3]={-1,-1,-1};for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];if(a[0]==p&&a[1]==0&&a[2]==0)vc[0]=k;if(a[0]==0&&a[1]==p&&a[2]==0)vc[1]=k;if(a[0]==0&&a[1]==0&&a[2]==p)vc[2]=k;}
    struct Tri{ std::array<std::array<double,2>,3> pv; std::vector<V3<double>> X; };
    std::vector<Tri> tris;
    auto pvert=[&](int i,int j){return std::array<double,2>{i*L/Nx,(2*PI)*j/Nt};};
    for(int i=0;i<Nx;++i)for(int j=0;j<Nt;++j){std::array<std::array<double,2>,3> A1={{pvert(i,j),pvert(i+1,j),pvert(i+1,j+1)}},A2={{pvert(i,j),pvert(i+1,j+1),pvert(i,j+1)}};
        for(auto&pv:{A1,A2}){Tri T;T.pv=pv;T.X.resize(nK);for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];double px=(a[0]*pv[0][0]+a[1]*pv[1][0]+a[2]*pv[2][0])/p,pt=(a[0]*pv[0][1]+a[1]*pv[1][1]+a[2]*pv[2][1])/p;T.X[k]=cyl(px,pt);}tris.push_back(T);}}
    int nT=tris.size();
    std::vector<V3<double>> gpos;std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
    auto foa=[&](const V3<double>&P){for(size_t i=0;i<gpos.size();++i)if(std::hypot(std::hypot(gpos[i][0]-P[0],gpos[i][1]-P[1]),gpos[i][2]-P[2])<1e-9)return(int)i;gpos.push_back(P);return(int)gpos.size()-1;};
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(tris[k].X[a]);
    int nCP=gpos.size();
    auto baryParam=[&](const Tri&T,const std::array<double,2>&P){double a=T.pv[1][0]-T.pv[0][0],b=T.pv[2][0]-T.pv[0][0],c=T.pv[1][1]-T.pv[0][1],dd=T.pv[2][1]-T.pv[0][1],det=a*dd-b*c;double px=P[0]-T.pv[0][0],py=P[1]-T.pv[0][1];return std::array<double,2>{(dd*px-b*py)/det,(-c*px+a*py)/det};};
    struct EdgeRef{int tri,e,g0,g1;};std::map<std::pair<int,int>,std::vector<EdgeRef>> em;
    for(int k=0;k<nT;++k)for(int e=0;e<3;++e){int g0=gmap[k][vc[e]],g1=gmap[k][vc[(e+1)%3]];em[std::minmax(g0,g1)].push_back({k,e,g0,g1});}
    auto buildAsc=[&](){ std::vector<std::vector<double>> Asc;
        for(auto&kv:em){if(kv.second.size()!=2)continue;const EdgeRef&M=kv.second[0],&S=kv.second[1];int gA=kv.first.first,gB=kv.first.second;
            for(int mm=0;mm<p;++mm){double s=(mm+1.0)/(p+1.0);std::vector<double> row(nCP,0.0);
                for(int side=0;side<2;++side){const EdgeRef&ER=(side==0?M:S);const Tri&T=tris[ER.tri];double sign=(side==0?1.0:-1.0);
                    std::array<double,2> Ae,Be;if(ER.g0==gA){Ae=T.pv[ER.e];Be=T.pv[(ER.e+1)%3];}else{Ae=T.pv[(ER.e+1)%3];Be=T.pv[ER.e];}
                    auto bcA=baryParam(T,Ae),bcB=baryParam(T,Be);std::array<double,2> bc={(1-s)*bcA[0]+s*bcB[0],(1-s)*bcA[1]+s*bcB[1]};
                    auto d=BasisDerivs::at(B,bc[0],bc[1]);Geom<double> G=Geom<double>::build(T.X,d);std::array<double,2> Pp={(1-s)*Ae[0]+s*Be[0],(1-s)*Ae[1]+s*Be[1]};
                    double t1=bcB[0]-bcA[0],t2=bcB[1]-bcA[1];V3<double> AS{G.a1[0]*t1+G.a2[0]*t2,G.a1[1]*t1+G.a2[1]*t2,G.a1[2]*t1+G.a2[2]*t2};double an=std::sqrt(dot3(AS,AS));for(int i=0;i<3;++i)AS[i]/=an;
                    V3<double> A3a=radial(Pp[1]);V3<double> AN=cross3(A3a,AS);double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;double r1=dot3(AN,G.a1),r2=dot3(AN,G.a2);double v1=(a22*r1-a12*r2)/det,v2=(-a12*r1+a11*r2)/det;
                    for(int k=0;k<nK;++k)row[gmap[ER.tri][k]]+=sign*(v1*d.N1[k]+v2*d.N2[k]);
                }Asc.push_back(row);}}return Asc;};
    // pass-1 geometry smoothing — EXACT scalar null-space projection (accurate; the penalty
    // version is NOT robust [kappa_g too low under-smooths, too high over-conditions]). This
    // dense scalar Gauss is the remaining R/t>=200 bottleneck (next lever: accurate-sparse geom).
    auto nullsp=[&](const std::vector<std::vector<double>>&Ain,int nc,std::vector<int>&fcl,int&rank)->std::vector<std::vector<double>>{
        std::vector<std::vector<double>> Rm=Ain;int m=Rm.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
        for(int c=0;c<nc&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(Rm[r][c])>best){best=std::fabs(Rm[r][c]);pr=r;}if(pr<0)continue;std::swap(Rm[rr],Rm[pr]);double pv=Rm[rr][c];for(int j=0;j<nc;++j)Rm[rr][j]/=pv;for(int r=0;r<m;++r)if(r!=rr){double f=Rm[r][c];if(f!=0)for(int j=0;j<nc;++j)Rm[r][j]-=f*Rm[rr][j];}piv.push_back(c);++rr;}
        rank=piv.size();std::vector<char> ip(nc,0);for(int c:piv)ip[c]=1;fcl.clear();for(int c=0;c<nc;++c)if(!ip[c])fcl.push_back(c);int nF=fcl.size();
        std::vector<std::vector<double>> Cs(nc,std::vector<double>(nF,0.0));for(int f=0;f<nF;++f){Cs[fcl[f]][f]=1;for(int i=0;i<rank;++i)Cs[piv[i]][f]=-Rm[i][fcl[f]];}return Cs;};
    {std::vector<int> fcl0;int rank0;auto C0=nullsp(buildAsc(),nCP,fcl0,rank0);int nFs0=fcl0.size();
     std::vector<V3<double>> g1(nCP);for(int cp=0;cp<nCP;++cp)for(int c=0;c<3;++c){double s=0;for(int f=0;f<nFs0;++f)s+=C0[cp][f]*gpos[fcl0[f]][c];g1[cp][c]=s;}
     for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)tris[k].X[a]=g1[gmap[k][a]]; for(int cp=0;cp<nCP;++cp)gpos[cp]=g1[cp]; }
    auto tA0=std::chrono::steady_clock::now();
    int nd=3*nCP;out_nd=nd;
    // K_elastic + K_geom (uniform axial N_xx=1) + C1 PENALTY, all sparse
    std::vector<Trip> tK,tG; V3<double> tax{0,0,1};
    for(int k=0;k<nT;++k){const Tri&T=tris[k];
        for(auto&q:quad_triangle(2*p)){auto d=BasisDerivs::at(B,q.xi1,q.xi2);Geom<double> G=Geom<double>::build(T.X,d);
            double A[3][3],D[3][3];matAD(G.a1,G.a2,thick,A,D);double Jac=G.jbar;Bmat Bm,Bb;analytic_B(T.X,d,Bm,Bb);
            double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12,ta1=dot3(tax,G.a1),ta2=dot3(tax,G.a2);
            double c1=(a22*ta1-a12*ta2)/det,c2=(a11*ta2-a12*ta1)/det;std::vector<double> g(nK);for(int a=0;a<nK;++a)g[a]=c1*d.N1[a]+c2*d.N2[a];
            for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*gmap[k][a]+i;
                for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*gmap[k][b]+j;
                    double v=0;for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s2=0;s2<3;++s2){Am+=A[r][s2]*Bm.at(s2,3*b+j);Dm+=D[r][s2]*Bb.at(s2,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                    tK.emplace_back(ga,gb,q.w*Jac*v);if(i==j)tG.emplace_back(ga,gb,q.w*Jac*g[a]*g[b]);}}
        }}
    // C1 penalty: kappa * row^T row (block per component), local per edge -> sparse
    double kappa = Pc1 * (E*thick*thick*thick/12.0) / L;
    auto Asc=buildAsc();
    for(auto&row:Asc){ std::vector<std::pair<int,double>> nz; for(int cp=0;cp<nCP;++cp)if(row[cp]!=0)nz.push_back({cp,row[cp]});
        for(auto&pa:nz)for(auto&pb:nz)for(int i=0;i<3;++i)tK.emplace_back(3*pa.first+i,3*pb.first+i,kappa*pa.second*pb.second); }
    SpMat K(nd,nd),Kg(nd,nd);K.setFromTriplets(tK.begin(),tK.end());Kg.setFromTriplets(tG.begin(),tG.end());
    // SS BC: pin end-CP radial+circ (=x,y) + one axial; build free-DOF list, extract submatrices
    std::vector<char> pinned(nd,0);int firstEnd=-1;
    for(int cp=0;cp<nCP;++cp){double z=gpos[cp][2];if(std::fabs(z)<1e-7||std::fabs(z-L)<1e-7){pinned[3*cp+0]=1;pinned[3*cp+1]=1;if(firstEnd<0)firstEnd=cp;}}
    if(firstEnd>=0)pinned[3*firstEnd+2]=1;
    std::vector<int> remap(nd,-1);int nfree=0;for(int i=0;i<nd;++i)if(!pinned[i])remap[i]=nfree++;out_nfree=nfree;
    auto sub=[&](const SpMat&Mm){std::vector<Trip> t;for(int c=0;c<Mm.outerSize();++c)for(SpMat::InnerIterator it(Mm,c);it;++it){int r=it.row(),cc=it.col();if(remap[r]>=0&&remap[cc]>=0)t.emplace_back(remap[r],remap[cc],it.value());}SpMat S(nfree,nfree);S.setFromTriplets(t.begin(),t.end());S.makeCompressed();return S;};
    SpMat Kfree=sub(K),Kgfree=sub(Kg);
    t_asm=std::chrono::duration<double>(std::chrono::steady_clock::now()-tA0).count();
    double sigma_cl=E*thick/(R*std::sqrt(3.0*(1-nu*nu)));double shift=0.8*sigma_cl*thick;
    int nev=std::min(14,nfree-1),ncv=std::min(3*nev,nfree);
    auto tE0=std::chrono::steady_clock::now();std::vector<Mode> out;
    try{
        gsSpectraGenSymShiftSolver<SpMat,Spectra::GEigsMode::Buckling> solver(Kfree,Kgfree,nev,ncv,shift);
        solver.compute(Spectra::SortRule::LargestMagn,1000,1e-10,Spectra::SortRule::SmallestMagn);
        ok=(solver.info()==Spectra::CompInfo::Successful);t_eig=std::chrono::duration<double>(std::chrono::steady_clock::now()-tE0).count();
        if(!ok)return out;
        gsMatrix<real_t> vals=solver.eigenvalues(),vecs=solver.eigenvectors();
        const int NXS=9,NTS=33;std::vector<double> gx,gth;for(int ia=0;ia<NXS;++ia)for(int it=0;it<NTS;++it){gx.push_back(L*ia/(NXS-1));gth.push_back(2*PI*it/(NTS-1));}
        struct Loc{int tri;std::vector<double>N;double th;};std::vector<Loc> loc(gx.size());
        for(size_t s=0;s<gx.size();++s){std::array<double,2>P{gx[s],gth[s]};int f=-1;std::array<double,2>bc{};for(int k=0;k<nT;++k){auto b=baryParam(tris[k],P);double b0=1-b[0]-b[1];if(b[0]>=-1e-7&&b[1]>=-1e-7&&b0>=-1e-7){f=k;bc=b;break;}}
            Loc Lc;Lc.tri=f;Lc.th=gth[s];Lc.N.assign(nK,0.0);if(f>=0)for(int k=0;k<nK;++k)Lc.N[k]=B.eval_one(k,bc[0],bc[1]);loc[s]=Lc;}
        auto wavenums=[&](const std::vector<double>&w,int&m,int&n){double mx=0;for(double v:w)mx=std::max(mx,std::fabs(v));double tol=0.1*mx;
            n=0;for(int ia=0;ia<NXS;++ia){int sc=0;double pv=0;for(int it=0;it<NTS;++it){double v=w[ia*NTS+it];if(std::fabs(v)<tol)continue;if(pv!=0&&(v>0)!=(pv>0))++sc;pv=v;}n=std::max(n,sc);}
            m=0;for(int it=0;it<NTS;++it){int sc=0;double pv=0;for(int ia=0;ia<NXS;++ia){double v=w[ia*NTS+it];if(std::fabs(v)<tol)continue;if(pv!=0&&(v>0)!=(pv>0))++sc;pv=v;}m=std::max(m,sc);}};
        std::vector<int> idx;for(int i=0;i<vals.rows();++i)idx.push_back(i);std::sort(idx.begin(),idx.end(),[&](int a,int b){return vals(a,0)<vals(b,0);});
        for(int t:idx){double lam=vals(t,0);if(!(lam>1e-9))continue;
            std::vector<double> uf(nd,0.0);for(int i=0;i<nd;++i)if(remap[i]>=0)uf[i]=vecs(remap[i],t);
            std::vector<double> w(gx.size(),0.0);for(size_t s=0;s<gx.size();++s){const Loc&Lc=loc[s];if(Lc.tri<0)continue;V3<double>rd=radial(Lc.th);double ww=0;for(int k=0;k<nK;++k){int cp=gmap[Lc.tri][k];ww+=Lc.N[k]*(uf[3*cp]*rd[0]+uf[3*cp+1]*rd[1]+uf[3*cp+2]*rd[2]);}w[s]=ww;}
            int mm,nn;wavenums(w,mm,nn);out.push_back({lam/thick,mm,nn});if((int)out.size()>=nmodes)break;}
    }catch(...){ok=false;t_eig=std::chrono::duration<double>(std::chrono::steady_clock::now()-tE0).count();}
    return out;
}

int main(int argc,char**argv){
    int p=5,nmodes=8;double thick=0.05;int Nx=4,Nt=20;
    double sigma_cl=E*thick/(R*std::sqrt(3.0*(1-nu*nu)));
    printf("Cylinder LBA via C1 PENALTY (sparse, no dense null-space). R/t=20, vs hard-C1 [m0,n8]=0.90.\n");
    printf("kappa-sweep: find where the penalty cluster matches hard-C1 (P too low: spurious low C1-violation modes).\n\n");
    printf("  %8s %7s %7s %8s %8s  %s\n","Pc1","nd","nfree","asm[s]","eig[s]","lowest cluster sigma/sigma_cl [m,n]");
    std::vector<double> Ps = {1e3,1e4,1e5,1e6,1e7};
    if(argc>1){Ps={std::atof(argv[1])}; if(argc>3){Nx=std::atoi(argv[2]);Nt=std::atoi(argv[3]);}}
    for(double Pc1:Ps){int nd=0,nf=0;double ta=0,te=0;bool ok=false;
        auto modes=run(Nx,Nt,thick,p,nmodes,Pc1,nd,nf,ta,te,ok);
        printf("  %8.0e %7d %7d %8.2f %8.2f  ",Pc1,nd,nf,ta,te);
        if(!ok){printf("[Spectra FAILED]\n");continue;}
        for(size_t i=0;i<modes.size()&&i<5;++i)printf("[%.3f m%d n%d] ",modes[i].sig/sigma_cl,modes[i].m,modes[i].n);printf("\n");
    }
    printf("\nNo dense C / no triple product: asm should be ~Kassemble (~2s) not 200s. Cluster must match hard-C1.\n");
    return 0;
}
