// Phase-4 step 3: over-constraint at an interior vertex (triangle FAN) (Aeris BB).
// Pure C++ / no gismo. Build: g++ -std=c++17 -O2 test_bb_c1_fan.cpp -o t && ./t
//
// A closed valence-6 fan (central Vc + ring V0..V5, 6 triangles) has 6 interior
// edges (spokes) meeting at Vc -> the per-edge C1 constraints are linearly
// DEPENDENT there. Incomplete Gauss elimination must remove exactly the
// redundant equations and keep C1 enforced on every edge. (Two triangles share
// only one edge => no interior vertex with multiple inner sides => no
// redundancy => trivial pass; the fan is the right geometry.)
//
// Two independent checks:
//   F1 A is correct: a GLOBAL smooth (quadratic) field is in null(A)
//      ( ||A u_smooth|| ~ 0 ), a generic random field is NOT ( ||A u_rand|| >> 0 ).
//      Anchors the constraint construction over the fan (like step 1 anchored g_k).
//   F2 POSITIVE C1 (the necessary-and-sufficient check, not just "K not singular"):
//      build C = null-space basis via incomplete Gauss (free pivot, tol), then
//      verify ||A C|| ~ 0 over ALL original rows. A wrongly-DROPPED non-redundant
//      constraint (tol too aggressive) shows as residual != 0 on that row -> caught,
//      and the pivot tolerance is thereby pinned. Plus: redundancy>0 (over-constraint
//      detected), C full column rank (independent DOFs genuinely free).
// Scalar w (the bending C1; membrane needs only C0).
#include "bb_triangle_basis.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <cstdio>
#include <functional>

using namespace aeris;
using V3=std::array<double,3>; using V2=std::array<double,2>;

static int idx_of(int q,int i,int j){int n=0;for(int ii=q;ii>=0;--ii)for(int jj=q-ii;jj>=0;--jj){if(ii==i&&jj==j)return n;++n;}return -1;}
static std::vector<double> elevate(const std::vector<double>& cq,int q){
    auto id1=multi_indices(q+1);std::vector<double> c1(id1.size(),0.0);
    for(size_t a=0;a<id1.size();++a){int i=id1[a][0],j=id1[a][1],k=id1[a][2];double v=0;
        if(i>0)v+=i*cq[idx_of(q,i-1,j)];if(j>0)v+=j*cq[idx_of(q,i,j-1)];if(k>0)v+=k*cq[idx_of(q,i,j)];c1[a]=v/(q+1);}return c1;}
static std::vector<double> quad_coefs(int p,std::function<double(double,double)> f,const V3&A,const V3&B,const V3&C){
    auto P=[&](double l0,double l1,double l2){return V2{l0*A[0]+l1*B[0]+l2*C[0],l0*A[1]+l1*B[1]+l2*C[1]};};
    auto fv=[&](V2 q){return f(q[0],q[1]);};
    double c200=fv(P(1,0,0)),c020=fv(P(0,1,0)),c002=fv(P(0,0,1));
    double c110=2*fv(P(.5,.5,0))-.5*c200-.5*c020,c101=2*fv(P(.5,0,.5))-.5*c200-.5*c002,c011=2*fv(P(0,.5,.5))-.5*c020-.5*c002;
    std::vector<double> c={c200,c110,c101,c020,c011,c002};for(int q=2;q<p;++q)c=elevate(c,q);return c;}
static V2 gradN_phys(const BBTriangleBasis<double>&B,int k,double x1,double x2,const V3&A1,const V3&A2){
    auto g=B.deriv_one(k,x1,x2);double a=A1[0],b=A2[0],c=A1[1],d=A2[1],det=a*d-b*c;
    return {(d*g[0]-c*g[1])/det,(-b*g[0]+a*g[1])/det};}
static V2 bary_xy(const V3&W0,const V3&W1,const V3&W2,const V2&P){ // (xi1,xi2)=(l1,l2)
    double a=W1[0]-W0[0],b=W2[0]-W0[0],c=W1[1]-W0[1],d=W2[1]-W0[1],det=a*d-b*c;
    double px=P[0]-W0[0],py=P[1]-W0[1]; return {(d*px-b*py)/det,(-c*px+a*py)/det};}
static std::vector<V3> flat_patch_cps(const BBTriangleBasis<double>&B,const V3&V0,const V3&V1,const V3&V2){
    std::vector<V3> X(B.size()); double p=B.degree();
    for(int k=0;k<B.size();++k){const auto&a=B.alpha()[k];
        for(int c=0;c<3;++c) X[k][c]=(a[0]*V0[c]+a[1]*V1[c]+a[2]*V2[c])/p;}
    return X;}

int main(){
    const double PI=3.14159265358979323846;
    for(int p:{3,4,5}){
        BBTriangleBasis<double> B(p); int nK=B.size();
        // valence-6 fan
        V3 Vc{0,0,0}; std::vector<V3> Vr(6);
        for(int k=0;k<6;++k) Vr[k]={std::cos(k*PI/3),std::sin(k*PI/3),0};
        std::vector<std::array<V3,3>> tris(6);
        for(int k=0;k<6;++k) tris[k]={Vc,Vr[k],Vr[(k+1)%6]};
        // CP positions per triangle + global DOF map (merge by position)
        std::vector<std::vector<V3>> X(6);
        for(int k=0;k<6;++k) X[k]=flat_patch_cps(B,tris[k][0],tris[k][1],tris[k][2]);
        std::vector<V2> gpos; std::vector<std::vector<int>> gmap(6,std::vector<int>(nK));
        auto find_or_add=[&](const V3&P)->int{ for(size_t i=0;i<gpos.size();++i)
            if(std::hypot(gpos[i][0]-P[0],gpos[i][1]-P[1])<1e-9) return (int)i;
            gpos.push_back({P[0],P[1]}); return (int)gpos.size()-1; };
        for(int k=0;k<6;++k)for(int a=0;a<nK;++a) gmap[k][a]=find_or_add(X[k][a]);
        int nCP=gpos.size();
        // build constraint matrix A (6 edges x p collocation rows) x nCP
        std::vector<std::vector<double>> A;
        for(int k=0;k<6;++k){ // interior edge shared by tri k (master) and tri (k+1)%6 (slave)
            int mt=k, st=(k+1)%6;
            V3 Va=Vc, Vb=Vr[(k+1)%6];               // shared spoke Vc - V_{k+1}
            // master/slave tangents + apex
            auto tang=[&](int tt,V3&A1,V3&A2){const auto&T=tris[tt];
                A1={T[1][0]-T[0][0],T[1][1]-T[0][1],0}; A2={T[2][0]-T[0][0],T[2][1]-T[0][1],0};};
            V3 A1m,A2m,A1s,A2s; tang(mt,A1m,A2m); tang(st,A1s,A2s);
            // slave apex (vertex not on edge)
            V3 sap{0,0,0}; for(auto&W:tris[st]) if(std::hypot(W[0]-Va[0],W[1]-Va[1])>1e-9 &&
                                                   std::hypot(W[0]-Vb[0],W[1]-Vb[1])>1e-9) sap=W;
            V2 t{Vb[0]-Va[0],Vb[1]-Va[1]};double tn=std::hypot(t[0],t[1]);t={t[0]/tn,t[1]/tn};
            V2 nu{t[1],-t[0]}; V2 emid{0.5*(Va[0]+Vb[0]),0.5*(Va[1]+Vb[1])};
            if(nu[0]*(sap[0]-emid[0])+nu[1]*(sap[1]-emid[1])<0){nu[0]=-nu[0];nu[1]=-nu[1];}
            for(int m=0;m<p;++m){ double s=(m+1.0)/(p+1.0);
                V2 Pm{(1-s)*Va[0]+s*Vb[0],(1-s)*Va[1]+s*Vb[1]};
                std::vector<double> row(nCP,0.0);
                // master +, slave -
                V2 bm=bary_xy(tris[mt][0],tris[mt][1],tris[mt][2],Pm);
                for(int a=0;a<nK;++a){V2 g=gradN_phys(B,a,bm[0],bm[1],A1m,A2m);
                    row[gmap[mt][a]]+= g[0]*nu[0]+g[1]*nu[1]; }
                V2 bs=bary_xy(tris[st][0],tris[st][1],tris[st][2],Pm);
                for(int a=0;a<nK;++a){V2 g=gradN_phys(B,a,bs[0],bs[1],A1s,A2s);
                    row[gmap[st][a]]-= g[0]*nu[0]+g[1]*nu[1]; }
                A.push_back(row);
            }
        }
        int mR=A.size();
        // ---- F1: anchor A. smooth global field in null(A); random not ----
        auto fsm=[&](double x,double y){return 0.5*x*x+0.3*x*y+0.2*y*y+0.1*x-0.07*y+0.4;};
        std::vector<double> usm(nCP,0.0); std::vector<char> setb(nCP,0);
        for(int k=0;k<6;++k){auto cc=quad_coefs(p,fsm,tris[k][0],tris[k][1],tris[k][2]);
            for(int a=0;a<nK;++a){int g=gmap[k][a]; if(!setb[g]){usm[g]=cc[a];setb[g]=1;}}}
        std::vector<double> ur(nCP); for(int i=0;i<nCP;++i) ur[i]=std::sin(1.0+2.3*i)+0.5*i;
        auto Anorm=[&](const std::vector<double>&u){double e=0;for(int r=0;r<mR;++r){double s=0;
            for(int c=0;c<nCP;++c)s+=A[r][c]*u[c]; e=std::max(e,std::fabs(s));}return e;};
        double e_sm=Anorm(usm), e_rand=Anorm(ur);
        // ---- incomplete Gauss elimination -> RREF, pivots, null-space C ----
        std::vector<std::vector<double>> R=A; std::vector<int> pivcol;
        const double TOL=1e-9; int rrow=0;
        for(int c=0;c<nCP && rrow<mR;++c){ int pr=-1;double best=TOL;
            for(int r=rrow;r<mR;++r) if(std::fabs(R[r][c])>best){best=std::fabs(R[r][c]);pr=r;}
            if(pr<0) continue; std::swap(R[rrow],R[pr]);
            double pv=R[rrow][c]; for(int j=0;j<nCP;++j)R[rrow][j]/=pv;
            for(int r=0;r<mR;++r) if(r!=rrow){double f=R[r][c];if(f!=0)for(int j=0;j<nCP;++j)R[r][j]-=f*R[rrow][j];}
            pivcol.push_back(c); ++rrow; }
        int rank=pivcol.size(); int redundancy=mR-rank;
        std::vector<char> isPiv(nCP,0); for(int c:pivcol) isPiv[c]=1;
        std::vector<int> freecol; for(int c=0;c<nCP;++c) if(!isPiv[c]) freecol.push_back(c);
        int nFree=freecol.size();
        // C (nCP x nFree): free col f -> basis vector; pivots from RREF rows
        std::vector<std::vector<double>> C(nCP,std::vector<double>(nFree,0.0));
        for(int fc=0;fc<nFree;++fc){ C[freecol[fc]][fc]=1.0;
            for(int i=0;i<rank;++i) C[pivcol[i]][fc] = -R[i][freecol[fc]]; }
        // ---- F2: ||A C|| over all original rows; C column rank proxy ----
        double e_AC=0; for(int r=0;r<mR;++r)for(int fc=0;fc<nFree;++fc){double s=0;
            for(int c=0;c<nCP;++c)s+=A[r][c]*C[c][fc]; e_AC=std::max(e_AC,std::fabs(s));}
        // C full column rank: the freecol rows of C form identity -> trivially independent; ok.
        bool g_ok=(e_sm<1e-9)&&(e_rand>1e-3)&&(redundancy>0)&&(e_AC<1e-9)&&(nFree>0);
        printf("p=%d  nCP=%d rows=%d rank=%d redundancy=%d indepDOF=%d | A.u_sm=%.2e A.u_rand=%.2e |AC|=%.2e  [%s]\n",
               p,nCP,mR,rank,redundancy,nFree,e_sm,e_rand,e_AC,g_ok?"PASS":"FAIL");
        if(p==5 && !(redundancy>0)) printf("   (no redundancy detected -> fan not exercising over-constraint!)\n");
    }
    printf("\nNOTE: redundancy>0 confirms the interior-vertex over-constraint EXISTS and was found;\n"
           "|AC|~0 over ALL rows confirms incomplete-Gauss removed ONLY redundant constraints\n"
           "(no non-redundant constraint dropped -> no latent hinge); the smooth/random anchor\n"
           "confirms A itself is the correct C1 constraint. Three independent criteria.\n");
    return 0;
}
