// Cylinder step 3b-LBA (i): A-vs-B discriminator. Assemble the SAME uniform-N_xx
// geometric stiffness + K_e on the NURBS basis (same formula/code as BB: Geom +
// analytic_B + eval3D + g_a=t_ax.gradN, block-delta_ij) — ONLY the shape functions
// differ (rational NURBS vs BB triangle), and the geometry is the EXACT cylinder.
//
// Factorial isolation of the 2.54x curved-buckling overstiffness (BB 3251 vs gismo
// prebuckling 1275, K_e already validated equal to 0.4%):
//   * hold FORMULA (uniform N_xx), vary BASIS:  BB-uniform(3251) vs NURBS-uniform(this)
//       equal      => formula basis-independent => no assembly bug => it's the prestress (B)
//       different  => BB's K_geom assembly is the outlier => bug (A)
//   * hold BASIS (NURBS), vary PRESTRESS:  NURBS-uniform(this) vs gismo-full-prebuckling(1275)
//       different  => the prebuckling idealization matters (B, expected)
//
// Single NURBS patch => C^(p-1) smooth => NO C1 coupling matrix; just assemble +
// pin the bottom-arc (south, x=0) displacement DOFs (hinged) + generalized eig.
// Imposed uniform N_xx=1 => lambda = N_cr ; sigma_cr = N_cr/t. (BB convention.)
//
// Build:
//   g++ -std=c++17 -O2 -I/opt/gismo/src -I/opt/gismo/build -I/opt/gismo/optional \
//       -I/opt/gismo/external test_bb_nurbs_kgeom.cpp -L/opt/gismo/build/lib \
//       -lgismo -Wl,-rpath,/opt/gismo/build/lib -o tkg && ./tkg
#include <gismo.h>
#include <gsAssembler/gsGaussRule.h>
#include "bb_kl_strains.hpp"
#include <gsKLShell/src/getMaterialMatrix.h>
#include <gsKLShell/src/gsMaterialMatrixIntegrate.h>
#include <vector>
#include <array>
#include <cmath>
using namespace gismo;
using aeris::Geom; using aeris::Bmat; using aeris::analytic_B; using aeris::BasisDerivs;
using aeris::V3; using aeris::dot3; using aeris::make_B;
typedef gsEigen::Matrix<real_t,gsEigen::Dynamic,gsEigen::Dynamic> EMat;

static const double R=1.0,L=1.0,phi=0.6,E=1.0e6,nu=0.3;

static void eval3D_ABD(const V3<double>&a1,const V3<double>&a2,double thick,
                       gsMatrix<real_t>&A,gsMatrix<real_t>&D){
    gsMultiPatch<real_t> mp;mp.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));mp.embed(3);
    gsMatrix<real_t>&C=mp.patch(0).coefs();for(index_t r=0;r<C.rows();++r){double xi=C(r,0),eta=C(r,1);for(int i=0;i<3;++i)C(r,i)=xi*a1[i]+eta*a2[i];}
    gsFunctionExpr<real_t> tf(std::to_string(thick),3),Ef(std::to_string(E),3),nf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pars{&Ef,&nf};gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,tf,pars,o);gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);gsVector<real_t> pt(2);pt<<0.5,0.5;
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mmA(mat.get(),&mp);gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    A=ev.eval(ea.getCoeff(mmA),pt);A.resize(3,3);D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3);
}

static double run(int r,int e,double thick,int&out_nd){
    double c=std::cos(phi),s=std::sin(phi);
    gsKnotVector<real_t> KU(0,1,0,3), KV(0,1,0,2);   // deg 2 (u=theta), deg 1 (v=x)
    gsMatrix<real_t> coefs(6,3), wgt(6,1);
    double cp[6][3]={{R*c,-R*s,0},{R/c,0,0},{R*c,R*s,0},{R*c,-R*s,L},{R/c,0,L},{R*c,R*s,L}};
    double ww[6]={1,c,1,1,c,1};
    for(int i=0;i<6;++i){for(int j=0;j<3;++j)coefs(i,j)=cp[i][j]; wgt(i,0)=ww[i];}
    gsTensorNurbs<2,real_t> patch(KU,KV,coefs,wgt);
    gsMultiPatch<real_t> mp; mp.addPatch(patch);
    mp.patch(0).degreeElevate(e); for(int i=0;i<r;++i) mp.patch(0).uniformRefine();
    const gsBasis<real_t>& basis = mp.basis(0);
    const gsMatrix<real_t>& CP = mp.patch(0).coefs();
    int nCP=basis.size(); int nd=3*nCP; out_nd=nd;
    int nel=1; for(int i=0;i<r;++i) nel*=2;          // 2^r elements per direction (single initial span)
    int nq = (2+e) + 3;                              // Gauss nodes/dir (degree 2+e, +3 margin)
    gsVector<index_t> nnodes(2); nnodes<<nq,nq; gsGaussRule<real_t> QuRule(nnodes);
    V3<double> tax{0,0,1};                            // axial = global z
    EMat Kf=EMat::Zero(nd,nd), Kg=EMat::Zero(nd,nd);
    gsMatrix<real_t> nodes; gsVector<real_t> wts;
    for(int iu=0;iu<nel;++iu)for(int iv=0;iv<nel;++iv){
        gsVector<real_t> lo(2),hi(2); lo<<(double)iu/nel,(double)iv/nel; hi<<(double)(iu+1)/nel,(double)(iv+1)/nel;
        QuRule.mapTo(lo,hi,nodes,wts);
        for(index_t q=0;q<nodes.cols();++q){
            gsMatrix<real_t> u=nodes.col(q);
            gsMatrix<index_t> act; basis.active_into(u,act);
            gsMatrix<real_t> val,der,der2; basis.eval_into(u,val); basis.deriv_into(u,der); basis.deriv2_into(u,der2);
            int K=act.rows();
            BasisDerivs d; d.N1.resize(K);d.N2.resize(K);d.N11.resize(K);d.N22.resize(K);d.N12.resize(K);
            std::vector<V3<double>> Xc(K);
            for(int k=0;k<K;++k){ d.N1[k]=der(2*k,0); d.N2[k]=der(2*k+1,0);
                d.N11[k]=der2(3*k,0); d.N22[k]=der2(3*k+1,0); d.N12[k]=der2(3*k+2,0);
                index_t gi=act(k,0); for(int i=0;i<3;++i)Xc[k][i]=CP(gi,i); }
            Geom<double> G=Geom<double>::build(Xc,d);
            gsMatrix<real_t> A,D; eval3D_ABD(G.a1,G.a2,thick,A,D);
            Bmat Bm,Bb; analytic_B(Xc,d,Bm,Bb);
            double Jac=G.jbar, wq=wts(q)*Jac;
            double a11=dot3(G.a1,G.a1),a12=dot3(G.a1,G.a2),a22=dot3(G.a2,G.a2),det=a11*a22-a12*a12;
            double ta1=dot3(tax,G.a1),ta2=dot3(tax,G.a2);
            double c1=(a22*ta1-a12*ta2)/det, c2=(a11*ta2-a12*ta1)/det;
            std::vector<double> g(K); for(int k=0;k<K;++k) g[k]=c1*d.N1[k]+c2*d.N2[k];
            for(int a=0;a<K;++a)for(int i=0;i<3;++i){int ga=3*act(a,0)+i;
                for(int b=0;b<K;++b)for(int j=0;j<3;++j){int gb=3*act(b,0)+j;
                    double v=0; for(int rr=0;rr<3;++rr){double Am=0,Dm=0;for(int s2=0;s2<3;++s2){Am+=A(rr,s2)*Bm.at(s2,3*b+j);Dm+=D(rr,s2)*Bb.at(s2,3*b+j);}v+=Bm.at(rr,3*a+i)*Am+Bb.at(rr,3*a+i)*Dm;}
                    Kf(ga,gb)+=wq*v;
                    if(i==j) Kg(ga,gb)+=wq*g[a]*g[b]; }}
        }}
    // BC: pin south (v=0 = x=0) displacement DOFs (hinged, all 3 comps)
    gsMatrix<index_t> bnd=basis.boundary(boundary::south);
    std::vector<char> pinned(nd,0);
    for(index_t i=0;i<bnd.rows();++i)for(int comp=0;comp<3;++comp) pinned[3*bnd(i,0)+comp]=1;
    std::vector<int> freed; for(int i=0;i<nd;++i)if(!pinned[i])freed.push_back(i);
    int nF=freed.size();
    EMat Ke(nF,nF),Kge(nF,nF);
    for(int a=0;a<nF;++a)for(int b=0;b<nF;++b){Ke(a,b)=Kf(freed[a],freed[b]);Kge(a,b)=Kg(freed[a],freed[b]);}
    gsEigen::GeneralizedSelfAdjointEigenSolver<EMat> ges(Kge,Ke);
    double mumax=ges.eigenvalues()(nF-1); double Ncr=1.0/mumax;
    return Ncr/thick;   // sigma_cr
}

int main(){
    double thick=0.05; int e=2;
    printf("A-vs-B discriminator: uniform-N_xx K_geom on the NURBS basis (same formula as BB, exact geometry).\n");
    printf("  R/t=%.0f t=%g, degree (2,1)->elevate e=%d->(%d,%d), BC bottom-arc hinged. sigma_cr=N_cr/t (N_xx=1).\n",R/thick,thick,e,2+e,1+e);
    printf("  Reference points: BB-uniform=3251, gismo-full-prebuckling=1275.\n");
    printf("    ~3251 => BB K_geom CORRECT, panel test confounded by prestress (B) => go to 3c.\n");
    printf("    ~1275 => BB K_geom ASSEMBLY BUG (A).\n\n");
    printf("  %4s %8s %16s\n","r","nd","sigma_cr(NURBS-unif)");
    for(int r:{2,3,4}){ int nd=0; double sig=run(r,e,thick,nd); printf("  %4d %8d %16.8g\n",r,nd,sig); }
    return 0;
}
