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
    mesh:              "default",
    bcsLoads:          "default",
    analysis:          "default",
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
    geometry: {
      shape: "cylinder",
      cylinder: { R: 1.0, L: 1.0, t: 0.01 },
    },
    materials: [
      {
        id: "mat-default",
        name: "Linear isotropic (default)",
        model: "linear",
        E: 1.0,
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
    load: { kind: "axial", neumann_traction_axial: "auto" },
    analysis: {
      kind: "lba", nmodes: 5,
      solver: "spectra-buckling", shift: "auto",
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
