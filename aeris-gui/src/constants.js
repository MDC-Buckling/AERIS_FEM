/** MDC Codex monospace stack — used inline on every label/value/button. */
export const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace";

/** Known result sets shipped by the Aeris solver (cylinder_lba.py).
 * Static for now; a later session will discover these via /data-index. */
export const KNOWN_RESULTS = [
  {
    id: "geometry",
    label: "Geometry (undeformed)",
    pvd: "mp.pvd",
    kind: "geometry",
    description: "4-patch closed cylinder, R=1, L=1, t=0.01 — bare mesh",
  },
  {
    id: "linear",
    label: "Linear elastic (pre-buckling)",
    // Different G+Smo versions cap the L differently; try both.
    pvd: "linearSolution.pvd",
    pvdFallback: "LinearSolution.pvd",
    kind: "displacement",
    description: "Smooth axisymmetric compression under unit Neumann load",
  },
  {
    id: "mode0",
    label: "Buckling mode 1",
    pvd: "modes/modes0_.pvd",
    pvdFallback: "modes/modes0.pvd",
    kind: "mode",
    description: "Lowest eigenmode (sin/cos doublet partner of mode 2)",
  },
  {
    id: "mode1",
    label: "Buckling mode 2",
    pvd: "modes/modes1_.pvd",
    pvdFallback: "modes/modes1.pvd",
    kind: "mode",
    description: "Sin/cos partner of mode 1 — clean circumferential lobes",
  },
  {
    id: "mode2",
    label: "Buckling mode 3",
    pvd: "modes/modes2_.pvd",
    pvdFallback: "modes/modes2.pvd",
    kind: "mode",
  },
  {
    id: "mode3",
    label: "Buckling mode 4",
    pvd: "modes/modes3_.pvd",
    pvdFallback: "modes/modes3.pvd",
    kind: "mode",
  },
  {
    id: "mode4",
    label: "Buckling mode 5",
    pvd: "modes/modes4_.pvd",
    pvdFallback: "modes/modes4.pvd",
    kind: "mode",
  },
];

/** Cylinder bounds for camera framing / snap views.
 * Matches DEFAULT_CASE in scripts/cylinder_lba.py. */
export const CYL = { R: 1.0, L: 1.0, center: [0, 0, 0.5] };

/** Camera snap presets — same intent as render_modes.py's three views. */
export const VIEW_PRESETS = {
  oblique: { pos: [3.0, -3.0, 2.5], target: CYL.center, up: [0, 0, 1] },
  side:    { pos: [0.0, -4.0, 0.5], target: CYL.center, up: [0, 0, 1] },
  end:     { pos: [0.0,  0.0, 4.0], target: CYL.center, up: [0, 1, 0] },
};
