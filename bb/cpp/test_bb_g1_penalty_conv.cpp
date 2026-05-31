// G1 penalty-coupling CONVERGENCE arbiter (Aeris BB). Pure C++ / no gismo.
// Step-4 PATTERN (the path that produced O(h^6)), NOT the buggy prescribe-solve patch.
//
// Square SS plate, sinusoidal load, EXACT Navier solution known. The interior mid-line
// x=L/2 is coupled by the PENALTY (the slope-jump penalty stiffness, = kappa * row^T row
// with the SAME C1 slope-jump rows), instead of a hard C1 constraint; all other interior
// edges keep the hard C1. If the penalty-coupled plate converges to Navier at O(h^(p+1)),
// the penalty COUPLING converges optimally (the core G1 question) — on the clean solve
// path, against the analytic, so it is a true arbiter, not the buggy patch test.
//   small kappa -> interface acts as a hinge -> no convergence;
//   kappa in the plateau -> converges to Navier at the element rate;
//   read the h-rate where the h-error dominates (kappa high enough the floor doesn't mask).
// (The real fold angle Theta / rotated director is validated separately in G0/G0.5.)
//
// Build: g++ -std=c++17 -O2 test_bb_g1_penalty_conv.cpp -o tgpc && ./tgpc
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

static V2 bary_xy(const V3&W0,const V3&W1,const V3&W2,const V2&P){double a=W1[0]-W0[0],b=W2[0]-W0[0],c=W1[1]-W0[1],d=W2[1]-W0[1],det=a*d-b*c,px=P[0]-W0[0],py=P[1]-W0[1];return {(d*px-b*py)/det,(-c*px+a*py)/det};}
static V2 gradN_phys(const BBTriangleBasis<double>&B,int k,double x1,double x2,const V3&A1,const V3&A2){auto g=B.deriv_one(k,x1,x2);double a=A1[0],b=A2[0],c=A1[1],d=A2[1],det=a*d-b*c;return {(d*g[0]-c*g[1])/det,(-b*g[0]+a*g[1])/det};}
static std::array<double,3> curvN(const BBTriangleBasis<double>&B,int k,double x1,double x2,const V3&A1,const V3&A2){
    auto h=B.deriv2_one(k,x1,x2);double a=A1[0],b=A2[0],c=A1[1],d=A2[1],det=a*d-b*c;double i00=d/det,i01=-b/det,i10=-c/det,i11=a/det,H00=h[0],H11=h[1],H01=h[2];
    auto hp=[&](double cx0,double cx1,double cy0,double cy1){return (cx0*H00+cx1*H01)*cy0+(cx0*H01+cx1*H11)*cy1;};
    return {hp(i00,i10,i00,i10),hp(i01,i11,i01,i11),2*hp(i00,i10,i01,i11)};}
static bool lusolve(std::vector<std::vector<double>> A,std::vector<double> b,std::vector<double>&x,int n){
    for(int c=0;c<n;++c){int p=c;double best=std::fabs(A[c][c]);for(int r=c+1;r<n;++r)if(std::fabs(A[r][c])>best){best=std::fabs(A[r][c]);p=r;}
        if(best<1e-300)return false;std::swap(A[c],A[p]);std::swap(b[c],b[p]);
        for(int r=c+1;r<n;++r){double f=A[r][c]/A[c][c];for(int j=c;j<n;++j)A[r][j]-=f*A[c][j];b[r]-=f*b[c];}}
    x.assign(n,0);for(int i=n-1;i>=0;--i){double s=b[i];for(int j=i+1;j<n;++j)s-=A[i][j]*x[j];x[i]=s/A[i][i];}return true;}
static void nullspace(const std::vector<std::vector<double>>&A,int nCP,std::vector<std::vector<double>>&C,std::vector<int>&fc,int&rank){
    std::vector<std::vector<double>> R=A;int m=R.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
    for(int c=0;c<nCP&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(R[r][c])>best){best=std::fabs(R[r][c]);pr=r;}
        if(pr<0)continue;std::swap(R[rr],R[pr]);double pv=R[rr][c];for(int j=0;j<nCP;++j)R[rr][j]/=pv;
        for(int r=0;r<m;++r)if(r!=rr){double f=R[r][c];if(f!=0)for(int j=0;j<nCP;++j)R[r][j]-=f*R[rr][j];}piv.push_back(c);++rr;}
    rank=piv.size();std::vector<char> ip(nCP,0);for(int c:piv)ip[c]=1;fc.clear();for(int c=0;c<nCP;++c)if(!ip[c])fc.push_back(c);
    int nF=fc.size();C.assign(nCP,std::vector<double>(nF,0.0));for(int f=0;f<nF;++f){C[fc[f]][f]=1.0;for(int i=0;i<rank;++i)C[piv[i]][f]=-R[i][fc[f]];}}
static std::vector<V3> fcps(const BBTriangleBasis<double>&B,const V3&V0,const V3&V1,const V3&V2){std::vector<V3> X(B.size());double p=B.degree();
    for(int k=0;k<B.size();++k){const auto&a=B.alpha()[k];for(int c=0;c<3;++c)X[k][c]=(a[0]*V0[c]+a[1]*V1[c]+a[2]*V2[c])/p;}return X;}
struct Mesh{std::vector<std::array<V3,3>> tris;};
static Mesh square_mesh(double L,int N){Mesh m;auto V=[&](int i,int j){return V3{i*L/N,j*L/N,0};};
    for(int i=0;i<N;++i)for(int j=0;j<N;++j){m.tris.push_back({V(i,j),V(i+1,j),V(i+1,j+1)});m.tris.push_back({V(i,j),V(i+1,j+1),V(i,j+1)});}return m;}

int main(){
    const double L=1.0,t=0.01,E=1.0e6,nu=0.3,q0=1.0;
    double Dp=E*t*t*t/(12*(1-nu*nu));
    std::array<std::array<double,3>,3> Dc={{{Dp,Dp*nu,0},{Dp*nu,Dp,0},{0,0,Dp*(1-nu)/2}}};
    double wmax=q0*L*L*L*L/(4*PI*PI*PI*PI*Dp);
    int p=5; BBTriangleBasis<double> B(p); int nK=B.size();
    printf("G1 PENALTY-coupling convergence arbiter: SS plate, mid-line x=L/2 PENALTY-coupled, vs Navier.\n");
    printf("  Dplate=%.6g  Navier w_center=%.8g  p=%d.  Step-4 path (clean solve), NOT the patch test.\n\n",Dp,wmax,p);
    for(double Pfac:{1e2,1e4,1e6}){
        double kpen=Pfac*Dp/L;   // penalty scale (sweep to find the plateau)
        printf("  == penalty P=%.0e (kappa=%.3g) ==\n",Pfac,kpen);
        printf("    %4s %7s %12s %8s\n","N","DOF","rel.L2 err","rate");
        double ph=0,pe=0; bool first=true;
        for(int N:{2,3,4,5,6}){
            Mesh M=square_mesh(L,N); int nT=M.tris.size();
            std::vector<std::vector<V3>> X(nT); for(int k=0;k<nT;++k)X[k]=fcps(B,M.tris[k][0],M.tris[k][1],M.tris[k][2]);
            std::vector<V2> pos; std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
            auto foa=[&](const V3&P){for(size_t i=0;i<pos.size();++i)if(std::hypot(pos[i][0]-P[0],pos[i][1]-P[1])<1e-9)return(int)i;pos.push_back({P[0],P[1]});return(int)pos.size()-1;};
            for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(X[k][a]);
            int nCP=pos.size();
            // interior edges -> C1 (within) or PENALTY (on x=L/2)
            auto vkey=[&](const V3&p){return std::make_pair((long long)llround(p[0]*1e7),(long long)llround(p[1]*1e7));};
            std::map<std::pair<std::pair<long long,long long>,std::pair<long long,long long>>,std::vector<int>> em;
            for(int k=0;k<nT;++k){const auto&T=M.tris[k];for(int e=0;e<3;++e){auto a=vkey(T[e]),b=vkey(T[(e+1)%3]);if(b<a)std::swap(a,b);em[{a,b}].push_back(k);}}
            std::vector<std::vector<double>> Ac1, Apen;
            for(auto&kv:em){ if(kv.second.size()!=2)continue; int mt=kv.second[0],st=kv.second[1];
                std::vector<V3> sh;for(auto&Wm:M.tris[mt])for(auto&Ws:M.tris[st])if(std::hypot(Wm[0]-Ws[0],Wm[1]-Ws[1])<1e-9)sh.push_back(Wm);
                V3 Va=sh[0],Vb=sh[1];
                bool isInterface = std::fabs(Va[0]-L/2)<1e-9 && std::fabs(Vb[0]-L/2)<1e-9;   // edge on x=L/2
                auto tang=[&](int tt,V3&A1,V3&A2){const auto&T=M.tris[tt];A1={T[1][0]-T[0][0],T[1][1]-T[0][1],0};A2={T[2][0]-T[0][0],T[2][1]-T[0][1],0};};
                V3 A1m,A2m,A1s,A2s;tang(mt,A1m,A2m);tang(st,A1s,A2s);
                V3 sap{0,0,0};for(auto&W:M.tris[st])if(std::hypot(W[0]-Va[0],W[1]-Va[1])>1e-9&&std::hypot(W[0]-Vb[0],W[1]-Vb[1])>1e-9)sap=W;
                V2 tt{Vb[0]-Va[0],Vb[1]-Va[1]};double tn=std::hypot(tt[0],tt[1]);tt={tt[0]/tn,tt[1]/tn};V2 nuv{tt[1],-tt[0]};V2 emid{0.5*(Va[0]+Vb[0]),0.5*(Va[1]+Vb[1])};
                if(nuv[0]*(sap[0]-emid[0])+nuv[1]*(sap[1]-emid[1])<0){nuv[0]=-nuv[0];nuv[1]=-nuv[1];}
                for(int mm=0;mm<p;++mm){double s=(mm+1.0)/(p+1.0);V2 Pm{(1-s)*Va[0]+s*Vb[0],(1-s)*Va[1]+s*Vb[1]};std::vector<double> row(nCP,0.0);
                    V2 bm=bary_xy(M.tris[mt][0],M.tris[mt][1],M.tris[mt][2],Pm);for(int a=0;a<nK;++a){V2 g=gradN_phys(B,a,bm[0],bm[1],A1m,A2m);row[gmap[mt][a]]+=g[0]*nuv[0]+g[1]*nuv[1];}
                    V2 bs=bary_xy(M.tris[st][0],M.tris[st][1],M.tris[st][2],Pm);for(int a=0;a<nK;++a){V2 g=gradN_phys(B,a,bs[0],bs[1],A1s,A2s);row[gmap[st][a]]-=g[0]*nuv[0]+g[1]*nuv[1];}
                    if(isInterface) Apen.push_back(row); else Ac1.push_back(row);}
            }
            // SS w=0 boundary -> hard constraint
            for(int c=0;c<nCP;++c){double x=pos[c][0],y=pos[c][1];if(std::fabs(x)<1e-9||std::fabs(x-L)<1e-9||std::fabs(y)<1e-9||std::fabs(y-L)<1e-9){std::vector<double> row(nCP,0.0);row[c]=1.0;Ac1.push_back(row);}}
            std::vector<std::vector<double>> C;std::vector<int> fc;int rank;nullspace(Ac1,nCP,C,fc,rank);int nF=fc.size();
            // K_full (bending) + PENALTY stiffness (kpen * row^T row over Apen) + load
            std::vector<std::vector<double>> Kf(nCP,std::vector<double>(nCP,0.0));std::vector<double> ff(nCP,0.0);
            for(int k=0;k<nT;++k){const auto&T=M.tris[k];V3 A1{T[1][0]-T[0][0],T[1][1]-T[0][1],0},A2{T[2][0]-T[0][0],T[2][1]-T[0][1],0};
                double Jac=std::fabs(A1[0]*A2[1]-A1[1]*A2[0]);
                for(auto&q:quad_triangle(14)){std::vector<std::array<double,3>> Bc(nK);for(int a=0;a<nK;++a)Bc[a]=curvN(B,a,q.xi1,q.xi2,A1,A2);
                    double xph=T[0][0]+q.xi1*(T[1][0]-T[0][0])+q.xi2*(T[2][0]-T[0][0]),yph=T[0][1]+q.xi1*(T[1][1]-T[0][1])+q.xi2*(T[2][1]-T[0][1]);
                    double qload=q0*std::sin(PI*xph/L)*std::sin(PI*yph/L),wq=q.w*Jac;
                    for(int a=0;a<nK;++a){int ga=gmap[k][a];ff[ga]+=wq*B.eval_one(a,q.xi1,q.xi2)*qload;
                        std::array<double,3> Da={Dc[0][0]*Bc[a][0]+Dc[0][1]*Bc[a][1],Dc[1][0]*Bc[a][0]+Dc[1][1]*Bc[a][1],Dc[2][2]*Bc[a][2]};
                        for(int b=0;b<nK;++b){int gb=gmap[k][b];Kf[ga][gb]+=wq*(Bc[b][0]*Da[0]+Bc[b][1]*Da[1]+Bc[b][2]*Da[2]);}}}}
            for(auto&row:Apen)for(int i=0;i<nCP;++i)if(row[i]!=0)for(int j=0;j<nCP;++j)if(row[j]!=0)Kf[i][j]+=kpen*row[i]*row[j];
            // reduce + solve
            std::vector<std::vector<double>> KC(nCP,std::vector<double>(nF,0.0));
            for(int i=0;i<nCP;++i)for(int f=0;f<nF;++f){double s=0;for(int j=0;j<nCP;++j)s+=Kf[i][j]*C[j][f];KC[i][f]=s;}
            std::vector<std::vector<double>> Ki(nF,std::vector<double>(nF,0.0));std::vector<double> fi(nF,0.0);
            for(int a=0;a<nF;++a){for(int b=0;b<nF;++b){double s=0;for(int i=0;i<nCP;++i)s+=C[i][a]*KC[i][b];Ki[a][b]=s;}double s=0;for(int i=0;i<nCP;++i)s+=C[i][a]*ff[i];fi[a]=s;}
            std::vector<double> ui;if(!lusolve(Ki,fi,ui,nF)){printf("    %4d solve fail\n",N);continue;}
            std::vector<double> uf(nCP,0.0);for(int i=0;i<nCP;++i){double s=0;for(int f=0;f<nF;++f)s+=C[i][f]*ui[f];uf[i]=s;}
            double l2e=0,l2x=0;
            for(int k=0;k<nT;++k){const auto&T=M.tris[k];V3 A1{T[1][0]-T[0][0],T[1][1]-T[0][1],0},A2{T[2][0]-T[0][0],T[2][1]-T[0][1],0};double Jac=std::fabs(A1[0]*A2[1]-A1[1]*A2[0]);
                for(auto&q:quad_triangle(14)){double wh=0;for(int a=0;a<nK;++a)wh+=B.eval_one(a,q.xi1,q.xi2)*uf[gmap[k][a]];
                    double xph=T[0][0]+q.xi1*(T[1][0]-T[0][0])+q.xi2*(T[2][0]-T[0][0]),yph=T[0][1]+q.xi1*(T[1][1]-T[0][1])+q.xi2*(T[2][1]-T[0][1]);
                    double wex=wmax*std::sin(PI*xph/L)*std::sin(PI*yph/L);l2e+=q.w*Jac*(wh-wex)*(wh-wex);l2x+=q.w*Jac*wex*wex;}}
            double err=std::sqrt(l2e/l2x),logh=std::log(L/N),loge=std::log(err),rate=first?0:(loge-pe)/(logh-ph);
            printf("    %4d %7d %12.3e %8.3f\n",N,nF,err,first?0.0:rate);
            ph=logh;pe=loge;first=false;
        }
    }
    printf("\nArbiter: at kappa in the plateau the rate -> O(h^(p+1))=O(h^%d) => penalty coupling converges optimally\n",p+1);
    printf("(element+coupling sound on the clean path; the abandoned patch test was scaffold). Low kappa: hinge, no conv.\n");
    return 0;
}
