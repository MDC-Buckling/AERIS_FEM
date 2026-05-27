# Aeris GUI

Desktop front-end (post-processor for now, pre-processor + solve-button next
session) for the Aeris shell-buckling pipeline. Built as a sibling product to
**MDC Codex** — same visual language: dark navy, cyan accents, glass panels
with HUD corner brackets, JetBrains Mono everywhere, dense engineering layout.

This session ships the **shell + interactive 3D viewport** reading the
multi-patch `.pvd` / `.vts` files that `scripts/cylinder_lba.py` already drops
into `../output/`. No solver wiring yet.

## Stack

| | |
|---|---|
| React | 18.3 |
| Vite | 6 |
| Tauri | 2 (desktop wrapper) |
| three.js | 0.169 (raw, via OrbitControls + custom shaders) |
| zustand | 5 (UI state) |
| @fontsource/jetbrains-mono | 400/600/700/800 imported in `main.jsx` |
| Tailwind / shadcn / MUI | **none** — hand-rolled per the design spec |

## Launch (development)

Two paths — pick one:

```powershell
# A) Browser dev — fastest feedback loop, opens at http://localhost:5174
cd aeris-gui
npm install      # first time only
npm run dev

# B) Tauri desktop window — what the spec calls for
cd aeris-gui
npm install      # first time only
npm run tauri:dev      # first launch compiles Rust skeleton (3–8 min)
```

Both load the same UI. Tauri runs the Vite dev server itself
(`beforeDevCommand`), so don't start option A and B at the same time.

## How it reads results

`vite.config.js` mounts a tiny middleware that serves `../output/` (the
solver's PVD/VTS drop) under `/data/`. The browser fetches the per-mode
`.pvd` collections, follows the `<DataSet file="…vts"/>` refs, parses each
patch's StructuredGrid XML, and builds one `THREE.BufferGeometry` per patch.

| Endpoint                                  | Returns                                          |
| ----------------------------------------- | ------------------------------------------------ |
| `/data/mp.pvd` + `/data/mp_K.vts`         | Undeformed cylinder (4 patches)                  |
| `/data/linearSolution.pvd` + per-patch    | Pre-buckling linear-elastic displacement state   |
| `/data/modes/modesN_.pvd` + per-patch     | N-th buckling eigenmode (N = 0..4), all 4 patches |
| `/data-index`                             | JSON inventory of what's actually on disk        |

If `output/` is empty, run `cylinder_lba.py` from the repo root first to
generate the files (see the top-level `README.md`).

## Architecture

```
aeris-gui/
  index.html                 vite entry
  vite.config.js             plugin: serve ../output under /data
  src/
    main.jsx                 React entry; loads @fontsource/jetbrains-mono + theme.css
    theme.css                MDC Codex design tokens (verbatim from the spec)
    constants.js             MONO font stack, KNOWN_RESULTS, VIEW_PRESETS
    store.js                 zustand: theme, selected result, warp scale, etc.
    App.jsx                  3-column layout (Results | Viewport | Inspector)
    components/
      TopChrome.jsx          AERIS brand bar + theme toggle
      ResultsPanel.jsx       left rail — pickable result list
      InspectorPanel.jsx     right rail — case data, eigenvalue, controls
      ViewportLegend.jsx     colormap legend bar overlay
      ui/                    GlassPanel · SectionHeader · ResultRow ·
                             KeyMetric · ToggleGroup · Slider
    viewport/
      Viewport3D.jsx         three.js scene, OrbitControls, warp shader
      colormap.js            256-step cyan-tinted ramp (RGBA, dark + light)
    vtk/
      parsePvd.js            tiny <Collection><DataSet/> XML walker
      parseVts.js            <StructuredGrid> parser + index buffer builder
      loadResult.js          orchestrates pvd→vts fetch + per-patch packaging
  src-tauri/                 Tauri 2 Rust skeleton (window config, icons)
```

The 3D viewport uses a **custom ShaderMaterial**:

- vertex shader displaces position by `aDisp * uWarp`, with `aDisp` the
  per-vertex `SolutionField` from the .vts file (3-component, often radial
  for cylinder buckling).
- fragment shader samples a 256x1 RGBA ramp by normalised displacement
  magnitude, plus a cheap Lambert-ish shading via screen-space derivatives
  so the cylinder reads as solid without precomputed normals.

This lets the **warp slider** change a single uniform per frame — no
geometry rebuild — so the deformation animates live with no perceptible lag.

## What works today (Sessions 3.0 → 3.1)

### Session 3.0 — Post-processor
- [x] App shell in the MDC Codex visual language (dark default, cyan accents,
      glass panels with HUD corners, mono everywhere, dense engineering spacing).
- [x] Light theme toggle (civil-engineering / concrete-grey variant from the spec).
- [x] Left rail lists the seven known result sets (geometry, linear, modes 0..4).
- [x] Central viewport: real cylinder mesh assembled from all 4 patches.
- [x] Right inspector: case data, eigenvalue + Δ vs classical, loaded-patch stats.
- [x] OrbitControls: rotate / zoom / pan with the mouse.
- [x] Warp slider: live deformation, no rebuild.
- [x] Colormap by `|SolutionField|`, with a legend bar overlay.
- [x] View-snap buttons: OBLIQUE / SIDE / END (match `render_modes.py`).
- [x] Edge wireframe overlay toggle, undeformed-mesh overlay toggle.

### Session 3.1 — Pre-processor SHELL (scaffold only)
- [x] **PRE / POST mode switch** in the top chrome flips the left + right panels;
      central viewport is shared and shows the cylinder as a live-preview
      stand-in when in pre mode.
- [x] **Codex-styled collapsible model tree** with the locked 8-section
      structure (Geometry / Shell Construction / Material / Imperfections /
      Mesh / BCs & Loads / Analysis Step / Run). Each section has a status
      dot (all "default" for now) and a 2-digit prefix.
- [x] **17 model-tree sub-items** addressable by dotted id, each with a
      `defaultPreview` line that mirrors the eventual current-value display.
- [x] **Stub right inspector** with per-`kind` renderers: `selector` (radio
      list with future-options listed as disabled + a "later" hint), `fields`,
      `field`, `toggle+config`, `run-button` (disabled Solve). Shows the
      eventual UI as a sketch so we know what to build.
- [x] All Session-3.0 post-processor features still work in POST mode.

## What's next

- [ ] Fill **GEOMETRY → Dimensions** functionally so the user-typed R/L/t
      drives the Python cylinder build (smallest end-to-end slice).
- [ ] Solve button — POST to the running container with the assembled config,
      stream output, refresh the post-processor result tree when done.
- [ ] Sidecar manifest from `cylinder_lba.py` so the post-processor inspector
      reads eigenvalues + convergence from disk instead of `LBA_META`.
- [ ] Replace cheap derivative-shading with proper precomputed normals so
      light mode looks less flat.
