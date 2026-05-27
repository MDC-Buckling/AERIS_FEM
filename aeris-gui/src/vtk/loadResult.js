import { parsePvd } from "./parsePvd.js";
import { parseVts, buildStructuredIndices } from "./parseVts.js";

/** Resolve and fetch the per-patch .vts files referenced by a result .pvd.
 * Returns a tidy structure ready for three.js BufferGeometry consumption:
 *   {
 *     patches: [
 *       { positions: Float32Array, displacement: Float32Array|null,
 *         magnitude: Float32Array|null, indices: Uint32Array, nx, ny }
 *       , ...
 *     ],
 *     magMin, magMax,        // overall magnitude range across patches
 *     hasDisplacement: bool,
 *   }
 *
 * Filters out `_mesh.vtp` files (G+Smo writes them for mp.pvd geometry plots
 * — they're wireframe-only PolyData and don't have SolutionField).
 */
export async function loadResult(pvdRelPath, dataBase = "/data") {
  const pvdUrl = `${dataBase}/${pvdRelPath}`.replace(/\/{2,}/g, "/");
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
      if (solutionField) {
        const nc = solutionField.components;
        // Always emit a 3-component displacement attribute so the vertex
        // shader has a uniform expectation; pad with zeros if needed.
        if (nc === 3) {
          displacement = solutionField.data;
        } else {
          displacement = new Float32Array(positions.length);
          for (let i = 0, n = positions.length / 3; i < n; i++) {
            for (let c = 0; c < Math.min(nc, 3); c++) {
              displacement[i * 3 + c] = solutionField.data[i * nc + c];
            }
          }
        }
        magnitude = new Float32Array(positions.length / 3);
        for (let i = 0; i < magnitude.length; i++) {
          const x = displacement[i * 3];
          const y = displacement[i * 3 + 1];
          const z = displacement[i * 3 + 2];
          magnitude[i] = Math.sqrt(x * x + y * y + z * z);
        }
      }

      return { positions, displacement, magnitude, indices, nx, ny };
    })
  );

  let magMin = Infinity;
  let magMax = -Infinity;
  let hasDisplacement = false;
  for (const p of patches) {
    if (p.magnitude) {
      hasDisplacement = true;
      for (let i = 0; i < p.magnitude.length; i++) {
        const v = p.magnitude[i];
        if (v < magMin) magMin = v;
        if (v > magMax) magMax = v;
      }
    }
  }
  if (!hasDisplacement) {
    magMin = 0;
    magMax = 1;
  }

  return { patches, magMin, magMax, hasDisplacement };
}
