// Cylinder step 2a: does eval3D's bending D carry a through-thickness SHIFTER?
// (Aeris BB). gismo-linked. Build: g++ ... (see other gismo tests) ... -lgismo
//
// Methodical point (user): a FLAT surrogate (b=0) is shifter-free by construction
// -> tautological, can't reveal whether eval3D includes the shifter. To probe
// eval3D's actual behaviour, call it on a GENUINELY CURVED gismo geometry (b!=0)
// and compare D to the flat surrogate that has the SAME first fundamental form
// (metric a_alpha). Any difference is the curvature (shifter) dependence:
//   D_curved == D_flat  -> eval3D bending stiffness depends only on the metric
//                          (shifter-FREE, D = C t^3/12, Ludwig-consistent);
//                          the flat-metric surrogate is EXACT on any geometry.
//   D_curved != D_flat by O(t/R) -> eval3D includes the shifter; then it's a
//                          Ludwig-free (surrogate) vs shifter-corrected CHOICE,
//                          now with numbers (O(t/R) ~ 1-2% in R/t 50-1000).
#include <gismo.h>
#include <gsKLShell/src/getMaterialMatrix.h>
#include <gsKLShell/src/gsMaterialMatrixIntegrate.h>
using namespace gismo;

static gsMatrix<real_t> evalD(const gsMultiPatch<real_t>& mp,double thick,double E,double nu,const gsVector<real_t>& pt){
    gsFunctionExpr<real_t> t(std::to_string(thick),3),Ef(std::to_string(E),3),nuf(std::to_string(nu),3);
    std::vector<gsFunctionSet<real_t>*> pars{&Ef,&nuf};
    gsOptionList o;o.addInt("Material","",0);o.addSwitch("Compressibility","",false);o.addInt("Implementation","",1);
    auto mat=getMaterialMatrix<3,real_t>(mp,t,pars,o);
    gsExprAssembler<> ea(1,1);gsExprEvaluator<> ev(ea);
    gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mmD(mat.get(),&mp);
    gsMatrix<real_t> D=ev.eval(ea.getCoeff(mmD),pt);D.resize(3,3);return D;
}

int main(){
    const double E=1.0e6,nu=0.3;
    gsVector<real_t> pt(2); pt<<0.5,0.5;
    printf("Shifter probe: D_curved(b!=0) vs D_flat-surrogate(same metric, b=0).\n");
    printf("%8s %6s | %14s %14s | %12s %10s\n","curv c","t","||D_curv||","||D_flat||","relDiff","~t/R");
    for(double c:{0.3,1.0,3.0}){            // surface z = c*x^2 -> stronger curvature
      for(double thick:{0.01,0.1}){
        // curved gismo patch: biquadratic, CP z = c * x_cp^2  (parabolic cylinder, b!=0)
        gsMultiPatch<real_t> cur; cur.addPatch(gsNurbsCreator<real_t>::BSplineSquare(2)); cur.embed(3);
        gsMatrix<real_t>& C=cur.patch(0).coefs();
        for(index_t r=0;r<C.rows();++r) C(r,2)=c*C(r,0)*C(r,0);
        gsMatrix<real_t> Dc=evalD(cur,thick,E,nu,pt);
        // flat surrogate with the SAME tangents (metric) at pt
        gsMatrix<real_t> J=cur.patch(0).jacobian(pt);   // 3x2, cols = a1,a2
        gsMultiPatch<real_t> flat; flat.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1)); flat.embed(3);
        gsMatrix<real_t>& F=flat.patch(0).coefs();
        for(index_t r=0;r<F.rows();++r){double xi=F(r,0),eta=F(r,1);
            for(int i=0;i<3;++i)F(r,i)=xi*J(i,0)+eta*J(i,1);}
        gsMatrix<real_t> Df=evalD(flat,thick,E,nu,pt);
        double rel=(Dc-Df).norm()/Df.norm();
        // curvature kappa ~ |d2X/dx2| / metric ; for z=c x^2, d2z/dx2=2c, R~1/(2c)
        double R=1.0/(2*c); double tR=thick/R;
        printf("%8.2g %6.2g | %14.6g %14.6g | %12.3e %10.3e\n",c,thick,Dc.norm(),Df.norm(),rel,tR);
      }
    }
    printf("\nReading: relDiff ~ machine -> shifter-FREE (surrogate exact on any geometry, Ludwig-consistent).\n"
           "relDiff scaling ~ t/R -> eval3D includes the shifter (then surrogate strips it = Ludwig-free choice).\n");
    return 0;
}
