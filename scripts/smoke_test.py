"""Aeris smoke test — proves the gsKLShell shell module is compiled and callable.

Locates a shipped gsKLShell example executable in /opt/gismo/build/bin and runs
it. Success = exit code 0 from the example with non-empty output. This is the
fallback path explicitly allowed by the session brief because pygismo currently
fails to compile against gsEigen (see README.md "STATUS").

Exit code 0 = pass.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

GISMO_BIN = Path(os.environ.get("GISMO_BIN", "/opt/gismo/build/bin"))


def find_klshell_example() -> Path:
    """Pick the smallest, well-behaved gsKLShell example we can find.

    gsKLShell ships its own example_*.cpp; their executables land in
    /opt/gismo/build/bin alongside G+Smo's own examples. We prefer simple
    linear / static examples over arc-length / DWR / APALM which take longer
    or expect specific data files.
    """
    if not GISMO_BIN.is_dir():
        sys.exit(f"FAIL — {GISMO_BIN} does not exist; nothing was built")

    candidates = sorted(p for p in GISMO_BIN.iterdir()
                        if p.is_file() and os.access(p, os.X_OK))
    shell = [p for p in candidates
             if "shell" in p.name.lower() or "klshell" in p.name.lower()]
    if not shell:
        listing = sorted(p.name for p in candidates)
        print(f"No gsKLShell example found in {GISMO_BIN}.")
        print(f"Available executables ({len(listing)} total):")
        for n in listing[:50]:
            print(f"  {n}")
        if len(listing) > 50:
            print(f"  ... and {len(listing) - 50} more")
        sys.exit("FAIL — gsKLShell module did not produce any executable")

    # Prefer cheap, deterministic examples over arc-length / buckling / DWR.
    preference = ("linear_shell", "example_shell2D", "example_shell3D",
                  "static", "plate", "example_shell")
    for tag in preference:
        for p in shell:
            if tag in p.name.lower() and "buckl" not in p.name.lower() \
                    and "dwr" not in p.name.lower() \
                    and "apalm" not in p.name.lower() \
                    and "arclength" not in p.name.lower():
                return p
    return shell[0]


def main() -> int:
    print("=" * 60)
    print("Aeris smoke test — invoke shipped gsKLShell example")
    print("=" * 60)

    exe = find_klshell_example()
    print(f"Selected: {exe}")

    # `--help` is safe across G+Smo examples (gsCmdLine). Confirms the binary
    # links, loads the shell library, and runs initialisation code.
    res = subprocess.run([str(exe), "--help"],
                         capture_output=True, text=True, timeout=60)
    print(f"exit code: {res.returncode}")
    print("--- stdout (first 30 lines) ---")
    for line in res.stdout.splitlines()[:30]:
        print(line)
    if res.stderr.strip():
        print("--- stderr (first 10 lines) ---")
        for line in res.stderr.splitlines()[:10]:
            print(line)

    if res.returncode != 0:
        sys.exit(f"FAIL — {exe.name} --help exited {res.returncode}")
    if not res.stdout.strip():
        sys.exit(f"FAIL — {exe.name} produced no stdout")

    print()
    print("=" * 60)
    print(f"SMOKE TEST PASSED — gsKLShell example '{exe.name}' "
          f"linked + ran (exit 0).")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
