// Phase-4 step 4+5: C1 patch consistency + multi-triangle SS-plate convergence
// (Aeris BB). THE Phase-4 gate. Pure C++ / no gismo (D_cart == eval3D proven in
// test_bb_Ke K4; flat plate is sturm-frei: no shear/membrane locking, polynomial
// integrand exactly integrated by Duffy -> the convergence RATE measures the C1
// coupling's approximation quality directly).
// Build: g++ -std=c++17 -O2 test_bb_c1_plate.cpp -o t && ./t
//
//  Patch (consistency): a global quadratic (constant-curvature) field satisfies
//    all C1 constraints (||A_C1 u_quad|| ~ 0) -> the C1 space contains const
//    curvature = necessary for convergence (no seam exclusion).
//  Plate (optimality = THE gate): square SS plate, sinusoidal load (= 1st Navier
//    mode, exact w known), h-refinement. Report the displacement convergence RATE
//    (slope of log|err| vs log h). Optimal = O(h^(p+1)). Sub-optimal on this
//    sturm-frei problem => points at the coupling.
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <cstdio>
#include <functional>
#include <map>

using namespace aeris;
using V3=std::array<double,3>; using V2=std::array<double,2>;
static const double PI=3.14159265358979323846;

static int idx_of(int q,int i,int j){int n=0;for(int ii=q;ii>=0;--ii)for(int jj=q-ii;jj>=0;--jj){if(ii==i&&jj==j)return n;++n;}return -1;}
static std::vector<double> elevate(const std::vector<double>&cq,int q){auto id1=multi_indices(q+1);std::vector<double> c1(id1.size(),0.0);
    for(size_t a=0;a<id1.size();++a){int i=id1[a][0],j=id1[a][1],k=id1[a][2];double v=0;if(i>0)v+=i*cq[idx_of(q,i-1,j)];if(j>0)v+=j*cq[idx_of(q,i,j-1)];if(k>0)v+=k*cq[idx_of(q,i,j)];c1[a]=v/(q+1);}return c1;}
static std::vector<double> quad_coefs(int p,std::function<double(double,double)> f,const V3&A,const V3&B,const V3&C){
    auto P=[&](double l0,double l1,double l2){return V2{l0*A[0]+l1*B[0]+l2*C[0],l0*A[1]+l1*B[1]+l2*C[1]};};auto fv=[&](V2 q){return f(q[0],q[1]);};
    double c200=fv(P(1,0,0)),c020=fv(P(0,1,0)),c002=fv(P(0,0,1));double c110=2*fv(P(.5,.5,0))-.5*c200-.5*c020,c101=2*fv(P(.5,0,.5))-.5*c200-.5*c002,c011=2*fv(P(0,.5,.5))-.5*c020-.5*c002;
    std::vector<double> c={c200,c110,c101,c020,c011,c002};for(int q=2;q<p;++q)c=elevate(c,q);return c;}
static std::vector<V3> fcps(const BBTriangleBasis<double>&B,const V3&V0,const V3&V1,const V3&V2){std::vector<V3> X(B.size());double p=B.degree();
    for(int k=0;k<B.size();++k){const auto&a=B.alpha()[k];for(int c=0;c<3;++c)X[k][c]=(a[0]*V0[c]+a[1]*V1[c]+a[2]*V2[c])/p;}return X;}
static V2 bary_xy(const V3&W0,const V3&W1,const V3&W2,const V2&P){double a=W1[0]-W0[0],b=W2[0]-W0[0],c=W1[1]-W0[1],d=W2[1]-W0[1],det=a*d-b*c,px=P[0]-W0[0],py=P[1]-W0[1];return {(d*px-b*py)/det,(-c*px+a*py)/det};}
static V2 gradN_phys(const BBTriangleBasis<double>&B,int k,double x1,double x2,const V3&A1,const V3&A2){auto g=B.deriv_one(k,x1,x2);double a=A1[0],b=A2[0],c=A1[1],d=A2[1],det=a*d-b*c;return {(d*g[0]-c*g[1])/det,(-b*g[0]+a*g[1])/det};}
// physical curvature Voigt [w,xx; w,yy; 2 w,xy] of basis fn k (affine: J const)
static std::array<double,3> curvN(const BBTriangleBasis<double>&B,int k,double x1,double x2,const V3&A1,const V3&A2){
    auto h=B.deriv2_one(k,x1,x2); double a=A1[0],b=A2[0],c=A1[1],d=A2[1],det=a*d-b*c;
    // Jinv = 1/det [[d,-b],[-c,a]]; Hphys = Jinv^T Hpar Jinv ; Hpar=[[h0,h2],[h2,h1]]
    double i00=d/det,i01=-b/det,i10=-c/det,i11=a/det; // Jinv rows
    double H00=h[0],H11=h[1],H01=h[2];
    // Hphys = Jinv^T H Jinv ; columns of Jinv: col0=(i00,i10), col1=(i01,i11)
    auto hp=[&](double cx0,double cx1,double cy0,double cy1){return (cx0*H00+cx1*H01)*cy0+(cx0*H01+cx1*H11)*cy1;};
    double pxx=hp(i00,i10,i00,i10), pyy=hp(i01,i11,i01,i11), pxy=hp(i00,i10,i01,i11);
    return {pxx,pyy,2*pxy};
}
// dense LU solve A x = b (n x n), partial pivot
static bool lusolve(std::vector<std::vector<double>> A,std::vector<double> b,std::vector<double>&x,int n){
    std::vector<int> pr(n);for(int i=0;i<n;++i)pr[i]=i;
    for(int c=0;c<n;++c){int p=c;double best=std::fabs(A[c][c]);for(int r=c+1;r<n;++r)if(std::fabs(A[r][c])>best){best=std::fabs(A[r][c]);p=r;}
        if(best<1e-300)return false; std::swap(A[c],A[p]);std::swap(b[c],b[p]);
        for(int r=c+1;r<n;++r){double f=A[r][c]/A[c][c];for(int j=c;j<n;++j)A[r][j]-=f*A[c][j];b[r]-=f*b[c];}}
    x.assign(n,0);for(int i=n-1;i>=0;--i){double s=b[i];for(int j=i+1;j<n;++j)s-=A[i][j]*x[j];x[i]=s/A[i][i];}return true;}

struct Mesh{ std::vector<std::array<V3,3>> tris; };
static Mesh square_mesh(double L,int N){ Mesh m;
    auto V=[&](int i,int j){return V3{i*L/N,j*L/N,0};};
    for(int i=0;i<N;++i)for(int j=0;j<N;++j){ m.tris.push_back({V(i,j),V(i+1,j),V(i+1,j+1)}); m.tris.push_back({V(i,j),V(i+1,j+1),V(i,j+1)});}
    return m; }

// build global DOF map + C1 constraint matrix A (incl optional w=0 boundary) + K_full + f
struct Sys{ int nCP; std::vector<V2> pos; std::vector<std::vector<int>> gmap;
            std::vector<std::vector<double>> Ac1; };
static Sys build(const Mesh&M,int p,const BBTriangleBasis<double>&B,double L,bool ssbc){
    int nK=B.size(); Sys S; std::vector<std::vector<V3>> X(M.tris.size());
    for(size_t k=0;k<M.tris.size();++k)X[k]=fcps(B,M.tris[k][0],M.tris[k][1],M.tris[k][2]);
    S.gmap.assign(M.tris.size(),std::vector<int>(nK));
    auto foa=[&](const V3&P){for(size_t i=0;i<S.pos.size();++i)if(std::hypot(S.pos[i][0]-P[0],S.pos[i][1]-P[1])<1e-9)return(int)i;S.pos.push_back({P[0],P[1]});return(int)S.pos.size()-1;};
    for(size_t k=0;k<M.tris.size();++k)for(int a=0;a<nK;++a)S.gmap[k][a]=foa(X[k][a]);
    S.nCP=S.pos.size();
    // interior edges: map edge(vertex-pair by rounded pos) -> tri list
    auto vkey=[&](const V3&p){long long xi=llround(p[0]*1e7),yi=llround(p[1]*1e7);return std::make_pair(xi,yi);};
    std::map<std::pair<std::pair<long long,long long>,std::pair<long long,long long>>,std::vector<int>> em;
    for(size_t k=0;k<M.tris.size();++k){const auto&T=M.tris[k];
        for(int e=0;e<3;++e){auto a=vkey(T[e]),b=vkey(T[(e+1)%3]);if(b<a)std::swap(a,b);em[{a,b}].push_back((int)k);}}
    // per interior edge -> C1 constraint rows
    for(auto&kv:em){ if(kv.second.size()!=2)continue; int mt=kv.second[0],st=kv.second[1];
        // shared physical verts
        std::vector<V3> shared; for(auto&Wm:M.tris[mt])for(auto&Ws:M.tris[st])if(std::hypot(Wm[0]-Ws[0],Wm[1]-Ws[1])<1e-9)shared.push_back(Wm);
        V3 Va=shared[0],Vb=shared[1];
        auto tang=[&](int tt,V3&A1,V3&A2){const auto&T=M.tris[tt];A1={T[1][0]-T[0][0],T[1][1]-T[0][1],0};A2={T[2][0]-T[0][0],T[2][1]-T[0][1],0};};
        V3 A1m,A2m,A1s,A2s;tang(mt,A1m,A2m);tang(st,A1s,A2s);
        V3 sap{0,0,0};for(auto&W:M.tris[st])if(std::hypot(W[0]-Va[0],W[1]-Va[1])>1e-9&&std::hypot(W[0]-Vb[0],W[1]-Vb[1])>1e-9)sap=W;
        V2 t{Vb[0]-Va[0],Vb[1]-Va[1]};double tn=std::hypot(t[0],t[1]);t={t[0]/tn,t[1]/tn};V2 nu{t[1],-t[0]};V2 em2{0.5*(Va[0]+Vb[0]),0.5*(Va[1]+Vb[1])};
        if(nu[0]*(sap[0]-em2[0])+nu[1]*(sap[1]-em2[1])<0){nu[0]=-nu[0];nu[1]=-nu[1];}
        for(int mm=0;mm<p;++mm){double s=(mm+1.0)/(p+1.0);V2 Pm{(1-s)*Va[0]+s*Vb[0],(1-s)*Va[1]+s*Vb[1]};
            std::vector<double> row(S.nCP,0.0);
            V2 bm=bary_xy(M.tris[mt][0],M.tris[mt][1],M.tris[mt][2],Pm);
            for(int a=0;a<nK;++a){V2 g=gradN_phys(B,a,bm[0],bm[1],A1m,A2m);row[S.gmap[mt][a]]+=g[0]*nu[0]+g[1]*nu[1];}
            V2 bs=bary_xy(M.tris[st][0],M.tris[st][1],M.tris[st][2],Pm);
            for(int a=0;a<nK;++a){V2 g=gradN_phys(B,a,bs[0],bs[1],A1s,A2s);row[S.gmap[st][a]]-=g[0]*nu[0]+g[1]*nu[1];}
            S.Ac1.push_back(row);}
    }
    if(ssbc){ for(int c=0;c<S.nCP;++c){double x=S.pos[c][0],y=S.pos[c][1];
        if(std::fabs(x)<1e-9||std::fabs(x-L)<1e-9||std::fabs(y)<1e-9||std::fabs(y-L)<1e-9){
            std::vector<double> row(S.nCP,0.0);row[c]=1.0;S.Ac1.push_back(row);}}}
    return S;
}
// null-space basis C (nCP x nFree) of A via incomplete Gauss
static void nullspace(const std::vector<std::vector<double>>&A,int nCP,std::vector<std::vector<double>>&C,std::vector<int>&freecol,int&rank){
    std::vector<std::vector<double>> R=A;int m=R.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
    for(int c=0;c<nCP&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(R[r][c])>best){best=std::fabs(R[r][c]);pr=r;}
        if(pr<0)continue;std::swap(R[rr],R[pr]);double pv=R[rr][c];for(int j=0;j<nCP;++j)R[rr][j]/=pv;
        for(int r=0;r<m;++r)if(r!=rr){double f=R[r][c];if(f!=0)for(int j=0;j<nCP;++j)R[r][j]-=f*R[rr][j];}piv.push_back(c);++rr;}
    rank=piv.size();std::vector<char> ip(nCP,0);for(int c:piv)ip[c]=1;freecol.clear();for(int c=0;c<nCP;++c)if(!ip[c])freecol.push_back(c);
    int nF=freecol.size();C.assign(nCP,std::vector<double>(nF,0.0));
    for(int f=0;f<nF;++f){C[freecol[f]][f]=1.0;for(int i=0;i<rank;++i)C[piv[i]][f]=-R[i][freecol[f]];}
}

int main(){
    const double L=1.0,t=0.01,E=1.0e6,nu=0.3,q0=1.0;
    double Dp=E*t*t*t/(12*(1-nu*nu));
    std::array<std::array<double,3>,3> Dc={{{Dp,Dp*nu,0},{Dp*nu,Dp,0},{0,0,Dp*(1-nu)/2}}};
    double wmax=q0*L*L*L*L/(4*PI*PI*PI*PI*Dp);
    int p=5; BBTriangleBasis<double> B(p); int nK=B.size();
    printf("SS plate: L=%g t=%g E=%g nu=%g  Dplate=%.6g  Navier w_center=%.8g  (p=%d)\n",L,t,E,nu,Dp,wmax,p);

    // ---- patch consistency: quadratic in null(A_C1) on a 2-tri mesh ----
    { Mesh m2; m2.tris={{V3{0,0,0},V3{1,0,0},V3{0.6,0.8,0}},{V3{1,0,0},V3{0,0,0},V3{0.4,-0.7,0}}};
      Sys S=build(m2,p,B,L,false);
      auto fq=[&](double x,double y){return 0.5*x*x+0.3*x*y+0.2*y*y+0.1*x;};
      std::vector<double> uq(S.nCP,0.0);std::vector<char> sb(S.nCP,0);
      for(size_t k=0;k<m2.tris.size();++k){auto cc=quad_coefs(p,fq,m2.tris[k][0],m2.tris[k][1],m2.tris[k][2]);
          for(int a=0;a<nK;++a){int g=S.gmap[k][a];if(!sb[g]){uq[g]=cc[a];sb[g]=1;}}}
      double e=0;for(auto&row:S.Ac1){double s=0;for(int c=0;c<S.nCP;++c)s+=row[c]*uq[c];e=std::max(e,std::fabs(s));}
      printf("PATCH consistency (const curvature in C1 space): ||A_C1 u_quad|| = %.3e  [%s]\n",e,e<1e-9?"PASS":"FAIL");
    }

    // ---- plate convergence ----
    printf("\nh-refinement (rate = slope of log|err| vs log h):\n  %4s %6s %14s %12s %8s\n","N","DOF","w_center","rel.err","rate");
    std::vector<double> hh,ee; double prevlogh=0,prevloge=0;
    for(int N:{2,3,4,5,6}){
        Mesh M=square_mesh(L,N); Sys S=build(M,p,B,L,true);
        std::vector<std::vector<double>> C;std::vector<int> fc;int rank;
        nullspace(S.Ac1,S.nCP,C,fc,rank); int nF=fc.size();
        // K_full (scalar w bending) + f_full
        std::vector<std::vector<double>> Kf(S.nCP,std::vector<double>(S.nCP,0.0));
        std::vector<double> ff(S.nCP,0.0);
        for(size_t k=0;k<M.tris.size();++k){const auto&T=M.tris[k];
            V3 A1{T[1][0]-T[0][0],T[1][1]-T[0][1],0},A2{T[2][0]-T[0][0],T[2][1]-T[0][1],0};
            double Jac=std::fabs(A1[0]*A2[1]-A1[1]*A2[0]);
            for(auto&q:quad_triangle(14)){   // high quadrature so the sinusoidal load isn't the floor
                std::vector<std::array<double,3>> Bc(nK);for(int a=0;a<nK;++a)Bc[a]=curvN(B,a,q.xi1,q.xi2,A1,A2);
                // physical point for load
                double xph=T[0][0]+q.xi1*(T[1][0]-T[0][0])+q.xi2*(T[2][0]-T[0][0]);
                double yph=T[0][1]+q.xi1*(T[1][1]-T[0][1])+q.xi2*(T[2][1]-T[0][1]);
                double qload=q0*std::sin(PI*xph/L)*std::sin(PI*yph/L);
                double wq=q.w*Jac;
                for(int a=0;a<nK;++a){int ga=S.gmap[k][a];
                    ff[ga]+=wq*B.eval_one(a,q.xi1,q.xi2)*qload;
                    // D*Bc[a]
                    std::array<double,3> Da={Dc[0][0]*Bc[a][0]+Dc[0][1]*Bc[a][1],Dc[1][0]*Bc[a][0]+Dc[1][1]*Bc[a][1],Dc[2][2]*Bc[a][2]};
                    for(int b=0;b<nK;++b){int gb=S.gmap[k][b];
                        Kf[ga][gb]+=wq*(Bc[b][0]*Da[0]+Bc[b][1]*Da[1]+Bc[b][2]*Da[2]);}}
            }}
        // K_indep = C^T K C, f_indep = C^T f
        std::vector<std::vector<double>> KC(S.nCP,std::vector<double>(nF,0.0));
        for(int i=0;i<S.nCP;++i)for(int f=0;f<nF;++f){double s=0;for(int j=0;j<S.nCP;++j)s+=Kf[i][j]*C[j][f];KC[i][f]=s;}
        std::vector<std::vector<double>> Ki(nF,std::vector<double>(nF,0.0));std::vector<double> fi(nF,0.0);
        for(int a=0;a<nF;++a){for(int b=0;b<nF;++b){double s=0;for(int i=0;i<S.nCP;++i)s+=C[i][a]*KC[i][b];Ki[a][b]=s;}
            double s=0;for(int i=0;i<S.nCP;++i)s+=C[i][a]*ff[i];fi[a]=s;}
        std::vector<double> ui;bool sol=lusolve(Ki,fi,ui,nF);
        if(!sol){printf("  N=%d solve failed\n",N);continue;}
        std::vector<double> uf(S.nCP,0.0);for(int i=0;i<S.nCP;++i){double s=0;for(int f=0;f<nF;++f)s+=C[i][f]*ui[f];uf[i]=s;}
        // robust global metric: relative L2 error of w over the domain
        double l2e=0,l2x=0;
        for(size_t k=0;k<M.tris.size();++k){const auto&T=M.tris[k];
            V3 A1{T[1][0]-T[0][0],T[1][1]-T[0][1],0},A2{T[2][0]-T[0][0],T[2][1]-T[0][1],0};
            double Jac=std::fabs(A1[0]*A2[1]-A1[1]*A2[0]);
            for(auto&q:quad_triangle(14)){double wh=0;for(int a=0;a<nK;++a)wh+=B.eval_one(a,q.xi1,q.xi2)*uf[S.gmap[k][a]];
                double xph=T[0][0]+q.xi1*(T[1][0]-T[0][0])+q.xi2*(T[2][0]-T[0][0]);
                double yph=T[0][1]+q.xi1*(T[1][1]-T[0][1])+q.xi2*(T[2][1]-T[0][1]);
                double wex=wmax*std::sin(PI*xph/L)*std::sin(PI*yph/L);
                l2e+=q.w*Jac*(wh-wex)*(wh-wex); l2x+=q.w*Jac*wex*wex; }}
        double err=std::sqrt(l2e/l2x);
        double logh=std::log(L/N),loge=std::log(err);double rate=hh.empty()?0:(loge-prevloge)/(logh-prevlogh);
        printf("  %4d %6d %14s %12.3e %8.3f\n",N,nF,"(L2)",err,hh.empty()?0.0:rate);
        prevlogh=logh;prevloge=loge;hh.push_back(L/N);ee.push_back(err);
    }
    printf("\nGate: displacement rate should approach O(h^(p+1))=O(h^%d) for optimal C1 coupling.\n",p+1);
    return 0;
}
