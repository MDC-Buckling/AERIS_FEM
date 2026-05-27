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

  // ----- Coming soon (need solver-side wiring before they go live) -----
  {
    id: "scordelis-lo",
    name: "Scordelis-Lo roof — single patch",
    category: CATEGORIES.STATIC_MEMBRANE,
    shortDescription: "Cylindrical-segment roof (R=25, L=50, t=0.25, φ=40°, ν=0!) loaded by self-weight. Canonical Belytschko obstacle-course test for membrane-dominated bending with free edges.",
    referenceSource: "Belytschko et al. (1985) · |u_z| = 0.3006 (KL shell)",
    referenceQoI: "|u_z|@free-edge-midpoint = 0.3006",
    tolerancePct: 2.0,
    enabled: false,
    comingSoonReason: (
      "Needs the static-analysis path in the GUI (analysis.kind=\"static\" is disabled today) "
      + "plus a new shape=\"cylinder_segment\" in geometry. The CLI version already PASSes — "
      + "see benchmarks/scordelis_lo/."
    ),
  },
  {
    id: "scordelis-lo-multipatch",
    name: "Scordelis-Lo roof — 4-patch (coupling test)",
    category: CATEGORIES.COUPLING_TEST,
    shortDescription: "Same roof but split into 4 patches across the arc. Specifically stress-tests gsSmoothInterfaces under static bending — Session 2.7 only validated it under buckling.",
    referenceSource: "Same as single-patch · |u_z| = 0.3006 (KL shell)",
    referenceQoI: "|u_z|@free-edge-midpoint = 0.3006",
    tolerancePct: 2.0,
    enabled: false,
    comingSoonReason: "Depends on the single-patch Scordelis-Lo wiring landing first; then split.",
  },
  {
    id: "pinched-cylinder",
    name: "Pinched cylinder",
    category: CATEGORIES.STATIC_BENDING,
    shortDescription: "Closed cylinder with two opposing point loads at mid-span. Classical bending-dominated test that catches shear-locking and inextensional-mode failures.",
    referenceSource: "MacNeal–Harder (1985) · |u| = 1.8248·10⁻⁵ at the load (KL shell)",
    referenceQoI: "|u|@load = 1.8248·10⁻⁵",
    tolerancePct: 2.0,
    enabled: false,
    comingSoonReason: "Needs analysis.kind=\"static\" + point-load support in the GUI's BCs section.",
  },
  {
    id: "pinched-hemisphere",
    name: "Pinched hemisphere",
    category: CATEGORIES.STATIC_BENDING,
    shortDescription: "Hemispherical shell with four alternating ±F point loads at the equator (90° apart). The canonical inextensional-bending stress test.",
    referenceSource: "MacNeal–Harder (1985) · u_x = 0.0924 at the load (KL shell)",
    referenceQoI: "u_x@load = 0.0924",
    tolerancePct: 2.0,
    enabled: false,
    comingSoonReason: "Needs shape=\"hemisphere\" geometry + the static-analysis path.",
  },
];

/** Pretty-print one convergence-table row as a string. */
export function formatConvergenceRow(row) {
  const { r, sigmaComputed, pct } = row;
  return `r=${r}  σ_cr=${sigmaComputed.toExponential(3)}  Δ=${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%`;
}
