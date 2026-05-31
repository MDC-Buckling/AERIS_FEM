"""Regression harness for the Code_Aster (classical-FEM) engine.

Runs the validated cases end-to-end INSIDE the aeris/codeaster image (mesh →
.comm → run_aster → run.json) and asserts each QoI against its pinned value,
so the engine can be re-verified after any change — in particular after the
parallel BB-triangle work merges into the shared files (aeris_model.py,
store.js, …). A new file: it touches nothing else.

Run:
    docker run --rm \\
      -v <repo>/scripts:/scripts:ro -v <writable-dir>:/work \\
      aeris/codeaster:v17 python3 /scripts/test_code_aster_engine.py

Each pinned value is the current correct result at the case's fixed mesh size
(deterministic), so a 1% tolerance flags any real regression while absorbing
trivial numerical noise. Update a pinned value ONLY with a deliberate,
understood change.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import code_aster_static  # noqa: E402

WORK = Path(os.environ.get("AERIS_TEST_WORK", "/work"))


def _seg():
    return {"shape": "cylinder_segment",
            "cylinder_segment": {"R": 25.0, "L": 50.0, "t": 0.25, "phi_deg": 40.0}}


def _cyl():
    return {"shape": "cylinder",
            "cylinder": {"R": 33.0, "L": 100.0, "t": 0.1, "partitions": []}}


def _mat(E, nu):
    return [{"id": "mat-default", "model": "linear", "E": E, "nu": nu}]


def _disc(fam="DKT", shape="triangle", tech="free", h=2.0):
    return {"code_aster": {"element_family": fam, "element_shape": shape,
                           "technique": tech, "mesh_size": h, "order": 1}}


def _model(geom, mats, bcs, load, kind, disc):
    return {"schemaVersion": 2, "geometry": geom, "materials": mats,
            "bcs": bcs, "load": load, "analysis": {"kind": kind},
            "solver": {"engine": "code_aster"}, "discretization": disc}


# name → (model, pinned |u_z|, rel-tolerance)
CASES = [
    ("segment_static_DKT",
     _model(_seg(), _mat(4.32e8, 0.0), {"kind": "scordelis_diaphragm"},
            {"kind": "gravity", "magnitude": 90.0}, "static",
            _disc("DKT", "triangle", "free", 2.5)),
     0.28105, 0.01),
    ("segment_static_COQUE_3D",
     _model(_seg(), _mat(4.32e8, 0.0), {"kind": "scordelis_diaphragm"},
            {"kind": "gravity", "magnitude": 90.0}, "static",
            _disc("COQUE_3D", "quad", "free", 2.5)),
     0.30201, 0.01),
    ("cylinder_axial_DKT",
     _model(_cyl(), _mat(208000.0, 0.0), {"kind": "clamped"},
            {"kind": "axial", "magnitude": 1000.0}, "static",
            _disc("DKT", "triangle", "free", 5.0)),
     0.02313, 0.01),
    ("cylinder_pressure",
     _model(_cyl(), _mat(208000.0, 0.3), {"kind": "clamped"},
            {"kind": "pressure", "magnitude": 1.0}, "static",
            _disc("DKT", "triangle", "free", 5.0)),
     0.04761, 0.02),
    ("segment_GNA",
     _model(_seg(), _mat(4.32e8, 0.0), {"kind": "scordelis_diaphragm"},
            {"kind": "gravity", "magnitude": 90.0}, "gna",
            _disc("DKT", "triangle", "free", 1.5)),
     0.24712, 0.02),
]


def _run_case(name, model, expect, tol):
    d = WORK / f"regtest_{name}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "model.json").write_text(json.dumps(model))
    rc = code_aster_static.main(["--model", str(d / "model.json")])
    if rc != 0:
        return False, f"solver exit {rc}"
    rj = json.loads((d / "run.json").read_text())
    got = float(rj["qois"][0]["qoiAbsValue"])
    rel = abs(got - expect) / expect
    return rel <= tol, f"|u_z|={got:.6g} vs {expect:.6g} ({rel * 100:.2f}%)"


def main() -> int:
    print("=" * 64)
    print("Code_Aster engine regression harness")
    print("=" * 64)
    results = []
    for name, model, expect, tol in CASES:
        try:
            ok, msg = _run_case(name, model, expect, tol)
        except Exception as exc:  # noqa: BLE001
            ok, msg = False, f"EXCEPTION {type(exc).__name__}: {exc}"
        results.append(ok)
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:28s} {msg}")
    n = sum(results)
    print("-" * 64)
    print(f"  {n}/{len(results)} passed")
    return 0 if n == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
