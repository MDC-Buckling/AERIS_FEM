"""Minimal VTK StructuredGrid (.vts) parser for benchmark QoI extraction.

`gsWriteParaview` from G+Smo writes the solver result as one
StructuredGrid per patch. Each grid is sampled uniformly in parametric
space at ~npts^(1/d) points per direction, with the Points block holding
the DEFORMED physical coordinates and the SolutionField holding the
displacement vector at each sample.

For benchmark QoI extraction we usually want one of two things:
  - displacement at a known parametric point (e.g. midpoint of a free
    edge) -> use `point_at_param` which indexes into the structured
    grid directly.
  - displacement at the sample point closest to a given physical
    coordinate -> use `closest_point` which scans linearly (n=npts).

Both return a (position, displacement) tuple where position is the
DEFORMED location and displacement is the vector field value at that
sample point.
"""
from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path


@dataclass
class VtsGrid:
    """One StructuredGrid worth of geometry + a single scalar/vector field."""
    nx: int                    # samples in parametric u direction
    ny: int                    # samples in parametric v direction
    nz: int                    # samples in third direction (1 for shells)
    points: list[tuple[float, float, float]]      # nx*ny*nz deformed positions
    field: list[tuple[float, ...]]                # nx*ny*nz field values
    field_components: int                         # 1 (scalar) or 3 (vector)
    field_name: str

    def flat_index(self, i: int, j: int, k: int = 0) -> int:
        """Convert (i, j, k) structured indices to flat array index.

        VTK StructuredGrid convention: i varies fastest, then j, then k.
        For 2D shells we always have nz==1, k==0."""
        if not (0 <= i < self.nx and 0 <= j < self.ny and 0 <= k < self.nz):
            raise IndexError(f"({i},{j},{k}) out of grid ({self.nx},{self.ny},{self.nz})")
        return k * (self.nx * self.ny) + j * self.nx + i

    def point_at_param(self, u: float, v: float) -> tuple[
        tuple[float, float, float], tuple[float, ...]
    ]:
        """Return the (position, field-value) at the structured-grid sample
        CLOSEST to parametric (u, v) in [0, 1] x [0, 1].

        The sampling is uniform in parametric space, so the closest sample
        is at i = round(u * (nx-1)), j = round(v * (ny-1)). For Scordelis-Lo
        with nx, ny ≈ 32 this gives parametric error ≤ 1/62 ≈ 0.016 — small
        enough that the displacement error at the QoI location stays well
        below the benchmark's 1 % tolerance band."""
        i = max(0, min(self.nx - 1, round(u * (self.nx - 1))))
        j = max(0, min(self.ny - 1, round(v * (self.ny - 1))))
        idx = self.flat_index(i, j, 0)
        return self.points[idx], self.field[idx]

    def closest_point(self, target: tuple[float, float, float]) -> tuple[
        tuple[float, float, float], tuple[float, ...], float
    ]:
        """Linear scan for the sample point closest to a physical target.
        Returns (position, field-value, distance). Use when you want a
        physical location rather than a parametric one; for parametric
        targets `point_at_param` is exact-grid and avoids the linear scan."""
        best_idx = 0
        best_d2 = float("inf")
        tx, ty, tz = target
        for k, (px, py, pz) in enumerate(self.points):
            d2 = (px - tx) ** 2 + (py - ty) ** 2 + (pz - tz) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_idx = k
        return self.points[best_idx], self.field[best_idx], math.sqrt(best_d2)


def parse_vts(path: Path | str) -> VtsGrid:
    """Parse a .vts file into a VtsGrid. Picks up the FIRST <DataArray>
    inside <PointData> as the field — gsWriteParaview writes exactly one
    field per call so this is unambiguous."""
    tree = ET.parse(path)
    root = tree.getroot()

    # WholeExtent on <StructuredGrid> gives (i0 i1 j0 j1 k0 k1) inclusive.
    sg = root.find(".//StructuredGrid")
    if sg is None:
        raise ValueError(f"no <StructuredGrid> in {path}")
    extent = [int(x) for x in sg.attrib["WholeExtent"].split()]
    nx = extent[1] - extent[0] + 1
    ny = extent[3] - extent[2] + 1
    nz = extent[5] - extent[4] + 1

    piece = sg.find("Piece")
    if piece is None:
        raise ValueError(f"no <Piece> in {path}")

    # Points: a single DataArray with NumberOfComponents="3"
    pts_da = piece.find("./Points/DataArray")
    if pts_da is None:
        raise ValueError(f"no Points/DataArray in {path}")
    pts_raw = [float(x) for x in pts_da.text.split()]
    n_pts = nx * ny * nz
    if len(pts_raw) != n_pts * 3:
        raise ValueError(
            f"point count mismatch in {path}: extent says {n_pts}, "
            f"got {len(pts_raw) // 3}"
        )
    points = [
        (pts_raw[3 * k], pts_raw[3 * k + 1], pts_raw[3 * k + 2])
        for k in range(n_pts)
    ]

    # Field: first DataArray inside PointData. Skip Normals if it's first.
    pd = piece.find("PointData")
    field = []
    field_components = 0
    field_name = ""
    if pd is not None:
        for da in pd.findall("DataArray"):
            name = da.attrib.get("Name", "")
            if name.lower() == "normals":
                continue
            field_components = int(da.attrib.get("NumberOfComponents", "1"))
            field_name = name
            raw = [float(x) for x in da.text.split()]
            if len(raw) != n_pts * field_components:
                raise ValueError(
                    f"field {name!r} length mismatch in {path}: "
                    f"expected {n_pts * field_components}, got {len(raw)}"
                )
            field = [
                tuple(raw[field_components * k + c]
                      for c in range(field_components))
                for k in range(n_pts)
            ]
            break

    return VtsGrid(
        nx=nx, ny=ny, nz=nz,
        points=points,
        field=field,
        field_components=field_components,
        field_name=field_name,
    )
