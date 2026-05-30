"""Parametric shell meshes for the Code_Aster (classical FEM) engine.

Sister subsystem to the IGA path: where the G+Smo scripts hand a NURBS
patch + refinement level to a C++ driver, the Code_Aster engine needs a
real FEM **mesh**. This module turns the *same* `ModelConfig`
(`aeris_model.ModelConfig`) into a GMSH mesh exported as MED — the format
Code_Aster reads — with named **physical groups** that the .comm step maps
to boundary conditions and loads.

The geometry frame is kept bit-identical to the validated IGA Scordelis-Lo
case in `scordelis_static.py::_geometry_cps`, so a Code_Aster solve can be
cross-validated against the G+Smo result on the *same* physical model:

    arc in the y-z plane, axis along x ∈ [0, L]
      A = ( 0,            0)          arc start  (free edge "free_A")
      B = (-2 R sinφ,     0)          arc end    (free edge "free_B", QoI side)
      C = (-R sinφ,  -R cosφ)         circle centre (radius R, half-angle φ)
    QoI: u_z at the free-edge midpoint (L/2, -2 R sinφ, 0) — on "free_B"

Physical groups emitted (Code_Aster reads them as GROUP_MA; the .comm
derives GROUP_NO via DEFI_GROUP):
    roof        (2D)  shell surface — elements + gravity body force
    diaph_x0    (1D)  curved support arc at x=0   (u_y=u_z=0)
    diaph_xL    (1D)  curved support arc at x=L   (u_y=u_z=0)
    free_A      (1D)  longitudinal free edge, y≈0
    free_B      (1D)  longitudinal free edge, y≈-2 R sinφ  (carries the QoI)
    corner_pin  (0D)  SW corner node (0,0,0) — u_x=0 kills the axial RBM

Mesh density / element type come from `discretization.code_aster`:
    mesh_size       target GMSH characteristic length
    element_family  COQUE_3D → quadratic mesh (TRIA6); DKT/DKTG → linear
    order           geometric order, coerced to the family's requirement

CLI:
    python gmsh_shells.py --out roof.med                 # default segment
    python gmsh_shells.py --model model.json --out m.med
    python gmsh_shells.py --out roof.med --mesh-size 1.0
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Dict

# Make scripts/ importable whether this runs as scripts/meshing/gmsh_shells.py
# (cwd=scripts) or as a package module — aeris_model lives one dir up.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from aeris_model import ModelConfig  # noqa: E402

import gmsh  # noqa: E402  (heavy import; only the FEM engine pulls this module)


# Mesh order each Code_Aster shell family requires. The DKT/DKTG/DST/Q4G
# discrete-Kirchhoff family is linear (TRIA3/QUAD4) — DKT is the validated
# default. COQUE_3D is quadratic BUT needs a *central node* (TRIA7/QUAD9):
# gmsh setOrder(2) yields TRIA6, which Code_Aster's AFFE_MODELE rejects
# ("aucune maille affectée"). Supporting COQUE_3D therefore means quad
# recombination + complete 2nd order (Mesh.SecondOrderIncomplete=0) → QUAD9;
# deferred. The "2" below is the geometric order only and is not yet enough
# on its own to make a COQUE_3D-loadable mesh.
_FAMILY_MESH_ORDER: Dict[str, int] = {
    "COQUE_3D": 2,
    "DKT": 1, "DKTG": 1, "DST": 1, "Q4G": 1, "COQUE_AXIS": 1,
}


def _resolve_order(family: str, requested: int) -> int:
    """Geometric mesh order for `family`, coercing an incompatible request.

    A linear mesh under COQUE_3D (or a quadratic one under DKT) silently
    produces a mesh Code_Aster rejects at AFFE_MODELE — so we coerce to the
    family's requirement and warn rather than ship an unloadable .med."""
    need = _FAMILY_MESH_ORDER.get(family.upper())
    if need is None:
        return max(1, requested)
    if requested != need:
        sys.stderr.write(
            f"[gmsh_shells] element_family={family!r} needs mesh order {need}; "
            f"coercing requested order {requested} → {need}\n"
        )
    return need


def _segment_frame(R: float, phi_deg: float):
    """(A, B, C, phi) in the y-z plane — see module docstring. A/B are arc
    endpoints (z=0), C the circle centre, all matching _geometry_cps."""
    phi = math.radians(phi_deg)
    sphi, cphi = math.sin(phi), math.cos(phi)
    A = (0.0, 0.0)                 # arc start  → free_A side
    B = (-2.0 * R * sphi, 0.0)     # arc end    → free_B side (QoI)
    C = (-R * sphi, -R * cphi)     # circle centre, radius R
    return A, B, C, phi


def _write_mesh(out_path: Path) -> str:
    """Write the current GMSH model to `out_path`. For MED we try GMSH's
    native writer first (best Code_Aster fidelity) and fall back to a
    meshio round-trip via .msh if this GMSH build lacks MED support.
    Returns which writer produced the file ("gmsh" | "meshio")."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.suffix.lower() != ".med":
        gmsh.write(str(out_path))
        return "gmsh"
    try:
        gmsh.write(str(out_path))
        if out_path.exists() and out_path.stat().st_size > 0:
            return "gmsh"
        raise RuntimeError("gmsh wrote an empty .med")
    except Exception as exc:  # pragma: no cover - depends on GMSH build
        sys.stderr.write(
            f"[gmsh_shells] native MED write failed ({exc}); falling back to "
            f"meshio via .msh — WARNING: physical-group (FAS) fidelity is "
            f"best-effort on this path, verify groups survive before relying "
            f"on the .comm BCs\n"
        )
        import meshio  # lazy — only needed on the fallback path
        msh = out_path.with_suffix(".msh")
        gmsh.write(str(msh))
        meshio.write(out_path, meshio.read(msh))
        return "meshio"


def build_cylinder_segment(model: ModelConfig, out_path: Path) -> Dict[str, Any]:
    """Mesh the Scordelis-Lo roof (cylinder_segment) into a Code_Aster MED
    file. Returns a manifest dict (counts, physical groups, QoI target)."""
    seg = model.geometry["cylinder_segment"]
    R, L, phi_deg = float(seg["R"]), float(seg["L"]), float(seg["phi_deg"])
    disc = model.disc("code_aster")
    h = float(disc.get("mesh_size", 2.0))
    family = str(disc.get("element_family", "COQUE_3D"))
    order = _resolve_order(family, int(disc.get("order", 2)))

    A, B, C, phi = _segment_frame(R, phi_deg)
    qoi_target = [L / 2.0, -2.0 * R * math.sin(phi), 0.0]

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("cylinder_segment")
        g = gmsh.model.geo

        # Arc at x=0: A → B about centre C, bulging +z. |A-C|=|B-C|=R, span 2φ.
        pA = g.addPoint(0.0, A[0], A[1], h)
        pB = g.addPoint(0.0, B[0], B[1], h)
        pC = g.addPoint(0.0, C[0], C[1], h)
        arc0 = g.addCircleArc(pA, pC, pB)

        # Extrude the arc along +x to sweep the roof surface.
        ext = g.extrude([(1, arc0)], L, 0.0, 0.0)
        surf = next(tag for (dim, tag) in ext if dim == 2)
        arcL = next(tag for (dim, tag) in ext if dim == 1)
        g.synchronize()

        # The two non-arc boundary curves are the longitudinal free edges.
        bnd = [t for (d, t) in gmsh.model.getBoundary([(2, surf)], oriented=False)]
        free = [t for t in bnd if t not in (arc0, arcL)]

        def _ymid(tag: int) -> float:
            bb = gmsh.model.getBoundingBox(1, tag)  # (xmin,ymin,zmin,xmax,ymax,zmax)
            return 0.5 * (bb[1] + bb[4])

        free_sorted = sorted(free, key=_ymid)       # most negative y first
        free_B, free_A = free_sorted[0], free_sorted[-1]

        groups = {
            ("roof", 2): [surf],
            ("diaph_x0", 1): [arc0],
            ("diaph_xL", 1): [arcL],
            ("free_A", 1): [free_A],
            ("free_B", 1): [free_B],
            ("corner_pin", 0): [pA],   # (0,0,0) SW corner — IGA corner (u=0,v=0)
        }
        for (name, dim), tags in groups.items():
            gid = gmsh.model.addPhysicalGroup(dim, tags)
            gmsh.model.setPhysicalName(dim, gid, name)

        gmsh.model.mesh.generate(2)
        if order >= 2:
            gmsh.model.mesh.setOrder(2)

        node_tags, _, _ = gmsh.model.mesh.getNodes()
        _etypes, etags, _ = gmsh.model.mesh.getElements(2)
        manifest = {
            "shape": "cylinder_segment",
            "path": str(out_path),
            "element_family": family,
            "mesh_order": order,
            "mesh_size": h,
            "n_nodes": len(node_tags),
            "n_elements": int(sum(len(t) for t in etags)),
            "physical_groups": {name: dim for (name, dim) in groups},
            "qoi": {
                "name": "uz_free_edge_midpoint",
                "label": "u_z at free-edge midpoint",
                "group": "free_B",
                "component": "uz",
                "target": qoi_target,
            },
            "case": {"R": R, "L": L, "t": float(seg["t"]), "phi_deg": phi_deg},
        }
        manifest["writer"] = _write_mesh(out_path)
        return manifest
    finally:
        gmsh.finalize()


def build_cylinder(model: ModelConfig, out_path: Path) -> Dict[str, Any]:
    """Mesh the closed cylinder (axis along z, z ∈ [0, L], radius R) into a
    Code_Aster MED file. Groups: shell (lateral surface), bottom/top (the two
    rim circles, for the support + axial end load). QoI: u_z at a top-rim node
    — the axial end displacement, compared against the membrane solution
    u_z = -F·L/(2πRtE) in the degenerate ν=0 sanity check."""
    cyl = model.geometry["cylinder"]
    R, L, t = float(cyl["R"]), float(cyl["L"]), float(cyl["t"])
    disc = model.disc("code_aster")
    h = float(disc.get("mesh_size", 2.0))
    family = str(disc.get("element_family", "DKT"))
    order = _resolve_order(family, int(disc.get("order", 1)))
    qoi_target = [R, 0.0, L]   # extrusion of the circle's seam point (R,0,0)

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("Mesh.MeshSizeMax", h)
        gmsh.option.setNumber("Mesh.MeshSizeMin", h)
        gmsh.model.add("cylinder")
        occ = gmsh.model.occ

        # Full-circle rim at z=0; extrude along +z to sweep the lateral shell.
        bottom = occ.addCircle(0.0, 0.0, 0.0, R)
        ext = occ.extrude([(1, bottom)], 0.0, 0.0, L)
        occ.synchronize()
        surf = next(tag for (dim, tag) in ext if dim == 2)
        top = next(tag for (dim, tag) in ext if dim == 1)

        groups = {
            ("shell", 2): [surf],
            ("bottom", 1): [bottom],
            ("top", 1): [top],
        }
        gids = {}
        for (name, dim), tags in groups.items():
            gid = gmsh.model.addPhysicalGroup(dim, tags)
            gmsh.model.setPhysicalName(dim, gid, name)
            gids[name] = (dim, gid)

        gmsh.model.mesh.generate(2)
        if order >= 2:
            gmsh.model.mesh.setOrder(2)

        node_tags, _, _ = gmsh.model.mesh.getNodes()
        _et, etags, _ = gmsh.model.mesh.getElements(2)
        # Top-rim node count: the axial end load is applied as equal nodal
        # forces (FORCE_NODALE) summing to the total F, so the .comm needs N.
        top_nodes, _ = gmsh.model.mesh.getNodesForPhysicalGroup(*gids["top"])
        manifest = {
            "shape": "cylinder",
            "path": str(out_path),
            "element_family": family,
            "mesh_order": order,
            "mesh_size": h,
            "n_nodes": len(node_tags),
            "n_elements": int(sum(len(t) for t in etags)),
            "top_node_count": int(len(top_nodes)),
            "physical_groups": {name: dim for (name, dim) in groups},
            "qoi": {
                "name": "uz_top_rim",
                "label": "u_z at top rim (axial)",
                "group": "top",
                "component": "uz",
                "target": qoi_target,
            },
            "case": {"R": R, "L": L, "t": t},
        }
        manifest["writer"] = _write_mesh(out_path)
        return manifest
    finally:
        gmsh.finalize()


def build_shell_mesh(model: ModelConfig, out_path: Path) -> Dict[str, Any]:
    """Dispatch on geometry.shape. Step 2 wired cylinder_segment; Step 6 adds
    the closed cylinder. Sphere (pinched-hemisphere point loads) is deferred."""
    shape = model.geometry.get("shape")
    if shape == "cylinder_segment":
        return build_cylinder_segment(model, out_path)
    if shape == "cylinder":
        return build_cylinder(model, out_path)
    raise NotImplementedError(
        f"gmsh_shells: geometry.shape={shape!r} not wired yet "
        "(sphere/hemisphere is the remaining Step 6 follow-up)"
    )


def main(argv: list[str] | None = None) -> int:
    import argparse
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", type=Path, default=None,
                   help="model.json to mesh (default: built-in cylinder_segment)")
    p.add_argument("--out", type=Path, default=Path("mesh.med"),
                   help="output mesh path (.med for Code_Aster)")
    p.add_argument("--mesh-size", type=float, default=None,
                   help="override discretization.code_aster.mesh_size")
    args = p.parse_args(argv)

    if args.model:
        model = ModelConfig.from_json_file(args.model)
    else:
        model = ModelConfig()
        # Default ModelConfig is a closed cylinder; retarget to the segment
        # so the no-model self-test produces the Scordelis-Lo roof.
        model.geometry = {**model.geometry, "shape": "cylinder_segment"}
    if args.mesh_size is not None:
        model.discretization["code_aster"]["mesh_size"] = float(args.mesh_size)

    manifest = build_shell_mesh(model, args.out)
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
