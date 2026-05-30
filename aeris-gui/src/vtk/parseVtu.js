/** Minimal parser for VTK XML UnstructuredGrid (.vtu) files — the Code_Aster
 * FEM path's analogue of parseVts.js (structured .vts). The Code_Aster wrapper
 * writes these from result.med via meshio (ascii, binary=False) carrying only
 * the triangle shell cells + a 3-component "SolutionField" displacement.
 *
 * We deliberately don't pull in vtk.js (>2 MB). The DOMParser walks the XML;
 * numeric DataArrays are whitespace-separated ascii (meshio binary=False).
 * Cell connectivity is parsed explicitly (no structured-grid assumption) and
 * collapsed to triangles: VTK type 5 (tri) as-is, 9 (quad) split into two,
 * 22 (tri6) reduced to its 3 corner nodes; everything else (vertex 1, line 3)
 * is skipped so only the shell surface renders as faces.
 */

function parseFloatArray(text) {
  const tokens = text.trim().split(/\s+/);
  const out = new Float32Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) out[i] = Number(tokens[i]);
  return out;
}

function parseIntArray(text) {
  const tokens = text.trim().split(/\s+/);
  const out = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) out[i] = parseInt(tokens[i], 10);
  return out;
}

function namedArray(parent, name) {
  const arrays = parent.querySelectorAll("DataArray");
  for (let i = 0; i < arrays.length; i++) {
    if (arrays[i].getAttribute("Name") === name) return arrays[i];
  }
  return null;
}

/** Parse one .vtu XML text into an unstructured patch description:
 *   { positions:Float32Array(N*3), indices:Uint32Array, solutionField|null }
 * Mirrors parseVts's return contract minus nx/ny (no structured topology). */
export function parseVtu(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("VTU parse error: " + err.textContent);

  const piece = doc.querySelector("UnstructuredGrid > Piece");
  if (!piece) throw new Error("VTU missing <Piece>");

  const ptsArr = piece.querySelector("Points > DataArray");
  if (!ptsArr) throw new Error("VTU missing Points/DataArray");
  const positions = parseFloatArray(ptsArr.textContent);
  const nPts = positions.length / 3;

  const cells = piece.querySelector("Cells");
  if (!cells) throw new Error("VTU missing <Cells>");
  const connEl = namedArray(cells, "connectivity");
  const offEl = namedArray(cells, "offsets");
  const typeEl = namedArray(cells, "types");
  if (!connEl || !offEl || !typeEl) {
    throw new Error("VTU Cells missing connectivity/offsets/types");
  }
  const conn = parseIntArray(connEl.textContent);
  const offsets = parseIntArray(offEl.textContent);
  const types = parseIntArray(typeEl.textContent);

  const idx = [];
  let start = 0;
  for (let c = 0; c < types.length; c++) {
    const end = offsets[c];
    const t = types[c];
    if ((t === 5 || t === 22) && end - start >= 3) {
      // triangle / quadratic-triangle (corner nodes only)
      idx.push(conn[start], conn[start + 1], conn[start + 2]);
    } else if (t === 9 && end - start >= 4) {
      // quad → two triangles
      const a = conn[start], b = conn[start + 1];
      const d = conn[start + 2], e = conn[start + 3];
      idx.push(a, b, d, a, d, e);
    }
    start = end;
  }
  const indices = new Uint32Array(idx);

  let solutionField = null;
  const arrays = piece.querySelectorAll("PointData > DataArray");
  arrays.forEach((a) => {
    if (a.getAttribute("Name") === "SolutionField") {
      const nc = parseInt(a.getAttribute("NumberOfComponents") ?? "1", 10);
      const buf = parseFloatArray(a.textContent);
      if (buf.length === nPts * nc) {
        solutionField = { components: nc, data: buf };
      }
    }
  });

  return { positions, indices, solutionField };
}
