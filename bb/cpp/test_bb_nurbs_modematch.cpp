// Cylinder step 3b-LBA (1): CONVERGED + MODE-MATCHED + BC-matched BB-vs-NURBS panel
// buckling, as the GATE before any locking verdict (Aeris BB). gismo-linked.
//
// The raw 3b-LBA table showed BB ~2.5x stiffer than the NURBS panel at R/t=20.
// Before calling that "locking" we must remove three confounders (per the brief):
//   (a) NON-CONVERGENCE: refine BB in Nx AND Nt (Nt counts double: hoop curvature
//       AND circumferential waves) and NURBS in r until each self-converges.
//   (b) MODE MISMATCH: shells have a dense near-degenerate buckling spectrum, so
//       "smallest vs smallest" is likely different mode shapes. We reconstruct the
//       radial buckling displacement w(x,theta) of the lowest modes of BOTH on ONE
//       common grid, classify each by wave numbers (m axial, n circumferential),
//       and compare eigenvalues of the SAME (m,n) mode.
//   (c) BC MISMATCH: the rotation-free support (hinged vs clamped) is imposed
//       differently on a triangle CP net vs a NURBS patch; a clamp-vs-hinge mix
//       makes BB stiffer and masquerades as locking. Both sides here are HINGED
//       (bottom-edge displacement pinned, rotation FREE: BB pins only the boundary
//       CP row, NURBS uses Dirichlet-displacement with NO Clamped). BB-clamped
//       sensitivity is probed separately (--bbclamp not needed; see CLAMP_PROBE).
//
// Only a real overstiffness that SURVIVES (a)+(b)+(c) is a locking candidate -> (2).
//
// Geometry/material: R=1, L=1, phi=0.6, t=0.05 (R/t=20), E=1e6, nu=0.3.
// BC: bottom arc (x=0) hinged (u=0, rot free); top + sides FREE; uniform axial
// prestress (BB: imposed N_xx=1 directly; NURBS: prebuckling under Tz=t*E, free
// sides => uniform). sigma_cr_BB = N_cr ; sigma_cr_NURBS = lambda*E. N_cr=sigma*t.
//
// Build:
//   g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//       -I/opt/gismo/external test_bb_nurbs_modematch.cpp -L/opt/gismo/build/lib \
//       -lgismo -Wl,-rpath,/opt/gismo/build/lib -o tmm && ./tmm
#include <gismo.h>
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include "bb_kl_strains.hpp"
#include <gsKLShell/src/getMaterialMatrix.h>
#include <gsKLShell/src/gsMaterialMatrixIntegrate.h>
#include <gsKLShell/src/gsThinShellAssembler.h>
#include <gsStructuralAnalysis/src/gsEigenSolvers/gsBucklingSolver.h>
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

static const double R=1.0,L=1.0,phi=0.6,E=1.0e6,nu=0.3;
static V3<double> cyl(double x,double th){ return {R*std::cos(th),R*std::sin(th),x}; }
static V3<double> radial(double th){ return {std::cos(th),std::sin(th),0.0}; }

// ---- common sample grid in (x, theta) ----
static const int NXS=11, NTS=15;
struct Grid{ std::vector<double> x, th; };  // size NXS*NTS, axial-major (ia*NTS+it)
static Grid make_grid(){ Grid g;
    for(int ia=0;ia<NXS;++ia)for(int it=0;it<NTS;++it){
        g.x.push_back(L*ia/(NXS-1)); g.th.push_back(-phi+2*phi*it/(NTS-1)); }
    return g; }
// wave numbers (m axial, n circumferential) from a radial-displacement grid
static void wavenums(const std::vector<double>&w,int&m,int&n){
    double mx=0; for(double v:w) mx=std::max(mx,std::fabs(v)); double tol=0.08*mx;
    n=0; for(int ia=0;ia<NXS;++ia){ int sc=0; double prev=0;
        for(int it=0;it<NTS;++it){ double v=w[ia*NTS+it]; if(std::fabs(v)<tol)continue;
            if(prev!=0 && (v>0)!=(prev>0)) ++sc; prev=v; } n=std::max(n,sc); }
    m=0; for(int it=0;it<NTS;++it){ int sc=0; double prev=0;
        for(int ia=0;ia<NXS;++ia){ double v=w[ia*NTS+it]; if(std::fabs(v)<tol)continue;
            if(prev!=0 && (v>0)!=(prev>0)) ++sc; prev=v; } m=std::max(m,sc); }
}

// ===================== BB segment =====================
struct Modes{ std::vector<double> eig; std::vector<std::vector<double>> w; std::vector<int> mm,nn; };

static Modes bb_modes(int Nx,int Nt,double thick,int p,int nmodes,const Grid&grid,int clampRows){
    BBTriangleBasis<double> B(p); int nK=B.size();
    struct Tri{ std::array<std::array<double,2>,3> pv; std::vector<V3<double>> X; };
    std::vector<Tri> tris;
    auto pvert=[&](int i,int j){return std::array<double,2>{i*L/Nx, -phi + j*(2*phi)/Nt};};
    for(int i=0;i<Nx;++i)for(int j=0;j<Nt;++j){
        std::array<std::array<double,2>,3> A1={{pvert(i,j),pvert(i+1,j),pvert(i+1,j+1)}};
        std::array<std::array<double,2>,3> A2={{pvert(i,j),pvert(i+1,j+1),pvert(i,j+1)}};
        for(auto&pv:{A1,A2}){ Tri T; T.pv=pv; T.X.resize(nK);
            for(int k=0;k<nK;++k){const auto&a=B.alpha()[k];
                double px=(a[0]*pv[0][0]+a[1]*pv[1][0]+a[2]*pv[2][0])/p;
                double pt=(a[0]*pv[0][1]+a[1]*pv[1][1]+a[2]*pv[2][1])/p;
                T.X[k]=cyl(px,pt); }
            tris.push_back(T);} }
    int nT=tris.size();
    std::vector<V3<double>> gpos; std::vector<std::vector<int>> gmap(nT,std::vector<int>(nK));
    auto foa=[&](const V3<double>&P){for(size_t i=0;i<gpos.size();++i)if(std::hypot(std::hypot(gpos[i][0]-P[0],gpos[i][1]-P[1]),gpos[i][2]-P[2])<1e-9)return(int)i;gpos.push_back(P);return(int)gpos.size()-1;};
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)gmap[k][a]=foa(tris[k].X[a]);
    int nCP=gpos.size();
    auto pkey=[&](const std::array<double,2>&p){return std::make_pair((long long)llround(p[0]*1e7),(long long)llround(p[1]*1e7));};
    std::map<std::pair<std::pair<long long,long long>,std::pair<long long,long long>>,std::vector<int>> em;
    for(int k=0;k<nT;++k)for(int e=0;e<3;++e){auto a=pkey(tris[k].pv[e]),b=pkey(tris[k].pv[(e+1)%3]);if(b<a)std::swap(a,b);em[{a,b}].push_back(k);}
    auto baryParam=[&](const Tri&T,const std::array<double,2>&P){double a=T.pv[1][0]-T.pv[0][0],b=T.pv[2][0]-T.pv[0][0],c=T.pv[1][1]-T.pv[0][1],dd=T.pv[2][1]-T.pv[0][1],det=a*dd-b*c;double px=P[0]-T.pv[0][0],py=P[1]-T.pv[0][1];return std::array<double,2>{(dd*px-b*py)/det,(-c*px+a*py)/det};};
    auto buildAsc=[&](){ std::vector<std::vector<double>> Asc;
        for(auto&kv:em){ if(kv.second.size()!=2)continue; int mt=kv.second[0],st=kv.second[1];
            std::vector<std::array<double,2>> sh; for(auto&Pm:tris[mt].pv)for(auto&Ps:tris[st].pv)if(std::hypot(Pm[0]-Ps[0],Pm[1]-Ps[1])<1e-9)sh.push_back(Pm);
            std::array<double,2> Pa=sh[0],Pb=sh[1];
            for(int mm=0;mm<p;++mm){ double s=(mm+1.0)/(p+1.0);
                std::array<double,2> Pp={(1-s)*Pa[0]+s*Pb[0],(1-s)*Pa[1]+s*Pb[1]};
                std::vector<double> row(nCP,0.0);
                for(int side=0;side<2;++side){ const Tri&T=tris[side==0?mt:st]; double sign=(side==0?+1.0:-1.0);
                    auto bc=baryParam(T,Pp); auto d=BasisDerivs::at(B,bc[0],bc[1]); Geom<double> G=Geom<double>::build(T.X,d);
                    auto bca=baryParam(T,Pa),bcb=baryParam(T,Pb); double t1=bcb[0]-bca[0],t2=bcb[1]-bca[1];
                    V3<double> AS{G.a1[0]*t1+G.a2[0]*t2,G.a1[1]*t1+G.a2[1]*t2,G.a1[2]*t1+G.a2[2]*t2};
                    double an=std::sqrt(dot3(AS,AS)); for(int i=0;i<3;++i)AS[i]/=an;
                    V3<double> A3a=radial(Pp[1]); V3<double> AN=cross3(A3a,AS);
                    double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
                    double r1=dot3(AN,G.a1),r2=dot3(AN,G.a2); double v1=(a22*r1-a12*r2)/det,v2=(-a12*r1+a11*r2)/det;
                    for(int k=0;k<nK;++k) row[gmap[side==0?mt:st][k]] += sign*(v1*d.N1[k]+v2*d.N2[k]);
                }
                Asc.push_back(row);
            } }
        return Asc; };
    auto nullsp=[&](const std::vector<std::vector<double>>& Ain,int ncols,std::vector<int>&fcl,int&rank)->std::vector<std::vector<double>>{
        std::vector<std::vector<double>> Rm=Ain;int m=Rm.size();std::vector<int> piv;const double TOL=1e-9;int rr=0;
        for(int c=0;c<ncols&&rr<m;++c){int pr=-1;double best=TOL;for(int r=rr;r<m;++r)if(std::fabs(Rm[r][c])>best){best=std::fabs(Rm[r][c]);pr=r;}if(pr<0)continue;std::swap(Rm[rr],Rm[pr]);double pv=Rm[rr][c];for(int j=0;j<ncols;++j)Rm[rr][j]/=pv;for(int r=0;r<m;++r)if(r!=rr){double f=Rm[r][c];if(f!=0)for(int j=0;j<ncols;++j)Rm[r][j]-=f*Rm[rr][j];}piv.push_back(c);++rr;}
        rank=piv.size();std::vector<char> ip(ncols,0);for(int c:piv)ip[c]=1;fcl.clear();for(int c=0;c<ncols;++c)if(!ip[c])fcl.push_back(c);int nFs=fcl.size();
        std::vector<std::vector<double>> Cs(ncols,std::vector<double>(nFs,0.0));for(int f=0;f<nFs;++f){Cs[fcl[f]][f]=1;for(int i=0;i<rank;++i)Cs[piv[i]][f]=-Rm[i][fcl[f]];} return Cs; };
    std::vector<int> fcl0;int rank0; auto C0=nullsp(buildAsc(),nCP,fcl0,rank0); int nFs0=fcl0.size();
    std::vector<V3<double>> geomC1(nCP);
    for(int cp=0;cp<nCP;++cp)for(int c=0;c<3;++c){double s=0;for(int f=0;f<nFs0;++f)s+=C0[cp][f]*gpos[fcl0[f]][c];geomC1[cp][c]=s;}
    for(int k=0;k<nT;++k)for(int a=0;a<nK;++a)tris[k].X[a]=geomC1[gmap[k][a]];
    auto Asc=buildAsc(); int nd=3*nCP;
    std::vector<std::vector<double>> A3;
    for(auto&row:Asc) for(int i=0;i<3;++i){ std::vector<double> r3(nd,0.0); for(int cp=0;cp<nCP;++cp) if(row[cp]!=0) r3[3*cp+i]=row[cp]; A3.push_back(r3); }
    // BC: bottom arc (x=0) hinged. clampRows: 1 = hinge (pin x=0 CPs); 2 = also pin the
    //     next axial CP row (x=L/Nx/p spacing) to emulate a rotational clamp (probe).
    auto pin=[&](int cp,int comp){ std::vector<double> r3(nd,0.0); r3[3*cp+comp]=1.0; A3.push_back(r3); };
    double xrow = (clampRows>=2)? (L/Nx)/p : -1;   // first interior CP row in x
    for(int cp=0;cp<nCP;++cp){ double z=geomC1[cp][2];
        if(std::fabs(z)<1e-7){ pin(cp,0);pin(cp,1);pin(cp,2); }
        else if(xrow>0 && std::fabs(z-xrow)<1e-7){ pin(cp,0);pin(cp,1);pin(cp,2); } }
    std::vector<int> fcl;int rank; auto Cs=nullsp(A3,nd,fcl,rank); int nF=fcl.size();
    EMat C(nd,nF); for(int i=0;i<nd;++i)for(int f=0;f<nF;++f)C(i,f)=Cs[i][f];
    EMat Kf=EMat::Zero(nd,nd), Kg=EMat::Zero(nd,nd);
    V3<double> tax{0,0,1};
    for(int k=0;k<nT;++k){ const Tri&T=tris[k];
        for(auto&q:quad_triangle(2*p)){ auto d=BasisDerivs::at(B,q.xi1,q.xi2); Geom<double> G=Geom<double>::build(T.X,d);
            gsMatrix<real_t> A,Bc,D;
            { gsMultiPatch<real_t> mp;mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));mp.embed(3);
              gsMatrix<real_t>&CC=mp.patch(0).coefs();for(index_t r=0;r<CC.rows();++r){double xi=CC(r,0),eta=CC(r,1);for(int i=0;i<3;++i)CC(r,i)=xi*G.a1[i]+eta*G.a2[i];}
              gsFunctionExpr<real_t> tf(std::to_string(thick),3),Ef(std::to_string(E),3),nf(std::to_string(nu),3);
              std::vector<gsFunctionSet<real_t>*> pars{&Ef,&nf};gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
              auto mat=getMaterialMatrix<3,real_t>(mp,tf,pars,o);gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);gsVector<real_t> pt(2);pt<<0.5,0.5;
              gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
              A=ev.eval(ea.getCoeff(mmA),pt);A.resize(3,3);D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3); }
            double Jac=G.jbar; Bmat Bm,Bb; analytic_B(T.X,d,Bm,Bb);
            double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
            double ta1=dot3(tax,G.a1),ta2=dot3(tax,G.a2);
            double c1=(a22*ta1-a12*ta2)/det, c2=(a11*ta2-a12*ta1)/det;
            std::vector<double> g(nK); for(int a=0;a<nK;++a) g[a]=c1*d.N1[a]+c2*d.N2[a];
            for(int a=0;a<nK;++a)for(int i=0;i<3;++i){int ga=3*gmap[k][a]+i;
                for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*gmap[k][b]+j;
                    double v=0; for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s2=0;s2<3;++s2){Am+=A(r,s2)*Bm.at(s2,3*b+j);Dm+=D(r,s2)*Bb.at(s2,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                    Kf(ga,gb)+=q.w*Jac*v;
                    if(i==j) Kg(ga,gb)+=q.w*Jac*g[a]*g[b]; }}
        }}
    EMat Ke=C.transpose()*Kf*C, Kge=C.transpose()*Kg*C;
    gsEigen::GeneralizedSelfAdjointEigenSolver<EMat> ges(Kge,Ke);
    auto mu=ges.eigenvalues(); auto V=ges.eigenvectors();
    // locate grid points in triangles (basis values)
    struct Loc{int tri; std::vector<double> N; double th;};
    std::vector<Loc> loc(grid.x.size());
    for(size_t s=0;s<grid.x.size();++s){ std::array<double,2> P{grid.x[s],grid.th[s]}; int found=-1; std::array<double,2> bc{};
        for(int k=0;k<nT;++k){ auto b=baryParam(tris[k],P); double b0=1-b[0]-b[1]; if(b[0]>=-1e-7&&b[1]>=-1e-7&&b0>=-1e-7){found=k;bc=b;break;} }
        Loc Lc; Lc.tri=found; Lc.th=grid.th[s]; Lc.N.assign(nK,0.0);
        if(found>=0) for(int k=0;k<nK;++k) Lc.N[k]=B.eval_one(k,bc[0],bc[1]);
        loc[s]=Lc; }
    Modes out;
    for(int i=0;i<nmodes;++i){ int col=nF-1-i; if(col<0)break; double m=mu(col); if(!(m>0))continue;
        out.eig.push_back(1.0/m);
        EMat phi=V.col(col); EMat uf=C*phi;            // nd
        std::vector<double> w(grid.x.size(),0.0);
        for(size_t s=0;s<grid.x.size();++s){ const Loc&Lc=loc[s]; if(Lc.tri<0)continue; V3<double> rdir=radial(Lc.th); double ww=0;
            for(int k=0;k<nK;++k){int cp=gmap[Lc.tri][k]; double dx=uf(3*cp,0),dy=uf(3*cp+1,0),dz=uf(3*cp+2,0); ww+=Lc.N[k]*(dx*rdir[0]+dy*rdir[1]+dz*rdir[2]); }
            w[s]=ww; }
        int mm,nn; wavenums(w,mm,nn); out.w.push_back(w); out.mm.push_back(mm); out.nn.push_back(nn);
    }
    return out;
}

// ===================== NURBS panel =====================
static Modes nurbs_modes(int r,int e,double thick,int nmodes,const Grid&grid){
    double c=std::cos(phi),s=std::sin(phi);
    gsKnotVector<real_t> KU(0,1,0,3), KV(0,1,0,2);   // degree 2 (u=theta), degree 1 (v=x)
    gsMatrix<real_t> coefs(6,3), wgt(6,1);
    double cp[6][3]={{R*c,-R*s,0},{R/c,0,0},{R*c,R*s,0},{R*c,-R*s,L},{R/c,0,L},{R*c,R*s,L}};
    double ww[6]={1,c,1,1,c,1};
    for(int i=0;i<6;++i){for(int j=0;j<3;++j)coefs(i,j)=cp[i][j]; wgt(i,0)=ww[i];}
    gsTensorNurbs<2,real_t> patch(KU,KV,coefs,wgt);
    gsMultiPatch<real_t> mp; mp.addPatch(patch);
    mp.patch(0).degreeElevate(e);
    for(int i=0;i<r;++i) mp.patch(0).uniformRefine();
    gsMultiBasis<real_t> dbasis(mp,true);
    gsFunctionExpr<real_t> tf(std::to_string(thick),3),Ef(std::to_string(E),3),nf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pars{&Ef,&nf};
    gsOptionList mo;mo.addInt("Material","",0);mo.addSwitch("Compressibility","",false);mo.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,tf,pars,mo);
    double Tz=thick*E;
    gsFunctionExpr<real_t> zero("0","0","0",3), neu("0","0",std::to_string(Tz),3), force("0","0","0",3);
    gsBoundaryConditions<real_t> bc;
    bc.addCondition(0, boundary::south, condition_type::dirichlet, &zero, 0, false, -1); // x=0 hinged
    bc.addCondition(0, boundary::north, condition_type::neumann,   &neu, 0);             // x=L axial load
    bc.setGeoMap(mp);
    gsThinShellAssembler<3,real_t,true> assembler(mp,dbasis,bc,force,mat.get());
    assembler.assemble();
    gsSparseMatrix<real_t> K_L=assembler.matrix(); gsVector<real_t> F=assembler.rhs();
    gsSparseSolver<real_t>::CGDiagonal lin; lin.compute(K_L); gsVector<real_t> u=lin.solve(F);
    assembler.assembleMatrix(u);
    gsSparseMatrix<real_t> K_NL=assembler.matrix();
    gsBucklingSolver<real_t> buck(K_L,K_NL);
    gsOptionList bo=buck.options(); bo.setInt("solver",3); bo.setInt("selectionRule",0); bo.setInt("sortRule",4);
    bo.setReal("shift",2.0e-3*(thick/0.05)); bo.setInt("ncvFac",4); bo.setReal("tolerance",1e-10); bo.setSwitch("verbose",false);
    buck.setOptions(bo);
    buck.computeSparse(nmodes+4);
    gsMatrix<real_t> vals=buck.values(), vecs=buck.vectors();
    // sample params: u=(theta+phi)/(2phi), v=x/L
    gsMatrix<real_t> uv(2,(index_t)grid.x.size());
    for(size_t k=0;k<grid.x.size();++k){ uv(0,k)=(grid.th[k]+phi)/(2*phi); uv(1,k)=grid.x[k]/L; }
    Modes out;
    int taken=0;
    for(index_t i=0;i<vals.rows()&&taken<nmodes;++i){ double lam=vals(i,0); if(!(std::isfinite(lam)&&lam>1e-9))continue;
        gsMultiPatch<real_t> def; assembler.constructSolution(vecs.col(i),def);
        def.patch(0).coefs() -= mp.patch(0).coefs();
        gsMatrix<real_t> disp=def.patch(0).eval(uv);   // 3 x npts displacement
        std::vector<double> w(grid.x.size(),0.0);
        for(size_t k=0;k<grid.x.size();++k){ V3<double> rd=radial(grid.th[k]); w[k]=disp(0,k)*rd[0]+disp(1,k)*rd[1]+disp(2,k)*rd[2]; }
        int mm,nn; wavenums(w,mm,nn); out.eig.push_back(lam*E); out.w.push_back(w); out.mm.push_back(mm); out.nn.push_back(nn); ++taken;
    }
    return out;
}

static void printmodes(const char*tag,const Modes&M,double scale){
    printf("    %s modes: ",tag);
    for(size_t i=0;i<M.eig.size();++i) printf("[m%d n%d sig=%.5g] ",M.mm[i],M.nn[i],M.eig[i]*scale);
    printf("\n");
}

int main(){
    double thick=0.05; int p=5, nmodes=6;
    Grid grid=make_grid();
    printf("BB-vs-NURBS panel buckling: CONVERGED + MODE-MATCHED + BC-matched (hinged).  R/t=%.0f t=%g\n",R/thick,thick);
    printf("  sigma reported. NURBS sigma=lambda*E; BB sigma=N_cr (imposed N_xx=1). Match by wave numbers (m axial, n circ).\n\n");
    printf("== NURBS reference (converging in r) ==\n");
    for(int r:{3,4,5}){ Modes M=nurbs_modes(r,2,thick,nmodes,grid); printf("  r=%d\n",r); printmodes("NURBS",M,1.0); }
    printf("\n== BB hinged (converging in Nx=Nt) ==\n");
    for(int N:{3,4,5}){ Modes M=bb_modes(N,N,thick,p,nmodes,grid,1); printf("  Nx=Nt=%d\n",N); printmodes("BB",M,1.0/thick); }
    printf("\n== BC PROBE: BB clamped (pin x=0 + first interior row) at Nx=Nt=4 ==\n");
    { Modes M=bb_modes(4,4,thick,p,nmodes,grid,2); printmodes("BBclamp",M,1.0/thick); }
    printf("\n== (2) p-SWEEP discriminator (Nx=Nt=4, hinged): does sigma(m0,n1) -> NURBS 1275 with p? ==\n");
    printf("   p-locking (Ludwig p>=5 claim) => decreasing toward 1275; flat at ~3250 => consistency error in curved K_e.\n");
    for(int pp:{3,4,5,6}){ Modes M=bb_modes(4,4,thick,pp,std::min(nmodes,4),grid,1);
        double s=-1; for(size_t i=0;i<M.eig.size();++i) if(M.mm[i]==0&&M.nn[i]==1){ s=M.eig[i]/thick; break; }
        printf("   p=%d  sigma(m0,n1)=%.6g  (ratio to NURBS=%.3f)\n",pp,s,s>0?s/1275.3:0); }
    printf("\nRead: match BB[m,n] to NURBS[m,n]; compare sigma of the SAME (m,n). A surviving ratio>>1 after\n");
    printf("convergence + mode + BC match is the locking candidate; hinge-vs-clamp gap shows the BC sensitivity.\n");
    return 0;
}
