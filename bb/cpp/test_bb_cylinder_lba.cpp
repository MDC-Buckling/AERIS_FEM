// Cylinder step 3c, part 3: CLOSED-cylinder axial LBA (Aeris BB). gismo-linked.
// Built on the seam-closure machinery (test_bb_cylinder_seam, 6-nullmode GREEN).
//
// Uniform axial membrane prestress N_xx=1 imposed DIRECTLY (closed cyl => uniform BY
// CONSTRUCTION, no free-edge boundary layer => the panel's (B) confounder is gone).
// SS (classical hinged) ends: pin radial+circumferential (= global x,y) at both end
// circles, axial (z) free + one z pinned to kill axial rigid translation.
// Generalized eig K_e phi = lambda K_geom phi ; sigma_cr = N_cr/t.
//
// READ AS A CLUSTER (user): the closed-cyl axial spectrum is densely near-degenerate
// at sigma_cl (Koiter circle; many (m,n) at ~same load), critical mode SHORT-wave
// (lambda~sqrt(Rt), n_cr~sqrt(R/t)). So: refine Nt AND Nx until the mesh resolves the
// sqrt(Rt) wavelength and the lowest CLUSTER converges; classify modes by (m axial,
// n circumferential). Target: sigma_cl = E t/(R sqrt(3(1-nu^2))), finite cyl lands
// AT/slightly ABOVE it. An UNDER-resolved mesh reads too-stiff (false overstiffness).
//
// Build:
//   g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//       -I/opt/gismo/external test_bb_cylinder_lba.cpp -L/opt/gismo/build/lib \
//       -lgismo -Wl,-rpath,/opt/gismo/build/lib -o tclba && ./tclba 2>/dev/null
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
#include <algorithm>
using namespace gismo;
using aeris::BBTriangleBasis; using aeris::BasisDerivs; using aeris::Bmat;
using aeris::analytic_B; using aeris::Geom; using aeris::V3; using aeris::dot3; using aeris::cross3;
using aeris::quad_triangle;
typedef gsEigen::Matrix<real_t,gsEigen::Dynamic,gsEigen::Dynamic> EMat;
static const double PI=3.14159265358979323846;
static const double R=1.0,L=1.0,E=1.0e6,nu=0.3;

static void eval3D_ABD(const V3<double>&a1,const V3<double>&a2,double thick,
                       gsMatrix<real_t>&A,gsMatrix<real_t>&D){
    gsMultiPatch<real_t> mp;mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));mp.embed(3);
    gsMatrix<real_t>&C=mp.patch(0).coefs();for(index_t r=0;r<C.rows();++r){double xi=C(r,0),eta=C(r,1);for(int i=0;i<3;++i)C(r,i)=xi*a1[i]+eta*a2[i];}
    gsFunctionExpr<real_t> t(std::to_string(thick),3),Ef(std::to_string(E),3),nuf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pars{&Ef,&nuf};gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,t,pars,o);gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);gsVector<real_t> pt(2);pt<<0.5,0.5;
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    A=ev.eval(ea.getCoeff(mmA),pt);A.resize(3,3);D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3);
}
static V3<double> cyl(double x,double th){ return {R*std::cos(th),R*std::sin(th),x}; }
static V3<double> radial(double th){ return {std::cos(th),std::sin(th),0.0}; }

struct Mode{ double sig; int m,n; };

static std::vector<Mode> run_lba(int Nx,int Nt,double thick,int p,int nmodes,int&out_nd,double&out_kemin){
    BBTriangleBasis<double> B(p); int nK=B.size();
    int vc[3]={-1,-1,-1};
    for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
        if(a[0]==p&&a[1]==0&&a[2]==0)vc[0]=k; if(a[0]==0&&a[1]==p&&a[2]==0)vc[1]=k; if(a[0]==0&&a[1]==0&&a[2]==p)vc[2]=k;}
    struct Tri{ std::array<std::array<double,2>,3> pv; std::vector<V3<double>> X; };
    std::vector<Tri> tris;
    auto pvert=[&](int i,int j){return std::array<double,2>{i*L/Nx,(2*PI)*j/Nt};};
    for(int i=0;i<Nx;++i)for(int j=0;j<Nt;++j){
        std::array<std::array<double,2>,3> A1={{pvert(i,j),pvert(i+1,j),pvert(i+1,j+1)}};
        std::array<std::array<double,2>,3> A2={{pvert(i,j),pvert(i+1,j+1),pvert(i,j+1)}};
        for(auto&pv:{A1,A2}){ Tri T; T.pv=pv; T.X.resize(nK);
            for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
                double px=(a[0]*pv[0][0]+a[1]*pv[1][0]+a[2]*pv[2][0])/p;
                double pt=(a[0]*pv[0][1]+a[1]*pv[1][1]+a[2]*pv[2][1])/p;
                T.X[k]=cyl(px,pt); } tris.push_back(T);} }
    int nT=tris.size();
    std::vector<V3<double>> gpos; std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
    auto foa=[&](const V3<double>&P){for(size_t i=0;i<gpos.size();++i)if(std::hypot(std::hypot(gpos[i][0]-P[0],gpos[i][1]-P[1]),gpos[i][2]-P[2])<1e-9)return(int)i;gpos.push_back(P);return(int)gpos.size()-1;};
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(tris[k].X[a]);
    int nCP=gpos.size();
    auto baryParam=[&](const Tri&T,const std::array<double,2>&P){double a=T.pv[1][0]-T.pv[0][0],b=T.pv[2][0]-T.pv[0][0],c=T.pv[1][1]-T.pv[0][1],dd=T.pv[2][1]-T.pv[0][1],det=a*dd-b*c;double px=P[0]-T.pv[0][0],py=P[1]-T.pv[0][1];return std::array<double,2>{(dd*px-b*py)/det,(-c*px+a*py)/det};};
    struct EdgeRef{int tri,e,g0,g1;};
    std::map<std::pair<int,int>,std::vector<EdgeRef>> em;
    for(int k=0;k<nT;++k)for(int e=0;e<3;++e){int g0=gmap[k][vc[e]],g1=gmap[k][vc[(e+1)%3]];std::pair<int,int> key=std::minmax(g0,g1);em[key].push_back({k,e,g0,g1});}
    auto buildAsc=[&](){ std::vector<std::vector<double>> Asc;
        for(auto&kv:em){ if(kv.second.size()!=2)continue; const EdgeRef&M=kv.second[0],&S=kv.second[1];
            int gA=kv.first.first,gB=kv.first.second;
            for(int mm=0;mm<p;++mm){ double s=(mm+1.0)/(p+1.0); std::vector<double> row(nCP,0.0);
                for(int side=0;side<2;++side){ const EdgeRef&ER=(side==0?M:S); const Tri&T=tris[ER.tri]; double sign=(side==0?+1.0:-1.0);
                    std::array<double,2> Ae,Be; if(ER.g0==gA){Ae=T.pv[ER.e];Be=T.pv[(ER.e+1)%3];}else{Ae=T.pv[(ER.e+1)%3];Be=T.pv[ER.e];}
                    std::array<double,2> Pp={(1-s)*Ae[0]+s*Be[0],(1-s)*Ae[1]+s*Be[1]};
                    auto bcA=baryParam(T,Ae),bcB=baryParam(T,Be); std::array<double,2> bc={(1-s)*bcA[0]+s*bcB[0],(1-s)*bcA[1]+s*bcB[1]};
                    auto d=BasisDerivs::at(B,bc[0],bc[1]); Geom<double> G=Geom<double>::build(T.X,d);
                    double t1=bcB[0]-bcA[0],t2=bcB[1]-bcA[1];
                    V3<double> AS{G.a1[0]*t1+G.a2[0]*t2,G.a1[1]*t1+G.a2[1]*t2,G.a1[2]*t1+G.a2[2]*t2};
                    double an=std::sqrt(dot3(AS,AS)); for(int i=0;i<3;++i)AS[i]/=an;
                    V3<double> A3a=radial(Pp[1]); V3<double> AN=cross3(A3a,AS);
                    double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
                    double r1=dot3(AN,G.a1),r2=dot3(AN,G.a2); double v1=(a22*r1-a12*r2)/det,v2=(-a12*r1+a11*r2)/det;
                    for(int k=0;k<nK;++k) row[gmap[ER.tri][k]] += sign*(v1*d.N1[k]+v2*d.N2[k]);
                } Asc.push_back(row);
            } } return Asc; };
    auto nullsp=[&](const std::vector<std::vector<double>>& Ain,int ncols,std::vector<int>&fcl,int&rank)->std::vector<std::vector<double>>{
        std::vector<std::vector<double>> Rm=Ain;int m=Rm.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
        for(int c=0;c<ncols&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(Rm[r][c])>best){best=std::fabs(Rm[r][c]);pr=r;}if(pr<0)continue;std::swap(Rm[rr],Rm[pr]);double pv=Rm[rr][c];for(int j=0;j<ncols;++j)Rm[rr][j]/=pv;for(int r=0;r<m;++r)if(r!=rr){double f=Rm[r][c];if(f!=0)for(int j=0;j<ncols;++j)Rm[r][j]-=f*Rm[rr][j];}piv.push_back(c);++rr;}
        rank=piv.size();std::vector<char> ip(ncols,0);for(int c:piv)ip[c]=1;fcl.clear();for(int c=0;c<ncols;++c)if(!ip[c])fcl.push_back(c);int nFs=fcl.size();
        std::vector<std::vector<double>> Cs(ncols,std::vector<double>(nFs,0.0));for(int f=0;f<nFs;++f){Cs[fcl[f]][f]=1;for(int i=0;i<rank;++i)Cs[piv[i]][f]=-Rm[i][fcl[f]];} return Cs;};
    // pass1: scalar C1 -> geom_C1
    std::vector<int> fcl0;int rank0; auto C0=nullsp(buildAsc(),nCP,fcl0,rank0); int nFs0=fcl0.size();
    std::vector<V3<double>> geomC1(nCP);
    for(int cp=0;cp<nCP;++cp)for(int c=0;c<3;++c){double s=0;for(int f=0;f<nFs0;++f)s+=C0[cp][f]*gpos[fcl0[f]][c];geomC1[cp][c]=s;}
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)tris[k].X[a]=geomC1[gmap[k][a]];
    // pass2: joint 3-DOF constraint = scalar C1 (x3 comps) + SS-end BC
    auto Asc=buildAsc(); int nd=3*nCP; out_nd=nd;
    std::vector<std::vector<double>> A3;
    for(auto&row:Asc) for(int i=0;i<3;++i){ std::vector<double> r3(nd,0.0); for(int cp=0;cp<nCP;++cp) if(row[cp]!=0) r3[3*cp+i]=row[cp]; A3.push_back(r3); }
    auto pin=[&](int cp,int comp){ std::vector<double> r3(nd,0.0); r3[3*cp+comp]=1.0; A3.push_back(r3); };
    int firstEnd=-1;
    for(int cp=0;cp<nCP;++cp){ double z=geomC1[cp][2];
        if(std::fabs(z)<1e-7||std::fabs(z-L)<1e-7){ pin(cp,0); pin(cp,1); if(firstEnd<0)firstEnd=cp; } }  // SS: x,y pinned at both ends
    if(firstEnd>=0) pin(firstEnd,2);   // kill axial rigid translation
    std::vector<int> fcl;int rank; auto Cs=nullsp(A3,nd,fcl,rank); int nF=fcl.size();
    EMat C(nd,nF); for(int i=0;i<nd;++i)for(int f=0;f<nF;++f)C(i,f)=Cs[i][f];
    // K_e + K_geom (uniform axial N_xx=1)
    EMat Kf=EMat::Zero(nd,nd), Kg=EMat::Zero(nd,nd);
    V3<double> tax{0,0,1};
    for(int k=0;k<nT;++k){ const Tri&T=tris[k];
        for(auto&q:quad_triangle(2*p)){ auto d=BasisDerivs::at(B,q.xi1,q.xi2); Geom<double> G=Geom<double>::build(T.X,d);
            gsMatrix<real_t> A,D; eval3D_ABD(G.a1,G.a2,thick,A,D);
            double Jac=G.jbar; Bmat Bm,Bb; analytic_B(T.X,d,Bm,Bb);
            double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
            double ta1=dot3(tax,G.a1),ta2=dot3(tax,G.a2);
            double c1=(a22*ta1-a12*ta2)/det,c2=(a11*ta2-a12*ta1)/det;
            std::vector<double> g(nK); for(int a=0;a<nK;++a) g[a]=c1*d.N1[a]+c2*d.N2[a];
            for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*gmap[k][a]+i;
                for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*gmap[k][b]+j;
                    double v=0; for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s2=0;s2<3;++s2){Am+=A(r,s2)*Bm.at(s2,3*b+j);Dm+=D(r,s2)*Bb.at(s2,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                    Kf(ga,gb)+=q.w*Jac*v; if(i==j)Kg(ga,gb)+=q.w*Jac*g[a]*g[b]; }}
        }}
    EMat Ke=C.transpose()*Kf*C, Kge=C.transpose()*Kg*C;
    gsEigen::SelfAdjointEigenSolver<EMat> esKe(Ke); out_kemin=esKe.eigenvalues()(0)/esKe.eigenvalues()(nF-1);
    gsEigen::GeneralizedSelfAdjointEigenSolver<EMat> ges(Kge,Ke);
    auto mu=ges.eigenvalues(); auto V=ges.eigenvectors();
    // grid for mode (m,n) classification
    const int NXS=9,NTS=33;
    std::vector<double> gx,gth; for(int ia=0;ia<NXS;++ia)for(int it=0;it<NTS;++it){gx.push_back(L*ia/(NXS-1));gth.push_back(2*PI*it/(NTS-1));}
    struct Loc{int tri;std::vector<double>N;double th;};
    std::vector<Loc> loc(gx.size());
    for(size_t s=0;s<gx.size();++s){std::array<double,2>P{gx[s],gth[s]};int f=-1;std::array<double,2>bc{};
        for(int k=0;k<nT;++k){auto b=baryParam(tris[k],P);double b0=1-b[0]-b[1];if(b[0]>=-1e-7&&b[1]>=-1e-7&&b0>=-1e-7){f=k;bc=b;break;}}
        Loc Lc;Lc.tri=f;Lc.th=gth[s];Lc.N.assign(nK,0.0);if(f>=0)for(int k=0;k<nK;++k)Lc.N[k]=B.eval_one(k,bc[0],bc[1]);loc[s]=Lc;}
    auto wavenums=[&](const std::vector<double>&w,int&m,int&n){double mx=0;for(double v:w)mx=std::max(mx,std::fabs(v));double tol=0.1*mx;
        n=0;for(int ia=0;ia<NXS;++ia){int sc=0;double pv=0;for(int it=0;it<NTS;++it){double v=w[ia*NTS+it];if(std::fabs(v)<tol)continue;if(pv!=0&&(v>0)!=(pv>0))++sc;pv=v;}n=std::max(n,sc);}
        m=0;for(int it=0;it<NTS;++it){int sc=0;double pv=0;for(int ia=0;ia<NXS;++ia){double v=w[ia*NTS+it];if(std::fabs(v)<tol)continue;if(pv!=0&&(v>0)!=(pv>0))++sc;pv=v;}m=std::max(m,sc);}};
    std::vector<Mode> out;
    for(int i=0;i<nmodes;++i){int col=nF-1-i;if(col<0)break;double m=mu(col);if(!(m>0))continue;
        EMat phi=V.col(col); EMat uf=C*phi;
        std::vector<double> w(gx.size(),0.0);
        for(size_t s=0;s<gx.size();++s){const Loc&Lc=loc[s];if(Lc.tri<0)continue;V3<double>rd=radial(Lc.th);double ww=0;
            for(int k=0;k<nK;++k){int cp=gmap[Lc.tri][k];ww+=Lc.N[k]*(uf(3*cp,0)*rd[0]+uf(3*cp+1,0)*rd[1]+uf(3*cp+2,0)*rd[2]);}w[s]=ww;}
        int mm,nn; wavenums(w,mm,nn); out.push_back({(1.0/m)/thick,mm,nn});
    }
    return out;
}

int main(int argc,char**argv){
    double thick=0.05; int p=5, nmodes=8;
    double sigma_cl=E*thick/(R*std::sqrt(3.0*(1-nu*nu)));
    printf("CLOSED cylinder axial LBA (BB).  R/t=%.0f t=%g  sqrt(Rt)=%.3f  n_cr~sqrt(R/t)=%.1f\n",R/thick,thick,std::sqrt(R*thick),std::sqrt(R/thick));
    printf("  sigma_cl = E t/(R sqrt(3(1-nu^2))) = %.6g  (finite cyl: AT/slightly ABOVE, converged)\n",sigma_cl);
    printf("  SS hinged ends, uniform N_xx=1 imposed. Read the lowest CLUSTER + (m,n), not bare min.\n\n");
    // mesh sweep: refine Nt (circumferential, resolves n_cr) and Nx (axial)
    std::vector<std::pair<int,int>> meshes;
    if(argc>2){meshes.push_back({std::atoi(argv[1]),std::atoi(argv[2])});}
    else { meshes={{4,12},{4,16},{4,20}}; }
    for(auto&mp:meshes){ int Nx=mp.first,Nt=mp.second,nd=0; double kemin=0;
        auto modes=run_lba(Nx,Nt,thick,p,nmodes,nd,kemin);
        printf("  Nx=%d Nt=%d (nd=%d, Ke cond min/max=%.1e):\n",Nx,Nt,nd,kemin);
        printf("    lowest cluster: ");
        for(auto&m:modes) printf("[m%d n%d sig=%.5g (%.2f sig_cl)] ",m.m,m.n,m.sig,m.sig/sigma_cl);
        printf("\n");
    }
    printf("\nConverged lowest cluster sitting at/just above sigma_cl=%.6g => curved BB element K_geom validated.\n",sigma_cl);
    return 0;
}
