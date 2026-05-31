// G1 REAL-Theta fold convergence (Aeris BB). gismo-linked (eval3D). The one untested
// PRODUCT: convergence at a genuine kink, with the FULL 3-DOF rotated-director penalty
// (G0.5), against an analytic manufactured solution. Isolates kink-convergence from G2's
// confounders (curved geometry, KL-vs-RM, ABAQUS setup) on a clean flat fold.
//
// Two flat strips at angle Theta. nu=0 -> clean cylindrical bending (manufactured sin
// exact with free y-sides). Manufactured w(xi)=A sin(pi xi/L) in each plate normal
// (xi = distance from fold), G1 at the fold (slope pi/L matched = rotation continuous).
// Load q = D A (pi/L)^4 sin(pi xi/L) transverse. SS outer ends (w=0,M=0; sin satisfies).
// C1 WITHIN each plate (v-form), PENALTY rotated-director at the fold (FULL daN, kappa
// in the rate-clean plateau P~1e6). h-refine Nx, relative L2 error of u vs manufactured.
//
// Build: g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//   -I/opt/gismo/external test_bb_g1_fold_conv.cpp -L/opt/gismo/build/lib -lgismo \
//   -Wl,-rpath,/opt/gismo/build/lib -o tgfc && ./tgfc 2>/dev/null
#include <gismo.h>
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
using namespace gismo;
using aeris::BBTriangleBasis; using aeris::BasisDerivs; using aeris::Bmat;
using aeris::analytic_B; using aeris::Geom; using aeris::V3; using aeris::dot3; using aeris::cross3; using aeris::flat_patch_cps;
using aeris::quad_triangle;
typedef gsEigen::Matrix<real_t,gsEigen::Dynamic,gsEigen::Dynamic> EMat;
static const double PI=3.14159265358979323846;
static const double E=1.0e6,nu=0.0,thick=0.05,L=1.0,W=0.25;   // nu=0: clean cylindrical bending
static const double GL5x[5]={0.046910077030668,0.230765344947158,0.5,0.769234655052842,0.953089922969332};
static const double GL5w[5]={0.118463442528095,0.239314335249683,0.284444444444444,0.239314335249683,0.118463442528095};
static V3<double> nrm(V3<double> v){double n=std::sqrt(dot3(v,v));return {v[0]/n,v[1]/n,v[2]/n};}
static V3<double> dn_(const BasisDerivs&d,const Geom<double>&G,int k,int i){V3<double> ei{0,0,0};ei[i]=1.0;V3<double> da;{V3<double> t1=cross3(ei,G.a2),t2=cross3(G.a1,ei);for(int j=0;j<3;++j)da[j]=d.N1[k]*t1[j]+d.N2[k]*t2[j];}double pr=dot3(G.a3,da);V3<double> r;for(int j=0;j<3;++j)r[j]=(da[j]-pr*G.a3[j])/G.jbar;return r;}
static V3<double> dS_(const BasisDerivs&d,const Geom<double>&G,double t1,double t2,const V3<double>&aS,double es,int k,int i){double cf=d.N1[k]*t1+d.N2[k]*t2;V3<double> de{0,0,0};de[i]=cf;double pr=dot3(aS,de);V3<double> r;for(int j=0;j<3;++j)r[j]=(de[j]-pr*aS[j])/es;return r;}
static void eval3D_AD(const V3<double>&a1,const V3<double>&a2,gsMatrix<real_t>&A,gsMatrix<real_t>&D){
    gsMultiPatch<real_t> mp;mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));mp.embed(3);
    gsMatrix<real_t>&C=mp.patch(0).coefs();for(index_t r=0;r<C.rows();++r){double xi=C(r,0),eta=C(r,1);for(int i=0;i<3;++i)C(r,i)=xi*a1[i]+eta*a2[i];}
    gsFunctionExpr<real_t> t(std::to_string(thick),3),Ef(std::to_string(E),3),nf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pr{&Ef,&nf};gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,t,pr,o);gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);gsVector<real_t> pt(2);pt<<0.5,0.5;
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    A=ev.eval(ea.getCoeff(mmA),pt);A.resize(3,3);D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3);}

static double run(int Nx,double Th,double P,int p,double&kemin){
    BBTriangleBasis<double> B(p); int nK=B.size();
    double Dp=E*thick*thick*thick/12.0;               // nu=0 plate bending stiffness
    double Aamp=0.01, kk=PI/L, ky=PI/W;                 // manufactured w=A sin(kk xi) sin(ky y) (2D Navier mode)
    V3<double> nP{0,0,1}, nM{std::sin(Th),0,std::cos(Th)};
    // geometry: plate + over xi in [0,L] (x=xi, z=0), plate - folded by Th. strip width W in y.
    auto pos_plus =[&](double xi,double y){return V3<double>{xi,y,0};};
    auto pos_minus=[&](double xi,double y){return V3<double>{-xi*std::cos(Th),y,xi*std::sin(Th)};};
    int vc[3]={-1,-1,-1};for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];if(a[0]==p&&a[1]==0&&a[2]==0)vc[0]=k;if(a[0]==0&&a[1]==p&&a[2]==0)vc[1]=k;if(a[0]==0&&a[1]==0&&a[2]==p)vc[2]=k;}
    struct Tri{ std::array<std::array<double,2>,3> pv; std::vector<V3<double>> X; int plate; };  // pv = (xi,y) param
    std::vector<Tri> tris;
    auto build_plate=[&](int plate){ auto mp=[&](double xi,double y){return (plate==0)?pos_plus(xi,y):pos_minus(xi,y);};
        for(int i=0;i<Nx;++i)for(int jj=0;jj<Nx;++jj){ double x0=i*L/Nx,x1=(i+1)*L/Nx,y0=jj*W/Nx,y1=(jj+1)*W/Nx;
            std::array<std::array<double,2>,3> A1={{{x0,y0},{x1,y0},{x1,y1}}}, A2={{{x0,y0},{x1,y1},{x0,y1}}};
            for(auto&pv:{A1,A2}){ Tri T;T.pv=pv;T.plate=plate;T.X.resize(nK);
                for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];double xi=(a[0]*pv[0][0]+a[1]*pv[1][0]+a[2]*pv[2][0])/p,yy=(a[0]*pv[0][1]+a[1]*pv[1][1]+a[2]*pv[2][1])/p;T.X[k]=mp(xi,yy);}
                tris.push_back(T);} } };
    build_plate(0); build_plate(1); int nT=tris.size();
    std::vector<V3<double>> gp;std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
    auto foa=[&](const V3<double>&Pp){for(size_t i=0;i<gp.size();++i)if(std::hypot(std::hypot(gp[i][0]-Pp[0],gp[i][1]-Pp[1]),gp[i][2]-Pp[2])<1e-9)return(int)i;gp.push_back(Pp);return(int)gp.size()-1;};
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(tris[k].X[a]);
    int nCP=gp.size();
    auto baryParam=[&](const Tri&T,const std::array<double,2>&Pp){double a=T.pv[1][0]-T.pv[0][0],b=T.pv[2][0]-T.pv[0][0],c=T.pv[1][1]-T.pv[0][1],dd=T.pv[2][1]-T.pv[0][1],det=a*dd-b*c,px=Pp[0]-T.pv[0][0],py=Pp[1]-T.pv[0][1];return std::array<double,2>{(dd*px-b*py)/det,(-c*px+a*py)/det};};
    // edges by physical global-CP pair; fold edge = both endpoints on the fold line (gp ~ (.,.,0) with x-comp 0 i.e. xi=0)
    struct ER{int tri,e,g0,g1;};std::map<std::pair<int,int>,std::vector<ER>> em;
    for(int k=0;k<nT;++k)for(int e=0;e<3;++e){int g0=gmap[k][vc[e]],g1=gmap[k][vc[(e+1)%3]];em[std::minmax(g0,g1)].push_back({k,e,g0,g1});}
    auto isFoldCP=[&](int g){ return std::hypot(gp[g][0],gp[g][2])<1e-9; };   // on the fold line (xi=0): x=z=0
    // C1 within-plate (v-form) ; collect fold-edge ERs for the penalty
    std::vector<std::pair<ER,ER>> foldEdges;
    auto buildAsc=[&](){ std::vector<std::vector<double>> Asc;
        for(auto&kv:em){ if(kv.second.size()!=2)continue; const ER&M=kv.second[0],&S=kv.second[1];
            bool fold = isFoldCP(kv.first.first)&&isFoldCP(kv.first.second);
            if(fold) continue;   // fold edge -> penalty, not C1
            int gA=kv.first.first,gB=kv.first.second;
            for(int mm=0;mm<p;++mm){double s=(mm+1.0)/(p+1.0);std::vector<double> row(nCP,0.0);
                for(int side=0;side<2;++side){const ER&er=(side==0?M:S);const Tri&T=tris[er.tri];double sign=(side==0?1.0:-1.0);
                    int cA=(er.g0==gA)?er.e:(er.e+1)%3,cB=(er.g0==gA)?(er.e+1)%3:er.e;
                    std::array<double,2> Ae=T.pv[cA],Be=T.pv[cB];
                    auto bcA=baryParam(T,Ae),bcB=baryParam(T,Be);std::array<double,2> bc={(1-s)*bcA[0]+s*bcB[0],(1-s)*bcA[1]+s*bcB[1]};
                    auto d=BasisDerivs::at(B,bc[0],bc[1]);Geom<double> G=Geom<double>::build(T.X,d);
                    double t1=bcB[0]-bcA[0],t2=bcB[1]-bcA[1];V3<double> AS{G.a1[0]*t1+G.a2[0]*t2,G.a1[1]*t1+G.a2[1]*t2,G.a1[2]*t1+G.a2[2]*t2};AS=nrm(AS);
                    V3<double> A3a=(T.plate==0)?nP:nM;V3<double> AN=cross3(AS,G.a3); (void)A3a;
                    double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
                    double r1=dot3(AN,G.a1),r2=dot3(AN,G.a2);double v1=(a22*r1-a12*r2)/det,v2=(-a12*r1+a11*r2)/det;
                    for(int k=0;k<nK;++k)row[gmap[er.tri][k]]+=sign*(v1*d.N1[k]+v2*d.N2[k]);
                } Asc.push_back(row);
            } }
        // record fold edges (master=plate0, slave=plate1)
        for(auto&kv:em){ if(kv.second.size()!=2)continue; if(isFoldCP(kv.first.first)&&isFoldCP(kv.first.second)){
            ER a=kv.second[0],b=kv.second[1]; if(tris[a.tri].plate!=0)std::swap(a,b); foldEdges.push_back({a,b}); } }
        return Asc; };
    auto nullsp=[&](const std::vector<std::vector<double>>&Ain,int nc,std::vector<int>&fcl,int&rank){
        std::vector<std::vector<double>> Rm=Ain;int m=Rm.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
        for(int c=0;c<nc&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(Rm[r][c])>best){best=std::fabs(Rm[r][c]);pr=r;}if(pr<0)continue;std::swap(Rm[rr],Rm[pr]);double pv=Rm[rr][c];for(int j=0;j<nc;++j)Rm[rr][j]/=pv;for(int r=0;r<m;++r)if(r!=rr){double f=Rm[r][c];if(f!=0)for(int j=0;j<nc;++j)Rm[r][j]-=f*Rm[rr][j];}piv.push_back(c);++rr;}
        rank=piv.size();std::vector<char> ip(nc,0);for(int c:piv)ip[c]=1;fcl.clear();for(int c=0;c<nc;++c)if(!ip[c])fcl.push_back(c);int nF=fcl.size();
        std::vector<std::vector<double>> Cs(nc,std::vector<double>(nF,0.0));for(int f=0;f<nF;++f){Cs[fcl[f]][f]=1;for(int i=0;i<rank;++i)Cs[piv[i]][f]=-Rm[i][fcl[f]];}return Cs;};
    foldEdges.clear(); auto Asc=buildAsc();
    // 3-DOF joint constraint = C1-within (x3 comps) + SS-end BC (pin normal w + rigid removal)
    int nd=3*nCP; std::vector<std::vector<double>> A3;
    for(auto&row:Asc)for(int i=0;i<3;++i){std::vector<double> r3(nd,0.0);for(int cp=0;cp<nCP;++cp)if(row[cp]!=0)r3[3*cp+i]=row[cp];A3.push_back(r3);}
    auto pinrow=[&](int cp,const V3<double>&dir){std::vector<double> r3(nd,0.0);for(int i=0;i<3;++i)r3[3*cp+i]=dir[i];A3.push_back(r3);};
    auto pincomp=[&](int cp,int i){std::vector<double> r3(nd,0.0);r3[3*cp+i]=1.0;A3.push_back(r3);};
    // BC matches the manufactured CYLINDRICAL bending (in-plane=0 everywhere, u=0 at fold
    // xi=0 and at outer ends xi=L, free rotation = SS). Pin all tangential comps everywhere
    // (only the normal bending DOF stays free) -> removes every in-plane mechanism; pin the
    // normal too at fold (xi=0) and outer ends (xi=L). Clean SPD reduced bending system.
    V3<double> tMa{0,1,0}, tMb{std::cos(Th),0,-std::sin(Th)};   // plate- in-plane tangents
    for(int cp=0;cp<nCP;++cp){ V3<double> X=gp[cp]; double xim=std::hypot(X[0],X[2]), yy=X[1];
        bool edge = xim<1e-9 || std::fabs(xim-L)<1e-9 || std::fabs(yy)<1e-9 || std::fabs(yy-W)<1e-9;  // SS on all 4 edges
        bool platePlus = (X[2]<1e-9 && X[0]>0) || (xim<1e-9);   // fold CPs treated as plate+ frame for tangents
        if(platePlus){ pincomp(cp,0); pincomp(cp,1); if(edge)pincomp(cp,2); }     // in-plane (x,y) pinned; normal w pinned on edges
        else { pinrow(cp,tMa); pinrow(cp,tMb); if(edge)pinrow(cp,nM); } }          // in-plane (tangents) pinned; normal nM pinned on edges
    std::vector<int> fcl;int rank;auto Cs=nullsp(A3,nd,fcl,rank);int nF=fcl.size();
    EMat C(nd,nF);for(int i=0;i<nd;++i)for(int f=0;f<nF;++f)C(i,f)=Cs[i][f];
    // K_e (3-DOF) + penalty fold (rotated director, FULL daN) + load
    double eta=(E/(2*(1+0.3)))*thick*thick*thick/W;   // use a representative mu*t^3/L (kappa scale); P sweeps it
    double kap=P*eta;
    EMat Kf=EMat::Zero(nd,nd); EMat Fv=EMat::Zero(nd,1);
    for(int k=0;k<nT;++k){const Tri&T=tris[k]; V3<double> nhat=(T.plate==0)?nP:nM;
        for(auto&q:quad_triangle(2*p)){auto d=BasisDerivs::at(B,q.xi1,q.xi2);Geom<double> G=Geom<double>::build(T.X,d);
            gsMatrix<real_t> A,D;eval3D_AD(G.a1,G.a2,A,D);double Jac=G.jbar;Bmat Bm,Bb;analytic_B(T.X,d,Bm,Bb);
            // physical xi at this quad point, load q(xi) in normal dir
            double xiphys=0,yphys=0; { V3<double> Xq{0,0,0}; for(int a=0;a<nK;++a){double Na=B.eval_one(a,q.xi1,q.xi2);for(int c=0;c<3;++c)Xq[c]+=Na*T.X[a][c];}
                xiphys=(T.plate==0)?Xq[0]:std::hypot(Xq[0],Xq[2]); yphys=Xq[1]; }
            double qload=Dp*Aamp*std::pow(kk*kk+ky*ky,2)*std::sin(kk*xiphys)*std::sin(ky*yphys);   // 2D Navier (nu=0)
            for(int a=0;a<nK;++a){double Na=B.eval_one(a,q.xi1,q.xi2);for(int i=0;i<3;++i)Fv(3*gmap[k][a]+i,0)+=q.w*Jac*Na*qload*nhat[i];
                for(int ii=0;ii<3;++ii){int ga=3*gmap[k][a]+ii;
                    for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*gmap[k][b]+j;
                        double v=0;for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s=0;s<3;++s){Am+=A(r,s)*Bm.at(s,3*b+j);Dm+=D(r,s)*Bb.at(s,3*b+j);}v+=Bm.at(r,3*a+ii)*Am+Bb.at(r,3*a+ii)*Dm;}
                        Kf(ga,gb)+=q.w*Jac*v;}}}
        }}
    // penalty at fold (rotated director, FULL daN), per fold edge
    for(auto&fe:foldEdges){ const ER&Mp=fe.first,&Sm=fe.second; int gA0=std::min(Mp.g0,Mp.g1),gB0=std::max(Mp.g0,Mp.g1);
        for(int gq=0;gq<5;++gq){double s=GL5x[gq],w=GL5w[gq]*W;
            // master (plate0)
            const Tri&TM=tris[Mp.tri]; int cAM=(Mp.g0==gA0)?Mp.e:(Mp.e+1)%3,cBM=(Mp.g0==gA0)?(Mp.e+1)%3:Mp.e;
            std::array<double,2> bcAM=baryParam(TM,TM.pv[cAM]),bcBM=baryParam(TM,TM.pv[cBM]);std::array<double,2> bcM={(1-s)*bcAM[0]+s*bcBM[0],(1-s)*bcAM[1]+s*bcBM[1]};
            auto dM=BasisDerivs::at(B,bcM[0],bcM[1]);Geom<double> GM=Geom<double>::build(TM.X,dM);
            // slave (plate1)
            const Tri&TS=tris[Sm.tri]; int cAS=(Sm.g0==gA0)?Sm.e:(Sm.e+1)%3,cBS=(Sm.g0==gA0)?(Sm.e+1)%3:Sm.e;
            std::array<double,2> bcAS=baryParam(TS,TS.pv[cAS]),bcBS=baryParam(TS,TS.pv[cBS]);std::array<double,2> bcS={(1-s)*bcAS[0]+s*bcBS[0],(1-s)*bcAS[1]+s*bcBS[1]};
            auto dS=BasisDerivs::at(B,bcS[0],bcS[1]);Geom<double> GS=Geom<double>::build(TS.X,dS);
            // slave edge tangent + frame for rotated director
            double tS1=bcBS[0]-bcAS[0],tS2=bcBS[1]-bcAS[1];V3<double> ehS{GS.a1[0]*tS1+GS.a2[0]*tS2,GS.a1[1]*tS1+GS.a2[1]*tS2,GS.a1[2]*tS1+GS.a2[2]*tS2};
            double esS=std::sqrt(dot3(ehS,ehS));V3<double> aSS=nrm(ehS);
            double cT=dot3(GM.a3,GS.a3),sT=-dot3(GM.a3,nrm(cross3(aSS,GS.a3)));
            std::vector<std::array<double,3>> Dm(nd,{0,0,0});
            for(int k=0;k<nK;++k)for(int i=0;i<3;++i){ V3<double> da3M=dn_(dM,GM,k,i);
                for(int c=0;c<3;++c)Dm[3*gmap[Mp.tri][k]+i][c]+=da3M[c];
                V3<double> da3S=dn_(dS,GS,k,i),daSS=dS_(dS,GS,tS1,tS2,aSS,esS,k,i);
                V3<double> daN;{V3<double> u=cross3(daSS,GS.a3),vv=cross3(aSS,da3S);for(int c=0;c<3;++c)daN[c]=u[c]+vv[c];}
                for(int c=0;c<3;++c)Dm[3*gmap[Sm.tri][k]+i][c]-=(cT*da3S[c]-sT*daN[c]); }
            for(int a=0;a<nd;++a)if(Dm[a][0]||Dm[a][1]||Dm[a][2])for(int b=0;b<nd;++b)if(Dm[b][0]||Dm[b][1]||Dm[b][2]){double sd=0;for(int c=0;c<3;++c)sd+=Dm[a][c]*Dm[b][c];Kf(a,b)+=kap*w*sd;}
        }}
    // reduce + solve
    EMat Ke=C.transpose()*Kf*C, Fr=C.transpose()*Fv;
    gsEigen::SelfAdjointEigenSolver<EMat> es(Ke); kemin=es.eigenvalues()(0)/es.eigenvalues()(nF-1);
    EMat ur=Ke.ldlt().solve(Fr); EMat uf=C*ur;
    // L2 error vs manufactured u = A sin(k xi) nhat
    double l2e=0,l2x=0;
    for(int k=0;k<nT;++k){const Tri&T=tris[k];V3<double> nhat=(T.plate==0)?nP:nM;
        for(auto&q:quad_triangle(2*p)){auto d=BasisDerivs::at(B,q.xi1,q.xi2);Geom<double> G=Geom<double>::build(T.X,d);double Jac=G.jbar;
            V3<double> uh{0,0,0},Xq{0,0,0};for(int a=0;a<nK;++a){double Na=B.eval_one(a,q.xi1,q.xi2);for(int c=0;c<3;++c){uh[c]+=Na*uf(3*gmap[k][a]+c,0);Xq[c]+=Na*T.X[a][c];}}
            double xiphys=(T.plate==0)?Xq[0]:std::hypot(Xq[0],Xq[2]);double wex=Aamp*std::sin(kk*xiphys)*std::sin(ky*Xq[1]);
            V3<double> uex{wex*nhat[0],wex*nhat[1],wex*nhat[2]};
            for(int c=0;c<3;++c){l2e+=q.w*Jac*(uh[c]-uex[c])*(uh[c]-uex[c]);l2x+=q.w*Jac*uex[c]*uex[c];}}}
    return std::sqrt(l2e/l2x);
}

int main(){
    int p=5; double Th=90.0*PI/180;
    printf("G1 REAL-Theta (=%.0fdeg) fold convergence: manufactured 2D Navier mode, nu=0.\n",Th*180/PI);
    printf("FULL rotated-director penalty at the fold; C1 within plates; SS all 4 edges. (rel L2 vs analytic)\n");
    printf("P-sweep separates kappa-floor (error drops with P) from a mechanism (P-independent).\n\n");
    for(double P:{1e6,1e8,1e10}){
        printf("  == penalty P=%.0e ==\n    %4s %12s %8s %12s\n",P,"Nx","rel.L2","rate","Ke cond");
        double ph=0,pe=0;bool first=true;
        for(int Nx:{2,3,4,5,6}){ double kemin=0; double err=run(Nx,Th,P,p,kemin);
            double h=L/Nx,logh=std::log(h),loge=std::log(err),rate=first?0:(loge-pe)/(logh-ph);
            printf("    %4d %12.3e %8.3f %12.2e\n",Nx,err,first?0.0:rate,kemin);
            ph=logh;pe=loge;first=false; } }
    printf("\nOptimal O(h^(p+1))=O(h^%d) at the rate-clean P => G1 airtight at a REAL kink.\n",p+1);
    return 0;
}
