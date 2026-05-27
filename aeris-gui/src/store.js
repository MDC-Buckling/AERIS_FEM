import { create } from "zustand";

const THEME_KEY = "aeris_theme";

function initialTheme() {
  if (typeof window === "undefined") return "dark";
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "dark";
}

export const useUI = create((set) => ({
  theme: initialTheme(),
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {}
      return { theme: next };
    }),

  /** Top-level mode: pre-processor (model tree) vs post-processor (results). */
  mode: "pre",
  setMode: (m) => set({ mode: m }),

  /** Pre-processor: which model-tree sub-item is selected. Dotted id like
   * "geometry.dimensions". Drives the right inspector content. */
  selectedTreeItem: "geometry.shape",
  selectTreeItem: (id) => set({ selectedTreeItem: id }),

  /** Pre-processor: which sections are expanded. Default: only GEOMETRY open
   * (that's the first thing the user will touch when filling sections later). */
  expandedSections: new Set(["geometry"]),
  toggleSection: (sectionId) =>
    set((s) => {
      const next = new Set(s.expandedSections);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return { expandedSections: next };
    }),

  /** Pre-processor: per-section state — "default" | "configured" | "warning".
   * Sessions tick them to "configured" as their sections get wired. */
  sectionStatus: {
    geometry:          "configured",  // 3.2
    material:          "configured",  // 3.3
    shellConstruction: "configured",  // 3.3  (trivial section assignment view)
    imperfections:     "default",
    mesh:              "configured",  // 3.5
    bcsLoads:          "configured",  // 3.6 — bcs + axial/bending load wired
    analysis:          "configured",  // 3.8
    run:               "default",
  },
  setSectionStatus: (sectionId, status) =>
    set((s) => ({
      sectionStatus: { ...s.sectionStatus, [sectionId]: status },
    })),

  /** Project / model name shown in the top chrome. Editable later. */
  projectName: "Cylinder LBA",

  /** ----------------------------------------------------------------------
   *  THE MODEL — in-memory mirror of scripts/aeris_model.py's ModelConfig
   *  schema v2. Session 3.3 introduces the ABAQUS-style materials[] /
   *  sections[] / assignments[] split, replacing the v1 top-level
   *  `material: {...}`. Trivial today (one shell, one material, one
   *  assignment) but extensible for stiffeners / variable thickness.
   *  Serialised to model.json on EXPORT MODEL / Solve.
   *  --------------------------------------------------------------------*/
  model: {
    schemaVersion: 2,
    name: "Cylinder LBA",
    // Session-3.3 default: realistic steel-shell case in mm/MPa.
    // R=33, L=100, t=0.1 mm  (R/t = 330, very thin; L/R ≈ 3).
    // E=208 GPa, ν=0.3 (S235 mild-steel ballpark).
    // The whole pipeline is unit-agnostic — pick a consistent system and
    // stick to it. Old dimensionless E=1/R=1 path still works (see
    // build_cylinder_xml comment about the E-scaling fix for large E).
    geometry: {
      shape: "cylinder",
      cylinder: { R: 33.0, L: 100.0, t: 0.1, partitions: [] },
    },
    materials: [
      {
        id: "mat-default",
        name: "Steel (linear isotropic)",
        model: "linear",
        E: 208000.0,   // MPa
        nu: 0.3,
      },
    ],
    sections: [
      {
        id: "sec-shell-1",
        name: "Shell — full cylinder",
        kind: "shell",
        material_ref: "mat-default",
        thickness_source: { kind: "geometry" },
        offset: "midsurface",
      },
    ],
    assignments: [
      { region: "shell_full", section_ref: "sec-shell-1" },
    ],
    mesh: {
      refinement: 5, degree: 3, smoothness: 2,
      coupling: "gsSmoothInterfaces",
    },
    bcs: { kind: "clamped_neumann" },
    // ABAQUS-LBA convention: magnitude is the applied F (axial) or M (bending)
    // in the user's consistent unit system. Default 1 means the eigenvalue
    // reads as the critical load directly (multiply by your real applied
    // load to get the safety factor). The solver's internal Neumann is
    // independently E-scaled for numerical conditioning.
    load: { kind: "axial", magnitude: 1.0 },
    analysis: {
      kind: "lba",
      nmodes: 5,
      // schema name (cylinder_lba.py maps to Spectra mode int via
      // SPECTRA_MODE_MAP). One of:
      //   spectra-buckling      → mode 3, our default (K_L SPD + K_g indef)
      //   spectra-shift-invert  → mode 2, generic shift-invert
      //   spectra-cayley        → mode 4, Cayley-transform shift-invert
      solver: "spectra-buckling",
      // "auto" resolves to classical_sigma_cr / E inside the solver, or
      // pass an explicit number to hunt a specific eigenvalue cluster.
      shift: "auto",
      // Arnoldi convergence tolerance. 1e-8 is well-conditioned; loosen
      // to 1e-6 for ~10–20 % faster runs, tighten to 1e-10 for paranoia.
      tolerance: 1e-8,
      // Krylov subspace size multiplier (ncv = ncv_factor · nmodes). Spectra
      // requires ≥ 2; 3 is generous and helps tough cases at modest cost.
      ncv_factor: 3,
      // gsThinShellAssembler IfcPenalty — weak C0/C1 fallback coupling.
      // 1e6 validated; bumping helps if patches couple poorly.
      interface_penalty: 1e6,
    },
  },

  /** Set cylinder geometry from the inspector. Validates positivity; on
   * non-positive value silently rejects (the input field clamps). */
  setCylinderDim: (key, value) =>
    set((s) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) return {};
      return {
        model: {
          ...s.model,
          geometry: {
            ...s.model.geometry,
            cylinder: { ...s.model.geometry.cylinder, [key]: v },
          },
        },
      };
    }),

  /** Set the shape family. Only "cylinder" is wired. */
  setShape: (shape) =>
    set((s) => ({
      model: {
        ...s.model,
        geometry: { ...s.model.geometry, shape },
      },
    })),

  /** Patch a single field on a material by id. Silently rejects non-finite
   * numbers; positivity for E, [0, 0.5) for nu enforced by the inspector. */
  setMaterialField: (matId, key, value) =>
    set((s) => {
      const materials = s.model.materials.map((m) => {
        if (m.id !== matId) return m;
        let v = value;
        if (typeof v === "number" && !Number.isFinite(v)) return m;
        return { ...m, [key]: v };
      });
      return { model: { ...s.model, materials } };
    }),

  /** -------------------- Partitions + Section Assignments --------------
   * The wiring matches scripts/aeris_model.py: geometry.cylinder.partitions
   * carries [{z}] sorted; sections[] is a library; assignments[] maps each
   * "band_i" region to a section ref. When partitions[] is empty, the
   * single legacy "shell_full" assignment is used.
   * --------------------------------------------------------------------*/

  /** Add a partition at the given z (snapped into [0+ε, L-ε], rejected if
   * within tolerance of an existing partition). Auto-rebuilds the
   * assignments[] table so every band gets a section reference, creating
   * extra sections by cloning the first section's material+thickness
   * when needed. */
  addPartition: (z) =>
    set((s) => {
      const cyl = s.model.geometry.cylinder;
      const L = cyl.L;
      const zNum = Number(z);
      if (!Number.isFinite(zNum) || zNum <= 0 || zNum >= L) return {};
      const existing = (cyl.partitions || []).map((p) => Number(p.z));
      if (existing.some((zp) => Math.abs(zp - zNum) < 1e-9)) return {};
      const partitions = [...existing, zNum]
        .sort((a, b) => a - b)
        .map((zv) => ({ z: zv }));
      return rebuildAssignments({
        ...s.model,
        geometry: { ...s.model.geometry, cylinder: { ...cyl, partitions } },
      });
    }),

  /** Remove the partition at index `i` (0-based) from the sorted list. */
  removePartition: (i) =>
    set((s) => {
      const partitions = (s.model.geometry.cylinder.partitions || []).slice();
      if (i < 0 || i >= partitions.length) return {};
      partitions.splice(i, 1);
      return rebuildAssignments({
        ...s.model,
        geometry: {
          ...s.model.geometry,
          cylinder: { ...s.model.geometry.cylinder, partitions },
        },
      });
    }),

  /** Edit one partition's z value; auto-resorts. */
  setPartitionZ: (i, z) =>
    set((s) => {
      const cyl = s.model.geometry.cylinder;
      const zNum = Number(z);
      if (!Number.isFinite(zNum) || zNum <= 0 || zNum >= cyl.L) return {};
      const partitions = (cyl.partitions || []).slice();
      if (i < 0 || i >= partitions.length) return {};
      partitions[i] = { z: zNum };
      partitions.sort((a, b) => a.z - b.z);
      return {
        model: {
          ...s.model,
          geometry: { ...s.model.geometry, cylinder: { ...cyl, partitions } },
        },
      };
    }),

  /** Edit thickness_source.value on a section's constant-thickness mode.
   * Implicitly flips kind to "constant" — call site doesn't need to know
   * about the kind switch, only that "user typed a number → that number
   * is now the section's thickness". */
  setSectionThickness: (sectionId, value) =>
    set((s) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) return {};
      const sections = s.model.sections.map((sec) => {
        if (sec.id !== sectionId) return sec;
        const ts = sec.thickness_source ?? { kind: "geometry" };
        return {
          ...sec,
          thickness_source: { ...ts, kind: "constant", value: v },
        };
      });
      return { model: { ...s.model, sections } };
    }),

  /** Revert a section to geometry-driven thickness (kind:"geometry"). Drops
   * any stored constant value — the canonical scalar t lives in
   * geometry.cylinder.t, so there's no value to retain on the section. */
  resetSectionThickness: (sectionId) =>
    set((s) => {
      const sections = s.model.sections.map((sec) => {
        if (sec.id !== sectionId) return sec;
        return { ...sec, thickness_source: { kind: "geometry" } };
      });
      return { model: { ...s.model, sections } };
    }),

  /** Patch one field on the model.mesh block (refinement / degree /
   * smoothness / coupling). The smoothness-must-be-less-than-degree
   * invariant is enforced at the inspector level so we can clamp
   * silently without a redundant store-side check. Strings and ints
   * both flow through here, validated by the caller. */
  setMeshField: (key, value) =>
    set((s) => {
      if (typeof value === "number" && !Number.isFinite(value)) return {};
      return { model: { ...s.model, mesh: { ...s.model.mesh, [key]: value } } };
    }),

  /** Set the boundary-condition preset (model.bcs.kind). Currently only
   * "clamped_neumann" is wired in the solver; the inspector enforces the
   * narrower allow-list via disabled toggles. */
  setBcsKind: (kind) =>
    set((s) => ({ model: { ...s.model, bcs: { ...s.model.bcs, kind } } })),

  /** Set the load-case preset (model.load.kind). "axial" and "bending" are
   * wired end-to-end as of Session 3.6; "torsion" / "extpress" / "intpress"
   * / "combined" are disabled in the GUI until the solver-side branches
   * land. */
  setLoadKind: (kind) =>
    set((s) => ({ model: { ...s.model, load: { ...s.model.load, kind } } })),

  /** Set the applied-load magnitude (model.load.magnitude). Cosmetic for
   * LBA — the eigenvalue is invariant under this scaling — but it lets
   * the user read the verdict's critical-load number in their own units
   * (ABAQUS-style: apply 1, get F_cr; apply 1000, get safety factor). */
  setLoadMagnitude: (value) =>
    set((s) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) return {};
      return { model: { ...s.model, load: { ...s.model.load, magnitude: v } } };
    }),

  /** Set model.analysis.kind. Only "lba" is enabled today; gnia / modal /
   * static are placeholders for future sessions. */
  setAnalysisKind: (kind) =>
    set((s) => ({ model: { ...s.model, analysis: { ...s.model.analysis, kind } } })),

  /** Patch one field on model.analysis (solver / shift / nmodes / tolerance
   * / ncv_factor / interface_penalty). Strings ("auto", solver names) and
   * numbers both flow through; numeric validation done by the inspector. */
  setAnalysisField: (key, value) =>
    set((s) => {
      if (typeof value === "number" && !Number.isFinite(value)) return {};
      return {
        model: { ...s.model, analysis: { ...s.model.analysis, [key]: value } },
      };
    }),

  /** Serialise the current model state into the on-disk model.json schema
   * (mirrors scripts/aeris_model.py::ModelConfig.to_dict). JSON.stringify
   * always emits decimal POINTS for numbers regardless of browser locale,
   * so the German-comma display in <input type=number> never leaks into
   * the saved JSON. */
  serializeModel: () => {
    const s = useUI.getState();
    return JSON.parse(JSON.stringify(s.model));   // deep clone, no live refs
  },

  /** POST the current model to the dev server's /save-model endpoint, which
   * writes ../output/model.json. Returns the server's reply. */
  exportModel: async () => {
    const body = useUI.getState().serializeModel();
    const res = await fetch("/save-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  },

  /** Which result is currently loaded into the viewport. */
  selectedResultId: "mode1",
  selectResult: (id) => set({ selectedResultId: id }),

  /** Live warp factor applied to SolutionField in the viewport. */
  warpScale: 1.5,
  setWarpScale: (v) => set({ warpScale: v }),

  /** Surface display options. */
  showEdges: true,
  setShowEdges: (b) => set({ showEdges: b }),
  showUndeformed: false,
  setShowUndeformed: (b) => set({ showUndeformed: b }),

  /** Current view preset name, set when user clicks oblique/side/end. */
  viewPreset: "oblique",
  setViewPreset: (name) => set({ viewPreset: name }),

  /** Loaded-result cache. {[id]: { patches: [...], magMax, valid }} */
  resultCache: {},
  cacheResult: (id, data) =>
    set((s) => ({ resultCache: { ...s.resultCache, [id]: data } })),

  /** UI status line for the inspector (e.g. "loading…", "loaded 4 patches"). */
  status: "ready",
  setStatus: (s) => set({ status: s }),
}));

/** Auto-rebuild the assignments[] (and sections[]) so that every band has a
 * section, in the right order, with sensible default thickness when a new
 * band is created. Idempotent: applying twice to the same partition layout
 * leaves the model unchanged. Returns a {model: ...} patch ready for set().
 *
 * Rules:
 *   - 0 partitions (homogeneous)  → single assignment "shell_full" → first
 *                                   section. Same as Session 3.3 default.
 *   - N+1 partitions (stepped)    → assignments [{region:"band_0", ...},
 *                                   {region:"band_1", ...}, …]; one per
 *                                   band. Reuses existing band_i sections
 *                                   when possible, clones the first
 *                                   section's material+thickness for any
 *                                   bands that don't have a section yet.
 *   - Sections orphaned by the rebuild are kept around (no destructive
 *     deletion — the user can clean them up later from the GUI).
 */
function rebuildAssignments(model) {
  const partitions = (model.geometry?.cylinder?.partitions ?? []).slice();
  const homogeneous = partitions.length === 0;
  const sections = (model.sections ?? []).slice();
  const assignments = (model.assignments ?? []).slice();

  if (homogeneous) {
    // Need exactly one assignment "shell_full" → first section.
    if (sections.length === 0) {
      return { model };
    }
    const newAssignments = [
      { region: "shell_full", section_ref: sections[0].id },
    ];
    return { model: { ...model, assignments: newAssignments } };
  }

  const nBands = partitions.length + 1;
  // Existing band assignments — keep them, but trim or extend the list.
  const existing = new Map();
  for (const a of assignments) {
    if (typeof a.region === "string" && a.region.startsWith("band_")) {
      existing.set(a.region, a.section_ref);
    }
  }
  // Source section for cloning new bands' thickness from. Prefer the first
  // existing band's section; else the very first section.
  const seedSec = sections[0];

  const newAssignments = [];
  const newSections = sections.slice();

  for (let i = 0; i < nBands; i++) {
    const region = `band_${i}`;
    let secId = existing.get(region);
    if (!secId || !newSections.find((s) => s.id === secId)) {
      // Clone the seed section under a band-named id; default to GEOMETRY
      // thickness for newly-created bands so the user gets a working
      // value out of the box.
      secId = `sec-${region}`;
      if (!newSections.find((s) => s.id === secId)) {
        newSections.push({
          id: secId,
          name: `Band ${i} section`,
          kind: "shell",
          material_ref: seedSec?.material_ref ?? "mat-default",
          thickness_source:
            seedSec?.thickness_source?.kind === "constant"
              ? { ...seedSec.thickness_source }
              : { kind: "geometry" },
          offset: "midsurface",
        });
      }
    }
    newAssignments.push({ region, section_ref: secId });
  }

  return {
    model: {
      ...model,
      sections: newSections,
      assignments: newAssignments,
    },
  };
}
