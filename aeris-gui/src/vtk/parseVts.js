/** Minimal parser for VTK XML StructuredGrid (.vts) files written by
 * gsWriteParaview. Each file is one patch with:
 *   - WholeExtent="0 NX 0 NY 0 0"  → (NX+1) x (NY+1) point grid in 2D parametric
 *   - Points: (NX+1)*(NY+1) (x,y,z) floats
 *   - PointData/DataArray Name="SolutionField" NumberOfComponents=3: per-point
 *     displacement vector (mode shape) — present on mode_*.vts and linearSolution_*.vts,
 *     ABSENT on bare geometry mp_*.vts
 *
 * We don't pull in vtk.js — it's >2 MB and we only need StructuredGrid.
 * The DOMParser does the XML walk; the numeric DataArrays are 'ascii'-format
 * Float32 in our case (gsWriteParaview defaults), parsed as whitespace-split numbers.
 */

function parseFloatArray(text) {
  // gsWriteParaview emits one big run of whitespace-separated floats.
  // Number(...) is faster than parseFloat here; trim and split on any whitespace.
  const tokens = text.trim().split(/\s+/);
  const out = new Float32Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) out[i] = Number(tokens[i]);
  return out;
}

/** Parse one .vts XML text into a structured patch description. */
export function parseVts(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("VTS parse error: " + err.textContent);

  const piece = doc.querySelector("StructuredGrid > Piece");
  if (!piece) throw new Error("VTS missing <Piece>");

  const ext = piece.getAttribute("Extent").trim().split(/\s+/).map(Number);
  const [i0, i1, j0, j1, k0, k1] = ext;
  const nx = i1 - i0 + 1;
  const ny = j1 - j0 + 1;
  const nz = k1 - k0 + 1;
  if (nz !== 1) {
    // Surface patches always have one layer in the third index for gsWriteParaview.
    throw new Error(`Unexpected VTS Extent (k0..k1): ${k0}..${k1} (must be 1 layer)`);
  }
  const nPts = nx * ny;

  const ptsArr = piece.querySelector("Points > DataArray");
  if (!ptsArr) throw new Error("VTS missing Points/DataArray");
  const positions = parseFloatArray(ptsArr.textContent);
  if (positions.length !== nPts * 3) {
    throw new Error(
      `VTS Points count mismatch: ${positions.length} != ${nPts * 3}`
    );
  }

  // PointData → DataArrays. SolutionField (vector) is the displacement we care about.
  let solutionField = null;
  const arrays = piece.querySelectorAll("PointData > DataArray");
  arrays.forEach((a) => {
    if (a.getAttribute("Name") === "SolutionField") {
      const nc = parseInt(a.getAttribute("NumberOfComponents") ?? "1", 10);
      const buf = parseFloatArray(a.textContent);
      if (buf.length !== nPts * nc) {
        throw new Error(
          `SolutionField size mismatch: ${buf.length} != ${nPts}*${nc}`
        );
      }
      solutionField = { components: nc, data: buf };
    }
  });

  return { nx, ny, positions, solutionField };
}

/** Build the (CCW) triangle index buffer for an (nx × ny) structured grid.
 * Two triangles per cell. Returns Uint32Array for >65k points (mode meshes
 * at r=5 can sit around 5k–10k per patch — Uint16 would do, but stay safe). */
export function buildStructuredIndices(nx, ny) {
  const nCells = (nx - 1) * (ny - 1);
  const idx = new Uint32Array(nCells * 6);
  let p = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // two triangles: (a, b, c) and (b, d, c) — CCW assuming grid handedness.
      idx[p++] = a;
      idx[p++] = b;
      idx[p++] = c;
      idx[p++] = b;
      idx[p++] = d;
      idx[p++] = c;
    }
  }
  return idx;
}
