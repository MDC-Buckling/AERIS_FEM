"""Aeris model.json schema + helpers.

`ModelConfig` is the in-memory representation of one complete Aeris analysis
case — the same shape as the JSON the GUI will eventually serialise to disk
and the solver scripts will read back. This file is the **schema contract**;
every future pre-processor section extends it under its own key.

Status (Session 3.2):
- `geometry`  GUI-wired (Cylinder R/L/t, this session)
- `material`  GUI stub, schema lists the validated defaults
- `mesh`     GUI stub, schema lists the validated defaults
- `bcs`      GUI stub, schema lists the validated defaults
- `load`     GUI stub, schema lists the validated defaults
- `analysis` GUI stub, schema lists the validated defaults

A model.json round-trip looks like:

    {
      "schemaVersion": 1,
      "name": "Cylinder LBA",
      "geometry": {
        "shape": "cylinder",
        "cylinder": { "R": 1.0, "L": 1.0, "t": 0.01 }
      },
      "material":  { "model": "linear", "E": 1.0, "nu": 0.3 },
      "mesh":      { "refinement": 5, "degree": 3, "smoothness": 2,
                     "coupling": "gsSmoothInterfaces" },
      "bcs":       { "kind": "clamped_neumann" },
      "load":      { "kind": "axial",
                     "neumann_traction_axial": "auto" },
      "analysis":  { "kind": "lba", "nmodes": 5,
                     "solver": "spectra-buckling",
                     "shift": "auto" }
    }

`auto` placeholders are resolved at solve time from the geometry/material
(e.g. `neumann_traction_axial = "auto"` resolves to the shell thickness `t`,
giving an implied uniform membrane axial reference stress σ_ref = 1; `shift
= "auto"` resolves to the classical critical stress estimate, which is the
right neighbourhood for Spectra GEigsMode::Buckling). This lets the GUI
write a clean intent-level model.json without baking in the wiring tricks.

CLI:
    python aeris_model.py --dump-xml OUT.xml                    # default case
    python aeris_model.py --R 2 --L 3 --t 0.02 --dump-xml O.xml # override
    python aeris_model.py --model model.json --dump-xml O.xml   # from file
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Dict


SCHEMA_VERSION = 1


# ---------------------------------------------------------------------------
# Validated defaults — exactly what Session 2.7 ran and verified against
# the classical Lorenz/Timoshenko critical stress.
# ---------------------------------------------------------------------------

DEFAULT_GEOMETRY: Dict[str, Any] = {
    "shape": "cylinder",
    "cylinder": {"R": 1.0, "L": 1.0, "t": 0.01},
}

DEFAULT_MATERIAL: Dict[str, Any] = {
    "model": "linear",      # Saint-Venant Kirchhoff (gsMaterialMatrixLinear<3>)
    "E": 1.0,
    "nu": 0.3,
}

DEFAULT_MESH: Dict[str, Any] = {
    "refinement": 5,        # buckling_shell_multipatch_XML -r
    "degree": 3,            # -p
    "smoothness": 2,        # -s
    "coupling": "gsSmoothInterfaces",   # -m 0  (Session 2.7 default)
}

DEFAULT_BCS: Dict[str, Any] = {
    "kind": "clamped_neumann",
    # Bottom (boundary 3): full Dirichlet (u_x=u_y=u_z=0) + KL Clamped (zero
    # shell-normal rotation). Top (boundary 4): Neumann line force (0,0,T).
    # See feedback_gismo_xml_quirks.md: a TRUE engineering clamp needs BOTH
    # Dirichlet AND `<bc type="Clamped">`, not Dirichlet alone.
}

DEFAULT_LOAD: Dict[str, Any] = {
    "kind": "axial",
    "neumann_traction_axial": "auto",   # → resolves to shell thickness `t`
}

DEFAULT_ANALYSIS: Dict[str, Any] = {
    "kind": "lba",
    "nmodes": 5,
    "solver": "spectra-buckling",       # gsBucklingSolver, Spectra GEigsMode::Buckling
    "shift": "auto",                    # → resolves to classical σ_cr estimate
    "interface_penalty": 1e6,           # gsThinShellAssembler IfcPenalty
}


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CylinderGeom:
    R: float
    L: float
    t: float

    def __post_init__(self):
        for name, v in (("R", self.R), ("L", self.L), ("t", self.t)):
            if v <= 0:
                raise ValueError(f"cylinder.{name} must be > 0, got {v!r}")


@dataclass(frozen=True)
class Case:
    """Solver-facing 5-tuple. The XML builder in cylinder_lba.py takes this."""
    R: float
    L: float
    t: float
    E: float
    nu: float


@dataclass
class ModelConfig:
    name: str = "Cylinder LBA"
    geometry: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_GEOMETRY))
    material: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_MATERIAL))
    mesh: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_MESH))
    bcs: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_BCS))
    load: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_LOAD))
    analysis: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_ANALYSIS))
    schemaVersion: int = SCHEMA_VERSION

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ModelConfig":
        if d.get("schemaVersion", SCHEMA_VERSION) != SCHEMA_VERSION:
            sys.stderr.write(
                f"[aeris_model] WARN: schemaVersion={d.get('schemaVersion')} "
                f"≠ expected {SCHEMA_VERSION}; reading anyway\n"
            )
        return cls(
            name=d.get("name", "Cylinder LBA"),
            geometry={**DEFAULT_GEOMETRY, **d.get("geometry", {})},
            material={**DEFAULT_MATERIAL, **d.get("material", {})},
            mesh={**DEFAULT_MESH, **d.get("mesh", {})},
            bcs={**DEFAULT_BCS, **d.get("bcs", {})},
            load={**DEFAULT_LOAD, **d.get("load", {})},
            analysis={**DEFAULT_ANALYSIS, **d.get("analysis", {})},
            schemaVersion=d.get("schemaVersion", SCHEMA_VERSION),
        )

    @classmethod
    def from_json_file(cls, path: Path) -> "ModelConfig":
        with open(path) as f:
            return cls.from_dict(json.load(f))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schemaVersion": self.schemaVersion,
            "name": self.name,
            "geometry": self.geometry,
            "material": self.material,
            "mesh": self.mesh,
            "bcs": self.bcs,
            "load": self.load,
            "analysis": self.analysis,
        }

    def cylinder(self) -> CylinderGeom:
        if self.geometry.get("shape") != "cylinder":
            raise ValueError(
                f"geometry.shape={self.geometry.get('shape')!r} is not 'cylinder' — "
                "other shapes are not wired this session"
            )
        c = self.geometry["cylinder"]
        return CylinderGeom(R=float(c["R"]), L=float(c["L"]), t=float(c["t"]))

    def case(self) -> Case:
        """Pack geometry + material into the solver-facing 5-tuple."""
        cyl = self.cylinder()
        mat = self.material
        if mat.get("model", "linear") != "linear":
            sys.stderr.write(
                f"[aeris_model] WARN: material.model={mat.get('model')!r} not 'linear';"
                " case() returns linear-elastic E/ν anyway (no nonlinear path wired)\n"
            )
        return Case(
            R=cyl.R, L=cyl.L, t=cyl.t,
            E=float(mat.get("E", 1.0)),
            nu=float(mat.get("nu", 0.3)),
        )


# ---------------------------------------------------------------------------
# CLI — used for verification + as the bridge the GUI will use later
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", type=Path, default=None,
                   help="Read model from this JSON file")
    p.add_argument("--R", type=float, default=None, help="Cylinder R override")
    p.add_argument("--L", type=float, default=None, help="Cylinder L override")
    p.add_argument("--t", type=float, default=None, help="Cylinder t override")
    p.add_argument("--E", type=float, default=None, help="Young's modulus override")
    p.add_argument("--nu", type=float, default=None, help="Poisson override")
    p.add_argument("--dump-xml", type=Path, default=None,
                   help="Write the G+Smo cylinder XML to this path and exit")
    p.add_argument("--dump-model", type=Path, default=None,
                   help="Write the resolved model.json to this path and exit")
    p.add_argument("--show", action="store_true",
                   help="Pretty-print the resolved model and exit")
    args = p.parse_args(argv)

    model = (
        ModelConfig.from_json_file(args.model)
        if args.model
        else ModelConfig()
    )
    # CLI scalar overrides (handy for quick verification)
    for k in ("R", "L", "t"):
        v = getattr(args, k)
        if v is not None:
            model.geometry["cylinder"][k] = float(v)
    if args.E is not None:
        model.material["E"] = float(args.E)
    if args.nu is not None:
        model.material["nu"] = float(args.nu)

    if args.dump_model:
        args.dump_model.write_text(json.dumps(model.to_dict(), indent=2))
        print(f"wrote model → {args.dump_model}")

    if args.dump_xml:
        # Local import — cylinder_lba.py imports us back, avoid the cycle at top.
        from cylinder_lba import build_cylinder_xml
        xml = build_cylinder_xml(model.case())
        args.dump_xml.write_text(xml)
        print(f"wrote XML → {args.dump_xml}  ({len(xml):,} bytes)")

    if args.show or not (args.dump_xml or args.dump_model):
        print(json.dumps(model.to_dict(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
