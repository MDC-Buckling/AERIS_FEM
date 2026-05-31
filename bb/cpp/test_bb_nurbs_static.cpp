// Cylinder step 3b-LBA isolation: STATIC K_e test, BB vs NURBS curved panel (Aeris BB).
// gismo-linked. Splits the 2.54x curved-buckling overstiffness into K_e vs K_geom/prestress.
//
// Same geometry + BC as the buckling test, but NO buckling: apply a matched transverse
// load (uniform global-x body force q=1, dead) and solve K_e u = F. Compare the
// COMPLIANCE  C = F^T u = 2*strain energy = integral f.u dA  (a basis-independent
// physical scalar; same physical load on both => directly comparable) and the radial
// tip deflection at the free-top centre (x=L, theta=0).
//
//   BB compliance << NURBS (BB stiffer)  => the bug is IN K_e (curved membrane/bending).
//   BB compliance ~= NURBS               => K_e is fine; the buckling gap is in the
//                                           3-DOF K_geom or the imposed-prestress mismatch.
//
// BC: bottom arc (x=0) hinged (u=0, rot free); top + sides FREE. Load = uniform (q,0,0).
//
// Build:
//   g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//       -I/opt/gismo/external test_bb_nurbs_static.cpp -L/opt/gismo/build/lib \
//       -lgismo -Wl,-rpath,/opt/gismo/build/lib -o tst && ./tst
#include <gismo.h>
#include "bb_triangle_basis.hpp"
#include "bb_triangle_quadrature.hpp"
#include "bb_kl_strains.hpp"
#include <gsKLShell/src/getMaterialMatrix.h>
#include <gsKLShell/src/gsMaterialMatrixIntegrate.h>
#include <gsKLShell/src/gsThinShellAssembler.h>
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
static const double QX=1.0;   // uniform body force in global x
static V3<double> cyl(double x,double th){ return {R*std::cos(th),R*std::sin(th),x}; }
static V3<double> radial(double th){ return {std::cos(th),std::sin(th),0.0}; }

// ---- BB static: returns compliance C=F^T u and radial tip deflection at (L,0) ----
static void bb_static(int Nx,int Nt,double thick,int p,double&compliance,double&tip){
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
    auto pin=[&](int cp,int comp){ std::vector<double> r3(nd,0.0); r3[3*cp+comp]=1.0; A3.push_back(r3); };
    for(int cp=0;cp<nCP;++cp){ double z=geomC1[cp][2]; if(std::fabs(z)<1e-7){ pin(cp,0);pin(cp,1);pin(cp,2); } }
    std::vector<int> fcl;int rank; auto Cs=nullsp(A3,nd,fcl,rank); int nF=fcl.size();
    EMat C(nd,nF); for(int i=0;i<nd;++i)for(int f=0;f<nF;++f)C(i,f)=Cs[i][f];
    EMat Kf=EMat::Zero(nd,nd); EMat Fv=EMat::Zero(nd,1);
    for(int k=0;k<nT;++k){ const Tri&T=tris[k];
        for(auto&q:quad_triangle(2*p)){ auto d=BasisDerivs::at(B,q.xi1,q.xi2); Geom<double> G=Geom<double>::build(T.X,d);
            gsMatrix<real_t> A,D;
            { gsMultiPatch<real_t> mp;mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));mp.embed(3);
              gsMatrix<real_t>&CC=mp.patch(0).coefs();for(index_t r=0;r<CC.rows();++r){double xi=CC(r,0),eta=CC(r,1);for(int i=0;i<3;++i)CC(r,i)=xi*G.a1[i]+eta*G.a2[i];}
              gsFunctionExpr<real_t> tf(std::to_string(thick),3),Ef(std::to_string(E),3),nf(std::to_string(nu),3);
              std::vector<gsFunctionSet<real_t>*> pars{&Ef,&nf};gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
              auto mat=getMaterialMatrix<3,real_t>(mp,tf,pars,o);gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);gsVector<real_t> pt(2);pt<<0.5,0.5;
              gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
              A=ev.eval(ea.getCoeff(mmA),pt);A.resize(3,3);D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3); }
            double Jac=G.jbar; Bmat Bm,Bb; analytic_B(T.X,d,Bm,Bb);
            for(int a=0;a<nK;++a){ double Na=B.eval_one(a,q.xi1,q.xi2); Fv(3*gmap[k][a]+0,0)+=q.w*Jac*Na*QX;  // body force in +x
                for(int i=0;i<3;++i){int ga=3*gmap[k][a]+i;
                    for(int b=0;b<nK;++b)for(int j=0;j<3;++j){int gb=3*gmap[k][b]+j;
                        double v=0; for(int r=0;r<3;++r){double Am=0,Dm=0;for(int s2=0;s2<3;++s2){Am+=A(r,s2)*Bm.at(s2,3*b+j);Dm+=D(r,s2)*Bb.at(s2,3*b+j);}v+=Bm.at(r,3*a+i)*Am+Bb.at(r,3*a+i)*Dm;}
                        Kf(ga,gb)+=q.w*Jac*v; }}
            }
        }}
    EMat Ke=C.transpose()*Kf*C, Fr=C.transpose()*Fv;
    EMat ur=Ke.ldlt().solve(Fr); EMat uf=C*ur;
    compliance=(Fr.transpose()*ur)(0,0);
    // radial tip deflection at (L,0)
    std::array<double,2> P{L,0.0}; int tri=-1; std::array<double,2> bc{};
    for(int k=0;k<nT;++k){ auto b=baryParam(tris[k],P); double b0=1-b[0]-b[1]; if(b[0]>=-1e-7&&b[1]>=-1e-7&&b0>=-1e-7){tri=k;bc=b;break;} }
    tip=0; if(tri>=0){ V3<double> rd=radial(0.0); for(int k=0;k<nK;++k){int cp=gmap[tri][k]; double Na=B.eval_one(k,bc[0],bc[1]); tip+=Na*(uf(3*cp,0)*rd[0]+uf(3*cp+1,0)*rd[1]+uf(3*cp+2,0)*rd[2]); } }
}

// ---- NURBS static: same load + BC, compliance + radial tip at (L,0) ----
static void nurbs_static(int r,int e,double thick,double&compliance,double&tip){
    double c=std::cos(phi),s=std::sin(phi);
    gsKnotVector<real_t> KU(0,1,0,3), KV(0,1,0,2);
    gsMatrix<real_t> coefs(6,3), wgt(6,1);
    double cp[6][3]={{R*c,-R*s,0},{R/c,0,0},{R*c,R*s,0},{R*c,-R*s,L},{R/c,0,L},{R*c,R*s,L}};
    double ww[6]={1,c,1,1,c,1};
    for(int i=0;i<6;++i){for(int j=0;j<3;++j)coefs(i,j)=cp[i][j]; wgt(i,0)=ww[i];}
    gsTensorNurbs<2,real_t> patch(KU,KV,coefs,wgt);
    gsMultiPatch<real_t> mp; mp.addPatch(patch);
    mp.patch(0).degreeElevate(e); for(int i=0;i<r;++i) mp.patch(0).uniformRefine();
    gsMultiBasis<real_t> dbasis(mp,true);
    gsFunctionExpr<real_t> tf(std::to_string(thick),3),Ef(std::to_string(E),3),nf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pars{&Ef,&nf};
    gsOptionList mo;mo.addInt("Material","",0);mo.addSwitch("Compressibility","",false);mo.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,tf,pars,mo);
    gsFunctionExpr<real_t> zero("0","0","0",3), force(std::to_string(QX),"0","0",3);   // uniform body force +x
    gsBoundaryConditions<real_t> bc;
    bc.addCondition(0, boundary::south, condition_type::dirichlet, &zero, 0, false, -1);  // x=0 hinged
    bc.setGeoMap(mp);
    gsThinShellAssembler<3,real_t,true> assembler(mp,dbasis,bc,force,mat.get());
    assembler.assemble();
    gsSparseMatrix<real_t> K=assembler.matrix(); gsVector<real_t> F=assembler.rhs();
    gsSparseSolver<real_t>::CGDiagonal lin; lin.compute(K); gsVector<real_t> u=lin.solve(F);
    compliance=F.dot(u);
    gsMultiPatch<real_t> disp; assembler.constructDisplacement(u,disp);
    gsMatrix<real_t> uv(2,1); uv(0,0)=(0.0+phi)/(2*phi); uv(1,0)=1.0;   // (theta=0, x=L)
    gsMatrix<real_t> dd=disp.patch(0).eval(uv);
    V3<double> rd=radial(0.0); tip=dd(0,0)*rd[0]+dd(1,0)*rd[1]+dd(2,0)*rd[2];
}

int main(){
    double thick=0.05; int p=5;
    printf("STATIC K_e test, BB vs NURBS curved panel (R/t=%.0f, t=%g). Load = uniform body force (q=%g,0,0).\n",R/thick,thick,QX);
    printf("BC: bottom arc hinged, top+sides free. Compliance C=F^T u (energy, basis-indep) + radial tip at (L,0).\n");
    printf("  BB stiffer (smaller C) => bug in K_e; BB~=NURBS => bug in K_geom/prestress, K_e clean.\n\n");
    printf("== NURBS (converging in r) ==\n");
    double Cn=0,tn=0;
    for(int r:{3,4,5}){ nurbs_static(r,2,thick,Cn,tn); printf("  r=%d  compliance=%.8g  tip_radial=%.8g\n",r,Cn,tn); }
    printf("\n== BB (converging in Nx=Nt) ==\n");
    double Cb=0,tb=0;
    for(int N:{3,4,5}){ bb_static(N,N,thick,p,Cb,tb); printf("  Nx=Nt=%d  compliance=%.8g  tip_radial=%.8g\n",N,Cb,tb); }
    printf("\n  ratio NURBS/BB  compliance=%.3f  tip=%.3f   (>1 => BB stiffer => K_e bug)\n",Cn/Cb,tn/tb);
    return 0;
}
