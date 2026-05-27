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


SCHEMA_VERSION = 2


# ---------------------------------------------------------------------------
# Validated defaults — exactly what Session 2.7 ran and verified against
# the classical Lorenz/Timoshenko critical stress.
# Schema v2 (Session 3.3) replaces the top-level `material` with
#     materials[]  + sections[]  + assignments[]
# in an ABAQUS-style section-assignment layout, trivial now (one shell, one
# material, one assignment) but extensible for stiffeners / variable
# thickness / composite layups later. v1 model.json files are migrated.
# ---------------------------------------------------------------------------

DEFAULT_GEOMETRY: Dict[str, Any] = {
    "shape": "cylinder",
    "cylinder": {"R": 1.0, "L": 1.0, "t": 0.01},
}

# materials[] is a library — any section can reference any material by id.
# For now only one default material; the GUI MATERIAL section edits this one.
# `model` discriminates linear / nonlinear families (nonlinear deferred).
DEFAULT_MATERIALS: list[Dict[str, Any]] = [
    {
        "id": "mat-default",
        "name": "Linear isotropic (default)",
        "model": "linear",   # → gsMaterialMatrixLinear<3>  (Saint-Venant Kirchhoff)
        "E": 1.0,
        "nu": 0.3,
        # Reserved schema slots — added when the relevant analysis lands:
        #   "yield":   used by Plasticity Correction (not affecting linear LBA)
        #   "density": affects modal / dynamic; LBA ignores it
    },
]

# sections[] is the ABAQUS-style shell-section library: each bundles a
# material reference + a thickness source + a (future) offset spec.
# `thickness_source.kind: "geometry"` means "use geometry.cylinder.t"; we
# keep thickness as single-source-of-truth in geometry so it can't drift
# between two places. When variable-thickness lands we add
# kind: "constant" (with .value) or kind: "function" (with .expr).
DEFAULT_SECTIONS: list[Dict[str, Any]] = [
    {
        "id": "sec-shell-1",
        "name": "Shell — full cylinder",
        "kind": "shell",
        "material_ref": "mat-default",
        "thickness_source": {"kind": "geometry"},
        "offset": "midsurface",   # future: "top" / "bottom" for offset shells
    },
]

# assignments[] binds each region of the model to a section. The current
# single-cylinder model has one region called "shell_full" assigned to
# sec-shell-1. Stiffened shells later add regions like "skin", "ring",
# "stringer", each with their own assignment.
DEFAULT_ASSIGNMENTS: list[Dict[str, Any]] = [
    {"region": "shell_full", "section_ref": "sec-shell-1"},
]

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
    materials: list = field(
        default_factory=lambda: [dict(m) for m in DEFAULT_MATERIALS]
    )
    sections: list = field(
        default_factory=lambda: [dict(s) for s in DEFAULT_SECTIONS]
    )
    assignments: list = field(
        default_factory=lambda: [dict(a) for a in DEFAULT_ASSIGNMENTS]
    )
    mesh: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_MESH))
    bcs: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_BCS))
    load: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_LOAD))
    analysis: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_ANALYSIS))
    schemaVersion: int = SCHEMA_VERSION

    # --- migration -------------------------------------------------------

    @staticmethod
    def _migrate_v1_to_v2(d: Dict[str, Any]) -> Dict[str, Any]:
        """Convert a schemaVersion=1 model.json (top-level `material: {...}`)
        into v2 (materials/sections/assignments arrays). Backward compat for
        old files saved by Session-3.2 GUI builds."""
        out = dict(d)
        old_mat = d.get("material", {})
        mat_id = "mat-default"
        out["materials"] = [{
            "id": mat_id,
            "name": "Linear isotropic (migrated from v1)",
            "model": old_mat.get("model", "linear"),
            "E": old_mat.get("E", 1.0),
            "nu": old_mat.get("nu", 0.3),
        }]
        sec_id = "sec-shell-1"
        out["sections"] = [{
            "id": sec_id,
            "name": "Shell — full cylinder",
            "kind": "shell",
            "material_ref": mat_id,
            "thickness_source": {"kind": "geometry"},
            "offset": "midsurface",
        }]
        out["assignments"] = [{"region": "shell_full", "section_ref": sec_id}]
        out.pop("material", None)
        out["schemaVersion"] = 2
        return out

    # --- io --------------------------------------------------------------

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ModelConfig":
        sv = d.get("schemaVersion", SCHEMA_VERSION)
        if sv == 1:
            sys.stderr.write(
                "[aeris_model] migrating schemaVersion 1 → 2 "
                "(material → materials[] / sections[] / assignments[])\n"
            )
            d = cls._migrate_v1_to_v2(d)
        elif sv != SCHEMA_VERSION:
            sys.stderr.write(
                f"[aeris_model] WARN: schemaVersion={sv} ≠ expected {SCHEMA_VERSION}; "
                "reading anyway\n"
            )
        return cls(
            name=d.get("name", "Cylinder LBA"),
            geometry={**DEFAULT_GEOMETRY, **d.get("geometry", {})},
            materials=list(d.get("materials") or [dict(m) for m in DEFAULT_MATERIALS]),
            sections=list(d.get("sections") or [dict(s) for s in DEFAULT_SECTIONS]),
            assignments=list(d.get("assignments") or [dict(a) for a in DEFAULT_ASSIGNMENTS]),
            mesh={**DEFAULT_MESH, **d.get("mesh", {})},
            bcs={**DEFAULT_BCS, **d.get("bcs", {})},
            load={**DEFAULT_LOAD, **d.get("load", {})},
            analysis={**DEFAULT_ANALYSIS, **d.get("analysis", {})},
            schemaVersion=SCHEMA_VERSION,
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
            "materials": self.materials,
            "sections": self.sections,
            "assignments": self.assignments,
            "mesh": self.mesh,
            "bcs": self.bcs,
            "load": self.load,
            "analysis": self.analysis,
        }

    # --- lookups ---------------------------------------------------------

    def material_by_id(self, mat_id: str) -> Dict[str, Any]:
        for m in self.materials:
            if m.get("id") == mat_id:
                return m
        raise KeyError(f"material id {mat_id!r} not found in materials[]")

    def section_by_id(self, sec_id: str) -> Dict[str, Any]:
        for s in self.sections:
            if s.get("id") == sec_id:
                return s
        raise KeyError(f"section id {sec_id!r} not found in sections[]")

    def section_for_region(self, region: str) -> Dict[str, Any]:
        for a in self.assignments:
            if a.get("region") == region:
                return self.section_by_id(a["section_ref"])
        raise KeyError(f"no assignment for region {region!r}")

    def cylinder(self) -> CylinderGeom:
        if self.geometry.get("shape") != "cylinder":
            raise ValueError(
                f"geometry.shape={self.geometry.get('shape')!r} is not 'cylinder' — "
                "other shapes are not wired this session"
            )
        c = self.geometry["cylinder"]
        return CylinderGeom(R=float(c["R"]), L=float(c["L"]), t=float(c["t"]))

    def case(self) -> Case:
        """Pack geometry + material into the solver-facing 5-tuple.

        Resolves through assignments → section → material, using the
        "shell_full" region as the single shell-cylinder source. Stiffened
        shells later add more regions, but the LBA solver still gets one
        Case at a time (per-patch material later if needed)."""
        cyl = self.cylinder()
        sec = self.section_for_region("shell_full")
        mat = self.material_by_id(sec["material_ref"])
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
    # CLI scalar overrides (handy for quick verification). Material edits
    # apply to materials[0] — the "default" material the GUI's MATERIAL
    # section also targets; sections[0]'s material_ref points at it.
    for k in ("R", "L", "t"):
        v = getattr(args, k)
        if v is not None:
            model.geometry["cylinder"][k] = float(v)
    if args.E is not None:
        model.materials[0]["E"] = float(args.E)
    if args.nu is not None:
        model.materials[0]["nu"] = float(args.nu)

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
