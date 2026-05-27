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
   * Session 3.2 flips `geometry` to "configured" as soon as R/L/t are valid.
   * Later sessions flip the rest as their sections get wired. */
  sectionStatus: {
    geometry: "configured",  // wired this session
    shellConstruction: "default",
    material: "default",
    imperfections: "default",
    mesh: "default",
    bcsLoads: "default",
    analysis: "default",
    run: "default",
  },
  setSectionStatus: (sectionId, status) =>
    set((s) => ({
      sectionStatus: { ...s.sectionStatus, [sectionId]: status },
    })),

  /** Project / model name shown in the top chrome. Editable later. */
  projectName: "Cylinder LBA",

  /** ----------------------------------------------------------------------
   *  THE MODEL — in-memory mirror of scripts/aeris_model.py's ModelConfig
   *  schema. Session 3.2 wires GEOMETRY (Cylinder R/L/t); other sections
   *  carry the validated Session-2.7 defaults as read-only state until
   *  their sessions land. Serialised to model.json on Solve.
   *  --------------------------------------------------------------------*/
  model: {
    schemaVersion: 1,
    name: "Cylinder LBA",
    geometry: {
      shape: "cylinder",
      cylinder: { R: 1.0, L: 1.0, t: 0.01 },
    },
    material: { model: "linear", E: 1.0, nu: 0.3 },
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

  /** Set the shape family. Only "cylinder" is wired this session. */
  setShape: (shape) =>
    set((s) => ({
      model: {
        ...s.model,
        geometry: { ...s.model.geometry, shape },
      },
    })),

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
