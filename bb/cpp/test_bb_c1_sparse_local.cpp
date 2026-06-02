// Phase-4 / scaling: SPARSE-EXACT LOCAL C1 null-space for the BB cylinder mesh.
// Pure C++ / no gismo (fast compile). Build:
//   g++ -std=c++17 -O2 test_bb_c1_sparse_local.cpp -o tsl && ./tsl [Nx Nt p]
//
// PROBLEM: the driver builds the scalar C1 null-space C0 (nCP x nF) by GLOBAL
// incomplete Gauss elimination. That C0 is DENSE (each free DOF couples to ~all
// CPs) -> the triple product C^T K C and the dense Gauss itself are the thin-shell
// wall. GOAL: build a C0 with the SAME null-space (A*C0=0, reproduces smooth
// fields, same dimension) but nnz(C0) ~ O(n) instead of O(n^2).
//
// This file is the gated standalone: it first reproduces the dense reference
// (dimension + density baseline), then will host the local construction. Gates:
//   G0  dense baseline: rank, null-dim, nnz(dense C0), density %.
//   G1  A*C0 ~ 0 over ALL rows (C0 is a true null-space basis).
//   G2  smooth-field reproduction: a globally smooth scalar field's free values
//       pushed through C0 reproduce its dependent values.
//   [G3 local sparse C0: A*Csp~0, dim==dense, smooth reproduced, nnz~O(n).]
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include "bb_kl_strains.hpp"
#include <array>
#include <vector>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <climits>
#include <algorithm>
using namespace aeris;
template<class T> using V3t = std::array<T,3>;
static const double PI=3.14159265358979323846;
static double R=1.0,L=1.0;
static V3t<double> cyl(double x,double th){ return {R*std::cos(th),R*std::sin(th),x}; }

// dense incomplete-Gauss null-space of a (m x ncols) row-list (same as the driver's nullsp)
static std::vector<std::vector<double>> dense_nullsp(const std::vector<std::vector<double>>& Ain,
        int ncols, std::vector<int>&fcl, int&rank){
    std::vector<std::vector<double>> Rm=Ain; int m=Rm.size(); std::vector<int> piv; const double TOL=1e-9; int rr=0;
    for(int c=0;c<ncols&&rr<m;++c){ int pr=-1; double best=TOL;
        for(int r=rr;r<m;++r) if(std::fabs(Rm[r][c])>best){best=std::fabs(Rm[r][c]);pr=r;}
        if(pr<0) continue; std::swap(Rm[rr],Rm[pr]); double pv=Rm[rr][c];
        for(int j=0;j<ncols;++j)Rm[rr][j]/=pv;
        for(int r=0;r<m;++r) if(r!=rr){double f=Rm[r][c]; if(f!=0)for(int j=0;j<ncols;++j)Rm[r][j]-=f*Rm[rr][j];}
        piv.push_back(c); ++rr; }
    rank=piv.size(); std::vector<char> ip(ncols,0); for(int c:piv)ip[c]=1;
    fcl.clear(); for(int c=0;c<ncols;++c) if(!ip[c]) fcl.push_back(c); int nFs=fcl.size();
    std::vector<std::vector<double>> Cs(ncols,std::vector<double>(nFs,0.0));
    for(int f=0;f<nFs;++f){ Cs[fcl[f]][f]=1; for(int i=0;i<rank;++i) Cs[piv[i]][f]=-Rm[i][fcl[f]]; }
    return Cs;
}

// SPARSE incomplete-Gauss null-space: same algorithm as dense_nullsp but rows
// are stored sparsely (col->val maps) and the pivot ORDER is fill-reducing
// (Markowitz-ish: among remaining rows pick the shortest, pivot on its largest
// entry in an un-pivoted column). On a mesh-local constraint system this keeps
// the null-space basis functions LOCAL -> nnz(C) ~ O(n) instead of the dense
// free-pivot's global spread. Returns Cs as sparse columns (col -> sorted entries).
// SAME null-space as dense (genuine Gauss), so A*Cs=0 + dim match are exact gates.
typedef std::map<int,double> SRow;
// SPARSE incomplete-Gauss null-space, ROW-BASED (correct) + fill control. Every
// unprocessed row is either turned into a pivot row or found redundant (empty) ->
// guarantees a genuine null-space (A*Cs=0, correct dim), unlike a column-first
// scheme that can strand rows. Fill control: process the SHORTEST rows first, and
// within a row pick the pivot column of MIN live degree (fewest other rows) among
// stable entries -> eliminate "corner/rare" DOFs first -> LOCAL basis, nnz~O(n)
// instead of the dense free-pivot's global spread. Returns Cs[f]=sparse column f.
static std::vector<SRow> sparse_nullsp(const std::vector<std::vector<double>>& Ain,
        int ncols, std::vector<int>&fcl, int&rank){
    int m=Ain.size(); std::vector<SRow> Rm(m);
    for(int r=0;r<m;++r) for(int c=0;c<ncols;++c) if(std::fabs(Ain[r][c])>1e-14) Rm[r][c]=Ain[r][c];
    const double TOL=1e-9;
    std::vector<int> pivrow, pivcol;
    std::vector<char> usedRow(m,0), pivotedCol(ncols,0);
    std::vector<int> colCnt(ncols,0);                 // live degree (unprocessed rows holding c)
    std::vector<std::vector<int>> colRows(ncols);
    for(int r=0;r<m;++r) for(auto&kv:Rm[r]){ colCnt[kv.first]++; colRows[kv.first].push_back(r); }
    int remaining=m;
    while(remaining>0){
        // shortest unprocessed non-empty row (Markowitz row factor); drop empties
        int br=-1; size_t blen=SIZE_MAX;
        for(int r=0;r<m;++r){ if(usedRow[r])continue; if(Rm[r].empty()){usedRow[r]=1;--remaining;continue;}
            if(Rm[r].size()<blen){blen=Rm[r].size();br=r;} }
        if(br<0) break;
        // within br: pivot col = MIN live-degree stable (|val|>TOL) un-pivoted column
        int pc=-1; int bestdeg=INT_MAX;
        for(auto&kv:Rm[br]) if(!pivotedCol[kv.first] && std::fabs(kv.second)>TOL && colCnt[kv.first]<bestdeg){bestdeg=colCnt[kv.first];pc=kv.first;}
        if(pc<0){ usedRow[br]=1; --remaining; continue; }   // mass only in pivoted cols -> redundant
        double pv=Rm[br][pc]; for(auto&kv:Rm[br]) kv.second/=pv;
        usedRow[br]=1; --remaining; pivotedCol[pc]=1; pivrow.push_back(br); pivcol.push_back(pc);
        for(auto&kv:Rm[br]) colCnt[kv.first]--;     // br leaves the live set
        // FULL RREF: eliminate pc from EVERY other row holding it (live AND pivot rows),
        // so pivot rows keep only pivotcol+free cols -> the simple Cs formula is exact.
        std::vector<int> rows=colRows[pc];          // snapshot (may contain stale/dupes; find() guards)
        for(int r:rows){ if(r==br) continue; auto it=Rm[r].find(pc); if(it==Rm[r].end()) continue;
            double f=it->second; if(f==0) continue; bool live=!usedRow[r];
            for(auto&kv:Rm[br]){ int c=kv.first; double add=-f*kv.second;
                auto jt=Rm[r].find(c);
                if(jt==Rm[r].end()){ if(std::fabs(add)>1e-14){ Rm[r][c]=add; colRows[c].push_back(r); if(live)colCnt[c]++; } }
                else { jt->second+=add; if(std::fabs(jt->second)<1e-14){ Rm[r].erase(jt); if(live)colCnt[c]--; } } }
        }
    }
    rank=pivrow.size();
    fcl.clear(); for(int c=0;c<ncols;++c) if(!pivotedCol[c]) fcl.push_back(c);
    int nFs=fcl.size();
    std::vector<int> colToFree(ncols,-1); for(int f=0;f<nFs;++f) colToFree[fcl[f]]=f;
    std::vector<SRow> Cs(nFs);
    for(int f=0;f<nFs;++f) Cs[f][fcl[f]]=1.0;
    for(int i=0;i<rank;++i){ int pr=pivrow[i], pcl=pivcol[i];
        for(auto&kv:Rm[pr]){ int c=kv.first; if(c==pcl) continue; int f=colToFree[c];
            if(f>=0 && std::fabs(kv.second)>1e-14) Cs[f][pcl]=-kv.second; } }
    return Cs;
}

int main(int argc,char**argv){
    int Nx=3,Nt=8,p=5;
    if(argc>3){Nx=std::atoi(argv[1]);Nt=std::atoi(argv[2]);p=std::atoi(argv[3]);}
    BBTriangleBasis<double> B(p); int nK=B.size();
    int vc[3]={-1,-1,-1};
    for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
        if(a[0]==p&&a[1]==0&&a[2]==0)vc[0]=k; if(a[0]==0&&a[1]==p&&a[2]==0)vc[1]=k; if(a[0]==0&&a[1]==0&&a[2]==p)vc[2]=k;}
    struct Tri{ std::array<std::array<double,2>,3> pv; std::vector<V3t<double>> X; };
    std::vector<Tri> tris;
    auto pvert=[&](int i,int j){return std::array<double,2>{i*L/Nx,(2*PI)*j/Nt};};
    for(int i=0;i<Nx;++i)for(int j=0;j<Nt;++j){
        std::array<std::array<double,2>,3> A1={{pvert(i,j),pvert(i+1,j),pvert(i+1,j+1)}};
        std::array<std::array<double,2>,3> A2={{pvert(i,j),pvert(i+1,j+1),pvert(i,j+1)}};
        for(auto&pv:{A1,A2}){ Tri T; T.pv=pv; T.X.resize(nK);
            for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
                double px=(a[0]*pv[0][0]+a[1]*pv[1][0]+a[2]*pv[2][0])/p;
                double pt=(a[0]*pv[0][1]+a[1]*pv[1][1]+a[2]*pv[2][1])/p;
                T.X[k]=cyl(px,pt);} tris.push_back(T);} }
    int nT=tris.size();
    std::vector<V3t<double>> gpos; std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
    auto foa=[&](const V3t<double>&P){for(size_t i=0;i<gpos.size();++i)if(std::hypot(std::hypot(gpos[i][0]-P[0],gpos[i][1]-P[1]),gpos[i][2]-P[2])<1e-9)return(int)i;gpos.push_back(P);return(int)gpos.size()-1;};
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(tris[k].X[a]);
    int nCP=gpos.size();
    auto baryParam=[&](const Tri&T,const std::array<double,2>&P){double a=T.pv[1][0]-T.pv[0][0],b=T.pv[2][0]-T.pv[0][0],c=T.pv[1][1]-T.pv[0][1],dd=T.pv[2][1]-T.pv[0][1],det=a*dd-b*c;double px=P[0]-T.pv[0][0],py=P[1]-T.pv[0][1];return std::array<double,2>{(dd*px-b*py)/det,(-c*px+a*py)/det};};
    struct EdgeRef{int tri,e,g0,g1;};
    std::map<std::pair<int,int>,std::vector<EdgeRef>> em;
    for(int k=0;k<nT;++k)for(int e=0;e<3;++e){int g0=gmap[k][vc[e]],g1=gmap[k][vc[(e+1)%3]];std::pair<int,int> key=std::minmax(g0,g1);em[key].push_back({k,e,g0,g1});}
    // scalar C1 constraint rows (v-form), exact-geometry cylinder normal (= driver pass1)
    auto radial=[&](double th){ return V3t<double>{std::cos(th),std::sin(th),0.0}; };
    auto dot3=[&](const V3t<double>&a,const V3t<double>&b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];};
    auto cross3=[&](const V3t<double>&a,const V3t<double>&b){return V3t<double>{a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]};};
    std::vector<std::vector<double>> Asc;
    for(auto&kv:em){ if(kv.second.size()!=2)continue; const EdgeRef&M=kv.second[0],&S=kv.second[1];
        int gA=kv.first.first,gB=kv.first.second;
        for(int mm=0;mm<p;++mm){ double s=(mm+1.0)/(p+1.0); std::vector<double> row(nCP,0.0);
            for(int side=0;side<2;++side){ const EdgeRef&ER=(side==0?M:S); const Tri&T=tris[ER.tri]; double sign=(side==0?+1.0:-1.0);
                std::array<double,2> Ae,Be; if(ER.g0==gA){Ae=T.pv[ER.e];Be=T.pv[(ER.e+1)%3];}else{Ae=T.pv[(ER.e+1)%3];Be=T.pv[ER.e];}
                std::array<double,2> Pp={(1-s)*Ae[0]+s*Be[0],(1-s)*Ae[1]+s*Be[1]};
                auto bcA=baryParam(T,Ae),bcB=baryParam(T,Be); std::array<double,2> bc={(1-s)*bcA[0]+s*bcB[0],(1-s)*bcA[1]+s*bcB[1]};
                auto d=BasisDerivs::at(B,bc[0],bc[1]); Geom<double> G=Geom<double>::build(T.X,d);
                double t1=bcB[0]-bcA[0],t2=bcB[1]-bcA[1];
                V3t<double> AS{G.a1[0]*t1+G.a2[0]*t2,G.a1[1]*t1+G.a2[1]*t2,G.a1[2]*t1+G.a2[2]*t2};
                double an=std::sqrt(dot3(AS,AS)); for(int i=0;i<3;++i)AS[i]/=an;
                V3t<double> A3a=radial(Pp[1]); V3t<double> AN=cross3(A3a,AS);
                double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
                double r1=dot3(AN,G.a1),r2=dot3(AN,G.a2); double v1=(a22*r1-a12*r2)/det,v2=(-a12*r1+a11*r2)/det;
                for(int k=0;k<nK;++k) row[gmap[ER.tri][k]] += sign*(v1*d.N1[k]+v2*d.N2[k]);
            } Asc.push_back(row);
        } }
    int mR=Asc.size();
    printf("Cylinder BB mesh: Nx=%d Nt=%d p=%d | nT=%d nCP=%d  C1-constraint rows=%d\n",Nx,Nt,p,nT,nCP,mR);

    // ---- G0: dense reference null-space + density baseline ----
    std::vector<int> fcl; int rank;
    auto C0=dense_nullsp(Asc,nCP,fcl,rank); int nF=fcl.size();
    long nnz=0; for(int c=0;c<nCP;++c)for(int f=0;f<nF;++f) if(std::fabs(C0[c][f])>1e-12) ++nnz;
    double per_col=(double)nnz/std::max(nF,1), dens=100.0*nnz/((double)nCP*nF);
    printf("  [dense] rank=%d  null-dim nF=%d  nnz(C0)=%ld  avg %.1f/col  density %.1f%%\n",
           rank,nF,nnz,per_col,dens);

    // ---- G1: A*C0 ~ 0 over all rows (C0 is a genuine null-space basis) ----
    // span is then automatic: C0 has nF independent cols (identity on free rows)
    // and lies in null(A) of dim nCP-rank=nF -> it spans null(A) exactly.
    double e_AC=0;
    for(int r=0;r<mR;++r)for(int f=0;f<nF;++f){ double s=0; for(int c=0;c<nCP;++c) s+=Asc[r][c]*C0[c][f]; e_AC=std::max(e_AC,std::fabs(s)); }
    printf("  [dense] G1 ||A*C0||=%.2e  (null-space basis OK; spans null(A) since nF cols indep)\n",e_AC);

    // ==== 3-DOF system (the REAL driver pass2: scalar C1 x3 + SS-end pins) ====
    // This is what the driver actually inverts and where the density explodes
    // (measured: 947/col at R/t=20). Decisive test: does fill-reducing pivoting
    // help on THIS system, or is the density inherent?
    int nd=3*nCP;
    std::vector<std::vector<double>> A3;
    for(auto&row:Asc) for(int i=0;i<3;++i){ std::vector<double> r3(nd,0.0);
        for(int c=0;c<nCP;++c) if(row[c]!=0) r3[3*c+i]=row[c]; A3.push_back(r3); }
    auto pin=[&](int cp,int comp){ std::vector<double> r3(nd,0.0); r3[3*cp+comp]=1.0; A3.push_back(r3); };
    int firstEnd=-1;
    for(int cp=0;cp<nCP;++cp){ double z=gpos[cp][2];
        if(std::fabs(z)<1e-7||std::fabs(z-L)<1e-7){ pin(cp,0); pin(cp,1); if(firstEnd<0)firstEnd=cp; } }
    if(firstEnd>=0) pin(firstEnd,2);
    int mR3=A3.size();
    std::vector<int> f3d; int r3d; auto C3=dense_nullsp(A3,nd,f3d,r3d); int nF3=f3d.size();
    long nnz3=0; for(int c=0;c<nd;++c)for(int f=0;f<nF3;++f) if(std::fabs(C3[c][f])>1e-12) ++nnz3;
    std::vector<int> f3s; int r3s; auto C3s=sparse_nullsp(A3,nd,f3s,r3s); int nF3s=f3s.size();
    long nnz3s=0; for(auto&col:C3s) nnz3s+=col.size();
    double e3s=0; for(int r=0;r<mR3;++r)for(int f=0;f<nF3s;++f){double s=0;for(auto&kv:C3s[f])s+=A3[r][kv.first]*kv.second; e3s=std::max(e3s,std::fabs(s));}
    printf("  [3DOF] nd=%d rows=%d  dense: nF=%d nnz=%ld avg %.0f/col  | sparse: nF=%d nnz=%ld avg %.0f/col  A*Cs=%.1e  gain %.1fx\n",
           nd,mR3,nF3,nnz3,(double)nnz3/std::max(nF3,1),nF3s,nnz3s,(double)nnz3s/std::max(nF3s,1),e3s,
           ((double)nnz3/std::max(nF3,1))/std::max((double)nnz3s/std::max(nF3s,1),1e-9));

    // ---- G3: SPARSE null-space via fill-reducing sparse Gauss ----
    std::vector<int> fcl_s; int rank_s;
    auto Cs=sparse_nullsp(Asc,nCP,fcl_s,rank_s); int nFs=fcl_s.size();
    long nnz_s=0; for(auto&col:Cs) nnz_s+=col.size();
    double per_col_s=(double)nnz_s/std::max(nFs,1);
    // A*Cs over all rows (Cs[f] is a sparse column map col->val)
    double e_ACs=0;
    for(int r=0;r<mR;++r)for(int f=0;f<nFs;++f){ double s=0; for(auto&kv:Cs[f]) s+=Asc[r][kv.first]*kv.second; e_ACs=std::max(e_ACs,std::fabs(s)); }
    bool dim_ok=(nFs==nF), span_ok=(e_ACs<1e-8);
    printf("  [sparse] rank=%d  null-dim nFs=%d (dense %d)  nnz=%ld  avg %.1f/col (dense %.1f)\n",
           rank_s,nFs,nF,nnz_s,per_col_s,per_col);
    printf("  [sparse] G_dim %s   ||A*Cs||=%.2e %s   sparsity gain %.1fx\n",
           dim_ok?"PASS":"FAIL",e_ACs,span_ok?"PASS":"FAIL",per_col/std::max(per_col_s,1e-9));
    printf("\n%s\n", (dim_ok&&span_ok)
        ? "GATE 2 PASS: sparse Gauss reproduces the EXACT null-space (same dim, A*Cs=0)\n"
          "  with fewer nnz/col. Run several Nt to confirm avg nnz/col stays ~constant\n"
          "  (mesh-independent) -> then wire sparse_nullsp into the driver."
        : "GATE 2 FAIL: sparse null-space differs from dense -> do NOT wire into driver.");
    return (dim_ok&&span_ok)?0:1;
}
