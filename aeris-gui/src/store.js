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
   * All sections start at "default" this session; later sessions flip them
   * to "configured" as fields get filled. */
  sectionStatus: {
    geometry: "default",
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
