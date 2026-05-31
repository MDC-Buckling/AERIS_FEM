// Phase-3 convention probe (Aeris BB) — what frame does eval3D_matrix return?
//
// The crux question (user's Gate-6 strengthening): does gsMaterialMatrixLinear
// hand back A/D in the local ORTHONORMAL (Cartesian) frame (metric-agnostic
// textbook plane-stress, metric lives in a frame transform) or in a
// METRIC-WEIGHTED curvilinear frame? An axis-aligned unit patch (identity
// metric) hides the difference; a SHEARED+STRETCHED flat patch (a_ab != delta,
// but b_ab = 0 so dn stays inert) forces it out.
//
// Test: eval MatrixA and MatrixD at a point on (1) the unit square and
// (2) a sheared+stretched flat patch, same E/nu/t. Compare to the textbook
// Cartesian plane-stress matrix A_cart = E t/(1-nu^2) [[1,nu,0],[nu,1,0],
// [0,0,(1-nu)/2]], D_cart = A_cart * t^2/12.
//   - identical across both patches AND == A_cart  => orthonormal/Cartesian.
//   - sheared differs from A_cart                  => metric-weighted.
#include <gismo.h>
#include <gsKLShell/src/getMaterialMatrix.h>
#include <gsKLShell/src/gsMaterialMatrixIntegrate.h>

using namespace gismo;

static gsMatrix<> evalMat(const gsMultiPatch<real_t>& mp,
                          gsMaterialMatrixBase<real_t>* mat,
                          bool bending, const gsVector<real_t>& pt) {
    gsExprAssembler<> A(1,1);
    gsExprEvaluator<> ev(A);
    if (!bending) {
        gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixA> mm(mat,&mp);
        auto v = A.getCoeff(mm);
        return ev.eval(v, pt);
    } else {
        gsMaterialMatrixIntegrate<real_t,MaterialOutput::MatrixD> mm(mat,&mp);
        auto v = A.getCoeff(mm);
        return ev.eval(v, pt);
    }
}

int main() {
    const real_t thickness = 0.1, E = 1.0e6, nu = 0.3;

    // (1) axis-aligned unit square (identity in-plane metric)
    gsMultiPatch<real_t> mp_id;
    mp_id.addPatch(gsNurbsCreator<real_t>::BSplineSquare(1));
    mp_id.embed(3);

    // (2) sheared + stretched flat patch: x' = 1.3*(x + 0.5*y), y'=y, z=0
    gsMultiPatch<real_t> mp_sh = mp_id;
    gsMatrix<real_t>& C = mp_sh.patch(0).coefs();
    for (index_t r = 0; r < C.rows(); ++r)
        C(r,0) = 1.3 * (C(r,0) + 0.5 * C(r,1));

    gsFunctionExpr<real_t> t(std::to_string(thickness), 3);
    gsFunctionExpr<real_t> Ef(std::to_string(E), 3);
    gsFunctionExpr<real_t> nuf(std::to_string(nu), 3);
    std::vector<gsFunctionSet<real_t>*> pars{&Ef, &nuf};

    gsOptionList opts;
    opts.addInt("Material","(0)=SvK",0);
    opts.addSwitch("Compressibility","",false);
    opts.addInt("Implementation","(1)=Analytical",1);

    auto matId = getMaterialMatrix<3,real_t>(mp_id, t, pars, opts);
    auto matSh = getMaterialMatrix<3,real_t>(mp_sh, t, pars, opts);

    gsVector<real_t> pt(2); pt << 0.5, 0.5;

    gsMatrix<real_t> A_id = evalMat(mp_id, matId.get(), false, pt);
    gsMatrix<real_t> A_sh = evalMat(mp_sh, matSh.get(), false, pt);
    gsMatrix<real_t> D_id = evalMat(mp_id, matId.get(), true,  pt);
    gsMatrix<real_t> D_sh = evalMat(mp_sh, matSh.get(), true,  pt);

    // textbook Cartesian plane-stress
    real_t f = E*thickness/(1.0-nu*nu);
    gsMatrix<real_t> A_cart(3,3);
    A_cart << f, f*nu, 0,  f*nu, f, 0,  0, 0, f*(1-nu)/2;
    gsMatrix<real_t> D_cart = A_cart * (thickness*thickness/12.0);

    gsInfo << "=== eval3D MatrixA (reshaped 3x3) ===\n";
    gsInfo << "A_cart (textbook):\n" << A_cart << "\n";
    gsInfo << "A on AXIS-ALIGNED patch:\n" << A_id.reshape(3,3) << "\n";
    gsInfo << "A on SHEARED patch:\n"      << A_sh.reshape(3,3) << "\n";
    gsInfo << "=== eval3D MatrixD ===\n";
    gsInfo << "D_cart (textbook):\n" << D_cart << "\n";
    gsInfo << "D on AXIS-ALIGNED patch:\n" << D_id.reshape(3,3) << "\n";
    gsInfo << "D on SHEARED patch:\n"      << D_sh.reshape(3,3) << "\n";

    real_t e_id  = (A_id.reshape(3,3) - A_cart).norm();
    real_t e_sh  = (A_sh.reshape(3,3) - A_cart).norm();
    real_t e_idsh = (A_id - A_sh).norm();
    gsInfo << "\n||A_axis - A_cart|| = " << e_id  << "\n";
    gsInfo << "||A_shear - A_cart|| = " << e_sh  << "\n";
    gsInfo << "||A_axis - A_shear|| = " << e_idsh << "\n";
    gsInfo << "\nVERDICT: ";
    if (e_sh < 1e-6*f && e_id < 1e-6*f)
        gsInfo << "ORTHONORMAL/CARTESIAN frame — eval3D returns the textbook "
                  "plane-stress matrix regardless of metric. The metric must be "
                  "applied via a frame transform (cartcov/cartcon) in the element.\n";
    else if (e_idsh > 1e-6*f)
        gsInfo << "METRIC-WEIGHTED — the sheared metric changes A; eval3D returns "
                  "the curvilinear constitutive. Pair directly with covariant strains.\n";
    else
        gsInfo << "INCONCLUSIVE — inspect the matrices above.\n";
    return 0;
}
