import React from "react";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Functional inspector for SHELL CONSTRUCTION > Section Assignments.
 *
 * Shows one row per assignment. Today that's either:
 *   - 1 row, region "shell_full" → the only section (homogeneous cylinder)
 *   - N rows, region "band_0".."band_{N-1}" → per-band sections, one per
 *     axial band created by the partitions in GEOMETRY → Dimensions.
 *
 * Per-row thickness is editable. Typing a number switches the section's
 * thickness_source to {kind:"constant", value:v}; clicking the ↻ button
 * reverts to {kind:"geometry"} so the section follows the canonical
 * geometry.cylinder.t again.
 *
 * Schema contract — see scripts/aeris_model.py + the model-schema memory.
 * Materials live in materials[]; sections bind region+material+thickness;
 * assignments[] bind region→section_ref. The solver resolves the chain
 * through ModelConfig.band_thickness — never read materials[0] directly.
 */
export default function SectionAssignments() {
  const model = useUI((s) => s.model);
  const setSectionThickness = useUI((s) => s.setSectionThickness);
  const resetSectionThickness = useUI((s) => s.resetSectionThickness);

  const cyl = model.geometry.cylinder;
  const partitions = cyl.partitions ?? [];
  const stepped = partitions.length > 0;

  // Compute the z-range covered by each assignment. For the homogeneous
  // "shell_full" row this is just [0, L]; for "band_i" rows we slice the
  // partition list at the right indices. Mirrors aeris_model.band_z_ranges.
  const edges = stepped
    ? [0, ...partitions.map((p) => Number(p.z)).slice().sort((a, b) => a - b), cyl.L]
    : null;

  const rows = model.assignments.map((a, idx) => {
    const sec = model.sections.find((s) => s.id === a.section_ref) ?? null;
    const mat = sec
      ? model.materials.find((m) => m.id === sec.material_ref) ?? null
      : null;

    let zRange = null;
    if (stepped && typeof a.region === "string" && a.region.startsWith("band_")) {
      const bandIdx = Number(a.region.slice(5));
      if (Number.isFinite(bandIdx) && edges && bandIdx + 1 < edges.length) {
        zRange = [edges[bandIdx], edges[bandIdx + 1]];
      }
    } else if (!stepped) {
      zRange = [0, cyl.L];
    }

    // Resolve the section's effective thickness, mirroring band_thickness().
    const ts = sec?.thickness_source ?? { kind: "geometry" };
    const effectiveT =
      ts.kind === "constant" && Number.isFinite(Number(ts.value))
        ? Number(ts.value)
        : cyl.t;
    const fromGeometry = ts.kind !== "constant";

    return { idx, assignment: a, section: sec, material: mat, zRange, effectiveT, fromGeometry };
  });

  return (
    <>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontFamily: MONO,
          fontSize: 11,
          background: "var(--panel-bg-soft)",
          border: "1px solid var(--line-soft)",
          borderRadius: 5,
          overflow: "hidden",
        }}
      >
        <thead>
          <tr style={{ background: "rgba(0,200,255,0.05)" }}>
            <Th>Region</Th>
            <Th>z range</Th>
            <Th>Material</Th>
            <Th align="right">Thickness</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map(
            ({ idx, assignment: a, section: s, material: m, zRange, effectiveT, fromGeometry }) => (
              <tr key={a.region ?? idx} style={{ borderTop: "1px solid var(--line-faint)" }}>
                <Td accent>{a.region}</Td>
                <Td>
                  {zRange ? (
                    <span style={{ color: "var(--text-secondary)" }}>
                      [{fmtZ(zRange[0])}, {fmtZ(zRange[1])}]
                    </span>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>—</span>
                  )}
                </Td>
                <Td>
                  {m ? (
                    <>
                      <span style={{ color: "var(--text-primary)" }}>{m.name}</span>
                      <div
                        className="num"
                        style={{
                          fontSize: 10,
                          color: "var(--accent-muted)",
                          marginTop: 1,
                        }}
                      >
                        E={m.E} · ν={m.nu}
                      </div>
                    </>
                  ) : (
                    <span style={{ color: "var(--error)" }}>?? missing</span>
                  )}
                </Td>
                <Td align="right">
                  {s ? (
                    <ThicknessCell
                      sectionId={s.id}
                      value={effectiveT}
                      fromGeometry={fromGeometry}
                      onCommit={(v) => setSectionThickness(s.id, v)}
                    />
                  ) : (
                    <span style={{ color: "var(--error)" }}>?? missing</span>
                  )}
                </Td>
                <Td align="right">
                  {s && !fromGeometry ? (
                    <button
                      type="button"
                      className="codex-action-button"
                      onClick={() => resetSectionThickness(s.id)}
                      title="Revert to geometry.cylinder.t"
                      style={{ padding: "2px 7px", minHeight: 20, fontSize: 10 }}
                    >
                      ↻
                    </button>
                  ) : null}
                </Td>
              </tr>
            ),
          )}
        </tbody>
      </table>

      <div
        style={{
          marginTop: 10,
          fontSize: 9.5,
          color: "var(--text-muted)",
          fontFamily: MONO,
          lineHeight: 1.5,
        }}
      >
        {stepped ? (
          <>
            Stepped wall · {partitions.length} cut → {rows.length} bands. Per-row
            thickness overrides{" "}
            <span style={{ color: "var(--accent-muted)" }}>geometry.cylinder.t</span>{" "}
            for that band only. Click <span style={{ color: "var(--accent-soft)" }}>↻</span>{" "}
            to follow the geometry value again. Materials are still shared — pick the
            material from MATERIAL → Base properties.
          </>
        ) : (
          <>
            Homogeneous cylinder · one section, one material, one assignment. Add an
            axial cut under{" "}
            <span style={{ color: "var(--accent-muted)" }}>GEOMETRY → Dimensions</span>{" "}
            to split the shell into bands with independent thickness.
          </>
        )}
      </div>
    </>
  );
}

/** Inline thickness editor: commits on blur / Enter, reverts on Escape. Shows
 * the value in monospace tabular-nums for column alignment. A faint hint
 * underneath indicates whether the value comes from geometry or is an
 * override, so the user can tell at a glance which sections are "live". */
function ThicknessCell({ sectionId, value, fromGeometry, onCommit }) {
  const [text, setText] = React.useState(fmtT(value));
  React.useEffect(() => setText(fmtT(value)), [value]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
      <input
        type="number"
        step={0.001}
        min={1e-9}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = Number(text);
          if (Number.isFinite(v) && v > 0) onCommit(v);
          else setText(fmtT(value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(fmtT(value));
            e.currentTarget.blur();
          }
        }}
        style={{
          width: 78,
          background: "var(--control-bg)",
          border: "1px solid var(--control-border)",
          borderRadius: 3,
          color: "var(--text-primary)",
          fontFamily: MONO,
          fontSize: 11.5,
          fontWeight: 700,
          padding: "3px 6px",
          textAlign: "right",
          fontVariantNumeric: "tabular-nums lining-nums",
          outline: "none",
        }}
      />
      <span
        style={{
          marginTop: 2,
          fontSize: 9,
          color: fromGeometry ? "var(--text-muted)" : "var(--accent-muted)",
          fontFamily: MONO,
        }}
        title={
          fromGeometry
            ? "Following geometry.cylinder.t"
            : "Override · type a value or use ↻ to revert"
        }
      >
        {fromGeometry ? "from geometry" : "override"}
      </span>
    </div>
  );
}

function fmtZ(v) {
  return Number(v).toFixed(2).replace(/\.?0+$/, "");
}
function fmtT(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  return Number(v).toFixed(6).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

function Th({ children, align = "left" }) {
  return (
    <th
      style={{
        textAlign: align,
        padding: "6px 8px",
        fontWeight: 600,
        color: "var(--text-secondary)",
        textTransform: "uppercase",
        letterSpacing: 0.06,
        fontSize: 9.5,
        borderBottom: "1px solid var(--line-soft)",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, accent, align = "left" }) {
  return (
    <td
      style={{
        padding: "7px 8px",
        verticalAlign: "top",
        textAlign: align,
        color: accent ? "var(--accent)" : "var(--text-primary)",
        fontWeight: accent ? 700 : 500,
        textShadow: accent ? "var(--shadow-accent)" : "none",
      }}
    >
      {children}
    </td>
  );
}
