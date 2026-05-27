"""Solver-invocation helpers for benchmark scripts.

These run INSIDE the aeris/gismo container — the binary path
`/opt/gismo/build/bin/<exe>` is invoked directly via subprocess. The
host-side entry point is a one-line `docker run` wrapper, see each
benchmark's README. Mirrors the design of `scripts/cylinder_lba.py`.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path


SOLVER_BIN_DIR = Path(os.environ.get(
    "AERIS_BIN_DIR", "/opt/gismo/build/bin"))


def run_solver(
    *,
    exe: str,
    work_dir: Path,
    input_xml: str = "input.xml",
    extra_args: list[str] | None = None,
    timeout_s: int = 600,
) -> subprocess.CompletedProcess:
    """Invoke a G+Smo blackbox solver. Assumes we're inside the
    aeris/gismo container so `/opt/gismo/build/bin/<exe>` exists.

    `work_dir` must already contain `input_xml`. Solver output (`.vts`,
    `.pvd`, etc.) lands back in `work_dir`. `extra_args` are appended
    after `-i <input_xml> -o <work_dir>`.

    Returns the completed process; the caller decides whether to assert
    on returncode."""
    work_dir = Path(work_dir).resolve()
    if not (work_dir / input_xml).exists():
        raise FileNotFoundError(
            f"{input_xml} not found in {work_dir}; write it before run_solver"
        )

    exe_path = SOLVER_BIN_DIR / exe
    if not exe_path.exists():
        raise FileNotFoundError(
            f"{exe_path} missing — are you running inside the aeris/gismo "
            "container? Set AERIS_BIN_DIR if the binary lives elsewhere."
        )

    cmd = [
        str(exe_path),
        "-i", str(work_dir / input_xml),
        "-o", str(work_dir),
        *(extra_args or []),
    ]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)


def verdict(label: str, computed: float, reference: float,
            tolerance_pct: float = 1.0) -> tuple[bool, str]:
    """Standard PASS/FAIL line. Returns (passed, formatted_string).

    A benchmark passes when the relative error |1 - computed/reference|
    is within `tolerance_pct` percent. We compare magnitudes because
    sign conventions differ across the literature."""
    rel_err_pct = 100.0 * abs(abs(computed) - abs(reference)) / abs(reference)
    passed = rel_err_pct <= tolerance_pct
    tag = "PASS" if passed else "FAIL"
    line = (
        f"[{tag}] {label}: "
        f"computed = {computed:+.6e}, reference = {reference:+.6e}, "
        f"|err| = {rel_err_pct:.3f}% (tol {tolerance_pct:.1f}%)"
    )
    return passed, line
