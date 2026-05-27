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
- **ParaView export** — same script writes the cylinder mesh + linear-elastic
  reference state + first N (default 5) eigenmodes to a `/aeris-output` mount
  for visualisation. Uses the shipped exe's `--plot` flag — no custom VTK
  writing on our side. Field name for mode shapes: `SolutionField` (3-vector).
- **Headless PNG renders** (`scripts/render_modes.py` + `aeris/render:1`
  image) — turns those `.pvd/.vts` files into 21 PNGs (7 datasets × 3 fixed
  cameras) so you can judge mode shapes without opening ParaView. Renders
  use PyVista + Xvfb in a slim Python image; warp + colour are tuned to
  show both bulk buckling patterns and patch-corner artefacts honestly.
- **Aeris GUI** (`aeris-gui/`, Session 3.0) — Tauri 2 desktop front-end in
  the MDC Codex visual language. Shell + interactive three.js viewport
  reads the multi-patch `.pvd` / `.vts` files directly, rotates with
  OrbitControls, deforms live via a warp-scale slider, colours by `|u|`
  with a cyan-tinted ramp + legend, snaps to oblique/side/end-on views.
  Launch with `cd aeris-gui && npm install && npm run dev` (browser at
  http://localhost:5174) or `npm run tauri:dev` (native window). No solver
  wiring yet — pre-processor + Solve-button is next session.

### Known gaps — next-session candidates (ordered)

1. **Fix pygismo.** Still `GISMO_WITH_PYBIND11=OFF`. Both Ubuntu apt
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
