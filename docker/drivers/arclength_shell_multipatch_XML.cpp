/** @file arclength_shell_multipatch_XML.cpp

    @brief Blackbox arc-length (GNIA) solver for shell buckling on
           multi-patches with unstructured splines.

    Aeris custom driver. Combines:
      - the XML bvp reading + gsSmoothInterfaces multipatch setup from
        buckling_shell_multipatch_XML.cpp, and
      - the arc-length continuation + bifurcation detection from the
        gsThinShell_ArcLength.cpp example,
    so the Aeris cylinder (4-patch closed cylinder) can be traced past
    its buckling limit point with a knockdown-producing imperfection.

    Output protocol (parsed by the Aeris GUI's load-deflection monitor):
      [AERIS-PROGRESS] step=k L=<loadFactor> u=<|U|> Dmin=<indicator>
                       bif=<0|1> bisected=<0|1>

    The geometry/material/BCs/loads XML schema is IDENTICAL to
    buckling_shell_multipatch_XML (ids 0/10-11/20/21/22/30-32/50-52/92),
    so cylinder_lba.py's build_cylinder_xml output works here verbatim.
    Arc-length-specific knobs come from CLI flags, not the XML.

    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0.
*/

#include <gismo.h>

#ifdef gsKLShell_ENABLED
#include <gsKLShell/src/gsThinShellAssembler.h>
#include <gsKLShell/src/gsFunctionSum.h>
#endif

#ifdef gsStructuralAnalysis_ENABLED
#include <gsStructuralAnalysis/src/gsALMSolvers/gsALMBase.h>
#include <gsStructuralAnalysis/src/gsALMSolvers/gsALMLoadControl.h>
#include <gsStructuralAnalysis/src/gsALMSolvers/gsALMRiks.h>
#include <gsStructuralAnalysis/src/gsALMSolvers/gsALMCrisfield.h>
#include <gsStructuralAnalysis/src/gsEigenSolvers/gsBucklingSolver.h>
#include <gsStructuralAnalysis/src/gsStructuralAnalysisTools/gsStructuralAnalysisUtils.h>
#endif

#ifdef gsUnstructuredSplines_ENABLED
#include <gsUnstructuredSplines/src/gsSmoothInterfaces.h>
#include <gsUnstructuredSplines/src/gsAlmostC1.h>
#include <gsUnstructuredSplines/src/gsDPatch.h>
#endif

#include <gsUtils/gsL2Projection.h>

using namespace gismo;

int main (int argc, char** argv)
{
#ifdef gsKLShell_ENABLED
#ifdef gsUnstructuredSplines_ENABLED
    // ---- Input options -----------------------------------------------------
    index_t numElevate = 0;
    index_t numRefine  = 1;
    index_t method     = 0;        // smoothing method (0: gsSmoothInterfaces)
    index_t degree     = 3;
    index_t smoothness = 2;
    bool    plot       = false;

    // Arc-length options
    index_t almMethod  = 2;        // 0: load control, 1: Riks, 2: Crisfield
    real_t  dLb        = 0.5;      // arc length per step
    index_t maxSteps   = 50;       // max load steps
    bool    bifurcation= true;     // detect singular points
    real_t  tol        = 1e-6;
    index_t maxit      = 50;

    // Imperfection options
    //   imperfKind 0 = none (perfect shell; sharp bifurcation),
    //              1 = random radial CP perturbation,
    //              2 = eigenmode-shaped (LBA mode `imperfMode` scaled to
    //                  amplitude `imperfection`, superimposed on geometry).
    index_t imperfKind = 1;
    real_t  imperfection = 0.0;    // amplitude (length units)
    index_t imperfMode = 1;        // 1-based LBA mode number (kind=2)
    index_t imperfSeed = 1;        // RNG seed (kind=1)

    std::string bvp;
    std::string dirname = "ArcLengthResults";

    gsCmdLine cmd("Arc-length (GNIA) shell solver for multi-patches.");
    cmd.addInt("r","hRefine", "Dyadic h-refinement steps", numRefine);
    cmd.addInt("e","degreeElevation", "Degree elevation steps", numElevate);
    cmd.addInt("m","method", "Smoothing method (0: smoothInterfaces, 1: AlmostC1, 2: DPatch)", method);
    cmd.addInt("p","degree", "Polynomial degree of the basis", degree);
    cmd.addInt("s","smoothness", "Smoothness of the basis", smoothness);
    cmd.addInt("A","almMethod", "Arc-length method: 0: load control, 1: Riks, 2: Crisfield", almMethod);
    cmd.addReal("L","arcLength", "Arc length per step (dLb)", dLb);
    cmd.addInt("N","maxSteps", "Maximum number of load steps", maxSteps);
    cmd.addSwitch("bifurcation", "Detect singular points (stability change)", bifurcation);
    cmd.addInt("K","imperfKind", "Imperfection kind: 0 none, 1 random radial, 2 eigenmode-shaped", imperfKind);
    cmd.addReal("P","imperfection", "Imperfection amplitude (length units; 0 = perfect)", imperfection);
    cmd.addInt("M","imperfMode", "LBA mode number for eigenmode imperfection (kind=2, 1-based)", imperfMode);
    cmd.addInt("S","imperfSeed", "RNG seed for the random radial imperfection (kind=1)", imperfSeed);
    cmd.addReal("t","tol", "Newton tolerance inside each arc-length step", tol);
    cmd.addInt("I","maxit", "Max Newton iterations per arc-length step", maxit);
    cmd.addSwitch("plot", "Plot result in ParaView format", plot);
    cmd.addString("i","inputFile", "Input bvp XML file", bvp);
    cmd.addString("o","outputDir", "Output directory", dirname);

    try { cmd.getValues(argc,argv); } catch (int rv) { return rv; }

    GISMO_ENSURE(degree>smoothness,"Degree must be larger than the smoothness!");

    // ---- Read data (same schema as buckling_shell_multipatch_XML) ----------
    gsMultiPatch<> mp, mp_def;
    gsBoundaryConditions<> BCs;
    gsFunctionExpr<> forceFun;
    gsFunctionExpr<> pressFun;
    gsPointLoads<real_t> pLoads = gsPointLoads<real_t>();
    gsMatrix<> points, loads;
    gsMatrix<index_t> pid_ploads;
    gsOptionList assemblerOptions, bucklingOptions;

    gsFileData<real_t> fd(bvp);
    gsInfo<<"Reading geometry (ID=0) ...";
    fd.getId(0,mp);
    gsInfo<<"Finished\n";

    for (size_t p=0; p!=mp.nPatches(); p++)
    {
      for(index_t i = 0; i< numElevate; ++i)
      {
        if (dynamic_cast<gsTensorNurbs<2,real_t> * >(&mp.patch(p)))
          mp.patch(p).degreeElevate();
        else
          mp.patch(p).degreeIncrease();
      }
      for(index_t i = 0; i< numRefine; ++i)
        mp.patch(p).uniformRefine();
    }

    gsMultiBasis<> dbasis(mp,true);
    gsInfo<<"Basis (patch 0): "<< mp.patch(0).basis() << "\n";
    mp_def = mp;

    gsInfo<<"Looking for material matrices ...\n";
    gsMaterialMatrixContainer<real_t> materialMatrixContainer;
    gsMaterialMatrixBase<real_t> * materialMatrix;
    if (fd.hasAny<gsMaterialMatrixContainer<real_t>>())
    {
      gsInfo<<"Reading material matrix container (ID=11) ...";
      fd.getId(11,materialMatrixContainer);
    }
    else
    {
      gsInfo<<"Reading material matrix (ID=10) ...";
      materialMatrix = fd.getId<gsMaterialMatrixBase<real_t>>(10).release();
      for (size_t p = 0; p!=mp.nPatches(); p++)
        materialMatrixContainer.add(materialMatrix);
    }
    gsInfo<<"Finished\n";

    gsInfo<<"Reading boundary conditions (ID=20) ...";
    fd.getId(20,BCs);
    BCs.setGeoMap(mp);
    gsInfo<<"Finished\n";

    gsInfo<<"Reading force function (ID=21) ...";
    fd.getId(21,forceFun);
    gsInfo<<"Finished\n";
    bool pressure = false;
    if ( fd.hasId(22) ) { pressure = true; fd.getId(22,pressFun); }

    if ( fd.hasId(30) ) fd.getId(30,points);
    if ( fd.hasId(31) ) fd.getId(31,loads);
    if ( fd.hasId(32) ) fd.getId(32,pid_ploads);
    if ( !fd.hasId(30) || !fd.hasId(31) || !fd.hasId(32) )
        pid_ploads = gsMatrix<index_t>::Zero(1,points.cols());
    for (index_t k =0; k!=points.cols(); k++)
        pLoads.addLoad(points.col(k), loads.col(k), pid_ploads.at(k) );

    // Reference points (id 50/51/52) — used for QoI extraction
    gsMatrix<index_t> refPatches;
    gsMatrix<> refPoints, refValue;
    if ( fd.hasId(50) ) fd.getId(50,refPoints);
    if ( fd.hasId(51) ) fd.getId(51,refPatches);
    if ( fd.hasId(52) ) fd.getId(52,refValue);

    if ( fd.hasId(92) ) fd.getId(92,assemblerOptions);
    // Buckling-solver options (id=94) — build_cylinder_xml writes the same
    // proven Spectra config cylinder_lba.py validated. Reused for the
    // eigenmode-imperfection LBA stage so we extract the correct mode.
    if ( fd.hasId(94) ) fd.getId(94,bucklingOptions);

    dirname = gsFileManager::getCanonicRepresentation(dirname,true);
    gsFileManager::mkdir(dirname);

    if (plot) gsWriteParaview(mp,"mp",1000,true);

    mp.computeTopology();

    // ---- Build unstructured (smooth) spline basis --------------------------
    gsMultiPatch<> geom;
    gsMappedBasis<2,real_t> bb2;
    gsSparseMatrix<> global2local;
    if (method==0)
    {
        gsSmoothInterfaces<2,real_t> smoothInterfaces(mp);
        smoothInterfaces.options().setSwitch("SharpCorners",false);
        smoothInterfaces.compute();
        smoothInterfaces.matrix_into(global2local);
        global2local = global2local.transpose();
        geom = smoothInterfaces.exportToPatches();
        dbasis = smoothInterfaces.localBasis();
        bb2.init(dbasis,global2local);
    }
    else if (method==1)
    {
        gsAlmostC1<2,real_t> almostC1(mp);
        almostC1.options().setSwitch("SharpCorners",true);
        almostC1.compute();
        almostC1.matrix_into(global2local);
        global2local = global2local.transpose();
        geom = almostC1.exportToPatches();
        dbasis = almostC1.localBasis();
        bb2.init(dbasis,global2local);
    }
    else if (method==2)
    {
        gsDPatch<2,real_t> dpatch(mp);
        dpatch.options().setSwitch("SharpCorners",true);
        dpatch.compute();
        dpatch.matrix_into(global2local);
        global2local = global2local.transpose();
        geom = dpatch.exportToPatches();
        dbasis = dpatch.localBasis();
        bb2.init(dbasis,global2local);
    }
    else
      GISMO_ERROR("Method "<<method<<" unknown");

    BCs.setGeoMap(geom);

    // ---- Assembler (built on the PERFECT geometry first) -------------------
    // For eigenmode imperfection we must run an LBA on the perfect shell
    // before perturbing, so the assembler is created here, the imperfection
    // is injected into geom below, and then we re-assemble. The assembler
    // holds geom by reference, so perturbing geom.coefs() in place + a
    // re-assemble() is all that's needed to switch to the imperfect shell.
    gsThinShellAssembler<3, real_t, true> assembler(geom,dbasis,BCs,forceFun,materialMatrixContainer);
    assembler.setOptions(assemblerOptions);
    assembler.options().setInt("Continuity",-1);
    assembler.setSpaceBasis(bb2);
    assembler.setPointLoads(pLoads);
    if (pressure) assembler.setPressure(pressFun);

    assembler.assemble();
    gsSparseMatrix<> K_L = assembler.matrix();
    gsVector<> Force = assembler.rhs();
    gsInfo<<"Number of DoFs: "<<assembler.numDofs()<<"\n";

    // ---- Imperfection injection --------------------------------------------
    // Three kinds (CLI -K): 0 none, 1 random radial, 2 eigenmode-shaped.
    // Both 1 and 2 perturb geom.coefs() in place, then re-assemble so the
    // arc-length walk integrates over the IMPERFECT reference. 0 leaves the
    // perfect shell (sharp bifurcation; arc-length may stall at the
    // singular tangent).
    size_t gdim = geom.targetDim();
    if (imperfKind==2 && imperfection != 0.0)
    {
        // ===== Eigenmode-shaped imperfection (textbook GNIA) =====
        // 1) LBA on the perfect shell: K_L from the assemble above, K_NL
        //    from a linear-prestress solve. We flip Force to TENSILE for
        //    the prestress so the buckling eigenvalues come out positive
        //    (matches the proven id=94 Spectra shift from build_cylinder_xml).
        //    The eigenVECTOR shape is sign-independent, so this gives the
        //    correct mode regardless.
        gsInfo<<"[AERIS-PHASE] lba_solving\n"<<std::flush;
        gsSparseSolver<>::CGDiagonal linSolver;
        linSolver.compute(K_L);
        gsVector<> u0 = linSolver.solve(-Force);   // tensile prestress

        gsSparseMatrix<> K_NL;
        {
            gsMatrix<real_t> solFull = assembler.fullSolutionVector(u0);
            solFull.resize(solFull.rows()/gdim,gdim);
            gsMappedSpline<2,real_t> msp(bb2,solFull);
            gsFunctionSum<real_t> def(&geom,&msp);
            assembler.assembleMatrix(def);
            K_NL = assembler.matrix();
        }
        K_NL -= K_L;

        gsBucklingSolver<real_t> bsolver(K_L,K_NL);
        if (bucklingOptions.size() > 0) bsolver.setOptions(bucklingOptions);
        // Need at least `imperfMode` modes; ask for a couple extra so
        // Spectra's ncv > nev constraint is comfortably satisfied.
        gsStatus bst = bsolver.computeSparse(imperfMode + 2);
        GISMO_ENSURE(bst == gsStatus::Success, "LBA (buckling) solve failed");
        gsMatrix<> evals = bsolver.values();
        gsMatrix<> evecs = bsolver.vectors();
        index_t mi = imperfMode - 1;                // 1-based → 0-based
        GISMO_ENSURE(mi >= 0 && mi < evecs.cols(),
                     "Requested imperfection mode "<<imperfMode
                     <<" out of range (got "<<evecs.cols()<<" modes)");
        real_t eig = evals.at(mi);
        gsInfo<<"[AERIS-PHASE] lba_done mode="<<imperfMode
              <<" eigenvalue="<<std::setprecision(8)<<eig<<"\n"<<std::flush;

        // 2) Build the mode field, L2-project onto the local basis to get
        //    per-patch control-point displacements (same pattern as the
        //    buckling driver's remap path).
        gsInfo<<"[AERIS-PHASE] applying_imperfection\n"<<std::flush;
        gsVector<> ev = evecs.col(mi).normalized();
        gsMatrix<real_t> modeGlobal = assembler.fullSolutionVector(ev);  // (nGlobal*gdim) x 1
        modeGlobal.resize(modeGlobal.rows()/gdim, gdim);                 // nGlobal x gdim

        // Map the mode's GLOBAL (mapped-basis) coefficients to LOCAL (per-patch
        // dbasis) coefficients via the smooth-interface matrix. This is the
        // EXACT linear map bb2 uses internally (localCoefs = global2local *
        // globalCoefs), so no L2 projection / quadrature is needed — avoids
        // the segfault we hit projecting a bare gsMappedSpline.
        gsMatrix<real_t> modeLocal = global2local * modeGlobal;          // nLocal x gdim

        // Normalise so the MAX nodal displacement of the mode equals the
        // requested amplitude (standard convention: imperfection =
        // amplitude * φ / max|φ|).
        real_t maxNorm = 0.0;
        for (index_t i=0; i<modeLocal.rows(); ++i)
            maxNorm = math::max(maxNorm, modeLocal.row(i).norm());
        real_t scale = (maxNorm > 1e-14) ? (imperfection / maxNorm) : 0.0;

        // Add the scaled mode to geom, per patch. geom's patches are in the
        // local basis (exportToPatches), so the row blocks line up with the
        // patch control-point counts.
        index_t offset = 0;
        for (size_t p=0; p!=geom.nPatches(); ++p)
        {
            index_t psz = geom.patch(p).coefs().rows();
            geom.patch(p).coefs() += scale * modeLocal.block(offset,0,psz,gdim);
            offset += psz;
        }
        gsInfo<<"Imperfection: eigenmode "<<imperfMode<<" scaled to amplitude "
              <<imperfection<<" (scale="<<scale<<", max|mode|="<<maxNorm<<")\n";

        // 5) Re-assemble on the imperfect geometry → fresh K_L + Force.
        assembler.assemble();
        K_L = assembler.matrix();
        Force = assembler.rhs();
    }
    else if (imperfKind==1 && imperfection != 0.0)
    {
        // ===== Random radial imperfection (quick symmetry-breaker) =====
        std::srand(static_cast<unsigned>(imperfSeed));
        index_t nPerturbed = 0;
        for (size_t p=0; p!=geom.nPatches(); p++)
        {
            gsMatrix<> & coefs = geom.patch(p).coefs();
            for (index_t i=0; i!=coefs.rows(); i++)
            {
                real_t x = coefs(i,0), y = coefs(i,1);
                real_t r = math::sqrt(x*x + y*y);
                if (r > 1e-12)
                {
                    real_t xi = 2.0 * (static_cast<real_t>(std::rand()) / RAND_MAX) - 1.0;
                    real_t d = imperfection * xi;
                    coefs(i,0) += d * x / r;
                    coefs(i,1) += d * y / r;
                    nPerturbed++;
                }
            }
        }
        gsInfo<<"Applied random radial imperfection (amplitude "<<imperfection
              <<", seed "<<imperfSeed<<") to "<<nPerturbed<<" control points.\n";
        assembler.assemble();
        K_L = assembler.matrix();
        Force = assembler.rhs();
    }
    GISMO_UNUSED(K_L);

    // ---- Arc-length operator lambdas (mapped-spline style) -----------------
    // These mirror buckling_shell_multipatch_XML's Jacobian: the solution
    // vector x is in the GLOBAL (mapped) basis, so we lift it via
    // fullSolutionVector → reshape → gsMappedSpline → gsFunctionSum(geom, .)
    // to get the deformed configuration the assembler integrates over.
    // (gsFunctionSum has a deleted assignment operator — const m_size — so
    //  each lambda constructs it fresh in-scope rather than via a helper.)
    gsStructuralAnalysisOps<real_t>::dJacobian_t dJacobian =
      [&assembler,&bb2,&geom](gsVector<real_t> const &x, gsVector<real_t> const & /*dx*/, gsSparseMatrix<real_t> & m)
    {
        gsMatrix<real_t> solFull = assembler.fullSolutionVector(x);
        size_t d = geom.targetDim();
        solFull.resize(solFull.rows()/d,d);
        gsMappedSpline<2,real_t> mspline(bb2,solFull);
        gsFunctionSum<real_t> def(&geom,&mspline);
        ThinShellAssemblerStatus status = assembler.assembleMatrix(def);
        m = assembler.matrix();
        return status == ThinShellAssemblerStatus::Success;
    };

    gsStructuralAnalysisOps<real_t>::ALResidual_t ALResidual =
      [&assembler,&bb2,&geom,&Force](gsVector<real_t> const &x, real_t lam, gsVector<real_t> & result)
    {
        gsMatrix<real_t> solFull = assembler.fullSolutionVector(x);
        size_t d = geom.targetDim();
        solFull.resize(solFull.rows()/d,d);
        gsMappedSpline<2,real_t> mspline(bb2,solFull);
        gsFunctionSum<real_t> def(&geom,&mspline);
        ThinShellAssemblerStatus status = assembler.assembleVector(def);
        result = Force - lam * Force - assembler.rhs();  // residual
        return status == ThinShellAssemblerStatus::Success;
    };

    // ---- Arc-length solver -------------------------------------------------
    gsALMBase<real_t> * arcLength;
    if (almMethod==0)      arcLength = new gsALMLoadControl<real_t>(dJacobian, ALResidual, Force);
    else if (almMethod==1) arcLength = new gsALMRiks<real_t>(dJacobian, ALResidual, Force);
    else                   arcLength = new gsALMCrisfield<real_t>(dJacobian, ALResidual, Force);

    arcLength->options().setString("Solver","SimplicialLDLT");
    arcLength->options().setInt("BifurcationMethod",0);   // 0: determinant
    arcLength->options().setReal("Length",dLb);
    // AngleMethod + Scaling are Crisfield-only options (Riks / LoadControl
    // don't declare them, and gsOptionList::setInt/setReal throw on an
    // undefined key). Only the common base options (Solver,
    // BifurcationMethod, Length, Tol, MaxIter, Verbose) are set for all.
    if (almMethod==2)
    {
        arcLength->options().setInt("AngleMethod",0);
        arcLength->options().setReal("Scaling",0.0);
    }
    arcLength->options().setReal("Tol",tol);
    arcLength->options().setInt("MaxIter",maxit);
    arcLength->options().setSwitch("Verbose",true);
    arcLength->applyOptions();
    arcLength->initialize();

    // ---- Step loop ---------------------------------------------------------
    real_t Lold = 0;
    gsVector<> Uold = Force; Uold.setZero();
    gsMatrix<> solVector;
    real_t indicator = 0.0;
    arcLength->setIndicator(indicator);

    // Track the stability indicator across steps. The robust bifurcation
    // signal is the SIGN CHANGE of the determinant-based indicator
    // (positive = stable pre-buckling, negative = an eigenvalue of K_T has
    // gone negative = limit/bifurcation point passed). gsALMBase's own
    // stabilityChange() can be timing-sensitive depending on when
    // computeStability runs, so we additionally flag the sign flip
    // ourselves — that's what the Aeris monitor keys off.
    real_t prevIndicator = 0.0;
    bool   haveePrev = false;
    bool   firstBifReported = false;

    gsInfo<<"[AERIS-PHASE] arclength_start\n"<<std::flush;

    for (index_t k=0; k<maxSteps; k++)
    {
        gsStatus status = arcLength->step();

        if (status==gsStatus::NotConverged || status==gsStatus::AssemblyError)
        {
            real_t newdLb = dLb / 2.0;
            gsInfo<<"[AERIS-PROGRESS] step="<<k<<" bisected=1 arcLength="<<newdLb
                  <<" reason=not_converged\n"<<std::flush;
            dLb = newdLb;
            arcLength->setLength(dLb);
            arcLength->setSolution(Uold,Lold);
            if (dLb < 1e-8)
            {
                gsInfo<<"[AERIS-PHASE] halt_min_arclength\n"<<std::flush;
                break;
            }
            k -= 1;
            continue;
        }

        index_t bif = 0;
        if (bifurcation)
        {
            arcLength->computeStability(true);
            if (arcLength->stabilityChange())
                bif = 1;
        }
        indicator = arcLength->indicator();

        // Sign-flip detection (positive → negative = buckling point).
        if (haveePrev && prevIndicator > 0 && indicator < 0)
            bif = 1;
        if (bif && !firstBifReported)
        {
            gsInfo<<"Bifurcation spotted! (limit/buckling point at L="
                  <<std::setprecision(8)<<arcLength->solutionL()<<")\n";
            firstBifReported = true;
        }
        prevIndicator = indicator;
        haveePrev = true;

        solVector = arcLength->solutionU();
        Uold = solVector;
        Lold = arcLength->solutionL();

        gsInfo<<"[AERIS-PROGRESS]"
              <<" step="<<k
              <<" L="<<std::setprecision(10)<<arcLength->solutionL()
              <<" u="<<std::setprecision(10)<<solVector.norm()
              <<" Dmin="<<std::setprecision(6)<<indicator
              <<" bif="<<bif
              <<" bisected=0\n"<<std::flush;
    }

    gsInfo<<"[AERIS-PHASE] arclength_done\n"<<std::flush;

    delete arcLength;
    return EXIT_SUCCESS;
#else
    GISMO_UNUSED(argc); GISMO_UNUSED(argv);
    gsWarn<<"G+Smo not compiled with gsUnstructuredSplines.";
    return EXIT_FAILURE;
#endif
#else
    GISMO_UNUSED(argc); GISMO_UNUSED(argv);
    gsWarn<<"G+Smo not compiled with gsKLShell.";
    return EXIT_FAILURE;
#endif
}
