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
                     "shift": "auto" },
      "solver":    { "engine": "gismo" },
      "discretization": {
        "gismo":      { "refinement": 5, "degree": 3, "smoothness": 2,
                        "coupling": "gsSmoothInterfaces" },
        "code_aster": { "element_family": "COQUE_3D", "mesh_size": 2.0,
                        "order": 1 }
      }
    }

`solver.engine` selects the discretisation engine ("gismo" = isogeometric,
the validated path; "code_aster" = classical FEM via GMSH mesh + Code_Aster
.comm). The model.json above is engine-agnostic; each engine reads its own
`discretization.<engine>` block. `discretization.gismo` is kept mirrored to
the legacy top-level `mesh` block so the IGA solver scripts keep reading
`model.mesh` unchanged.

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
    # Default cylinder pinned to a realistic steel-shell case (Session 3.3, on
    # user request): R=33, L=100, t=0.1 mm — R/t = 330 (very thin), L/R ≈ 3.
    # Engineering units assumed: mm for lengths, MPa for stresses → forces
    # naturally come out in N. The whole pipeline is unit-agnostic; the user
    # picks a consistent system and sticks to it (see the input hint in the
    # GUI). Old E=1, R=1, L=1, t=0.01 dimensionless defaults are still
    # mathematically equivalent; the new defaults are just a friendlier
    # starting point for the engineering audience.
    "shape": "cylinder",
    "cylinder": {
        "R": 33.0,
        "L": 100.0,
        "t": 0.1,
        # Session 3.4 — axial partitions for stepped wall thickness.
        # `partitions: [{"z": z1}, {"z": z2}, ...]` (sorted, 0 < zi < L)
        # creates len(partitions)+1 axial bands. Empty list = homogeneous
        # cylinder (the validated Session-3.3 path, single MaterialMatrix
        # in the XML — bit-identical regression preserved).
        # Each band's thickness comes from its assigned section's
        # `thickness_source`: `kind:"geometry"` falls back to cylinder.t,
        # `kind:"constant"` carries `value` directly.
        "partitions": [],
    },
    # Increment 1 of Scordelis-Lo integration — cylindrical-segment "roof"
    # geometry. Single NURBS patch (biquadratic, 3x3 control points), arc
    # in the y-z plane sweeping ±phi_deg from the apex, x ∈ [0, L] as the
    # cylinder axis. Solver dispatch on geometry.shape lands in
    # Increment 3 (until then this is preview-only in the GUI viewport).
    # Defaults match the literature Scordelis-Lo case (Belytschko 1985).
    "cylinder_segment": {
        "R": 25.0,
        "L": 50.0,
        "t": 0.25,
        "phi_deg": 40.0,
    },
    # Hemisphere geometry: spherical shell sector defined by opening_angle_deg.
    # R = radius, t = thickness, opening_angle_deg = polar span (90° = hemisphere,
    # 180° = full sphere). Used for the MacNeal-Harder pinched-hemisphere test.
    # G+Smo dispatch (geometry.shape="sphere") routes to hemisphere_static.py.
    "sphere": {
        "R": 10.0,
        "t": 0.04,
        "opening_angle_deg": 90.0,
    },
}

# materials[] is a library — any section can reference any material by id.
# For now only one default material; the GUI MATERIAL section edits this one.
# `model` discriminates linear / nonlinear families (nonlinear deferred).
DEFAULT_MATERIALS: list[Dict[str, Any]] = [
    {
        "id": "mat-default",
        # S235 / mild steel ballpark: E ≈ 208 GPa, ν ≈ 0.3. Stays inside the
        # large-E-safe regime now that build_cylinder_xml scales the Neumann
        # load by E to dodge the K_NL-K_L catastrophic cancellation.
        "name": "Steel (linear isotropic)",
        "model": "linear",   # → gsMaterialMatrixLinear<3> (Saint-Venant Kirchhoff)
        "E": 208000.0,       # MPa  ≡ N/mm²
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
    # User-facing applied-load magnitude, ABAQUS-LBA convention: F (force) for
    # axial, M (moment) for bending — interpreted in whatever consistent unit
    # system the rest of the model uses (N + mm + MPa, or N + m + Pa, etc.).
    # The eigenvalue is multiplied by this to report critical load (F_cr or
    # M_cr) in the user's units; default 1.0 means λ_1 itself reads as the
    # buckling load. The XML Neumann magnitude is independently E-scaled for
    # numerical conditioning (see build_cylinder_xml) — magnitude here is
    # purely a verdict-side scaling, the eigenvalue is invariant.
    "magnitude": 1.0,
}


def _migrate_load(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Reconcile incoming load dict with the current DEFAULT_LOAD shape.

    Backward-compat: the pre-3.7 field name was `neumann_traction_axial`
    (always set to "auto" in practice). If present, drop it — the new
    `magnitude` field replaces it with a real number defaulting to 1.0.
    Saved files don't need to be re-written; from_dict is idempotent."""
    out = {**DEFAULT_LOAD, **(raw or {})}
    out.pop("neumann_traction_axial", None)
    return out

DEFAULT_ANALYSIS: Dict[str, Any] = {
    "kind": "lba",
    "nmodes": 5,
    # Spectra GEigsMode — one of:
    #   "spectra-buckling"     → mode 3, K_L SPD + K_geom indefinite (our default)
    #   "spectra-shift-invert" → mode 2, generic shift-invert
    #   "spectra-cayley"       → mode 4, Cayley-transform shift-invert
    # The schema string is the canonical name; cylinder_lba.py maps to the
    # Spectra integer via SPECTRA_MODE_MAP. Modes 0/1 (Cholesky / Regular-
    # Inverse) are *not* exposed — they require K_g SPD which is not our case.
    "solver": "spectra-buckling",
    # Spectral shift target. "auto" resolves to classical_sigma_cr / E (the
    # E-scaling makes eigenvalues O(1)). Override with an explicit number
    # when chasing a specific mode cluster — Spectra finds eigenvalues
    # nearest the shift first.
    "shift": "auto",
    # Convergence tolerance for the Arnoldi iteration. 1e-8 is well-conditioned
    # for our problems; 1e-6 trades 10–20 % runtime for a quicker first pass,
    # 1e-10 is paranoia territory.
    "tolerance": 1e-8,
    # Krylov subspace size multiplier (ncv = ncv_factor · nmodes). Spectra
    # recommends ≥ 2 nmodes + 1; 3× is generous, helps convergence on tough
    # cases at modest extra cost.
    "ncv_factor": 3,
    # gsThinShellAssembler interface penalty for weak C0/C1 coupling. The
    # smooth-basis path (gsSmoothInterfaces) uses this only as a fallback;
    # 1e6 is the validated default. Bumping helps when bands or partitions
    # introduce ill-conditioned interfaces.
    "interface_penalty": 1e6,
}


# ---------------------------------------------------------------------------
# Discretisation engine (Session — Code_Aster as a second strategy)
# ---------------------------------------------------------------------------
# The model.json is engine-agnostic: geometry / material / section / load /
# analysis describe *intent*; the engine decides *how* the intent is
# discretised and solved. Two engines:
#   "gismo"      → isogeometric (NURBS patches + Greville h-refinement),
#                  the validated path; reads `discretization.gismo`.
#   "code_aster" → classical FEM (GMSH mesh → .med → Code_Aster .comm),
#                  reads `discretization.code_aster`.
# Dispatch in aeris-gui/vite.config.js reads solver.engine *before* the
# (shape, kind, load) matrix, then picks the backend script for that engine.
DEFAULT_SOLVER: Dict[str, Any] = {
    "engine": "gismo",
}

# Per-engine discretisation parameters. The IGA path keeps refinement /
# degree / smoothness / coupling (these have no meaning in a classical
# mesh); the FEM path uses a target element size, a shell element family,
# and an interpolation order (no NURBS refinement *level* exists in a mesh).
# `discretization.gismo` is kept identical to the legacy top-level `mesh`
# block — mirrored on load (see from_dict) so the two can't drift — until
# the IGA solver scripts are migrated off `model.mesh` onto this.
DEFAULT_DISCRETIZATION: Dict[str, Any] = {
    "gismo": dict(DEFAULT_MESH),
    "code_aster": {
        # Shell formulation (Code_Aster modelisation): "DKT" (thin Kirchhoff,
        # the validated default) or "COQUE_3D" (curved/thick, biquadratic).
        "element_family": "DKT",
        # Abaqus-style independent mesh controls:
        #   element_shape : "triangle" | "quad" — gmsh recombines to quads.
        #   technique     : "free" (Delaunay/Frontal) | "structured" (mapped,
        #                   transfinite — regular rows of elements).
        # Coupling enforced in the mesh layer: COQUE_3D requires "quad" (its
        # QUAD9 needs a centre node) and is quadratic; DKT/DKQ are linear.
        "element_shape": "triangle",
        "technique": "free",
        "mesh_size": 2.0,               # target GMSH characteristic length
        "order": 1,                     # derived from the family (DKT=1, COQUE_3D=2)
    },
}


def _default_discretization() -> Dict[str, Any]:
    """Fresh deep-ish copy of DEFAULT_DISCRETIZATION (nested dicts copied)."""
    return {eng: dict(params) for eng, params in DEFAULT_DISCRETIZATION.items()}


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
    solver: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_SOLVER))
    discretization: Dict[str, Any] = field(default_factory=_default_discretization)
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
        # Discretisation: `discretization.gismo` is the canonical IGA params,
        # but legacy files only carry the top-level `mesh` block. Merge so
        # discretization.gismo (if present) wins over mesh wins over default,
        # then mirror the resolved gismo params back into `mesh` so the IGA
        # solver scripts (which still read model.mesh) stay bit-identical.
        raw_disc = d.get("discretization") or {}
        gismo_disc = {
            **DEFAULT_MESH,
            **(d.get("mesh") or {}),
            **(raw_disc.get("gismo") or {}),
        }
        ca_disc = {
            **DEFAULT_DISCRETIZATION["code_aster"],
            **(raw_disc.get("code_aster") or {}),
        }
        return cls(
            name=d.get("name", "Cylinder LBA"),
            geometry={**DEFAULT_GEOMETRY, **d.get("geometry", {})},
            materials=list(d.get("materials") or [dict(m) for m in DEFAULT_MATERIALS]),
            sections=list(d.get("sections") or [dict(s) for s in DEFAULT_SECTIONS]),
            assignments=list(d.get("assignments") or [dict(a) for a in DEFAULT_ASSIGNMENTS]),
            mesh=dict(gismo_disc),
            bcs={**DEFAULT_BCS, **d.get("bcs", {})},
            load=_migrate_load(d.get("load", {})),
            analysis={**DEFAULT_ANALYSIS, **d.get("analysis", {})},
            solver={**DEFAULT_SOLVER, **(d.get("solver") or {})},
            discretization={"gismo": gismo_disc, "code_aster": ca_disc},
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
            "solver": self.solver,
            "discretization": self.discretization,
        }

    # --- engine / discretisation -----------------------------------------

    def engine(self) -> str:
        """Discretisation engine selector ("gismo" | "code_aster")."""
        return str(self.solver.get("engine", "gismo"))

    def disc(self, engine: str | None = None) -> Dict[str, Any]:
        """Discretisation params for `engine` (defaults to the active one)."""
        eng = engine or self.engine()
        params = self.discretization.get(eng)
        if params is None:
            raise KeyError(
                f"no discretization params for engine {eng!r}; "
                f"have {sorted(self.discretization)}"
            )
        return params

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

    # --- partition / band layout (Session 3.4 stepped wall thickness) -----

    def band_z_ranges(self) -> list[tuple[float, float]]:
        """Returns the [(z_lo, z_hi), …] axial intervals of each band.

        Single band [(0, L)] when no partitions defined; for partitions at
        [z1, z2, …] returns [(0, z1), (z1, z2), …, (z_last, L)] sorted and
        validated (0 < z_i < L, strictly increasing). Bands are ordered
        bottom-to-top in z.
        """
        cyl = self.cylinder()
        raw = self.geometry["cylinder"].get("partitions", []) or []
        zs = sorted({float(p["z"]) for p in raw})
        for z in zs:
            if not (0.0 < z < cyl.L):
                raise ValueError(
                    f"geometry.cylinder.partitions[].z = {z} out of (0, L={cyl.L})"
                )
        edges = [0.0] + zs + [cyl.L]
        return list(zip(edges[:-1], edges[1:]))

    def band_thickness(self, band_index: int) -> float:
        """Thickness of band `band_index` (0-based, bottom-up).

        Resolution order:
          1. Look for an assignment with region == f"band_{i}".
          2. If found, follow section_ref → section → thickness_source:
               kind == "geometry" → fall back to cylinder.t (the SoT)
               kind == "constant" → use the explicit value
          3. If no per-band assignment, fall back to the "shell_full"
             assignment (the homogeneous-cylinder default).
          4. Final fallback: cylinder.t.

        This lets a homogeneous model (no partitions, no per-band
        assignments) keep working with the single "shell_full" assignment,
        AND lets a stepped model carry distinct constant thicknesses
        per band without giving up the geometry-as-SoT principle.
        """
        cyl = self.cylinder()
        candidates = (f"band_{band_index}", "shell_full")
        for region in candidates:
            try:
                sec = self.section_for_region(region)
            except KeyError:
                continue
            src = sec.get("thickness_source", {"kind": "geometry"})
            kind = src.get("kind", "geometry")
            if kind == "geometry":
                return cyl.t
            if kind == "constant":
                v = src.get("value")
                if v is None:
                    return cyl.t
                return float(v)
            sys.stderr.write(
                f"[aeris_model] WARN: unknown thickness_source.kind={kind!r}, "
                f"falling back to geometry.cylinder.t={cyl.t}\n"
            )
            return cyl.t
        return cyl.t

    def case(self) -> Case:
        """Pack geometry + material into the solver-facing 5-tuple.

        Resolves through assignments → section → material. Uses
        "shell_full" if present (homogeneous case), otherwise falls back
        to the first assignment (stepped case where assignments are
        `band_0`, `band_1`, ...).

        Note: for stepped cylinders with band-varying MATERIAL (not just
        thickness), the per-band material is plumbed through
        MaterialMatrixContainer in build_cylinder_xml. case() here is
        used by the legacy single-Case path and by classical-σ reporting,
        which assumes E/ν are uniform — true today since the GUI only
        edits materials[0] and all sections point at it."""
        cyl = self.cylinder()
        sec = None
        for region in ("shell_full",):
            try:
                sec = self.section_for_region(region)
                break
            except KeyError:
                continue
        if sec is None and self.assignments:
            # Fall back to first assignment (stepped case: band_0).
            first = self.assignments[0]
            sec = self.section_by_id(first["section_ref"])
        if sec is None:
            # No assignments at all → just use materials[0] directly.
            if not self.materials:
                raise ValueError("ModelConfig has no materials defined")
            mat = self.materials[0]
        else:
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
        xml = build_cylinder_xml(model)
        args.dump_xml.write_text(xml)
        print(f"wrote XML → {args.dump_xml}  ({len(xml):,} bytes)")

    if args.show or not (args.dump_xml or args.dump_model):
        print(json.dumps(model.to_dict(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
