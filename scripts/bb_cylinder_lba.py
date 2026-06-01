"""Aeris — closed-cylinder axial LBA with the Bernstein-Bezier (BB) triangle
KL-shell element.

This is the BB analogue of ``cylinder_lba.py``: it reads the same ``model.json``
contract (geometry / material via ``ModelConfig``, BB mesh params from
``discretization.bb``), drives the validated dense BB driver
(``bb/cpp/bb_cylinder_lba_driver.cpp``) instead of gsKLShell + gsBucklingSolver,
parses the eigenvalue cluster + (m,n) modes it prints, and writes the same
``run.json`` sidecar shape the post-processor already consumes (verdict /
convergence / modes / criticalLoad) — with ``engine="bb"``.

The BB element computes a CLOSED cylinder with a uniform axial membrane
prestress imposed directly (uniform BY CONSTRUCTION), SS hinged ends, and a
dense generalized eigensolve. It is validated end-to-end (memory:
project_aeris_bb_triangle): at R/t=20 the lowest cluster is [m0,n8] ~0.90·σ_cl,
the classical Koiter short-wave mode — that's the acceptance target.

The driver C++ is compiled on first use (cached under <work>/.bb_build, keyed
on a hash of the sources) — the BB sources live in /bb (mounted read-only by
the dev-server dispatcher), gismo headers/lib under /opt/gismo. No image
rebake needed for the first simulation; baking the exe into the image is a
later optimisation.

Usage (inside the aeris/gismo:v25.07.0 container):

    python3 /scripts/bb_cylinder_lba.py --model /work/model.json --plot-dir /work
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Physics — same classical reference as cylinder_lba.py
# ---------------------------------------------------------------------------

def classical_sigma_cr(R: float, t: float, E: float, nu: float) -> float:
    """Classical critical axial buckling stress (Lorenz / Timoshenko)."""
    return E * t / (R * math.sqrt(3.0 * (1.0 - nu ** 2)))


# ---------------------------------------------------------------------------
# BB driver: locate / compile / run
# ---------------------------------------------------------------------------

# BB sources mounted read-only by the dispatcher at /bb (override via env for
# local runs). The driver TU + the three element headers it includes.
BB_ROOT = Path(os.environ.get("AERIS_BB_ROOT", "/bb"))
BB_CPP = BB_ROOT / "cpp"
DRIVER_SRC = BB_CPP / "bb_cylinder_lba_driver.cpp"
DRIVER_HEADERS = [
    "bb_triangle_basis.hpp",
    "bb_triangle_quadrature.hpp",
    "bb_kl_strains.hpp",
]

GISMO_INCLUDES = ["/opt/gismo/src", "/opt/gismo/build",
                  "/opt/gismo/optional", "/opt/gismo/external"]
GISMO_LIBDIR = "/opt/gismo/build/lib"


def _source_hash(compile_cmd: list[str]) -> str:
    h = hashlib.sha256()
    h.update(("\0".join(compile_cmd)).encode())
    for name in ["bb_cylinder_lba_driver.cpp", *DRIVER_HEADERS]:
        p = BB_CPP / name
        h.update(p.read_bytes())
    return h.hexdigest()[:16]


def ensure_driver(build_dir: Path) -> Path:
    """Return a path to the compiled BB driver, compiling (once, cached) if
    needed. Cache lives under build_dir keyed by a source hash so a re-solve
    of the same job reuses the binary and an edited source recompiles."""
    if not DRIVER_SRC.exists():
        raise SystemExit(
            f"BB driver source not found at {DRIVER_SRC} — is the bb/ directory "
            f"mounted into the container at {BB_ROOT}? (dispatcher mounts -v "
            f"<repo>/bb:/bb:ro for engine=bb)"
        )
    build_dir.mkdir(parents=True, exist_ok=True)
    exe = build_dir / "bb_cylinder_lba_driver"
    compile_cmd = [
        "g++", "-std=c++17", "-O2",
        *[f"-I{inc}" for inc in GISMO_INCLUDES], f"-I{BB_CPP}",
        str(DRIVER_SRC),
        f"-L{GISMO_LIBDIR}", "-lgismo", f"-Wl,-rpath,{GISMO_LIBDIR}",
        "-o", str(exe),
    ]
    want = _source_hash(compile_cmd)
    stamp = build_dir / "bb_cylinder_lba_driver.hash"
    if exe.exists() and stamp.exists() and stamp.read_text().strip() == want:
        return exe   # cache hit
    print("[AERIS-PHASE] compiling", flush=True)
    print(f"Compiling BB driver → {exe}", flush=True)
    res = subprocess.run(compile_cmd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.stderr.write(res.stdout)
        sys.stderr.write(res.stderr)
        raise RuntimeError(f"g++ failed compiling BB driver (exit {res.returncode})")
    stamp.write_text(want)
    return exe


@dataclass
class BBMode:
    index: int
    m: int
    n: int
    sigma: float
    ratio: float
    lam: float        # critical line load N_cr = sigma * t
    pvd: str | None


META_RE = re.compile(r"^\[BB-META\]\s+(.*)$")
SIGCL_RE = re.compile(r"^\[BB-SIGMA-CL\]\s+([-+0-9.eE]+)\s*$")
MODE_RE = re.compile(
    r"^\[BB-MODE\]\s+index=(\d+)\s+m=(\d+)\s+n=(\d+)\s+sigma=([-+0-9.eE]+)\s+"
    r"ratio=([-+0-9.eE]+)\s+lambda=([-+0-9.eE]+)\s+pvd=(\S+)\s*$"
)


def run_driver(exe: Path, R: float, L: float, t: float, E: float, nu: float,
               Nx: int, Nt: int, p: int, nmodes: int,
               out_dir: Path | None, timeout: int = 1800):
    cmd = [str(exe),
           "--R", repr(R), "--L", repr(L), "--t", repr(t),
           "--E", repr(E), "--nu", repr(nu),
           "--Nx", str(Nx), "--Nt", str(Nt), "--p", str(p),
           "--nmodes", str(nmodes)]
    if out_dir is not None:
        cmd += ["--out", str(out_dir)]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    # Driver writes progress to stderr; surface it for the live monitor.
    if res.stderr:
        sys.stderr.write(res.stderr)
    if res.returncode != 0:
        sys.stderr.write(res.stdout)
        raise RuntimeError(f"{exe.name} exited {res.returncode}")

    sigma_cl = None
    modes: list[BBMode] = []
    for line in res.stdout.splitlines():
        m = SIGCL_RE.match(line)
        if m:
            sigma_cl = float(m.group(1))
            continue
        m = MODE_RE.match(line)
        if m:
            pvd = m.group(7)
            modes.append(BBMode(
                index=int(m.group(1)), m=int(m.group(2)), n=int(m.group(3)),
                sigma=float(m.group(4)), ratio=float(m.group(5)),
                lam=float(m.group(6)), pvd=(None if pvd == "-" else pvd),
            ))
    if sigma_cl is None or not modes:
        sys.stderr.write(res.stdout[-2000:])
        raise RuntimeError("BB driver produced no parseable [BB-MODE]/[BB-SIGMA-CL] output")
    return sigma_cl, modes


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def _phase(name: str) -> None:
    print(f"[AERIS-PHASE] {name}", flush=True)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", type=Path, default=None,
                   help="Path to a model.json (schema in aeris_model.py).")
    p.add_argument("--R", type=float, default=None)
    p.add_argument("--L", type=float, default=None)
    p.add_argument("--t", type=float, default=None)
    p.add_argument("--E", type=float, default=None)
    p.add_argument("--nu", type=float, default=None)
    # BB mesh overrides (default: pull from model.discretization.bb)
    p.add_argument("--degree", type=int, default=None, help="BB polynomial degree p")
    p.add_argument("--Nx", type=int, default=None, help="axial element count")
    p.add_argument("--Nt", type=int, default=None, help="circumferential element count")
    p.add_argument("--nmodes", type=int, default=None)
    # Compatibility with the generic dispatcher arg surface (ignored by BB —
    # the BB mesh is set by Nx/Nt/p, not an h-refinement sweep).
    p.add_argument("--refines", type=int, nargs="+", default=None,
                   help="(ignored — BB meshes via Nx/Nt/p)")
    p.add_argument("--threads", type=int, default=1, help="(accepted; driver is serial)")
    p.add_argument("--plot-dir", type=Path, default=None,
                   help="Where to write mp.pvd + modes/*.pvd + run.json. "
                        "Defaults to /work if it exists.")
    p.add_argument("--no-plot", action="store_true",
                   help="Skip ParaView file export (still writes run.json).")
    args = p.parse_args(argv)

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from aeris_model import ModelConfig

    model = (ModelConfig.from_json_file(args.model) if args.model else ModelConfig())
    cyl = model.geometry["cylinder"]
    if args.R is not None: cyl["R"] = args.R
    if args.L is not None: cyl["L"] = args.L
    if args.t is not None: cyl["t"] = args.t
    if args.E is not None: model.materials[0]["E"] = args.E
    if args.nu is not None: model.materials[0]["nu"] = args.nu
    case = model.case()

    # BB discretisation block — model.discretization.bb, CLI overrides on top.
    try:
        bb_disc = model.disc("bb")
    except Exception:
        bb_disc = {}
    p_deg  = args.degree if args.degree is not None else int(bb_disc.get("degree", 5))
    Nx     = args.Nx     if args.Nx     is not None else int(bb_disc.get("Nx", 4))
    Nt     = args.Nt     if args.Nt     is not None else int(bb_disc.get("Nt", 20))
    nmodes = (args.nmodes if args.nmodes is not None
              else int(bb_disc.get("nmodes", model.analysis.get("nmodes", 8))))

    plot_dir = args.plot_dir
    if plot_dir is None:
        default = Path("/work")
        plot_dir = default if default.exists() else None
    out_dir = None if (args.no_plot or plot_dir is None) else plot_dir

    _phase("setup")
    print("=" * 70)
    print("Aeris cylinder LBA — Bernstein-Bezier triangle KL-shell element")
    print("=" * 70)
    print(f"Geometry : R={case.R}, L={case.L}, t={case.t}")
    print(f"Material : E={case.E}, nu={case.nu}")
    print(f"BB mesh  : p={p_deg}, Nx={Nx}, Nt={Nt}, nmodes={nmodes}")
    print(f"Slenderness  R/t = {case.R / case.t:.0f}")
    print(f"Aspect ratio L/R = {case.L / case.R:.2f}")
    sigma_cl_ref = classical_sigma_cr(case.R, case.t, case.E, case.nu)
    print(f"Classical sigma_cl = E*t/(R*sqrt(3(1-nu^2))) = {sigma_cl_ref:.8e}")
    print()

    build_dir = (plot_dir / ".bb_build") if plot_dir is not None else Path("/tmp/bb_build")
    exe = ensure_driver(build_dir)

    _phase("solving")
    print(f"Driving BB element: closed cylinder, uniform axial N_xx, SS ends, "
          f"dense generalized eig (nmodes={nmodes}).")
    sigma_cl, modes = run_driver(
        exe, case.R, case.L, case.t, case.E, case.nu, Nx, Nt, p_deg, nmodes, out_dir)

    _phase("verdict")
    # The buckling load = the lowest member of the cluster (smallest sigma).
    crit = min(modes, key=lambda mo: mo.sigma)
    sigma_finest = crit.sigma
    pct = 100.0 * (sigma_finest - sigma_cl) / sigma_cl

    print()
    print("Lowest buckling cluster (read the cluster, not bare λ_min):")
    print(f"  {'idx':>3}  {'(m,n)':>8}  {'sigma_cr':>14}  {'sigma/sigma_cl':>14}")
    for mo in modes:
        print(f"  {mo.index:>3}  {'(%d,%d)' % (mo.m, mo.n):>8}  "
              f"{mo.sigma:>14.6e}  {mo.ratio:>14.4f}")
    print()
    print("=" * 70)
    print("Verdict")
    print("=" * 70)
    print(f"Critical mode      : (m{crit.m}, n{crit.n})")
    print(f"sigma_cr (computed): {sigma_finest:.6e}")
    print(f"sigma_cl (classical): {sigma_cl:.6e}")
    print(f"Relative deviation : {pct:+.2f}%")
    print(f"n_cr ~ sqrt(R/t)   : predicted {math.sqrt(case.R / case.t):.1f}, "
          f"got {crit.n}")

    # ABAQUS-style critical axial force F_cr = sigma_cr · 2πRt
    A_axial = 2.0 * math.pi * case.R * case.t
    magnitude = float(model.load.get("magnitude", 1.0))
    F_cr_computed = sigma_finest * A_axial
    F_cr_classical = sigma_cl * A_axial
    print()
    print(f"Critical axial force (computed)  : F_cr = {F_cr_computed:.6e}")
    print(f"Critical axial force (classical) : F_cr = {F_cr_classical:.6e}")

    # Accept within the inherent cluster scatter + finite-length offset band.
    deviation_ok = abs(pct) < 25.0

    # --- run.json sidecar (same shape the post-processor reads from IGA) ----
    if plot_dir is not None:
        try:
            modes_entries = [{
                "id": f"mode{i}",
                "index": i,
                "label": f"Buckling mode {i + 1} — (m{mo.m}, n{mo.n})",
                "pvd": mo.pvd,
                "lambda": mo.lam,
                "sigmaComputed": mo.sigma,
                "m": mo.m,
                "n": mo.n,
            } for i, mo in enumerate(modes)]
            run_json = {
                "schemaVersion": 1,
                "engine": "bb",
                "analysisKind": "lba",
                "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "command": " ".join(sys.argv),
                "case": {
                    "R": case.R, "L": case.L, "t": case.t,
                    "E": case.E, "nu": case.nu,
                    "RoverT": case.R / case.t,
                    "LoverR": case.L / case.R,
                },
                "geometry": {
                    "shape": "cylinder",
                    "n_bands": 1,
                    "n_patches": 1,
                    "n_interfaces": 0,
                    "partitions": [],
                },
                "mesh": {
                    "engine": "bb",
                    "degree": p_deg,
                    "Nx": Nx,
                    "Nt": Nt,
                    "nmodes": nmodes,
                    # IGA-shape mirror fields so the generic post-processor
                    # header/coupling line still reads cleanly.
                    "refinement": Nt,
                    "coupling": f"BB-triangle C¹ (Ludwig) · p={p_deg}",
                    "couplingMethod": p_deg,
                },
                "load": {
                    "kind": "axial",
                    "magnitude": magnitude,
                },
                "analysis": {
                    "kind": "lba",
                    "solver": "bb-dense-geneig",
                    "nmodes": nmodes,
                },
                "convergence": [
                    {"r": Nt, "lambda1": crit.lam,
                     "sigmaComputed": sigma_finest, "pct": pct},
                ],
                "verdict": {
                    "sigmaFinest": sigma_finest,
                    "sigmaClassical": sigma_cl,
                    "deviationPct": pct,
                    "ok": deviation_ok,
                    "finestR": Nt,
                    "criticalMode": {"m": crit.m, "n": crit.n},
                },
                "criticalLoad": {
                    "kind": "F",
                    "label": "axial force",
                    "applied": magnitude,
                    "computed": F_cr_computed,
                    "classical": F_cr_classical,
                    "loadFactor": (F_cr_computed / magnitude)
                                  if magnitude not in (0.0, 1.0) else None,
                },
                "modes": modes_entries,
                "files": {
                    "geometry": "mp.pvd",
                    "modesDir": "modes",
                },
            }
            (plot_dir / "run.json").write_text(json.dumps(run_json, indent=2))
            print(f"\nSidecar manifest written: {plot_dir}/run.json")
        except Exception as e:
            print(f"\nSidecar write failed: {e}")
            print("(Numerical results above are unaffected.)")

    if deviation_ok:
        print("\nORDER OF MAGNITUDE OK — cluster sits at σ_cl within the")
        print("finite-length / Koiter-scatter envelope (~±25%).")
        _phase("done")
        return 0
    print("\nDEVIATION TOO LARGE — check BCs / units / mesh resolution.")
    _phase("done")
    return 2


if __name__ == "__main__":
    sys.exit(main())
