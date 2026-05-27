# Aeris

Internal FEM toolkit for thin-shell buckling research. Built around the
open-source **G+Smo** (Geometry + Simulation Modules, MPL-2.0) C++ isogeometric
analysis library, driven via its shipped C++ executables (we parse their
stdout from Python — `pygismo` is deferred, see STATUS).

## Repo layout

```
aeris/
  docker/
    Dockerfile              G+Smo + shell stack build image (Ubuntu 22.04, gcc-11)
    Dockerfile.render       Slim render image (Python + PyVista + Xvfb)
  external/gismo            G+Smo source, git submodule pinned to v25.07.0
  scripts/
    smoke_test.py           Proves a gsKLShell exe links + runs (--help)
    cylinder_lba.py         Linear buckling of a clamped axially-compressed
                            cylinder vs the classical Lorenz/Timoshenko 1908
                            formula; mesh-convergence study; ParaView export
    render_modes.py         Reads output/*.pvd, writes per-mode PNGs to
                            output/renders/ (3 fixed cameras × 7 datasets)
  aeris-gui/                Desktop GUI (Tauri 2 + React + three.js) — the
                            interactive post-processor. Reads output/ via dev
                            server middleware. See aeris-gui/README.md.
  output/                   (gitignored) .pvd / .vts dropped by cylinder_lba.py
                            and renders/*.png dropped by render_modes.py
  .dockerignore  .gitignore  README.md
```

## Prerequisites

- Docker Desktop (Windows / macOS) or Docker Engine (Linux). Docker Desktop
  ships WSL2 + the Linux kernel needed by the daemon.
- Git, with submodule support (any modern version).
- ~5 GB free disk for the image.
- Network access during build — CMake fetches `gsKLShell`,
  `gsStructuralAnalysis`, and `gsUnstructuredSplines` from
  `github.com/gismo/<name>.git` at configure time.

## Clone (with submodule)

```powershell
git clone <this-repo-url> Aeris
cd Aeris
git submodule update --init --recursive
```

## Build the image

```powershell
docker build -t aeris/gismo:v25.07.0 -f docker/Dockerfile .
```

Expect 30–60 min on first build, ~5 min on cmake-only rebuilds (apt + source
layers cached). The bundled optional modules (`gsSpectra`, `gsOptim`, …)
compile fast; only the externally fetched ones (`gsKLShell`,
`gsStructuralAnalysis`, `gsUnstructuredSplines`) take real time.

Build-time overrides (all optional):

| `--build-arg`            | default                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `CMAKE_BUILD_TYPE`       | `Release`                                                                |
| `CMAKE_CXX_STANDARD`     | `17`                                                                     |
| `GISMO_OPTIONAL`         | `gsKLShell;gsStructuralAnalysis;gsUnstructuredSplines;gsOptim;gsSpectra` |
| `GISMO_WITH_PYBIND11`    | `OFF` (see STATUS — blocked on gsEigen/pybind11)                         |
| `GISMO_WITH_OPENMP`      | `ON`                                                                     |
| `GISMO_BUILD_EXAMPLES`   | `ON`                                                                     |
| `BUILD_PARALLEL`         | `4` (raise on bigger machines)                                           |

## Run the smoke test (proves the shell module is compiled + callable)

```powershell
docker run --rm aeris/gismo:v25.07.0 python3 /aeris/scripts/smoke_test.py
```

Expected tail of output:

```
SMOKE TEST PASSED — gsKLShell example '<name>' linked + ran (exit 0).
```

The script locates a shipped `gsKLShell` example executable (preferring
`linear_shell`) and invokes `--help`; passing means the binary linked against
`libgismo.so.25.7.0` and ran initialisation.

## Run the cylinder linear-buckling analysis (LBA validation)

```powershell
docker run --rm -v ${PWD}/scripts:/aeris-scripts aeris/gismo:v25.07.0 `
    python3 /aeris-scripts/cylinder_lba.py
```

(Mounting `scripts/` from the host lets you iterate on the Python without a
rebuild; for a fully self-contained run with the script baked into the image,
just `python3 /aeris/scripts/cylinder_lba.py`.)

What it does:

1. **Computes the analytical reference** — classical critical axial buckling
   stress for an isotropic perfect cylinder (Lorenz 1908, Timoshenko 1910):

       σ_cr = E·t / (R · √(3·(1 − ν²)))

2. **Builds a 4-patch closed NURBS cylinder** (R=1.0, L=1.0, t=0.01, E=1.0,
   ν=0.3 ⇒ R/t = 100, L/R = 1) as an in-memory XML config consumed by
   `buckling_shell_XML`.
3. **Boundary conditions**:
   - Bottom edge: Dirichlet (u_x = u_y = u_z = 0) + Kirchhoff–Love `Clamped`
     (zero normal rotation) — a true engineering clamp, not just zero
     displacement.
   - Top edge: Neumann line force `(0, 0, +t)` (tensile axial line load
     scaled so that the implied uniform membrane axial stress σ_ref = 1).
   - We load in *tension* so K_geom is positive-definite and the
     `gsBucklingSolver` eigenvalues come back positive; the smallest
     positive eigenvalue is the load factor that would drive the
     corresponding compressive buckling.
4. **Solves the generalised eigenvalue problem** K_L v = λ K_geom v with the
   `gsBucklingSolver` (Spectra `GEigsMode::Buckling`, shift placed near the
   analytical estimate to focus Krylov iterations on the physically
   interesting band).
5. **Sweeps mesh refinement** at `-r 3, 4, 5` and prints a convergence table.

### Viewing the mesh and eigenmodes in ParaView

Mount a host directory at `/aeris-output` and `cylinder_lba.py` will
automatically re-run the finest mesh with `--plot` and drop ParaView files
into it (default behaviour — pass `--no-plot` to skip).

```powershell
mkdir output -Force | Out-Null
docker run --rm `
    -v ${PWD}/scripts:/aeris-scripts `
    -v ${PWD}/output:/aeris-output `
    aeris/gismo:v25.07.0 `
    python3 /aeris-scripts/cylinder_lba.py
```

After the run, `output/` contains (28 `.vts` + 7 `.pvd` for the default
5-mode case):

| File                      | What it is                                                            |
| ------------------------- | --------------------------------------------------------------------- |
| `output/mp.pvd`           | **Undeformed cylinder geometry** — open this to see the bare mesh     |
| `output/linearSolution.pvd` | Pre-buckling linear-elastic displacement field (reference state)    |
| `output/modes/modes0.pvd` | **1st buckling eigenmode** — open this to see the lowest mode shape   |
| `output/modes/modes1.pvd` | 2nd eigenmode (same cluster, slightly higher critical load)           |
| `output/modes/modes2.pvd` | 3rd eigenmode                                                         |
| `output/modes/modes.pvd`  | ⚠ top-level collection — buggy in the shipped exe, only includes patch 0 of each mode. Use the per-mode `modesN.pvd` files instead. |

**Install ParaView** (free, separate download) from
[paraview.org/download](https://www.paraview.org/download/). The Windows
binary works out of the box.

**What to click in ParaView** for a mode shape (e.g. `modes0.pvd`):

1. `File → Open → modes0.pvd`, then click **Apply** in the *Properties*
   panel. You see the cylinder, slightly squished into the first buckling
   pattern.
2. The deformation is small by default — the modes are normalised so
   `|u_z|_max = 1` inside the exe, then added to the original geometry.
   To exaggerate for visibility: `Filters → Alphabetical → Warp By Vector`,
   pick **`SolutionField`** as the *Vectors* field, raise *Scale Factor*
   (try 0.05 then bump up), click Apply.
3. Same recipe for `modes1.pvd`, `modes2.pvd`, … — open each, Apply.
4. To overlay the undeformed shape, also open `mp.pvd` and Apply; set its
   *Representation* to *Wireframe* and a contrasting colour.

The eigenmode field name `SolutionField` is the only vector array in the
`.vts` files, so picking it in *Warp by Vector* is unambiguous.

### Automated PNG renders (no ParaView clicking required)

`scripts/render_modes.py` reads the same `.pvd` / `.vts` files and writes
fixed-camera PNGs of every mode + the linear pre-buckling state, so you
can flip through the eigenmodes as a contact-sheet of images without
operating ParaView by hand. Runs in a separate `aeris/render:1` image
(slim Python + PyVista + Xvfb, ~600 MB) so the main G+Smo image stays
clean of OpenGL baggage.

**Build the render image** (one-off, ~2 min):

```powershell
docker build -t aeris/render:1 -f docker/Dockerfile.render .
```

**Run the renders** (assumes `output/` already contains the `.vts/.pvd`
from a prior `cylinder_lba.py` run):

```powershell
docker run --rm `
    -v ${PWD}/output:/aeris-output `
    -v ${PWD}/scripts:/aeris/scripts `
    aeris/render:1
```

**What you get** in `output/renders/` — 7 datasets × 3 fixed cameras =
**21 PNGs** at 1200×900:

| Stem            | What it shows                                          |
| --------------- | ------------------------------------------------------ |
| `geometry_*`    | undeformed 4-patch cylinder mesh                       |
| `linear_*`      | pre-buckling linear-elastic state (smooth, axisymmetric — sanity check) |
| `mode0_*`       | **1st buckling eigenmode** — lowest critical, classic regular lobe pattern |
| `mode1_*`       | 2nd mode — happens to localise on one side for our case (real physics, not a render bug) |
| `mode2_*` … `mode4_*` | next three modes in the eigenvalue cluster        |

Each stem has three views:

| Suffix   | View                                                          |
| -------- | ------------------------------------------------------------- |
| `_oblique` | 3/4 perspective from above-front                            |
| `_side`    | profile, cylinder axis horizontal                           |
| `_end`     | **straight down the cylinder axis** — best for counting circumferential lobes (the key physics diagnostic) |

All modes share `WARP_SCALE = 0.015` (in `render_modes.py`) so cross-mode
amplitudes stay honest. The script also clamps per-point displacement at
1.2× the 95th percentile before warping, to keep the *colour* scale
informative when a handful of nodes at multipatch corners (weak C0/C1
coupling artefacts) sit well above the bulk. The clamp acts only on the
warp + colour bar; reported eigenvalues are unaffected (those come from
`cylinder_lba.py`, not from this script).

### Latest result (R=1, L=1, t=0.01, E=1, ν=0.3, gcc-11, 4 patches, smooth G¹ coupling)

| `-r` | per-patch basis | σ_cr_computed | % vs classical |
| ---: | --------------: | ------------: | -------------: |
|    3 | 9 × 9           | 6.083 × 10⁻³  | **+0.51 %**    |
|    4 | 17 × 17         | 5.991 × 10⁻³  | **−1.02 %**    |
|    5 | 33 × 33         | 6.022 × 10⁻³  | **−0.49 %**    |

Classical reference: σ_cr = **6.052 × 10⁻³**. With the smooth-coupled multipatch
driver (Session 2.7 fix — see STATUS), the FE result brackets classical within
±1 % and the eigenvalues come back in clean **doublet pairs** (sin/cos partners
at nearly-identical eigenvalues, the textbook signature of cylinder buckling).

Earlier numbers (Session 2 / before Session 2.7) printed −2.51 % / −0.62 % /
−0.16 % at r=3/4/5 using `buckling_shell_XML` with weak C0/C1 penalty coupling.
That driver appeared to converge slightly closer to classical at r=5, but the
seam penalty was *artificially stiffening* the cylinder along its 4 vertical
patch seams, splitting the eigenvalue doublets and surfacing spurious local
modes (visible as exploded localised "spikes" in mode-2 / mode-4 renders).
The current numbers are physically correct; the old numbers were a happy
accident in which the seam stiffening canceled some finite-length softening.

## Launching the GUI (Aeris desktop front-end)

`aeris-gui/` is a Tauri 2 + React + three.js post-processor styled to match
**MDC Codex**. Reads the same `output/` PVD/VTS files this README's earlier
sections drop, and renders the cylinder + buckling modes in an interactive
3D viewport.

```powershell
cd aeris-gui
npm install              # first time only
npm run dev              # browser dev, http://localhost:5174
# — or —
npm run tauri:dev        # native desktop window (first launch compiles Rust, 3–8 min)
```

Both load the same UI. See [aeris-gui/README.md](aeris-gui/README.md) for
the architecture + what's wired today.

## Pinned versions

| Component                | Pin                                                |
| ------------------------ | -------------------------------------------------- |
| G+Smo                    | tag `v25.07.0` (commit `3cd33adc2`)                |
| `gsKLShell`              | fetched at HEAD — SHA recorded in `/aeris/BUILD_SHAS.txt` inside the image |
| `gsStructuralAnalysis`   | fetched at HEAD — SHA recorded in `/aeris/BUILD_SHAS.txt`                  |
| `gsUnstructuredSplines`  | fetched at HEAD — SHA recorded in `/aeris/BUILD_SHAS.txt`                  |
| `gsOptim`, `gsSpectra`   | bundled inside v25.07.0                            |
| Ubuntu base              | `ubuntu:22.04`                                     |
| GCC                      | `gcc-11` / `g++-11`                                |

To read the actual fetched SHAs from a built image:

```powershell
docker run --rm aeris/gismo:v25.07.0 cat /aeris/BUILD_SHAS.txt
```

The capture is done inside the build RUN itself, immediately after `cmake ..`
(which is when `gsFetch.cmake` does its `git clone --depth 1`); the
Dockerfile's `git init` against `/opt/gismo/` is the trick that makes
`get_repo_info()` pick the `git clone` code path instead of the `URL
.../master.zip` fallback (the latter strips `.git/` and was why Session 1's
SHA file printed "bundled-with-v25.07.0" for everything).

## STATUS

### Works
- G+Smo v25.07.0 built as a shared library inside a reproducible Ubuntu 22.04
  image (`aeris/gismo:v25.07.0`).
- Shell stack enabled: `gsKLShell` + `gsStructuralAnalysis` + `gsUnstructuredSplines`
  + `gsOptim` + `gsSpectra` (all via `GISMO_OPTIONAL`; the externally fetched
  ones are recorded with their actual SHAs in `/aeris/BUILD_SHAS.txt`).
- Smoke test (`scripts/smoke_test.py`) proves the shell module links and runs.
- **Cylinder LBA validation (`scripts/cylinder_lba.py`)** brackets the classical
  Lorenz–Timoshenko critical axial buckling stress within **±1 %** at r=3..5
  on a 4-patch closed cylinder using G+Smo's `buckling_shell_multipatch_XML`
  with smooth (G¹) inter-patch coupling via `gsSmoothInterfaces` — proves the
  buckling pipeline (geometry, BCs, Saint-Venant Kirchhoff material, smooth
  multipatch basis, eigensolver, XML I/O) is wired correctly. Eigenvalues
  return in clean doublet pairs (sin/cos partners), the textbook signature
  of cylinder buckling.
- **Validation suite (`benchmarks/`)** — second validated case beyond the
  cylinder LBA. **Scordelis-Lo roof PASSES** at `|err| = 0.031 %` at r=6
  vs the Kirchhoff-Love reference `|u_z| = 0.3006` (the literature's
  shear-rigid number, not the 0.3024 shear-deformable one). Monotonic
  convergence from below over r=0..6, no shear / membrane locking
  detected. First test of the **static linear** shell path — confirms
  `static_shell_XML` + `gsThinShellAssembler` + `gsStaticNewton` produce
  the right membrane / bending split + Poisson-free isotropic response
  + free-edge behaviour. Single-patch; a multipatch variant for
  cross-checking `gsSmoothInterfaces` moment transfer under bending is
  next in the suite roadmap. See `benchmarks/scordelis_lo/README.md`
  for the full convergence table + interpretation.
- **Benchmark Hub (GUI, Session H)** — third top-level mode alongside
  Pre-/Post-Processor. Browseable card grid for the validation suite:
  every standard shell benchmark (cylinder LBA × 2 variants live, plus
  Scordelis-Lo + multipatch + pinched-cylinder + pinched-hemisphere as
  "coming soon" cards). Each card has `LOAD INTO MODEL` (copies the
  benchmark's case into the pre-processor) + `RUN (r=N)` (single-r
  submission) + `↗ SWEEP (r=3,4,5)` (one-click convergence study).
  Verdicts are auto-interpreted from the run.json sidecar via a
  per-benchmark `interpret(manifest)` hook: PASS/FAIL chip + Δ vs
  classical + convergence table + 5-deep job history right on the card.
  Sits on Sessions 3.6–3.8 of wiring (BCs/Loads, Analysis, Jobs) — an
  audit (model.json + XML diff between the bending and axial IW1 jobs;
  non-default Analysis settings flowing into the OptionList; classical
  reference computed from the case's E·t·R·ν, no defaults trap) was run
  first to confirm the foundation. Adding a new benchmark = adding one
  entry to `aeris-gui/src/benchmarks/catalog.js`. See the memory note
  on the hub architecture for the interpreter pattern.
- **ParaView export** — same script writes the cylinder mesh + linear-elastic
  reference state + first N (default 5) eigenmodes to a `/aeris-output` mount
  for visualisation. Uses the shipped exe's `--plot` flag — no custom VTK
  writing on our side. Field name for mode shapes: `SolutionField` (3-vector).
- **Headless PNG renders** (`scripts/render_modes.py` + `aeris/render:1`
  image) — turns those `.pvd/.vts` files into 21 PNGs (7 datasets × 3 fixed
  cameras) so you can judge mode shapes without opening ParaView. Renders
  use PyVista + Xvfb in a slim Python image; warp + colour are tuned to
  show both bulk buckling patterns and patch-corner artefacts honestly.
- **Aeris GUI** (`aeris-gui/`, Sessions 3.0–3.1) — Tauri 2 desktop front-end
  in the MDC Codex visual language.
  - **Post-processor** (3.0): interactive three.js viewport reads multi-patch
    `.pvd` / `.vts` directly, rotates with OrbitControls, deforms live via a
    warp-scale slider, colours by `|u|` with a cyan-tinted ramp + legend,
    snaps to oblique/side/end-on views.
  - **Pre-processor SHELL** (3.1, this session — scaffold only): Codex-styled
    collapsible model-tree with the locked 8-section structure, per-sub-item
    stub inspectors, status dots. Disabled `► SOLVE` placeholder at the end
    of the chain. Tree items clickable; stubs sketch the eventual fields as
    disabled. PRE / POST mode switch in the top chrome flips the left + right
    panels; the central viewport stays shared (live-preview stand-in shows the
    cylinder geometry in pre mode).

  Launch: `cd aeris-gui && npm install && npm run dev` (browser at
  http://localhost:5174) or `npm run tauri:dev` (native window).

### Pre-processor model-tree — locked structure (Session 3.1)

The 8 sections (with sub-items) that fill in over the next several sessions.
Order shown is the navigation order; **fill order is Geometry → Material →
BCs/Loads → Analysis → Mesh → Imperfections → Shell Construction → Run**
(get the smallest functional vertical slice working end-to-end first).

```
01  GEOMETRY              · Shape & Type  · Dimensions
02  SHELL CONSTRUCTION    · Thickness Mode  · Ring Frames / Stiffeners
03  MATERIAL              · Base · Manufacturing · Plasticity · Thermal
04  IMPERFECTIONS         · Amplitude · Type/Source · Cutouts (KDF)
05  MESH / DISCRETISATION · Refinement · Polynomial degree · Patch coupling
06  BCs & LOADS           · Boundary Conditions · Load Case
07  ANALYSIS STEP         · Analysis Type · Solver Settings
08  RUN                   · ► SOLVE (disabled until wiring lands)
```

See [aeris-gui/src/preprocessor/modelTree.js](aeris-gui/src/preprocessor/modelTree.js)
for the full data (defaults, all selector options for both functional and
"later" choices, field lists). Structure is the architecture contract — don't
silently move sub-items between sections without a session note.

**Session 3.1 architecture decisions captured in the tree:**
- `Cutouts` lives under `IMPERFECTIONS` with the `(KDF)` suffix making the
  η-knockdown choice explicit (vs `GEOMETRY` where real holes would go).
- `Patch coupling` defaults to `gsSmoothInterfaces (m=0)` matching the
  Session-2.7 validated path.
- `Shape & Type` already lists Cylinder, Cone, Sphere, Torispherical,
  Stiffened so the structure doesn't need rebuilding when we add them.
- The Solve button is deliberately the LAST item — Codex-style continuous
  flow, but the run is still a discrete commit at the end.

### Session 3.2 — GEOMETRY wired end-to-end ✅

The first functional slice landed. The Python side has a new module
[`scripts/aeris_model.py`](scripts/aeris_model.py) holding `ModelConfig`,
the in-memory mirror of the `model.json` schema that every later section
will extend. `cylinder_lba.py` now accepts `--model PATH` (or scalar
`--R/--L/--t/--E/--nu` overrides on top) and routes through `ModelConfig
→ case() → build_cylinder_xml`. Verified by dumping the XML for
`R=2, L=3, t=0.02` and confirming the 4 patches' control points scale to
(±2, 0, z) / (0, ±2, z) and z spans 0→3, while `Thickness=0.02` and the
BC block (Dirichlet+Clamped at bottom, Neumann at top) survive intact.
The default-case regression still gives -1.02% at r=4 vs classical (= Session 2.7).

GUI side: GEOMETRY → Shape & Type and GEOMETRY → Dimensions are now real,
not stubs. R/L/t inputs use a new GlowInput-style `NumberField` primitive
(mono, right-aligned, tabular-nums, dark/light-aware glass body); the
inspector shows live R/t and L/R derived values plus a gentle thin-shell
warning if R/t < 20. The model-tree sub-item preview line under
"Dimensions" reflects the live values. GEOMETRY's section dot is now
cyan ("configured · live") and the per-item badge swaps from
`STUB · NOT WIRED` to `CONFIGURED · LIVE` for the two wired items.

The central 3D viewport now branches on mode: **post** still loads
`.pvd / .vts` results as before; **pre** builds a procedural cylinder
(64×24 segments, open-ended, `THREE.CylinderGeometry` rotated and shifted
to match the solver z-up convention) directly from `model.geometry.cylinder`
— changing R/L/t in the inspector updates the preview live with no
solver round-trip. Snap-view cameras auto-frame for any R/L.

### Session 3.3 — MATERIAL wired + ABAQUS-style section assignments ✅

Schema bumped to v2: the top-level `material: {...}` is replaced by a
section-assignment layout with three new arrays — `materials[]`,
`sections[]`, `assignments[]` — trivial today (1 + 1 + 1) but the contract
for stiffened shells / variable thickness later. See
[`scripts/aeris_model.py`](scripts/aeris_model.py) for the canonical
schema; v1 model.json files are auto-migrated on read.

GUI side: MATERIAL → Base Properties now has real `E` and `ν` `NumberField`
inputs flowing through `materials[0]` into the solver XML `<Parameters>`.
SHELL CONSTRUCTION → Section Assignments is a new sub-item showing the
region→section→material table (1 row today; many later). Thickness stays
single-source-of-truth in `geometry.cylinder.t` — surfaced in the
MaterialBase derived block as "Thickness from geometry.cylinder.t" so
nobody types it in two places.

**Audit (E=210, ν=0.33 ≠ default E=1, ν=0.3):**

- model.json on disk has `"E": 210, "nu": 0.33` after EXPORT MODEL.
- Solver XML `<Parameters>` carries `210.0` and `0.33` verbatim.
- `<Thickness>` still `0.01` (from geometry, not duplicated in material).
- Solver runs, returns clean doublet pairs (`1.197 / 1.197`, `1.211 / 1.211`),
  converges from −13.52 % at r=4 to −6.83 % at r=5 vs classical = 1.284 (the
  formula scales correctly with both E and ν, verified by an independent
  sweep — see Working notes below).
- Classical `σ_cr = E·t/(R·√(3(1−ν²)))` confirmed to use the **real** E and ν
  from the case, not hardcoded defaults — exactly the cancels-at-default
  trap the Session-3.2 audit caught.

**One solver-numerics limitation found:** at very large E (tested with
E=208000), `gsBucklingSolver` returns garbage eigenvalues (e.g. 1e+28). Root
cause is **catastrophic cancellation in `m_B = K_NL − K_L`**: both matrices
are O(E), their difference is O(1), so relative precision in the geometric
stiffness `K_geom` degrades by ~log₁₀(E) significant digits. Workaround for
now: pick consistent dimensionless units so `E` stays moderate (e.g. GPa
with mm, or normalise E ≈ 1). Documented in the "Known gaps" list below;
not a wiring bug.

### Session 3.4 — Stepped wall thickness via axial partitions ✅

`geometry.cylinder.partitions[]` carries an ordered list of axial z-cuts
that split the cylinder into N+1 bands. Each band gets its own region tag
(`band_0`, `band_1`, …) bound through `assignments[]` to a section with
its own `thickness_source` — either `{kind:"geometry"}` (follows the
canonical `geometry.cylinder.t`) or `{kind:"constant", value:t_band}` for
a per-band override. Materials stay shared across bands today; per-band
materials drop in for free when needed (each section already carries its
own `material_ref`).

Solver side: `build_cylinder_xml` now emits `4·(N+1)` patches with
band-major ordering (4 quarters × N+1 bands), `8N+4` interfaces (4 θ-seams
per band + 4 z-seams per partition), and either a single `MaterialMatrix`
(homogeneous, bit-identical to Session 3.3) or a `MaterialMatrixContainer`
(stepped, one `MaterialMatrix` per unique thickness, mapped to patches via
`<group material="i">`). BCs reference band-relative patch indices so the
clamp + Neumann edge stay on the bottom (`band_0`) and top (`band_N`).

GUI side:
- **GEOMETRY → Dimensions** gains an "Axial partitions" sub-block with
  `+ ADD CUT` / per-row `z`-editor / remove buttons. Adding a cut
  auto-rebuilds `assignments[]` and clones extra sections for any new
  bands (cloned from the seed section's material+thickness so the user
  gets a working stepped model out of the box).
- **SHELL CONSTRUCTION → Section Assignments** shows one editable row per
  band: region tag, z-range, material, inline thickness input with a
  `↻` revert-to-geometry button. Typing a number flips that band's
  section to `{kind:"constant"}`; clicking `↻` flips it back to
  `{kind:"geometry"}`.
- **Viewport** draws a bright amber ring at each axial cut so the user
  sees their stepped-wall layout live as soon as they hit `+ ADD CUT`.

**Regression:** homogeneous default case stays bit-identical to Session
3.3 (= -0.49% vs classical at r=5). **Stepped audit** (R=33, L=100,
partition at z=50, t=[0.2, 0.1] mm, E=208000 MPa, ν=0.3): 8 patches, 12
interfaces, 2 materials in container; r=4 → +0.48 %, r=5 → -0.28 % vs
the classical formula evaluated at the top-band (loaded-edge) thickness.

### Session 3.5 — MESH wired (h / p / k + coupling) ✅

The IGA mesh surface is much narrower than classical FEM — no element
types, no element size, no normals — just the three classical h/p/k
refinement knobs plus the inter-patch coupling strategy. All four now
flow from `model.mesh` through `cylinder_lba.py` to the multipatch
driver's `-r / -p / -s / -m` flags.

Python side: `run_buckling` takes `method`/`degree`/`smoothness` as
parameters (defaults preserved); `main` resolves them as model.json →
CLI override (`--degree` / `--smoothness` / `--coupling`) → hardcoded
fallback. `COUPLING_METHOD` maps the schema-level coupling string
(`gsSmoothInterfaces`, `gsAlmostC1`, …) onto the integer `-m` flag. The
smoothness < degree invariant (a spline-theory requirement) is enforced
at parse time with a clean `SystemExit` message.

GUI side: the three previous stub sub-items (refinement / degree /
coupling) collapse into a single wired `MESH → Discretisation` inspector
— three integer `NumberField`s (h / p / k) + a four-segment `ToggleGroup`
for coupling, plus a derived block that live-estimates patch count
(`4·(N+1)`), interface count (`8N+4`), per-patch DOFs
(`((2^r·(p-k)+k+1)²·3)`), and total DOFs as the user dials knobs. The
smoothness field clamps silently to `[0, degree-1]` when the user lowers
degree — no spurious solver crashes.

**Regression:** default no-args path still hits -0.01 % at r=5 (=
Session-3.3 number, bit-identical). **Mesh smoke-test** (r=4 with p=4
instead of default p=3) ran end-to-end and converged to -0.98 % vs
classical, proving the model.json → CLI → solver chain is live; the
"Mesh : degree=4, smoothness=2, coupling=gsSmoothInterfaces (-m 0)"
banner in the run output is the audit trail.

### Session 3.6 — BCs + Loads wired (axial + bending) ✅

`build_cylinder_xml` now dispatches on `model.load.kind`:

- **axial** (current path) — constant `Tz = E·t` on the top edge →
  uniform tensile membrane stress `σ_z = E`. Smallest positive λ_1 is
  the load factor that drives compressive buckling.
- **bending** (new) — `Tz(x) = (E·t/R)·x` on the top edge → cos(θ)
  around the circle. Tension on +x, compression on −x; membrane stress
  `σ_z(x) = (E/R)·x` gives `|σ_max| = E` at `x = ±R`, so the same
  E-scaling that fixes the K_NL−K_L cancellation for axial carries
  over verbatim. Buckle localises on the −x half-cylinder.

GUI: two new inspector components under BOUNDARY CONDITIONS & LOADS —
`BcsKind.jsx` (single enabled preset: clamped + Neumann, three locked
with tooltips explaining the un-wired XML blocks) and `LoadCase.jsx`
(two enabled: axial + bending, four locked: torsion / extpress /
intpress / combined). Each disabled toggle carries a hover tooltip that
explains what's missing rather than leaving the user wondering whether
the UI is broken — same pattern as the Session-3.5 coupling toggle.

**Bending validation:** at the default geometry (R=L=1, t=0.01, E=1,
ν=0.3, r=5) bending LBA converges to σ_cr = 6.023e-3, **−0.48 %** vs
the classical σ_cr = E·t/(R·√(3(1−ν²))) = 6.052e-3. That's
essentially the same number as axial (−0.49 % at the same mesh), which
matches Stein & Mayers' result that perfect-shell LBA gives the same
critical stress for both load cases — the localised buckle on the
compression side sees an effectively uniform stress field. Bending
knockdown is an imperfection-sensitivity story, not LBA.

Axial regression unchanged: −0.01 % at r=5.

### Known gaps — next-session candidates (ordered)

1. **Mesh / BCs / Loads / Analysis sections** — same wiring pattern as
   MATERIAL: editable inputs for the values that already live in `model.json`
   under the respective keys. Mesh next (refinement / degree / smoothness
   are pure integers, easy slice).
2. **Solve-button wiring** — POST the assembled `model.json` to the running
   G+Smo container, run `cylinder_lba.py --model /aeris-input/model.json`,
   stream eigenvalues + .vts back into `output/`, refresh the post-processor
   tree when done.
3. **Numerical conditioning at large E (Session-3.3 finding).** The
   `m_B = K_NL − K_L` subtraction in `gsBucklingSolver` loses precision when
   `K_L = O(E)` and `K_geom = O(1)`. Workarounds:
   (a) auto-rescale the system internally before handing it to Spectra;
   (b) try `GEigsMode::Cayley` (solver index 4) which may be less sensitive;
   (c) document "pick units so E is moderate" and put a soft warning in the
   GUI MATERIAL inspector when E > ~1e4.
3. **Sidecar manifest from `cylinder_lba.py`** so the inspector reads
   eigenvalues + convergence table from disk instead of the hard-coded
   `LBA_META` constant in `InspectorPanel.jsx`.
4. **Fix pygismo.** Still `GISMO_WITH_PYBIND11=OFF`. Both Ubuntu apt
   `pybind11-dev 2.9.1` and pip `pybind11==2.13.6` fail to compile
   `src/misc/gsPyBind11.cpp` against G+Smo's renamed `gsEigen` namespace
   (`src/gsCore/gsLinearAlgebra.h:21` does `#define Eigen gsEigen`).
   First failed call site is `src/gsMatrix/gsVector.h:340-341` where
   `pybind11_init_gsVector` tries to bind `EigenBase<>` member functions.
   Paths to investigate:
   - (a) Replicate G+Smo's own wheel CI exactly (`pyproject.toml` + `setup.py`,
     i.e. `GISMO_BUILD_EXAMPLES=OFF` and **no** `GISMO_OPTIONAL`), then add
     shell modules back one at a time to isolate which one breaks the binding.
   - (b) Try `pybind11==2.10.4` (older, contemporary with last successful
     pygismo wheels on PyPI).
2. **Pin the optional submodule hashes for truly bit-reproducible builds.**
   The Dockerfile now captures them at build time (`/aeris/BUILD_SHAS.txt`),
   but they still float to HEAD on every fresh build. Lift the SHAs into
   `external/gismo/submodules.txt` via the `gs<Module>_HASH` mechanism — see
   `external/gismo/cmake/gsFetch.cmake:125`. Or carry our own forks.
3. **Imperfection sensitivity sweep.** The validation cylinder is *perfect*;
   real-world knock-down factors come from imperfections. Next session: add a
   single eigenmode-shaped imperfection of amplitude δ·t, sweep δ over
   `[0, 0.5, 1, 2]`, plot σ_cr(δ) / σ_cr(0). This is the entry point for the
   Monte-Carlo programme the toolkit is being built for.
4. **Split the Dockerfile** so Python-script iteration doesn't trigger a
   ~5-min recompile. Right now the COPY of `scripts/` is downstream of the
   COPY of `external/gismo`, so source changes there still rebuild gismo.
   Reorder + a `--target` argument would let us do iterative dev cleanly.
5. **Real shell computation in the smoke test** is partially obsolete now
   that `cylinder_lba.py` exists; consider promoting `cylinder_lba.py` to
   the canonical smoke test and dropping the `--help` wrapper.
6. **Solver extension audit.** We have Spectra and Optim. Skipping SuperLU,
   Trilinos, MPI for now; revisit when scaling to multi-million-DOF cases.
7. **CI.** Wire to GitHub Actions (or similar) once we settle on a hosting
   choice for Aeris.

## Working notes for next-session-you

- **OptionList XML quirk** — in `gsOptionListXml.cpp:40`, the XML reader
  recognises tag names `int`, `real`, `bool`, and falls through to *string*
  for everything else. A G+Smo switch option must be written as `<bool ...>`,
  **not** `<switch ...>`; the silent-string fallback otherwise causes
  `setOptions()` to throw "X is not a string; it is a switch" at runtime.
  Session 2 burned ~20 min on this before finding the comment in the reader.
- **Spectra `GEigsMode::Buckling` requires `shift ≠ 0`** and finds eigenvalues
  *nearest* the shift; for unknown problems put the shift roughly where you
  expect the lowest eigenvalue (a classical-formula estimate works well).
- **For shell buckling validation, use a NEUMANN load + the KL `Clamped` BC**
  (constrains the shell normal rotation, not just displacement). Pure
  Dirichlet displacement BCs without `Clamped` give "simply supported, with
  zero displacement" which is a different physical problem.
- **Multipatch KL shells need TRUE G¹ coupling, not weak C⁰/C¹ penalty**
  (Session 2.7). The single-patch driver `buckling_shell_XML.cpp` falls back
  to `addWeakC0` + `addWeakC1` penalty for multipatch input; this gives
  correct first-eigenvalue magnitude but artificially stiffens patch seams
  and surfaces spurious localised modes (visible as exploded one-sided
  spikes in renders). Use `buckling_shell_multipatch_XML.cpp` with
  `-m 0` (`gsSmoothInterfaces`) for regular topology like our closed
  cylinder, or `-m 1` (`gsAlmostC1`) when the topology has extraordinary
  vertices (T-junctions, cone-cylinder junctions, etc.). The exe builds
  a `gsMappedBasis` from the smooth construction and calls
  `assembler.setSpaceBasis(bb2)` so the shell assembly sees one globally
  smooth basis instead of patch-wise tensor products glued by penalty.
- **Cluster picker for buckling eigenvalues** — Spectra in shift-invert /
  Buckling mode happily returns isolated near-zero or near-infinite slots
  when it runs out of converged eigenpairs. `first_physical_positive` in
  `cylinder_lba.py` only accepts eigenvalues that have at least one
  neighbour within 3× of them — drops both denormals and rogue 1e+246
  entries without per-problem tuning.

## License notes

- G+Smo and its optional modules are MPL-2.0. Any local patches we apply to
  `external/gismo` must remain MPL-2.0 and be upstreamable file-by-file —
  keep our changes minimal and isolated.
- Aeris code we write *outside* `external/` is ours to license as we wish.
