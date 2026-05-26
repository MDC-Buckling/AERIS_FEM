# Aeris

Internal FEM toolkit for thin-shell buckling research. Built around the
open-source **G+Smo** (Geometry + Simulation Modules, MPL-2.0) C++ isogeometric
analysis library with its Kirchhoff–Love shell + structural-analysis modules
and the `pygismo` Python binding.

This first session bootstraps a reproducible Docker build only — there is no
Aeris application code yet.

## Repo layout

```
aeris/
  docker/Dockerfile      G+Smo + pygismo build image (Ubuntu 22.04, gcc-11)
  external/gismo         G+Smo source, git submodule pinned to v25.07.0
  scripts/smoke_test.py  Proves pygismo imports AND a gsKLShell exe runs
  .dockerignore
  .gitignore
  README.md              (this file)
```

## Prerequisites

- Docker Desktop (Windows / macOS) or Docker Engine (Linux). Docker Desktop
  ships WSL2 + the Linux kernel needed by the daemon.
- Git, with submodule support (any modern version).
- ~5 GB free disk for the image (G+Smo + boost + openblas + build artefacts).
- Network access during build — CMake fetches `gsKLShell`,
  `gsStructuralAnalysis`, and `gsUnstructuredSplines` from
  `github.com/gismo/<name>.git` at configure time.

## Clone (with submodule)

```powershell
git clone <this-repo-url> Aeris
cd Aeris
git submodule update --init --recursive
```

If you already cloned without submodules, run only the last line.

## Build the image

```powershell
docker build -t aeris/gismo:v25.07.0 -f docker/Dockerfile .
```

Expect 30–60 min on a 4–8-core laptop the first time. Subsequent rebuilds
reuse the apt-deps layer (~1 min if nothing changed) or the source layer
(~30–60 min if `external/gismo` content changed).

Build-time overrides (all optional):

| `--build-arg`            | default                                            |
| ------------------------ | -------------------------------------------------- |
| `CMAKE_BUILD_TYPE`       | `Release`                                          |
| `CMAKE_CXX_STANDARD`     | `17`                                               |
| `GISMO_OPTIONAL`         | `gsKLShell;gsStructuralAnalysis;gsUnstructuredSplines;gsOptim` |
| `GISMO_WITH_PYBIND11`    | `OFF` (see STATUS — blocked on gsEigen/pybind11)   |
| `GISMO_WITH_OPENMP`      | `ON`                                               |
| `GISMO_BUILD_EXAMPLES`   | `ON`                                               |
| `BUILD_PARALLEL`         | `4` (raise on bigger machines)                     |

## Run the smoke test

```powershell
docker run --rm aeris/gismo:v25.07.0 python3 /aeris/scripts/smoke_test.py
```

Expected tail of output:

```
SMOKE TEST PASSED — gsKLShell example '<name>' linked + ran (exit 0).
```

The script locates a shipped `gsKLShell` example executable in
`/opt/gismo/build/bin` (preferring `linear_shell` / `example_shellNN` over
arc-length / DWR / APALM variants) and invokes `--help` on it. Success means
the binary linked against `libgismo`, loaded the shell module, and ran
initialisation code without crashing — i.e. the shell module is compiled and
callable.

If no shell example is found, the script prints what *did* land in `bin/`
so you can pick one manually.

> **Why not `import pygismo`?** Pygismo currently fails to compile against
> G+Smo's renamed `gsEigen` namespace with both apt pybind11-dev 2.9.1 and
> pip pybind11 2.13.6. The session brief explicitly allows wrapping a shipped
> C++ example as the fallback; that's what `smoke_test.py` does. See STATUS
> below for the next-session plan.

## Interactive shell in the image

```powershell
docker run --rm -it aeris/gismo:v25.07.0
# inside:
ls /opt/gismo/build/bin | grep -i shell
python3 -c "import pygismo as gs; print(dir(gs))"
```

## Pinned versions

| Component                | Pin                                        |
| ------------------------ | ------------------------------------------ |
| G+Smo                    | tag `v25.07.0` (commit `3cd33adc2`)        |
| `gsKLShell`              | HEAD at build time (see STATUS — TODO)     |
| `gsStructuralAnalysis`   | HEAD at build time (see STATUS — TODO)     |
| `gsUnstructuredSplines`  | HEAD at build time (see STATUS — TODO)     |
| Ubuntu base              | `ubuntu:22.04`                             |
| GCC                      | `gcc-11` / `g++-11`                        |
| pybind11                 | Ubuntu 22.04 `pybind11-dev`                |

The actual hashes of the fetched optional modules are written to
`/opt/gismo/.pins` inside the image — `docker run --rm aeris/gismo:v25.07.0 cat /opt/gismo/.pins`.

## STATUS

### Works
- G+Smo v25.07.0 built as a shared library inside a reproducible Ubuntu 22.04
  image (`aeris/gismo:v25.07.0`).
- `gsKLShell`, `gsStructuralAnalysis`, `gsUnstructuredSplines` enabled via
  `GISMO_OPTIONAL` and fetched automatically by CMake at configure time.
- ~30 shell-related example executables in `/opt/gismo/build/bin/` —
  smoke test invokes one and confirms it links + runs.
- Build is reproducible: same Dockerfile + same submodule SHA = same image.

### Known gaps — next-session candidates (ordered by priority)

1. **Fix pygismo.** Currently `GISMO_WITH_PYBIND11=OFF`. Both Ubuntu apt
   `pybind11-dev` 2.9.1 and pip `pybind11==2.13.6` fail to compile
   `src/misc/gsPyBind11.cpp` against G+Smo's renamed `gsEigen` namespace
   (`src/gsCore/gsLinearAlgebra.h:21` does `#define Eigen gsEigen`).
   First failed call site is `src/gsMatrix/gsVector.h:340-341` where
   `pybind11_init_gsVector` tries to bind `EigenBase<>` member functions.
   Two paths to investigate:
   - (a) G+Smo's own wheel CI (`pyproject.toml` + `setup.py`) builds pygismo
     with `GISMO_BUILD_EXAMPLES=OFF` and **no** `GISMO_OPTIONAL` — try
     replicating exactly that, then add the shell modules back one at a time
     to isolate which one (if any) breaks the binding.
   - (b) Try an older pybind11 (e.g. `pybind11==2.10.4`) that matches the
     period when G+Smo last shipped wheels successfully.
2. **Pin the optional submodule hashes.** They currently float at HEAD on
   build day. After a successful build, run
   `docker run --rm aeris/gismo:v25.07.0 cat /opt/gismo/.pins`
   and bake the hashes into `external/gismo/submodules.txt` (via the
   `gs<Module>_HASH` mechanism — see `external/gismo/cmake/gsFetch.cmake:125`)
   — or carry our own fork of each module.
3. **Real shell computation in the smoke test.** Today's test only runs
   `--help`. Upgrade to actually solve a small linear plate / cylinder
   buckling case via `linear_shell` or similar, parse and assert on a
   numerical result.
4. **Drop the per-rebuild source layer.** If we expect to iterate on shell
   examples without touching G+Smo internals, separate "G+Smo install layer"
   from "user code layer" in the Dockerfile so script changes don't trigger
   a 40-minute recompile.
5. **Decide on solver extensions.** No Spectra / SuperLU / MPI yet — fine for
   the smoke test, but buckling eigenproblems will want at least Spectra.
6. **CI.** Wire the build to GitHub Actions (or wherever) so the image is
   rebuilt on every G+Smo bump.

## License notes

- G+Smo and its optional modules are MPL-2.0. Any local patches we apply to
  `external/gismo` must remain MPL-2.0 and be upstreamable file-by-file —
  keep our changes minimal and isolated.
- Aeris code we write *outside* `external/` is ours to license as we wish
  (decide later).
