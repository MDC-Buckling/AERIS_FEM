/** Benchmark catalog — single source of truth for the Hub.
 *
 * Each entry is one benchmark. The Hub renders a card per entry; "Load
 * into Model" copies the `modelPreset` into the store's `model` slot,
 * "Run" fires runBenchmark which submits a job with that benchmark's
 * recipe (single r or full convergence sweep), and the per-card verdict
 * row reads the latest run.json sidecar through `interpret(manifest)`
 * to extract the PASS/FAIL + key number.
 *
 * Adding a new benchmark = adding one entry here + one
 * `interpret(manifest)` if the QoI extraction differs from the cylinder
 * LBA's verdict-block readout. Wiring a "coming soon" benchmark to
 * `enabled: true` is a separate session because it usually needs new
 * solver-side support (different driver, different shape).
 */

/** Categories the cards group / colour by. Stable strings — the Hub UI
 * uses them for the chip and the optional category filter. */
export const CATEGORIES = {
  BUCKLING_LBA:   { id: "buckling-lba",   label: "Buckling · LBA",          color: "var(--accent)" },
  STATIC_MEMBRANE:{ id: "static-membrane",label: "Static · membrane-dom.",  color: "var(--success)" },
  STATIC_BENDING: { id: "static-bending", label: "Static · bending-dom.",   color: "var(--accent-muted)" },
  COUPLING_TEST:  { id: "coupling-test",  label: "Coupling · multipatch",   color: "var(--warning)" },
};

/** Default analysis block — copied verbatim from store.js so a benchmark
 * preset that doesn't override it gets the validated solver settings. */
const DEFAULT_ANALYSIS = {
  kind: "lba",
  nmodes: 5,
  solver: "spectra-buckling",
  shift: "auto",
  tolerance: 1e-8,
  ncv_factor: 3,
  interface_penalty: 1e6,
};

const DEFAULT_MESH = {
  refinement: 5, degree: 3, smoothness: 2, coupling: "gsSmoothInterfaces",
};

/** Defaults preserved in every preset so the loaded model always carries
 * BOTH shape blocks (matches the store's default) — switching shape in
 * the GUI after loading doesn't lose the dimensions of the OTHER kind. */
const DEFAULT_CYLINDER = { R: 33.0, L: 100.0, t: 0.1, partitions: [] };
const DEFAULT_SEGMENT  = { R: 25.0, L: 50.0, t: 0.25, phi_deg: 40.0 };
const DEFAULT_HEMISPHERE = { R: 10.0, t: 0.04 };

/** Helper: build a cylinder-LBA preset with sensible defaults. Each
 * benchmark only has to specify what's special (R / L / t / E / nu /
 * load.kind), the rest comes from these defaults. materialName
 * keeps the human label consistent with store.js's default so the
 * "load into model" flow doesn't churn the inspector for cosmetic
 * reasons. */
function cylinderLbaPreset({ R, L, t, E, nu,
                             loadKind = "axial", magnitude = 1.0,
                             projectName = "Cylinder LBA",
                             materialName = "Steel (linear isotropic)" }) {
  return {
    schemaVersion: 2,
    name: projectName,
    geometry: {
      shape: "cylinder",
      cylinder: { R, L, t, partitions: [] },
      // Carry the segment defaults too so a user who switches shape
      // after loading this preset still finds reasonable values to
      // edit (matches store.js's default geometry block).
      cylinder_segment: { ...DEFAULT_SEGMENT },
    },
    materials: [
      { id: "mat-default", name: materialName,
        model: "linear", E, nu },
    ],
    sections: [
      { id: "sec-shell-1", name: "Shell — full cylinder",
        kind: "shell", material_ref: "mat-default",
        thickness_source: { kind: "geometry" }, offset: "midsurface" },
    ],
    assignments: [{ region: "shell_full", section_ref: "sec-shell-1" }],
    mesh:     { ...DEFAULT_MESH },
    bcs:      { kind: "clamped_neumann" },
    load:     { kind: loadKind, magnitude },
    analysis: { ...DEFAULT_ANALYSIS },
  };
}

/** Interpreter for cylinder-axial / cylinder-bending LBA benchmarks.
 * The run.json sidecar already carries everything we need:
 *   verdict.deviationPct       — % off the classical reference
 *   verdict.ok                 — true when |deviation| < 25 %
 *   criticalLoad.{computed,classical}  — for the headline number
 *
 * The Hub's pass threshold is tighter than the script's ±25 % "order of
 * magnitude" check: for a validated benchmark we expect well under 1 %
 * at r=5 once the case is set up correctly. */
function cylinderLbaInterpret(manifest, pct_tolerance) {
  if (!manifest || !manifest.verdict) {
    return { status: "no-data", text: "no run yet" };
  }
  const dev = manifest.verdict.deviationPct;
  const passed = Math.abs(dev) <= pct_tolerance;
  const cl = manifest.criticalLoad;
  const headline = cl
    ? `${cl.kind}_cr = ${cl.computed.toExponential(3)} (classical ${cl.classical.toExponential(3)})`
    : `σ_cr = ${manifest.verdict.sigmaFinest.toExponential(3)}`;
  return {
    status: passed ? "pass" : "fail",
    deviationPct: dev,
    headline,
    tolerance: pct_tolerance,
    convergence: manifest.convergence ?? [],
  };
}

/** Interpreter for the Scordelis-Lo static benchmark. Reads the static
 * sidecar shape (qois[0].qoiAbsValue + convergence[] with per-r
 * qoiAbsValue entries) and compares |u_z| against the literature
 * reference (0.3006 for the KL shell; the often-quoted 0.3024 is for
 * shear-deformable shells, which is NOT us).
 *
 * Also enriches each convergence row with `pct` = (|u_z| - ref) / ref
 * so the Hub's formatConvergenceRow can render the per-r deviation
 * trend without the script having to know the reference. */
function staticPointLoadInterpret(manifest, pct_tolerance, refDisplacement, qoiLabel = "|u|") {
  if (!manifest || !manifest.qois || manifest.qois.length === 0) {
    return { status: "no-data", text: "no run yet" };
  }
  const q = manifest.qois[0];
  const computed = Number(q.qoiAbsValue ?? Math.abs(q.qoiValue));
  const dev = 100.0 * (computed - refDisplacement) / refDisplacement;
  const passed = Math.abs(dev) <= pct_tolerance;
  const conv = (manifest.convergence ?? []).map((row) => {
    const v = Number(row.qoiAbsValue ?? Math.abs(row.qoiValue));
    return {
      ...row,
      pct: 100.0 * (v - refDisplacement) / refDisplacement,
    };
  });
  return {
    status: passed ? "pass" : "fail",
    deviationPct: dev,
    headline: `${qoiLabel} = ${computed.toExponential(4)}  (reference ${refDisplacement.toExponential(4)})`,
    tolerance: pct_tolerance,
    convergence: conv,
  };
}

function scordelisLoInterpret(manifest, pct_tolerance, refAbsUz) {
  if (!manifest || !manifest.qois || manifest.qois.length === 0) {
    return { status: "no-data", text: "no run yet" };
  }
  const q = manifest.qois[0];
  const computed = Number(q.qoiAbsValue ?? Math.abs(q.qoiValue));
  const dev = 100.0 * (computed - refAbsUz) / refAbsUz;
  const passed = Math.abs(dev) <= pct_tolerance;
  const conv = (manifest.convergence ?? []).map((row) => {
    const v = Number(row.qoiAbsValue ?? Math.abs(row.qoiValue));
    return {
      ...row,
      pct: 100.0 * (v - refAbsUz) / refAbsUz,
    };
  });
  return {
    status: passed ? "pass" : "fail",
    deviationPct: dev,
    headline: `|u_z| = ${computed.toFixed(5)}  (reference ${refAbsUz})`,
    tolerance: pct_tolerance,
    convergence: conv,
  };
}

/** Preset for the Scordelis-Lo roof. Mirrors store.js's defaults so the
 * "load into model" flow doesn't churn unused fields; only what's
 * actually different for this benchmark is overridden. */
function pinchedCylinderPreset() {
  // MacNeal-Harder benchmark: closed cylinder with two opposing point loads
  // at mid-span. Reference: |u| = 1.8248e-5 at the load (KL shell).
  return {
    schemaVersion: 2,
    name: "Pinched cylinder",
    geometry: {
      shape: "cylinder",
      cylinder: { R: 6.3, L: 12.6, t: 0.03, partitions: [] },
      cylinder_segment: { ...DEFAULT_SEGMENT },
      hemisphere: { ...DEFAULT_HEMISPHERE },
    },
    materials: [
      { id: "mat-default", name: "MacNeal-Harder isotropic",
        model: "linear", E: 207000, nu: 0.3 },
    ],
    sections: [
      { id: "sec-shell-1", name: "Shell — full cylinder",
        kind: "shell", material_ref: "mat-default",
        thickness_source: { kind: "geometry" }, offset: "midsurface" },
    ],
    assignments: [{ region: "shell_full", section_ref: "sec-shell-1" }],
    mesh:     { ...DEFAULT_MESH },
    bcs:      { kind: "clamped_neumann" },
    load:     { kind: "point_load", magnitude: 1.0 },
    analysis: { ...DEFAULT_ANALYSIS, kind: "static" },
  };
}

function pinchedHemispherePreset() {
  // MacNeal-Harder benchmark: hemispherical shell with four alternating
  // ±F point loads at the equator (90° apart). Reference: u_x = 0.0924
  // at the load (KL shell). Classic inextensional-bending test.
  return {
    schemaVersion: 2,
    name: "Pinched hemisphere",
    geometry: {
      shape: "hemisphere",
      cylinder: { ...DEFAULT_CYLINDER },
      cylinder_segment: { ...DEFAULT_SEGMENT },
      hemisphere: { R: 10.0, t: 0.04 },
    },
    materials: [
      { id: "mat-default", name: "MacNeal-Harder isotropic",
        model: "linear", E: 207000, nu: 0.3 },
    ],
    sections: [
      { id: "sec-shell-1", name: "Shell — hemisphere",
        kind: "shell", material_ref: "mat-default",
        thickness_source: { kind: "geometry" }, offset: "midsurface" },
    ],
    assignments: [{ region: "shell_full", section_ref: "sec-shell-1" }],
    mesh:     { ...DEFAULT_MESH },
    bcs:      { kind: "clamped_neumann" },
    load:     { kind: "point_load", magnitude: 1.0 },
    analysis: { ...DEFAULT_ANALYSIS, kind: "static" },
  };
}

function scordelisLoPreset() {
  return {
    schemaVersion: 2,
    name: "Scordelis-Lo roof",
    geometry: {
      shape: "cylinder_segment",
      cylinder: { ...DEFAULT_CYLINDER },
      cylinder_segment: {
        R: 25.0, L: 50.0, t: 0.25, phi_deg: 40.0,
      },
    },
    materials: [
      { id: "mat-default", name: "Scordelis isotropic",
        model: "linear", E: 4.32e8, nu: 0.0 },
    ],
    sections: [
      { id: "sec-shell-1", name: "Shell — roof segment",
        kind: "shell", material_ref: "mat-default",
        thickness_source: { kind: "geometry" }, offset: "midsurface" },
    ],
    assignments: [{ region: "shell_full", section_ref: "sec-shell-1" }],
    mesh:     { ...DEFAULT_MESH },
    bcs:      { kind: "scordelis_diaphragm" },
    load:     { kind: "gravity", magnitude: 90.0 },
    analysis: { ...DEFAULT_ANALYSIS, kind: "static" },
  };
}

export const BENCHMARKS = [
  {
    id: "cylinder-lba-validated",
    name: "Cylinder axial LBA — validated default",
    category: CATEGORIES.BUCKLING_LBA,
    shortDescription: "Dimensionless 4-patch closed cylinder (R=L=1, t=0.01, E=1, ν=0.3). The Session 2.7 reference case — pipeline foundation.",
    referenceSource: "Lorenz (1908) / Timoshenko (1910) — σ_cr = E·t / (R·√(3(1−ν²)))",
    referenceQoI: "σ_cr / E = 1/(100·√2.73) ≈ 6.05·10⁻³",
    tolerancePct: 1.0,
    enabled: true,
    modelPreset: cylinderLbaPreset({
      R: 1.0, L: 1.0, t: 0.01, E: 1.0, nu: 0.3,
      projectName: "Cylinder LBA · validated default",
      materialName: "Linear isotropic (dimensionless)",
    }),
    recipe: { refines: [5], convergenceRefines: [3, 4, 5] },
    interpret: (m) => cylinderLbaInterpret(m, 1.0),
  },
  {
    id: "cylinder-lba-iw1-compression",
    name: "IW1 steel cylinder — axial compression",
    category: CATEGORIES.BUCKLING_LBA,
    shortDescription: "ArianeGroup IW1 reference geometry in SI mm-MPa-N units (R=33, L=100, t=0.1, E=208000, ν=0.3). Tests the toolchain at realistic engineering scale + the E-scaling K_NL−K_L cancellation fix.",
    referenceSource: "Classical Lorenz–Timoshenko · F_cr = σ_cr · 2π·R·t",
    referenceQoI: "F_cr ≈ 7909.7 N at r=5",
    tolerancePct: 1.0,
    enabled: true,
    modelPreset: cylinderLbaPreset({
      R: 33.0, L: 100.0, t: 0.1, E: 208000.0, nu: 0.3,
      projectName: "IW1 cylinder · axial",
    }),
    recipe: { refines: [5], convergenceRefines: [3, 4, 5] },
    interpret: (m) => cylinderLbaInterpret(m, 1.0),
  },
  {
    id: "cylinder-lba-iw1-bending",
    name: "IW1 steel cylinder — pure bending",
    category: CATEGORIES.BUCKLING_LBA,
    shortDescription: "Same IW1 geometry as above but loaded in pure bending via cos(θ) Neumann traction on the top edge. Same theoretical critical stress as axial (Stein & Mayers 1953); knockdown only with imperfections.",
    referenceSource: "Stein & Mayers (1953) · M_cr = σ_cr · π·R²·t for thin annulus",
    referenceQoI: "M_cr ≈ 130 510 N·mm at r=5",
    tolerancePct: 1.0,
    enabled: true,
    modelPreset: cylinderLbaPreset({
      R: 33.0, L: 100.0, t: 0.1, E: 208000.0, nu: 0.3, loadKind: "bending",
      projectName: "IW1 cylinder · bending",
    }),
    recipe: { refines: [5], convergenceRefines: [3, 4, 5] },
    interpret: (m) => cylinderLbaInterpret(m, 1.0),
  },

  // ----- Live (Scordelis-Lo single-patch shipped in Inc 4) -----
  {
    id: "scordelis-lo",
    name: "Scordelis-Lo roof — single patch",
    category: CATEGORIES.STATIC_MEMBRANE,
    shortDescription: "Cylindrical-segment roof (R=25, L=50, t=0.25, φ=40°, ν=0!) loaded by self-weight (q=90/area). Canonical Belytschko obstacle-course test for membrane-dominated bending with free edges.",
    referenceSource: "Belytschko et al. (1985) · |u_z| = 0.3006 (KL shell)",
    referenceQoI: "|u_z|@free-edge-midpoint = 0.3006",
    tolerancePct: 1.0,
    enabled: true,
    modelPreset: scordelisLoPreset(),
    recipe: { refines: [5], convergenceRefines: [3, 4, 5] },
    interpret: (m) => scordelisLoInterpret(m, 1.0, 0.3006),
  },
  {
    id: "scordelis-lo-multipatch",
    name: "Scordelis-Lo roof — 4-patch (coupling test)",
    category: CATEGORIES.COUPLING_TEST,
    shortDescription: "Same roof but split into 4 patches across the arc. Specifically stress-tests gsSmoothInterfaces under static bending — Session 2.7 only validated it under buckling.",
    referenceSource: "Same as single-patch · |u_z| = 0.3006 (KL shell)",
    referenceQoI: "|u_z|@free-edge-midpoint = 0.3006",
    tolerancePct: 2.0,
    enabled: true,
    modelPreset: scordelisLoPreset(),
    recipe: { refines: [5], convergenceRefines: [3, 4, 5] },
    interpret: (m) => scordelisLoInterpret(m, 2.0, 0.3006),
  },
  {
    id: "pinched-cylinder",
    name: "Pinched cylinder",
    category: CATEGORIES.STATIC_BENDING,
    shortDescription: "Closed cylinder with two opposing point loads at mid-span. Classical bending-dominated test that catches shear-locking and inextensional-mode failures.",
    referenceSource: "MacNeal–Harder (1985) · |u| = 1.8248·10⁻⁵ at the load (KL shell)",
    referenceQoI: "|u|@load = 1.8248·10⁻⁵",
    tolerancePct: 2.0,
    enabled: true,
    modelPreset: pinchedCylinderPreset(),
    recipe: { refines: [5], convergenceRefines: [3, 4, 5] },
    interpret: (m) => staticPointLoadInterpret(m, 2.0, 1.8248e-5, "|u|"),
  },
  {
    id: "pinched-hemisphere",
    name: "Pinched hemisphere",
    category: CATEGORIES.STATIC_BENDING,
    shortDescription: "Hemispherical shell with four alternating ±F point loads at the equator (90° apart). The canonical inextensional-bending stress test.",
    referenceSource: "MacNeal–Harder (1985) · u_x = 0.0924 at the load (KL shell)",
    referenceQoI: "u_x@load = 0.0924",
    tolerancePct: 2.0,
    enabled: true,
    modelPreset: pinchedHemispherePreset(),
    recipe: { refines: [5], convergenceRefines: [3, 4, 5] },
    interpret: (m) => staticPointLoadInterpret(m, 2.0, 0.0924, "u_x"),
  },
];

/** Pretty-print one convergence-table row as a string. Dispatches on
 * which fields the row carries so a single Hub renderer covers both
 * LBA (sigmaComputed) and static (qoiAbsValue) sweeps. */
export function formatConvergenceRow(row) {
  const { r, sigmaComputed, qoiAbsValue, pct } = row;
  const pctStr = pct == null
    ? ""
    : `  Δ=${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%`;
  if (qoiAbsValue != null) {
    return `r=${r}  |u_z|=${Number(qoiAbsValue).toFixed(5)}${pctStr}`;
  }
  return `r=${r}  σ_cr=${sigmaComputed.toExponential(3)}${pctStr}`;
}
