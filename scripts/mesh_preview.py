"""Aeris FE mesh preview — mesh-only, no solve.

The Abaqus-style "Mesh Part" step for the Code_Aster engine: run gmsh_shells
on the model and emit (a) meshpreview.vtu/.pvd of the actual FE mesh so the
GUI can render the elements in the viewport, and (b) meshpreview.json with the
node/element counts + element type, so the user sees what they'll get BEFORE
committing to a solve. No Code_Aster run, just GMSH.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aeris_model import ModelConfig                       # noqa: E402
from meshing.gmsh_shells import build_shell_mesh          # noqa: E402
from code_aster_static import _patch_meshio_med           # noqa: E402  (QU9 reader patch)


def main(argv: list[str] | None = None) -> int:
    import argparse
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", type=Path, required=True)
    args = p.parse_args(argv)

    model = ModelConfig.from_json_file(args.model)
    if model.engine() != "code_aster":
        raise SystemExit(
            "mesh_preview: only the code_aster engine has an FE mesh "
            f"(engine={model.engine()!r})"
        )

    work_dir = args.model.parent
    mesh_path = work_dir / "mesh.med"
    manifest = build_shell_mesh(model, mesh_path)

    # MED → meshpreview.vtu: every surface cell collapsed to corner triangles
    # (TRIA3/6, QUAD4/8/9), zero displacement field — the viewport renders the
    # undeformed mesh and its element edges. Reuses the QU9 meshio patch.
    import meshio
    import numpy as np
    _patch_meshio_med()
    m = meshio.read(str(mesh_path))
    tri_blocks = []
    for ct, data in m.cells_dict.items():
        d = np.asarray(data)
        if ct.startswith("triangle"):
            tri_blocks.append(d[:, :3])
        elif ct.startswith("quad"):
            tri_blocks.append(d[:, [0, 1, 2]])
            tri_blocks.append(d[:, [0, 2, 3]])
    pts = np.asarray(m.points)
    if tri_blocks:
        out = meshio.Mesh(
            points=pts,
            cells=[("triangle", np.vstack(tri_blocks))],
            point_data={"SolutionField": np.zeros((len(pts), 3))},
        )
        meshio.write(str(work_dir / "meshpreview.vtu"), out, binary=False)
        (work_dir / "meshpreview.pvd").write_text(
            '<?xml version="1.0"?>\n'
            '<VTKFile type="Collection" version="0.1" byte_order="LittleEndian">\n'
            '  <Collection>\n'
            '    <DataSet timestep="0" group="" part="0" file="meshpreview.vtu"/>\n'
            '  </Collection>\n'
            '</VTKFile>\n'
        )
        preview = "meshpreview.pvd"

        # Unique element edges of the NATIVE cells (3 per triangle, 4 per quad
        # on the corner nodes) → flat xyz pairs the viewport draws as
        # LineSegments. This shows the TRUE element shapes (triangles for DKT,
        # quads for COQUE_3D), unlike the density-only parametric grid.
        edge_set = set()
        for ct, data in m.cells_dict.items():
            d = np.asarray(data)
            if ct.startswith("triangle"):
                corners = d[:, :3]
                loops = [(0, 1), (1, 2), (2, 0)]
            elif ct.startswith("quad"):
                corners = d[:, :4]
                loops = [(0, 1), (1, 2), (2, 3), (3, 0)]
            else:
                continue
            for cell in corners:
                for a, b in loops:
                    i, j = int(cell[a]), int(cell[b])
                    edge_set.add((i, j) if i < j else (j, i))
        edge_pos = []
        for (a, b) in edge_set:
            edge_pos.extend([float(pts[a][0]), float(pts[a][1]), float(pts[a][2]),
                             float(pts[b][0]), float(pts[b][1]), float(pts[b][2])])
        (work_dir / "meshpreview_edges.json").write_text(
            json.dumps({"n_edges": len(edge_set), "edgePositions": edge_pos})
        )
    else:
        preview = None

    info = {
        "ok": True,
        "shape": manifest.get("shape"),
        "element_family": manifest.get("element_family"),
        "mesh_order": manifest.get("mesh_order"),
        "mesh_size": manifest.get("mesh_size"),
        "n_nodes": manifest.get("n_nodes"),
        "n_elements": manifest.get("n_elements"),
        "preview": preview,
        "edges": "meshpreview_edges.json" if preview else None,
    }
    (work_dir / "meshpreview.json").write_text(json.dumps(info, indent=2))
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
