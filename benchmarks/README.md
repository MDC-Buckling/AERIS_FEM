# Aeris Validation Suite

Cross-checks of the G+Smo / `gsKLShell` toolchain against the classical
shell benchmarks (Belytschko obstacle course + others). Each benchmark
is a standalone Python script that:

1. Builds the boundary value problem (geometry + material + BCs + load).
2. Runs the appropriate solver inside the `aeris/gismo` container.
3. Extracts the published quantity of interest from the solver output.
4. Sweeps refinement levels and reports a convergence table.
5. Prints a clear **PASS / FAIL** verdict against the reference value.

The point is to keep Aeris **honest**: a single working buckling case is
not enough; the shell chain has to give the right answer across
different deformation regimes (membrane, bending, mixed) and topologies
(single patch, multipatch with smooth coupling) before we can trust it
on novel problems.

## Suite layout

| Benchmark | Type | Deformation regime | Reference QoI | Status |
|---|---|---|---|---|
| [scordelis_lo](scordelis_lo/) | static linear | membrane-dominated bending | `u_z = 0.3006` at free-edge midpoint (KL shell) | **PASS** (0.031 % at r=6) |
| _scordelis_lo_multipatch_ | static linear | + multipatch C¹ moment transfer | same as above | planned |
| _pinched_cylinder_ | static linear | bending-dominated, point load | `u = 1.8248e-5` under load (KL shell) | planned |
| _pinched_hemisphere_ | static linear | inextensional bending | `u_x = 0.0924` at load point (KL shell) | planned |
| _cylinder_axial_lba_ | linear buckling | bifurcation eigenvalue | classical Lorenz/Timoshenko | shipped (`scripts/cylinder_lba.py`) |

Add new benchmarks by copying the `scordelis_lo/` layout and editing
the problem statement + reference value.

## Shared helpers

`common/` holds the bits each benchmark reuses — the docker-run wrapper
for the static shell driver, a small VTK structured-grid parser that
extracts displacement at a given grid index, and a verdict printer
with PASS/FAIL formatting.

## Why these specific benchmarks

The cylinder axial LBA we already had (`scripts/cylinder_lba.py`) is an
**eigenvalue** problem on a closed-cylinder topology. It exercises
membrane stiffness + the geometric prestress matrix, but it does NOT
exercise static bending response, free-edge behaviour, or multi-patch
moment transfer under bending. The obstacle course fills those gaps:

- **Scordelis-Lo** is membrane-dominated with significant bending near
  the free edges. The QoI is sensitive to both the membrane stiffness
  and how the basis handles the C¹ requirement across patches when
  the geometry is multipatch — a perfect cross-check for our
  `gsSmoothInterfaces` coupling under a bending load (not just under
  the buckling eigenvalue we tested before).
- **Pinched cylinder** is the canonical bending-dominated test; it
  catches shear locking and inextensible-mode failures.
- **Pinched hemisphere** is the inextensional-bending stress test.

Together these three cover the "no single element class passes all
three" pathology that motivated the Belytschko 1985 obstacle course
paper. If `gsKLShell` clears all three on Aeris's pipeline, the chain
is solid for general thin-shell linear analysis.

## Running a benchmark

Each benchmark is self-contained:

```bash
cd benchmarks/scordelis_lo
python3 scordelis_lo.py          # full convergence sweep + verdict
python3 scordelis_lo.py --quick  # single coarse run (smoke test)
```

The scripts assume `aeris/gismo:v25.07.0` is available locally (built
from the repo's `docker/Dockerfile`) and that the host has Docker
Desktop running.
