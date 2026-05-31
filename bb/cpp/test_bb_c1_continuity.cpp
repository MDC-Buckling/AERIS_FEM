// Phase-4 step 1: the C1 continuity functional g_k, anchored (Aeris BB).
// Pure C++ / no gismo (this is basis-geometry, like Phases 1-2).
// Build: g++ -std=c++17 -O2 test_bb_c1_continuity.cpp -o t && ./t
//
// The C1 condition across a shared straight edge (KL bending needs continuity
// of the normal slope d w / d nu of the transverse displacement). On each
// triangle w(xi) = sum N_k(xi) w_k, grad_phys w = J^-T (N_k,1; N_k,2). The
// slope jump along the edge:
//     jump(s) = sum_{k in T+} (grad N_k^+ . nu) w_k^+
//             - sum_{k in T-} (grad N_k^- . nu) w_k^-
// is the continuity functional (= sum_k g_k w_k, the spec's g_k). The
// constraint is jump(s)=0 along the edge.
//
// ANCHOR (independent oracle, self-corrects sign/orientation/reversal):
//   A1 a GLOBALLY SMOOTH field (one quadratic over both triangles) has
//      continuous slope -> jump(s) = 0 at every s   (~machine)
//   A2 a KINKED C0-but-not-C1 field (master flat, slave linear in distance
//      from the edge: matches on the edge, slope jumps) -> jump(s) != 0
// Consistent orientation: adjacent triangles traverse the shared edge in
// OPPOSITE directions, so T+ samples (s,0) while T- samples (1-s,0), and the
// edge CP (i,j,0)^+ matches (j,i,0)^- (the reversal).
#include "bb_triangle_basis.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <cstdio>
#include <functional>

using namespace aeris;
using V3 = std::array<double,3>;
using V2 = std::array<double,2>;

// ---- exact triangular-Bezier degree elevation + quadratic field coefs ----
static int idx_of(int q,int i,int j){int n=0;for(int ii=q;ii>=0;--ii)for(int jj=q-ii;jj>=0;--jj){if(ii==i&&jj==j)return n;++n;}return -1;}
static std::vector<double> elevate(const std::vector<double>& cq,int q){
    auto id1=multi_indices(q+1); std::vector<double> c1(id1.size(),0.0);
    for(size_t a=0;a<id1.size();++a){int i=id1[a][0],j=id1[a][1],k=id1[a][2];double v=0;
        if(i>0)v+=i*cq[idx_of(q,i-1,j)]; if(j>0)v+=j*cq[idx_of(q,i,j-1)]; if(k>0)v+=k*cq[idx_of(q,i,j)];
        c1[a]=v/(q+1);} return c1;}
static std::vector<double> quad_coefs(int p,std::function<double(double,double)> f,
        const V3& A,const V3& B,const V3& C){
    auto P=[&](double l0,double l1,double l2){return V2{l0*A[0]+l1*B[0]+l2*C[0], l0*A[1]+l1*B[1]+l2*C[1]};};
    auto fv=[&](V2 q){return f(q[0],q[1]);};
    double c200=fv(P(1,0,0)),c020=fv(P(0,1,0)),c002=fv(P(0,0,1));
    double c110=2*fv(P(.5,.5,0))-.5*c200-.5*c020, c101=2*fv(P(.5,0,.5))-.5*c200-.5*c002,
           c011=2*fv(P(0,.5,.5))-.5*c020-.5*c002;
    std::vector<double> c={c200,c110,c101,c020,c011,c002};
    for(int q=2;q<p;++q)c=elevate(c,q); return c;}

// physical gradient of basis fn k at param (xi1,xi2) on a triangle with tangents A1,A2 (in-plane)
static V2 gradN_phys(const BBTriangleBasis<double>& B,int k,double xi1,double xi2,
                     const V3& A1,const V3& A2){
    auto g=B.deriv_one(k,xi1,xi2);                 // (dN/dxi1, dN/dxi2)
    // J = [[A1x,A2x],[A1y,A2y]]; grad_phys = J^-T (dxi1; dxi2)
    double a=A1[0],b=A2[0],c=A1[1],d=A2[1], det=a*d-b*c;
    // J^-1 = 1/det [[d,-b],[-c,a]]; J^-T = 1/det [[d,-c],[-b,a]]
    double gx=( d*g[0] - c*g[1])/det;
    double gy=(-b*g[0] + a*g[1])/det;
    return {gx,gy};
}

int main(){
    V3 V0{0,0,0},V1{2.0,0,0},V2v{0.5,1.2,0},Vd{0.8,-1.0,0};   // flat, shared edge V0V1
    // T+ = (V0,V1,V2v); T- = (V1,V0,Vd)  (both CCW -> +z normal, consistent)
    V3 A1p{V1[0]-V0[0],V1[1]-V0[1],0}, A2p{V2v[0]-V0[0],V2v[1]-V0[1],0};   // T+ tangents
    V3 A1m{V0[0]-V1[0],V0[1]-V1[1],0}, A2m{Vd[0]-V1[0],Vd[1]-V1[1],0};     // T- tangents
    // edge normal nu (in-plane), oriented from T+ toward T- (toward Vd)
    V2 t{V1[0]-V0[0],V1[1]-V0[1]}; double tn=std::hypot(t[0],t[1]); t={t[0]/tn,t[1]/tn};
    V2 nu{ t[1], -t[0] };                                  // rotate -90
    V2 mid{0.5*(V0[0]+V1[0]),0.5*(V0[1]+V1[1])};
    if( nu[0]*(Vd[0]-mid[0])+nu[1]*(Vd[1]-mid[1]) < 0 ){ nu[0]=-nu[0]; nu[1]=-nu[1]; }

    double sm[5]={0.1,0.3,0.5,0.7,0.9};
    bool ok=true;
    for(int p:{3,4,5}){
        BBTriangleBasis<double> B(p); int nK=B.size();
        // smooth global quadratic w(x,y); per-triangle exact coefs
        auto w=[&](double x,double y){return 0.7*x*x+0.4*x*y+0.25*y*y+0.13*x-0.06*y;};
        auto wp=quad_coefs(p,w,V0,V1,V2v);     // T+ coefs (bary order V0,V1,V2v)
        auto wm=quad_coefs(p,w,V1,V0,Vd);      // T- coefs (bary order V1,V0,Vd)
        // kinked field: master 0; slave linear in signed distance from edge (=> slope jump)
        // dist(X) = nu . (X - V0) ; on edge =0, off-edge linear. linear field -> exact coefs.
        auto distf=[&](double x,double y){return nu[0]*(x-V0[0])+nu[1]*(y-V0[1]);};
        std::vector<double> kp(nK,0.0), km(nK);
        {   // slave linear field coefs: linear -> coef = field at CP physical loc
            for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
                V3 X{(a[0]*V1[0]+a[1]*V0[0]+a[2]*Vd[0])/p,(a[0]*V1[1]+a[1]*V0[1]+a[2]*Vd[1])/p,0};
                km[k]=1.5*distf(X[0],X[1]); } }

        double e_smooth=0, min_kink=1e9;
        for(double s:sm){
            // T+ samples (s,0); T- samples (1-s,0)  [orientation reversal]
            double jp_s=0, jm_s=0, kp_s=0, km_s=0;
            for(int k=0;k<nK;++k){
                V2 gP=gradN_phys(B,k,s,0.0,A1p,A2p);
                V2 gM=gradN_phys(B,k,1.0-s,0.0,A1m,A2m);
                double dnP=gP[0]*nu[0]+gP[1]*nu[1];
                double dnM=gM[0]*nu[0]+gM[1]*nu[1];
                jp_s += dnP*wp[k];  jm_s += dnM*wm[k];
                kp_s += dnP*kp[k];  km_s += dnM*km[k];
            }
            double jump_smooth = jp_s - jm_s;     // should be ~0
            double jump_kink   = kp_s - km_s;     // should be != 0
            e_smooth=std::max(e_smooth,std::fabs(jump_smooth));
            min_kink=std::min(min_kink,std::fabs(jump_kink));
        }
        bool g=(e_smooth<1e-9)&&(min_kink>1e-3); ok&=g;
        std::printf("p=%d  smooth jump max|.|=%.3e (->0)   kinked jump min|.|=%.3e (->!=0)   [%s]\n",
                    p,e_smooth,min_kink,g?"PASS":"FAIL");
    }
    std::printf("\n%s\n", ok
      ? "RESULT: PASS - C1 continuity functional g_k correct (smooth field -> zero slope jump, "
        "kinked field -> nonzero). Per-side construction anchored. Ready to build C."
      : "RESULT: FAIL - inspect orientation/sign/reversal against the anchor.");
    return ok?0:1;
}
