/** Parse a ParaView .pvd collection into a list of referenced datasets.
 * gsWriteParaview emits a tiny <VTKFile type="Collection"><Collection>
 * <DataSet file="..."/></Collection></VTKFile> structure. */
export function parsePvd(xmlText, baseUrl) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("PVD parse error: " + err.textContent);

  const sets = Array.from(doc.querySelectorAll("Collection > DataSet"));
  return sets.map((node) => {
    const file = node.getAttribute("file");
    return {
      file,
      // Build absolute URL relative to the PVD's location so the .vts files
      // load via /data/... in dev.
      url: new URL(file, baseUrl).toString(),
      timestep: parseFloat(node.getAttribute("timestep") ?? "0"),
      group: node.getAttribute("group") ?? null,
      part: parseInt(node.getAttribute("part") ?? "0", 10),
    };
  });
}
