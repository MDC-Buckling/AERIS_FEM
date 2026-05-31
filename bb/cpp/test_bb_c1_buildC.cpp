// Phase-4 step 2: build the per-side C1 map C two ways + cross-check (Aeris BB).
// Pure C++ / no gismo. Build: g++ -std=c++17 -O2 test_bb_c1_buildC.cpp -o t && ./t
//
// C expresses the SLAVE adjacent-row DOFs (Q) as a linear combination of the
// edge + master adjacent-row DOFs (P): u_Q = -H_QQ^-1 H_QP u_P. The partition
// is FIXED to "slave row dependent" (NOT free-pivot Gauss) so the entries are
// directly comparable to Farin. Free-pivot incomplete-Gauss is only for the
// GLOBAL over-constraint step (fan, next).
//
//   Way 1 (Weighted-Residual): H_kl = int_L g_k g_l, g_k the normal-slope-jump
//     continuity functional (Phase-4 step 1). C_WR = -H_QQ^-1 H_QP.
//   Way 2 (Farin, geometric affine sub-triangle, NO g_k): with (u,v,w) the
//     barycentrics of the slave apex Vd w.r.t. master triangle (V0,V1,V2):
//        sadj[j] = u*edge[j] + v*edge[j+1] + w*madj[j]
//   The two share no convention machinery => entry-for-entry agreement is a
//   strong independent check. Both also anchored: applied to a global smooth
//   field's P-coefs they must reproduce its Q-coefs.
//
// Indexing (consistent orientation, reversal): T+ = (V0,V1,V2), T- = (V1,V0,Vd),
//   shared edge V0V1. edge[j]=T+(p-j,j,0)=T-(j,p-j,0); madj[j]=T+(p-1-j,j,1)
//   (j=0..p-1); sadj[j]=T-(j,p-1-j,1) (j=0..p-1). Combined order: edge[0..p],
//   madj[0..p-1], sadj[0..p-1]. P=[0..2p], Q=[2p+1..3p].
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
    auto id1=multi_indices(q+1); std::vector<double> c1(id1.size(),0.0);
    for(size_t a=0;a<id1.size();++a){int i=id1[a][0],j=id1[a][1],k=id1[a][2];double v=0;
        if(i>0)v+=i*cq[idx_of(q,i-1,j)]; if(j>0)v+=j*cq[idx_of(q,i,j-1)]; if(k>0)v+=k*cq[idx_of(q,i,j)];
        c1[a]=v/(q+1);} return c1;}
static std::vector<double> quad_coefs(int p,std::function<double(double,double)> f,
        const V3&A,const V3&B,const V3&C){
    auto P=[&](double l0,double l1,double l2){return V2{l0*A[0]+l1*B[0]+l2*C[0],l0*A[1]+l1*B[1]+l2*C[1]};};
    auto fv=[&](V2 q){return f(q[0],q[1]);};
    double c200=fv(P(1,0,0)),c020=fv(P(0,1,0)),c002=fv(P(0,0,1));
    double c110=2*fv(P(.5,.5,0))-.5*c200-.5*c020,c101=2*fv(P(.5,0,.5))-.5*c200-.5*c002,
           c011=2*fv(P(0,.5,.5))-.5*c020-.5*c002;
    std::vector<double> c={c200,c110,c101,c020,c011,c002}; for(int q=2;q<p;++q)c=elevate(c,q); return c;}
static V2 gradN_phys(const BBTriangleBasis<double>&B,int k,double x1,double x2,const V3&A1,const V3&A2){
    auto g=B.deriv_one(k,x1,x2); double a=A1[0],b=A2[0],c=A1[1],d=A2[1],det=a*d-b*c;
    return {( d*g[0]-c*g[1])/det,(-b*g[0]+a*g[1])/det};}
// solve A(n x n) X = Rhs(n x m), partial pivot; returns false if singular; minpiv out.
static bool gauss_solve(std::vector<std::vector<double>> A,std::vector<std::vector<double>> R,
                        std::vector<std::vector<double>>&X,int n,int m,double&minpiv){
    minpiv=1e300;
    for(int c=0;c<n;++c){int pr=c;double best=std::fabs(A[c][c]);
        for(int r=c+1;r<n;++r)if(std::fabs(A[r][c])>best){best=std::fabs(A[r][c]);pr=r;}
        minpiv=std::min(minpiv,best); if(best<1e-300)return false;
        std::swap(A[c],A[pr]); std::swap(R[c],R[pr]);
        double piv=A[c][c]; for(int j=0;j<n;++j)A[c][j]/=piv; for(int j=0;j<m;++j)R[c][j]/=piv;
        for(int r=0;r<n;++r)if(r!=c){double f=A[r][c]; for(int j=0;j<n;++j)A[r][j]-=f*A[c][j];
            for(int j=0;j<m;++j)R[r][j]-=f*R[c][j];}}
    X=R; return true;}

int main(){
    V3 V0{0,0,0},V1{2.0,0,0},V2v{0.5,1.2,0},Vd{0.8,-1.0,0};
    V3 A1p{V1[0]-V0[0],V1[1]-V0[1],0},A2p{V2v[0]-V0[0],V2v[1]-V0[1],0};
    V3 A1m{V0[0]-V1[0],V0[1]-V1[1],0},A2m{Vd[0]-V1[0],Vd[1]-V1[1],0};
    V2 t{V1[0]-V0[0],V1[1]-V0[1]};double tn=std::hypot(t[0],t[1]);t={t[0]/tn,t[1]/tn};
    V2 nu{t[1],-t[0]}; V2 mid{0.5*(V0[0]+V1[0]),0.5*(V0[1]+V1[1])};
    if(nu[0]*(Vd[0]-mid[0])+nu[1]*(Vd[1]-mid[1])<0){nu[0]=-nu[0];nu[1]=-nu[1];}
    // bary(Vd; V0,V1,V2v): solve [V0 V1 V2; 1 1 1][u;v;w]=[Vd;1]
    double uvw[3]; {
        std::vector<std::vector<double>> M={{V0[0],V1[0],V2v[0]},{V0[1],V1[1],V2v[1]},{1,1,1}};
        std::vector<std::vector<double>> r={{Vd[0]},{Vd[1]},{1}}; std::vector<std::vector<double>> x; double mp;
        gauss_solve(M,r,x,3,1,mp); uvw[0]=x[0][0];uvw[1]=x[1][0];uvw[2]=x[2][0]; }
    double u=uvw[0],v=uvw[1],w=uvw[2];
    printf("bary(Vd; V0,V1,V2) = (u,v,w) = (%.4f, %.4f, %.4f), sum=%.4f\n",u,v,w,u+v+w);

    // Gauss-Legendre on [0,1], n points
    auto gl=[&](int ng,std::vector<double>&xs,std::vector<double>&ws){
        // reuse simple: map [-1,1] tables for ng<=6
        std::vector<double> X,W;
        if(ng==4){X={-0.8611363115940526,-0.3399810435848563,0.3399810435848563,0.8611363115940526};
                  W={0.3478548451374538,0.6521451548625461,0.6521451548625461,0.3478548451374538};}
        else if(ng==5){X={-0.9061798459386640,-0.5384693101056831,0,0.5384693101056831,0.9061798459386640};
                  W={0.2369268850561891,0.4786286704993665,0.5688888888888889,0.4786286704993665,0.2369268850561891};}
        else {X={-0.9324695142031521,-0.6612093864662645,-0.2386191860831969,0.2386191860831969,0.6612093864662645,0.9324695142031521};
                  W={0.1713244923791704,0.3607615730481386,0.4679139345726910,0.4679139345726910,0.3607615730481386,0.1713244923791704};}
        xs.clear();ws.clear();for(size_t i=0;i<X.size();++i){xs.push_back(0.5*(X[i]+1));ws.push_back(0.5*W[i]);}};

    bool ok=true;
    for(int p:{3,4,5}){
        BBTriangleBasis<double> B(p); int nINV=3*p+1; // edge(p+1)+madj(p)+sadj(p)
        // g_k(s) for combined index
        auto g=[&](int idx,double s)->double{
            if(idx<=p){ int j=idx; int pj=idx_of(p,p-j,j), mj=idx_of(p,j,p-j);
                V2 gP=gradN_phys(B,pj,s,0,A1p,A2p), gM=gradN_phys(B,mj,1-s,0,A1m,A2m);
                return (gP[0]*nu[0]+gP[1]*nu[1])-(gM[0]*nu[0]+gM[1]*nu[1]); }
            else if(idx<=2*p){ int j=idx-(p+1); int pidx=idx_of(p,p-1-j,j);
                V2 gP=gradN_phys(B,pidx,s,0,A1p,A2p); return gP[0]*nu[0]+gP[1]*nu[1]; }
            else { int j=idx-(2*p+1); int midx=idx_of(p,j,p-1-j);
                V2 gM=gradN_phys(B,midx,1-s,0,A1m,A2m); return -(gM[0]*nu[0]+gM[1]*nu[1]); } };
        std::vector<double> xs,ws; gl(p+1<6?6:6,xs,ws); // 6-pt GL, exact to deg 11 >= 2(p-1)
        std::vector<std::vector<double>> H(nINV,std::vector<double>(nINV,0.0));
        for(size_t q=0;q<xs.size();++q)for(int a=0;a<nINV;++a){double ga=g(a,xs[q]);
            for(int b=0;b<nINV;++b)H[a][b]+=ws[q]*ga*g(b,xs[q]);}
        // partition: P=[0..2p], Q=[2p+1..3p]
        int nP=2*p+1,nQ=p;
        std::vector<std::vector<double>> Hqq(nQ,std::vector<double>(nQ)),Hqp(nQ,std::vector<double>(nP));
        for(int a=0;a<nQ;++a){for(int b=0;b<nQ;++b)Hqq[a][b]=H[2*p+1+a][2*p+1+b];
                              for(int b=0;b<nP;++b)Hqp[a][b]=H[2*p+1+a][b];}
        // C_WR = -Hqq^-1 Hqp
        std::vector<std::vector<double>> negHqp(nQ,std::vector<double>(nP));
        for(int a=0;a<nQ;++a)for(int b=0;b<nP;++b)negHqp[a][b]=-Hqp[a][b];
        std::vector<std::vector<double>> Cwr; double minpiv;
        bool inv_ok=gauss_solve(Hqq,negHqp,Cwr,nQ,nP,minpiv);
        // C_Farin
        std::vector<std::vector<double>> Cf(nQ,std::vector<double>(nP,0.0));
        for(int j=0;j<p;++j){ Cf[j][j]+=u; Cf[j][j+1]+=v; Cf[j][(p+1)+j]+=w; }
        double e_cmp=0; for(int a=0;a<nQ;++a)for(int b=0;b<nP;++b)e_cmp=std::max(e_cmp,std::fabs(Cwr[a][b]-Cf[a][b]));
        // anchor: global quadratic f -> Cf*pcoef == qcoef, Cwr*pcoef == qcoef
        auto f=[&](double x,double y){return 0.6*x*x+0.35*x*y+0.2*y*y+0.1*x-0.05*y+0.3;};
        auto cp=quad_coefs(p,f,V0,V1,V2v); auto cm=quad_coefs(p,f,V1,V0,Vd);
        std::vector<double> pco(nP),qco(nQ);
        for(int j=0;j<=p;++j) pco[j]=cp[idx_of(p,p-j,j)];
        for(int j=0;j<p;++j) pco[(p+1)+j]=cp[idx_of(p,p-1-j,j)];
        for(int j=0;j<p;++j) qco[j]=cm[idx_of(p,j,p-1-j)];
        double e_anchor_f=0,e_anchor_wr=0;
        for(int a=0;a<nQ;++a){double sf=0,sw=0;for(int b=0;b<nP;++b){sf+=Cf[a][b]*pco[b];sw+=Cwr[a][b]*pco[b];}
            e_anchor_f=std::max(e_anchor_f,std::fabs(sf-qco[a])); e_anchor_wr=std::max(e_anchor_wr,std::fabs(sw-qco[a]));}
        bool g_ok=inv_ok&&(minpiv>1e-12)&&(e_cmp<1e-10)&&(e_anchor_f<1e-9)&&(e_anchor_wr<1e-9); ok&=g_ok;
        printf("p=%d  H_QQ minpiv=%.3e(SPD?)  ||C_WR-C_Farin||=%.3e  anchorFarin=%.2e anchorWR=%.2e  [%s]\n",
               p,minpiv,e_cmp,e_anchor_f,e_anchor_wr,g_ok?"PASS":"FAIL");
    }
    printf("\n%s\n",ok
      ?"RESULT: PASS - per-side C built; Weighted-Residual C == Farin C entry-for-entry, both "
       "reproduce a global smooth field. Cross-check GREEN (two independent constructions agree)."
      :"RESULT: FAIL.");
    return ok?0:1;
}
