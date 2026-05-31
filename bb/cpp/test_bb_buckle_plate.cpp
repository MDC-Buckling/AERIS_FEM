// Cylinder step 3a: geometric stiffness K_geom + eigenvalue machinery, isolated
// on a FLAT sturm-frei buckling problem with a known answer (Aeris BB). gismo-linked
// (uses gsEigen GeneralizedSelfAdjointEigenSolver). D_cart shifter-free == eval3D.
//
// SS square plate, uniaxial reference compression N_x=1 -> geometric stiffness
//   K_g[a][b] = int (dN_a/dx)(dN_b/dx)  (the prestress softening of out-of-plane w)
// Buckling: K_e v = lambda K_g v, smallest lambda = N_cr. Classical (Bryan):
//   N_cr = 4 pi^2 D / L^2  (square, simply supported, uniaxial, k=4).
// Flat plate => sturm-frei (no locking/curvature) => isolates K_geom + the
// generalized eigensolver + the C1 pipeline before the curved cylinder.
#include <gismo.h>
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <map>
using namespace gismo;
using aeris::BBTriangleBasis; using aeris::quad_triangle;
using V3=std::array<double,3>; using V2=std::array<double,2>;
static const double PI=3.14159265358979323846;

static int idx_of(int q,int i,int j){int n=0;for(int ii=q;ii>=0;--ii)for(int jj=q-ii;jj>=0;--jj){if(ii==i&&jj==j)return n;++n;}return -1;}
static std::vector<V3> fcps(const BBTriangleBasis<double>&B,const V3&V0,const V3&V1,const V3&V2){std::vector<V3> X(B.size());double p=B.degree();
    for(int k=0;k<B.size();++k){const auto&a=B.alpha()[k];for(int c=0;c<3;++c)X[k][c]=(a[0]*V0[c]+a[1]*V1[c]+a[2]*V2[c])/p;}return X;}
static V2 bary_xy(const V3&W0,const V3&W1,const V3&W2,const V2&P){double a=W1[0]-W0[0],b=W2[0]-W0[0],c=W1[1]-W0[1],d=W2[1]-W0[1],det=a*d-b*c,px=P[0]-W0[0],py=P[1]-W0[1];return {(d*px-b*py)/det,(-c*px+a*py)/det};}
static V2 gradN_phys(const BBTriangleBasis<double>&B,int k,double x1,double x2,const V3&A1,const V3&A2){auto g=B.deriv_one(k,x1,x2);double a=A1[0],b=A2[0],c=A1[1],d=A2[1],det=a*d-b*c;return {(d*g[0]-c*g[1])/det,(-b*g[0]+a*g[1])/det};}
static std::array<double,3> curvN(const BBTriangleBasis<double>&B,int k,double x1,double x2,const V3&A1,const V3&A2){
    auto h=B.deriv2_one(k,x1,x2);double a=A1[0],b=A2[0],c=A1[1],d=A2[1],det=a*d-b*c;
    double i00=d/det,i01=-b/det,i10=-c/det,i11=a/det,H00=h[0],H11=h[1],H01=h[2];
    auto hp=[&](double c0,double c1,double y0,double y1){return (c0*H00+c1*H01)*y0+(c0*H01+c1*H11)*y1;};
    return {hp(i00,i10,i00,i10),hp(i01,i11,i01,i11),2*hp(i00,i10,i01,i11)};}

struct Mesh{std::vector<std::array<V3,3>> tris;};
static Mesh square_mesh(double L,int N){Mesh m;auto V=[&](int i,int j){return V3{i*L/N,j*L/N,0};};
    for(int i=0;i<N;++i)for(int j=0;j<N;++j){m.tris.push_back({V(i,j),V(i+1,j),V(i+1,j+1)});m.tris.push_back({V(i,j),V(i+1,j+1),V(i,j+1)});}return m;}

int main(){
    const double L=1.0,t=0.01,E=1.0e6,nu=0.3;
    double Dp=E*t*t*t/(12*(1-nu*nu));
    std::array<std::array<double,3>,3> Dc={{{Dp,Dp*nu,0},{Dp*nu,Dp,0},{0,0,Dp*(1-nu)/2}}};
    double Ncr=4*PI*PI*Dp/(L*L);
    int p=5; BBTriangleBasis<double> B(p); int nK=B.size();
    printf("SS square plate uniaxial buckling: classical N_cr = 4 pi^2 D/L^2 = %.8g  (p=%d)\n\n",Ncr,p);
    printf("  %4s %6s %14s %12s %8s\n","N","DOF","N_cr(FE)","rel.err","rate");
    double ph=0,pe=0;bool first=true;
    for(int N:{2,3,4,5}){
        Mesh M=square_mesh(L,N);
        // DOF map
        std::vector<V2> pos;std::vector<std::vector<int>> gmap(M.tris.size(),std::vector<int>(nK));
        std::vector<std::vector<V3>> X(M.tris.size());
        for(size_t k=0;k<M.tris.size();++k)X[k]=fcps(B,M.tris[k][0],M.tris[k][1],M.tris[k][2]);
        auto foa=[&](const V3&P){for(size_t i=0;i<pos.size();++i)if(std::hypot(pos[i][0]-P[0],pos[i][1]-P[1])<1e-9)return(int)i;pos.push_back({P[0],P[1]});return(int)pos.size()-1;};
        for(size_t k=0;k<M.tris.size();++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(X[k][a]);
        int nCP=pos.size();
        // C1 constraints (interior edges) + SS w=0 boundary
        std::vector<std::vector<double>> A;
        auto vkey=[&](const V3&p){return std::make_pair((long long)llround(p[0]*1e7),(long long)llround(p[1]*1e7));};
        std::map<std::pair<std::pair<long long,long long>,std::pair<long long,long long>>,std::vector<int>> em;
        for(size_t k=0;k<M.tris.size();++k){const auto&T=M.tris[k];for(int e=0;e<3;++e){auto a=vkey(T[e]),b=vkey(T[(e+1)%3]);if(b<a)std::swap(a,b);em[{a,b}].push_back((int)k);}}
        for(auto&kv:em){if(kv.second.size()!=2)continue;int mt=kv.second[0],st=kv.second[1];
            std::vector<V3> sh;for(auto&Wm:M.tris[mt])for(auto&Ws:M.tris[st])if(std::hypot(Wm[0]-Ws[0],Wm[1]-Ws[1])<1e-9)sh.push_back(Wm);
            V3 Va=sh[0],Vb=sh[1];auto tang=[&](int tt,V3&A1,V3&A2){const auto&T=M.tris[tt];A1={T[1][0]-T[0][0],T[1][1]-T[0][1],0};A2={T[2][0]-T[0][0],T[2][1]-T[0][1],0};};
            V3 A1m,A2m,A1s,A2s;tang(mt,A1m,A2m);tang(st,A1s,A2s);
            V3 sap{0,0,0};for(auto&W:M.tris[st])if(std::hypot(W[0]-Va[0],W[1]-Va[1])>1e-9&&std::hypot(W[0]-Vb[0],W[1]-Vb[1])>1e-9)sap=W;
            V2 tt{Vb[0]-Va[0],Vb[1]-Va[1]};double tn=std::hypot(tt[0],tt[1]);tt={tt[0]/tn,tt[1]/tn};V2 nu2{tt[1],-tt[0]};V2 emid{0.5*(Va[0]+Vb[0]),0.5*(Va[1]+Vb[1])};
            if(nu2[0]*(sap[0]-emid[0])+nu2[1]*(sap[1]-emid[1])<0){nu2[0]=-nu2[0];nu2[1]=-nu2[1];}
            for(int mm=0;mm<p;++mm){double s=(mm+1.0)/(p+1.0);V2 Pm{(1-s)*Va[0]+s*Vb[0],(1-s)*Va[1]+s*Vb[1]};std::vector<double> row(nCP,0.0);
                V2 bm=bary_xy(M.tris[mt][0],M.tris[mt][1],M.tris[mt][2],Pm);for(int a=0;a<nK;++a){V2 g=gradN_phys(B,a,bm[0],bm[1],A1m,A2m);row[gmap[mt][a]]+=g[0]*nu2[0]+g[1]*nu2[1];}
                V2 bs=bary_xy(M.tris[st][0],M.tris[st][1],M.tris[st][2],Pm);for(int a=0;a<nK;++a){V2 g=gradN_phys(B,a,bs[0],bs[1],A1s,A2s);row[gmap[st][a]]-=g[0]*nu2[0]+g[1]*nu2[1];}
                A.push_back(row);}}
        for(int c=0;c<nCP;++c){double x=pos[c][0],y=pos[c][1];if(std::fabs(x)<1e-9||std::fabs(x-L)<1e-9||std::fabs(y)<1e-9||std::fabs(y-L)<1e-9){std::vector<double> row(nCP,0.0);row[c]=1;A.push_back(row);}}
        // null space C
        std::vector<std::vector<double>> R=A;int m=R.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
        for(int c=0;c<nCP&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(R[r][c])>best){best=std::fabs(R[r][c]);pr=r;}if(pr<0)continue;std::swap(R[rr],R[pr]);double pv=R[rr][c];for(int j=0;j<nCP;++j)R[rr][j]/=pv;for(int r=0;r<m;++r)if(r!=rr){double f=R[r][c];if(f!=0)for(int j=0;j<nCP;++j)R[r][j]-=f*R[rr][j];}piv.push_back(c);++rr;}
        int rank=piv.size();std::vector<char> ip(nCP,0);for(int c:piv)ip[c]=1;std::vector<int> fcl;for(int c=0;c<nCP;++c)if(!ip[c])fcl.push_back(c);int nF=fcl.size();
        std::vector<std::vector<double>> C(nCP,std::vector<double>(nF,0.0));for(int f=0;f<nF;++f){C[fcl[f]][f]=1;for(int i=0;i<rank;++i)C[piv[i]][f]=-R[i][fcl[f]];}
        // K_e (bending) and K_g ( int (dN/dx)^2 )
        std::vector<std::vector<double>> Ke(nCP,std::vector<double>(nCP,0.0)),Kg(nCP,std::vector<double>(nCP,0.0));
        for(size_t k=0;k<M.tris.size();++k){const auto&T=M.tris[k];V3 A1{T[1][0]-T[0][0],T[1][1]-T[0][1],0},A2{T[2][0]-T[0][0],T[2][1]-T[0][1],0};
            double Jac=std::fabs(A1[0]*A2[1]-A1[1]*A2[0]);
            for(auto&q:quad_triangle(2*p)){std::vector<std::array<double,3>> Bc(nK);std::vector<V2> gx(nK);
                for(int a=0;a<nK;++a){Bc[a]=curvN(B,a,q.xi1,q.xi2,A1,A2);gx[a]=gradN_phys(B,a,q.xi1,q.xi2,A1,A2);}
                double wq=q.w*Jac;
                for(int a=0;a<nK;++a){int ga=gmap[k][a];std::array<double,3> Da={Dc[0][0]*Bc[a][0]+Dc[0][1]*Bc[a][1],Dc[1][0]*Bc[a][0]+Dc[1][1]*Bc[a][1],Dc[2][2]*Bc[a][2]};
                    for(int b=0;b<nK;++b){int gb=gmap[k][b];Ke[ga][gb]+=wq*(Bc[b][0]*Da[0]+Bc[b][1]*Da[1]+Bc[b][2]*Da[2]);Kg[ga][gb]+=wq*gx[a][0]*gx[b][0];}}}}
        // reduce: Ke_r=C^T Ke C, Kg_r=C^T Kg C
        typedef gsEigen::Matrix<real_t,gsEigen::Dynamic,gsEigen::Dynamic> EMat;
        auto reduce=[&](std::vector<std::vector<double>>&K){EMat Kr(nF,nF);std::vector<std::vector<double>> KC(nCP,std::vector<double>(nF,0.0));
            for(int i=0;i<nCP;++i)for(int f=0;f<nF;++f){double s=0;for(int j=0;j<nCP;++j)s+=K[i][j]*C[j][f];KC[i][f]=s;}
            for(int a=0;a<nF;++a)for(int b=0;b<nF;++b){double s=0;for(int i=0;i<nCP;++i)s+=C[i][a]*KC[i][b];Kr(a,b)=s;}return Kr;};
        EMat Ker=reduce(Ke),Kgr=reduce(Kg);
        // generalized eig: Kg v = mu Ke v (Ke PD) -> lambda = 1/mu_max
        gsEigen::GeneralizedSelfAdjointEigenSolver<EMat> ges(Kgr,Ker);
        double mumax=ges.eigenvalues()(nF-1); double lam=1.0/mumax;
        double err=std::fabs(lam-Ncr)/Ncr;double logh=std::log(L/N),loge=std::log(err);
        double rate=first?0:(loge-pe)/(logh-ph);
        printf("  %4d %6d %14.8g %12.3e %8.3f\n",N,nF,lam,err,first?0.0:rate);
        ph=logh;pe=loge;first=false;
    }
    printf("\nFlat sturm-frei => clean convergence validates K_geom + generalized eigensolver + C1 pipeline.\n");
    return 0;
}
