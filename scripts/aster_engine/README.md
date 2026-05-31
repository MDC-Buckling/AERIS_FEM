# Aeris Code_Aster engine (classical FEM)

A second discretisation engine alongside the G+Smo isogeometric (IGA) path.
The same engine-agnostic `model.json` drives either engine; `solver.engine`
(`"gismo"` | `"code_aster"`) selects it. The IGA path is untouched — this is
purely additive.

```
model.json  ──►  solver.engine ?
                  ├─ "gismo"      →  NURBS patches + refinement  →  G+Smo C++ drivers
                  └─ "code_aster" →  GMSH mesh (.med)            →  Code_Aster .comm
                       │                                              │
                       └─ scripts/meshing/gmsh_shells.py        run_aster
                          scripts/aster_engine/comm.py          ──►  result.med
                          scripts/code_aster_*.py  ◄────────────────────┘
                                       └─►  run.json + .vtu  →  GUI viewport
```

## Pieces

| File | Role |
|---|---|
| `docker/Dockerfile.codeaster` | `aeris/codeaster:v17` — conda-forge code-aster 17.x + **pip** gmsh + meshio + h5py |
| `scripts/aeris_model.py` | schema: `solver.engine` + `discretization.{gismo,code_aster}` |
| `scripts/meshing/gmsh_shells.py` | GMSH → `.med`; element shape/technique → recombine/order/transfinite |
| `scripts/aster_engine/comm.py` | `.comm` builders (static / GNA / buckling) + `.export` |
| `scripts/code_aster_static.py` | static + GNA wrapper: mesh → comm → `run_aster` → QoI + stress → `run.json` |
| `scripts/code_aster_buckling.py` | linear-buckling wrapper (MODE_FLAMB) |
| `scripts/mesh_preview.py` | mesh-only ("Mesh Part"): counts + `meshpreview.vtu/.pvd` + edges |
| `scripts/test_code_aster_engine.py` | regression harness (pins the validated QoIs) |
| GUI | `MeshDiscretisation.jsx` (engine + mesh controls), `vite.config.js` (`/run-solver`, `/mesh-preview` dispatch), `vtk/parseVtu.js`, `Viewport3D.jsx` |

## Dispatch (vite.config.js)

`solver.engine` is read **before** the `(shape, kind, load)` matrix. For
`code_aster` the wired combos are:

| shape | analysis.kind | load.kind | script |
|---|---|---|---|
| cylinder_segment | static | gravity | code_aster_static.py |
| cylinder_segment | gna | gravity | code_aster_static.py |
| cylinder | static | axial \| pressure | code_aster_static.py |
| cylinder | lba | axial | code_aster_buckling.py (infra, see below) |

Code_Aster runs in `aeris/codeaster:v17`; the IGA scripts in `aeris/gismo`.

## Validated results

| case | QoI | value | reference | error |
|---|---|---|---|---|
| Scordelis-Lo segment, DKT | u_z | 0.30030 (h→0.25) | 0.3006 FE / 0.3024 analytic / IGA ~0.3006 | 0.1% |
| Scordelis-Lo segment, COQUE_3D | u_z | 0.30201 (h2.5) | 0.3006 | 0.1% |
| cylinder axial (ν=0), DKT | u_z(top) | 0.023127 | membrane −F·L/(2πRtE) = 0.023187 | 0.26% |
| cylinder axial, membrane σ_vm | σ_vm | 48.27 | F/(2πRt) = 48.23 | 0.09% |
| cylinder pressure, membrane σ_vm | σ_θ | 329.1 | pR/t = 330 | 0.26% |

Run the harness to re-check all of these after any change:
```
docker run --rm -v <repo>/scripts:/scripts:ro -v <tmp-dir>:/work \
  aeris/codeaster:v17 python3 /scripts/test_code_aster_engine.py
```

## Mesh controls (Abaqus-style, independent)

- **Element type** (modelisation): `DKT` (thin, TRIA3/QUAD4) | `COQUE_3D` (curved, QUAD9).
- **Element shape**: triangle | quad (gmsh recombine). COQUE_3D forces quad.
- **Technique**: free (Delaunay) | structured (transfinite mapped grid).
- **Element size** `h` (mm). "Generate mesh" previews the real FE mesh + counts.

## Results produced

`run.json` (+ `.vtu`/`.pvd`): displacement (`files.solution`), membrane
von-Mises (`files.stressVonMises`, σ=N/t), surface von-Mises
(`files.stressVonMisesSurface`, σ=N/t ± 6M/t², the yield-relevant one).

## Gotchas (hard-won — don't relearn these)

- **conda-forge gmsh has NO MED support** → install gmsh via **pip** in the image.
- gmsh pip wheel needs `libGLU.so.1`/`libGL.so.1`/`libX*` even headless (apt).
- **meshio's MED reader lacks `QU9`** (COQUE_3D's QUAD9) → `_patch_meshio_med()`.
- Dir is `aster_engine/`, **not `aster/`** — code-aster ships its own `aster` package.
- **`DKQ`/`DSQ` are elements, not modelisations** — quad thin-shell = QUAD4 mesh + `MODELISATION='DKT'`.
- COQUE_3D needs QUAD9 (centre node); a bare `setOrder(2)` gives TRIA6 which it rejects.
- Shell stress needs `AFFE_CARA_ELEM/COQUE/VECTEUR` (cylinder (0,0,1), roof (1,0,0)) or `PLATE1_40`.
- GNA: use `DKTG` (DKT's null drilling DOF → singular tangent), `RESI_GLOB_RELA=1e-5`, auto step-cut.
- Code_Aster success = `<A>_ALARM`/`OK` diagnostic, not just exit code — parse `study.mess`.

## Open / deferred

- **Buckling → classical σ_cr: INFRASTRUCTURE ONLY.** The pipeline runs
  (free-top + BANDE → σ ≈ 0.40·classical, an edge mode). The classical match
  needs simply-supported ends, whose dense near-degenerate spectrum the
  shift-invert eigensolver doesn't resolve blind (`CENTRE` applies a 0 shift,
  `BANDE` finds 800+ and diverges). A dedicated ARPACK/packeted-CALC_MODES task.
- **GUI: expose `pressure` in the LoadCase selector** (backend validated; the
  selector is IGA-shared, needs engine-conditional enabling).
- **GNA**: converges + sensible, but no quantitative cross-check yet.
- **Geometry**: sphere/hemisphere not wired for FEM.
- **Viewport**: real-mesh render wired for the cylinder branch only (not segment).
- **Deployment**: dev-server only; image not on the VPS.
