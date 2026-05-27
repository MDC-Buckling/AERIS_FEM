/** Aeris pre-processor section structure — the architecture contract.
 *
 * One entry per section, each with sub-items. Sub-items are addressable by a
 * dotted id (`{sectionId}.{itemId}`) used by the store's `selectedTreeItem`
 * and by the right inspector to know which stub to render.
 *
 * Filling these out section-by-section is the next-few-sessions plan; this
 * file IS the locked structure (sub-items, default-value sketches, future
 * options for selectors) and should not be quietly drifted without bumping
 * a session note.
 */

export const SECTIONS = [
  {
    id: "geometry",
    label: "Geometry",
    items: [
      {
        id: "shape",
        label: "Shape & Type",
        defaultPreview: "Cylinder",
        kind: "selector",
        // Multiple shell families — only Cylinder is functional in the first fill.
        // Listed in full so the tree structure doesn't move when we add the rest.
        options: [
          { value: "cylinder", label: "Cylinder", enabled: true },
          { value: "cone", label: "Cone", enabled: false, note: "coming soon" },
          { value: "sphere", label: "Sphere", enabled: false, note: "coming soon" },
          { value: "torispherical", label: "Torispherical", enabled: false, note: "coming soon" },
          { value: "stiffened", label: "Stiffened Shell", enabled: false, note: "coming soon" },
        ],
      },
      {
        id: "dimensions",
        label: "Dimensions",
        defaultPreview: "R=1.0  L=1.0  t=0.01",
        kind: "fields",
        fields: [
          { name: "R", label: "Mid-surface radius", unit: "–" },
          { name: "L", label: "Axial length", unit: "–" },
          { name: "t", label: "Shell thickness", unit: "–" },
        ],
      },
    ],
  },

  {
    id: "shellConstruction",
    label: "Shell Construction",
    items: [
      {
        id: "thicknessMode",
        label: "Thickness Mode",
        defaultPreview: "Plain (constant t)",
        kind: "selector",
        options: [
          { value: "plain", label: "Plain (constant t)", enabled: true },
          { value: "variable", label: "Variable / function of (θ, z)", enabled: false, note: "later" },
          { value: "composite", label: "Composite layup", enabled: false, note: "later" },
        ],
      },
      {
        id: "stiffeners",
        label: "Ring Frames / Stiffeners",
        defaultPreview: "off",
        kind: "toggle+config",
      },
    ],
  },

  {
    id: "material",
    label: "Material",
    items: [
      {
        id: "base",
        label: "Base Properties",
        defaultPreview: "E=1.0  ν=0.3  σ_y=—",
        kind: "fields",
        fields: [
          { name: "E", label: "Young's modulus", unit: "–" },
          { name: "nu", label: "Poisson ratio", unit: "–" },
          { name: "sigma_y", label: "Yield stress", unit: "–" },
          { name: "rho", label: "Density (optional)", unit: "–" },
        ],
      },
      {
        id: "manufacturing",
        label: "Manufacturing Process",
        defaultPreview: "none",
        kind: "selector",
        options: [
          { value: "none", label: "None", enabled: true },
          { value: "weld", label: "Welded shell", enabled: false, note: "later" },
          { value: "spinning", label: "Spinning", enabled: false, note: "later" },
          { value: "rolling", label: "Rolling", enabled: false, note: "later" },
        ],
      },
      {
        id: "plasticity",
        label: "Plasticity Correction",
        defaultPreview: "off",
        kind: "toggle+config",
      },
      {
        id: "thermal",
        label: "Thermal Correction",
        defaultPreview: "off",
        kind: "toggle+config",
      },
    ],
  },

  {
    id: "imperfections",
    label: "Imperfections",
    items: [
      {
        id: "amplitude",
        label: "Amplitude (w/t)",
        defaultPreview: "0 (perfect)",
        kind: "field",
        field: { name: "wt", label: "Imperfection amplitude w/t", unit: "–" },
      },
      {
        id: "source",
        label: "Type / Source",
        defaultPreview: "none",
        kind: "selector",
        options: [
          { value: "none", label: "None (perfect shell)", enabled: true },
          { value: "eigenmode", label: "Eigenmode-shaped", enabled: false, note: "later" },
          { value: "measured", label: "Measured field (NASA 89-shell DB)", enabled: false, note: "later — the 89 measured fields plug in here" },
          { value: "axisymmetric", label: "Axisymmetric (Koiter)", enabled: false, note: "later" },
          { value: "weld", label: "Weld imperfection (Rotter)", enabled: false, note: "later" },
        ],
      },
      {
        id: "cutouts",
        label: "Cutouts (KDF)",
        defaultPreview: "off",
        kind: "toggle+config",
        // Naming-note in the brief verdict: kept under IMPERFECTIONS because in
        // the Aeris/MDC philosophy cutouts are an η-knockdown effect, but the
        // "(KDF)" suffix makes that choice explicit so we don't trip over it
        // later if we ever model real holes (those would move to GEOMETRY).
      },
    ],
  },

  {
    id: "mesh",
    label: "Mesh / Discretisation",
    items: [
      {
        id: "refinement",
        label: "Refinement level",
        defaultPreview: "r = 5  (matches cylinder_lba.py default)",
        kind: "selector",
        options: [
          { value: 3, label: "r = 3  (coarse)", enabled: true },
          { value: 4, label: "r = 4  (medium)", enabled: true },
          { value: 5, label: "r = 5  (fine — Session-2.7 default)", enabled: true },
          { value: 6, label: "r = 6  (very fine — slow)", enabled: false, note: "later" },
        ],
      },
      {
        id: "degree",
        label: "Polynomial degree",
        defaultPreview: "p = 3, s = 2",
        kind: "fields",
        fields: [
          { name: "p", label: "Spline degree", unit: "–" },
          { name: "s", label: "Inter-patch smoothness", unit: "–" },
        ],
      },
      {
        id: "coupling",
        label: "Patch coupling",
        defaultPreview: "gsSmoothInterfaces  (m=0)",
        kind: "selector",
        // Reflects what Session-2.7 validated; AlmostC1 needed for extraordinary
        // vertices in later geometries (cone-cylinder junctions, etc.).
        options: [
          { value: 0, label: "gsSmoothInterfaces  (regular topology)", enabled: true },
          { value: 1, label: "gsAlmostC1  (extraordinary vertices OK)", enabled: false, note: "later" },
          { value: 2, label: "gsDPatch  (B-spline only)", enabled: false, note: "later" },
          { value: 3, label: "gsApproxC1Spline", enabled: false, note: "later" },
        ],
      },
    ],
  },

  {
    id: "bcsLoads",
    label: "Boundary Conditions & Loads",
    items: [
      {
        id: "bcs",
        label: "Boundary Conditions",
        defaultPreview: "Bottom clamped · Top Neumann",
        kind: "selector",
        options: [
          { value: "clamped_neumann", label: "Bottom clamped · Top Neumann (Session-2.7 default)", enabled: true },
          { value: "clamped_both", label: "Both ends clamped (axial-only Dirichlet)", enabled: false, note: "later" },
          { value: "ss_both", label: "Both ends simply supported", enabled: false, note: "later" },
          { value: "free_top", label: "Bottom clamped · Top free (cantilever)", enabled: false, note: "later" },
        ],
      },
      {
        id: "load",
        label: "Load Case",
        defaultPreview: "Axial compression",
        kind: "selector",
        options: [
          { value: "axial", label: "Axial compression", enabled: true },
          { value: "bending", label: "Bending", enabled: false, note: "later" },
          { value: "torsion", label: "Torsion", enabled: false, note: "later" },
          { value: "extpress", label: "External pressure", enabled: false, note: "later" },
          { value: "intpress", label: "Internal pressure", enabled: false, note: "later" },
          { value: "combined", label: "Combined (axial + bending + pressure)", enabled: false, note: "later" },
        ],
      },
    ],
  },

  {
    id: "analysis",
    label: "Analysis Step",
    items: [
      {
        id: "type",
        label: "Analysis Type",
        defaultPreview: "LBA (linear buckling eigenvalue)",
        kind: "selector",
        options: [
          { value: "lba", label: "LBA · linear buckling eigenvalue (Session-2.7)", enabled: true },
          { value: "gnia", label: "GNIA · geometrically nonlinear (arc-length)", enabled: false, note: "later — gsALMBase / Riks / Crisfield" },
          { value: "modal", label: "Modal (vibration eigenvalue)", enabled: false, note: "later" },
          { value: "static", label: "Static (linear elastic)", enabled: false, note: "later" },
        ],
      },
      {
        id: "solver",
        label: "Solver Settings",
        defaultPreview: "Spectra Buckling  nmodes=5  shift≈σ_cr",
        kind: "fields",
        fields: [
          { name: "nmodes", label: "Number of eigenvalues" },
          { name: "shift", label: "Spectral shift (LBA)" },
          { name: "arclengthDs", label: "Arc-length step Δs (GNIA, later)" },
          { name: "maxIter", label: "Max iterations" },
        ],
      },
    ],
  },

  {
    id: "run",
    label: "Run",
    items: [
      {
        id: "solve",
        label: "Solve",
        defaultPreview: "wired in a later session",
        kind: "run-button",
        disabled: true,
      },
    ],
  },
];

/** Helper: find a section by id. */
export function findSection(id) {
  return SECTIONS.find((s) => s.id === id) ?? null;
}

/** Helper: find a sub-item by dotted id ("section.item"). */
export function findItem(dottedId) {
  if (!dottedId) return null;
  const [sectionId, itemId] = dottedId.split(".");
  const section = findSection(sectionId);
  if (!section) return null;
  return {
    section,
    item: section.items.find((it) => it.id === itemId) ?? null,
  };
}
