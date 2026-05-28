import { parsePvd } from "./parsePvd.js";
import { parseVts, buildStructuredIndices } from "./parseVts.js";

/** Resolve and fetch the per-patch .vts files referenced by a result .pvd.
 * Returns a tidy structure ready for three.js BufferGeometry consumption:
 *   {
 *     patches: [
 *       { positions, displacement|null, magnitude|null, scalar|null,
 *         indices, nx, ny }, ...
 *     ],
 *     magMin, magMax,        // overall magnitude range across patches
 *     hasDisplacement: bool, // true when the loaded field is a 3-vector
 *                            //   (warp + |u| coloring)
 *     hasScalar: bool,       // true when the loaded field is 1-component
 *                            //   (e.g. von Mises stress, no warp,
 *                            //   color directly by scalar value)
 *   }
 *
 * Filters out `_mesh.vtp` files (G+Smo writes them for mp.pvd geometry plots
 * — they're wireframe-only PolyData and don't have SolutionField).
 *
 * Dispatches on SolutionField.components — unless `projection` overrides
 * the default behaviour:
 *   - projection="max-abs" + nc=3: principal-field projection. Treats the
 *     3 components as principal eigenvalues (σ_1, σ_2, σ_3) sorted by
 *     the C++ driver and stores scalar = max(|v_i|) per vertex. Used for
 *     the Principal* stress/strain entries from static_shell_XML.
 *   - default + nc=3: displacement (existing path)
 *   - default + nc=1: scalar field (stress/strain — color directly, no warp)
 *   - default + other: treated as displacement with zero-padding (legacy,
 *     keeps tensor-output debug viewable as best-effort)
 */
export async function loadResult(pvdRelPath, dataBase = "/data", opts = {}) {
  const projection = opts.projection ?? null;
  // Strip any leading "/" so the join below doesn't double up.
  const cleanRel = String(pvdRelPath).replace(/^\/+/, "");
  const pvdUrl = `${dataBase}/${cleanRel}`.replace(/\/{2,}/g, "/");
  const pvdText = await (await fetch(pvdUrl)).text();
  // Build a proper base URL so relative refs in the .pvd resolve correctly.
  const base = new URL(pvdUrl, window.location.origin);
  const datasets = parsePvd(pvdText, base).filter(
    (d) => !d.file.toLowerCase().endsWith(".vtp")
  );

  const patches = await Promise.all(
    datasets.map(async (ds) => {
      const res = await fetch(ds.url);
      if (!res.ok) throw new Error(`fetch ${ds.url} failed: ${res.status}`);
      const xml = await res.text();
      const { nx, ny, positions, solutionField } = parseVts(xml);
      const indices = buildStructuredIndices(nx, ny);

      let displacement = null;
      let magnitude = null;
      let scalar = null;
      if (solutionField) {
        const nc = solutionField.components;
        if (projection === "max-abs" && nc === 3) {
          // Principal-field projection — collapse (σ_1, σ_2, σ_3) per vertex
          // to max(|σ_i|), the magnitude of the dominant principal value.
          // Sign is dropped (highest signed principal is also a common
          // choice; we picked abs so peak compression and peak tension
          // both surface as bright on a sequential colormap).
          const npts = positions.length / 3;
          scalar = new Float32Array(npts);
          for (let i = 0; i < npts; i++) {
            const a = Math.abs(solutionField.data[i * 3 + 0]);
            const b = Math.abs(solutionField.data[i * 3 + 1]);
            const c = Math.abs(solutionField.data[i * 3 + 2]);
            scalar[i] = Math.max(a, b, c);
          }
        } else if (nc === 1) {
          // Scalar field (von Mises stress, principal-stress eigenvalue, etc).
          // No displacement to warp by — the shape stays in its undeformed
          // configuration and we colour directly by the scalar value.
          scalar = solutionField.data;
        } else if (nc === 3) {
          displacement = solutionField.data;
        } else {
          // Tensor or higher-dim field — best-effort: take the first 3
          // components as a pseudo-displacement so the user at least sees
          // _something_ on screen. Stress tensor field rendering proper
          // (e.g. project σ_xx / σ_xy / σ_yy / projected to principal) is
          // a follow-up.
          displacement = new Float32Array(positions.length);
          for (let i = 0, n = positions.length / 3; i < n; i++) {
            for (let c = 0; c < Math.min(nc, 3); c++) {
              displacement[i * 3 + c] = solutionField.data[i * nc + c];
            }
          }
        }
        if (displacement) {
          magnitude = new Float32Array(positions.length / 3);
          for (let i = 0; i < magnitude.length; i++) {
            const x = displacement[i * 3];
            const y = displacement[i * 3 + 1];
            const z = displacement[i * 3 + 2];
            magnitude[i] = Math.sqrt(x * x + y * y + z * z);
          }
        }
      }

      return { positions, displacement, magnitude, scalar, indices, nx, ny };
    })
  );

  let magMin = Infinity;
  let magMax = -Infinity;
  let hasDisplacement = false;
  let hasScalar = false;
  for (const p of patches) {
    if (p.magnitude) {
      hasDisplacement = true;
      for (let i = 0; i < p.magnitude.length; i++) {
        const v = p.magnitude[i];
        if (v < magMin) magMin = v;
        if (v > magMax) magMax = v;
      }
    }
    if (p.scalar) {
      hasScalar = true;
      for (let i = 0; i < p.scalar.length; i++) {
        const a = Math.abs(p.scalar[i]);
        if (a > magMax) magMax = a;
        if (a < magMin) magMin = a;
      }
    }
  }
  if (!hasDisplacement && !hasScalar) {
    magMin = 0;
    magMax = 1;
  }

  return { patches, magMin, magMax, hasDisplacement, hasScalar };
}
