"""Render cylinder buckling eigenmodes (and the pre-buckling state) to PNGs.

Reads the multi-patch .pvd files dropped by `cylinder_lba.py` into
/aeris-output and writes per-mode PNG images into /aeris-output/renders/.
Three fixed viewpoints per mode/state so they're comparable side-by-side:

  *_oblique.png   3/4 view from above
  *_side.png      profile, cylinder axis horizontal
  *_end.png       looking straight down the cylinder axis (best for
                  counting circumferential waves)

All renders use the SAME warp scale factor so amplitudes stay honest
across modes (eigenmodes have arbitrary amplitude, but cross-mode
*relative* magnitudes are meaningful when normalised the same way).

Headless: requires Xvfb (see docker/Dockerfile.render).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pyvista as pv

# ---------------------------------------------------------------------------
# Headless setup — must come before any plotter is created.
# ---------------------------------------------------------------------------
pv.OFF_SCREEN = True
try:
    pv.start_xvfb(wait=0.5)
except Exception as e:
    sys.stderr.write(f"[render_modes] pv.start_xvfb failed: {e}\n")
    sys.stderr.write("[render_modes] continuing; off-screen may still work\n")


# ---------------------------------------------------------------------------
# Config — cylinder centred at (0,0,L/2) with axis along z, R=L=1, t=0.01
# (matches DEFAULT_CASE in cylinder_lba.py). Everything is hard-coded for
# now since this script is purely a companion to that one cylinder case.
# ---------------------------------------------------------------------------
OUT_ROOT = Path(os.environ.get("AERIS_OUTPUT", "/aeris-output"))
RENDERS = OUT_ROOT / "renders"
RENDERS.mkdir(parents=True, exist_ok=True)

# Cylinder geometric centre + characteristic length for camera placement.
CYL_CENTER = (0.0, 0.0, 0.5)
CYL_R = 1.0
CYL_L = 1.0

# Warp scale. Mode shapes are normalised so |u_z|_max = 1 inside the exe,
# but for cylinder buckling the RADIAL component is 10-50x larger than
# the axial, so |SolutionField| reaches O(10-50). We want the visible
# deformation to be O(5%) of the cylinder radius (=0.05 here). 0.015 sits
# in the middle — clearly bumpy but not exploded. Same scale for every
# mode so cross-mode relative amplitudes stay honest (mod the exe's
# per-mode |u_z|_max=1 normalisation, which we can't escape).
WARP_SCALE = 0.015

# Per-image colour scale (auto-fit each render's own range). Cross-image
# colour comparisons are meaningless anyway because of the exe's
# per-mode normalisation; this just gives in-image contrast.
SCALAR_CLIM = None

# When clamping outliers before warp: how many times the 95th percentile
# is "still bulk"? Anything above gets pulled down to OUTLIER_FACTOR * p95
# so it can't spike out and dominate the render.
OUTLIER_FACTOR = 1.2

# Render size + background.
IMG_W, IMG_H = 1200, 900
BG_COLOR = "white"
EDGE_COLOR = "black"
CMAP = "viridis"

# Three fixed cameras (position, focal_point, up).
CAMERAS: dict[str, tuple[tuple, tuple, tuple]] = {
    "oblique": ((3.0, -3.0, 2.5), CYL_CENTER, (0.0, 0.0, 1.0)),
    "side":    ((0.0, -4.0, 0.5), CYL_CENTER, (0.0, 0.0, 1.0)),
    # End-on: camera above the cylinder top, looking straight down z.
    # `up` lies in the xy-plane so the circular cross-section renders flat.
    "end":     ((0.0, 0.0, 4.0), CYL_CENTER, (0.0, 1.0, 0.0)),
}


# ---------------------------------------------------------------------------
def load_multipatch_pvd(pvd_path: Path) -> pv.UnstructuredGrid:
    """Load a 4-patch G+Smo .pvd as ONE merged UnstructuredGrid.

    `pv.read` on a Collection .pvd returns a MultiBlock; we combine the
    blocks so the warp filter + colour mapping see a single dataset
    (otherwise the legend / scale bar can desync across blocks).
    """
    if not pvd_path.exists():
        raise FileNotFoundError(pvd_path)
    mb = pv.read(str(pvd_path))
    if isinstance(mb, pv.MultiBlock):
        # combine() merges into an UnstructuredGrid keeping point data.
        merged = mb.combine()
        return merged
    return mb


def render_dataset(merged: pv.DataSet, *, title: str, png_stem: str,
                   warp: bool = True, undeformed_outline: pv.DataSet | None = None
                   ) -> list[Path]:
    """Write one PNG per camera angle for the given (possibly warped) dataset."""
    written: list[Path] = []

    robust_clim: tuple[float, float] | None = None
    if warp and "SolutionField" in merged.array_names:
        import numpy as np
        sf = merged.point_data["SolutionField"]
        mag = np.linalg.norm(sf, axis=1)
        p95 = float(np.percentile(mag, 95))
        print(f"    |u| stats: min={mag.min():.3g}, mean={mag.mean():.3g}, "
              f"max={mag.max():.3g}, p95={p95:.3g}")

        # CLAMP per-point displacement to OUTLIER_FACTOR * p95 before warping.
        # A handful of nodes at multipatch corners get O(3-10x) higher
        # displacements than the bulk (weak C0/C1 coupling slop); without
        # clamping they spike out and dominate every render of mode 1.
        # Clamping shrinks those vectors while keeping the bulk untouched,
        # so the global mode shape is honest.
        cap = OUTLIER_FACTOR * p95
        outlier_mask = mag > cap
        if outlier_mask.any():
            scale = np.ones_like(mag)
            scale[outlier_mask] = cap / mag[outlier_mask]
            sf_clamped = sf * scale[:, None]
            merged = merged.copy()
            merged.point_data["SolutionField"] = sf_clamped
            n_out = int(outlier_mask.sum())
            print(f"    clamped {n_out} outlier nodes (|u|>{cap:.3g}) "
                  f"so they don't spike the warp")

        robust_clim = (0.0, max(p95, 1e-12))
        deformed = merged.warp_by_vector(vectors="SolutionField",
                                         factor=WARP_SCALE)
    else:
        deformed = merged

    for cam_name, (pos, focal, up) in CAMERAS.items():
        plotter = pv.Plotter(off_screen=True, window_size=(IMG_W, IMG_H))
        plotter.background_color = BG_COLOR
        if "SolutionField" in deformed.array_names:
            kwargs = dict(
                scalars="SolutionField",
                cmap=CMAP,
                show_edges=True,
                edge_color=EDGE_COLOR,
                line_width=0.5,
                smooth_shading=True,
                scalar_bar_args={"title": "|u| (warp x{:.2g})".format(WARP_SCALE),
                                 "n_labels": 4, "fmt": "%.2e"},
            )
            if SCALAR_CLIM is not None:
                kwargs["clim"] = SCALAR_CLIM
            elif robust_clim is not None:
                kwargs["clim"] = robust_clim
            plotter.add_mesh(deformed, **kwargs)
        else:
            plotter.add_mesh(deformed, color="lightgray",
                             show_edges=True, edge_color=EDGE_COLOR)

        if undeformed_outline is not None:
            plotter.add_mesh(
                undeformed_outline,
                color="black",
                style="wireframe",
                line_width=1.0,
                opacity=0.25,
            )

        plotter.add_text(title, position="upper_edge", font_size=10,
                         color="black")
        plotter.add_text(f"view: {cam_name}", position="lower_left",
                         font_size=8, color="black")
        plotter.camera_position = (pos, focal, up)
        plotter.camera.zoom(1.0)

        out_path = RENDERS / f"{png_stem}_{cam_name}.png"
        plotter.show(screenshot=str(out_path), auto_close=True)
        plotter.close()
        written.append(out_path)
        print(f"  wrote {out_path}")
    return written


def main() -> int:
    print(f"[render_modes] OUT_ROOT={OUT_ROOT}  RENDERS={RENDERS}")
    print(f"[render_modes] WARP_SCALE={WARP_SCALE}  image={IMG_W}x{IMG_H}")

    # Undeformed geometry — used both as its own render and as a faint
    # overlay on the mode renders.
    mp_pvd = OUT_ROOT / "mp.pvd"
    undeformed: pv.DataSet | None = None
    if mp_pvd.exists():
        print(f"[render_modes] loading geometry {mp_pvd}")
        undeformed = load_multipatch_pvd(mp_pvd)
        render_dataset(undeformed, title="Undeformed cylinder mesh (4 patches)",
                       png_stem="geometry", warp=False)
    else:
        print(f"[render_modes] WARN: {mp_pvd} not found; skipping geometry")

    # Pre-buckling linear-elastic state — should look smooth / axisymmetric.
    ls_pvd = OUT_ROOT / "linearSolution.pvd"
    if ls_pvd.exists():
        print(f"[render_modes] loading pre-buckling {ls_pvd}")
        ls = load_multipatch_pvd(ls_pvd)
        render_dataset(ls, title="Pre-buckling linear-elastic state (reference)",
                       png_stem="linear", warp=True,
                       undeformed_outline=undeformed)
    else:
        print(f"[render_modes] WARN: {ls_pvd} not found; skipping linear state")

    # Eigenmodes 0..4 (per-mode .pvd has all 4 patches; the buggy top-level
    # modes.pvd only has patch 0, so we read the per-mode files directly).
    modes_dir = OUT_ROOT / "modes"
    for m in range(5):
        per_mode_pvd = modes_dir / f"modes{m}.pvd"
        if not per_mode_pvd.exists():
            print(f"[render_modes] WARN: {per_mode_pvd} not found; skip mode {m}")
            continue
        print(f"[render_modes] loading mode {m} from {per_mode_pvd}")
        merged = load_multipatch_pvd(per_mode_pvd)
        render_dataset(
            merged,
            title=f"Buckling eigenmode {m+1}  (warp x{WARP_SCALE})",
            png_stem=f"mode{m}",
            warp=True,
            undeformed_outline=undeformed,
        )

    print("[render_modes] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
