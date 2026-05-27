import React from "react";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Functional inspector for SHELL CONSTRUCTION > Section Assignments.
 *
 * Today: read-mostly list of region → section rows. Exactly one row for
 * our single-cylinder case ("shell_full" → "Shell — full cylinder"),
 * but the table structure is the one that later holds many rows when
 * stiffened shells / variable thickness add regions (skin / ring /
 * stringer / …) with different (material, thickness_source) bundles.
 *
 * Schema contract — see scripts/aeris_model.py and the model-schema
 * memory note. Each assignment carries:
 *     region              tag of the geometric region it binds
 *     section_ref         id into sections[]
 * Each section then carries:
 *     material_ref        id into materials[]
 *     thickness_source    {kind:"geometry"|"constant"|"function", ...}
 *     offset              "midsurface" today; "top"/"bottom" later
 */
export default function SectionAssignments() {
  const model = useUI((s) => s.model);

  const rows = model.assignments.map((a) => {
    const sec = model.sections.find((s) => s.id === a.section_ref) ?? null;
    const mat = sec
      ? model.materials.find((m) => m.id === sec.material_ref) ?? null
      : null;
    return { assignment: a, section: sec, material: mat };
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
            <Th>Section</Th>
            <Th>Material</Th>
            <Th>Thickness</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ assignment: a, section: s, material: m }) => (
            <tr key={a.region} style={{ borderTop: "1px solid var(--line-faint)" }}>
              <Td accent>{a.region}</Td>
              <Td>
                {s ? s.name : <span style={{ color: "var(--error)" }}>?? missing</span>}
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
              <Td>
                {s && s.thickness_source.kind === "geometry" ? (
                  <>
                    <span style={{ color: "var(--text-secondary)" }}>from geometry</span>
                    <div
                      className="num"
                      style={{
                        fontSize: 10,
                        color: "var(--accent-muted)",
                        marginTop: 1,
                      }}
                    >
                      t = {model.geometry.cylinder.t}
                    </div>
                  </>
                ) : (
                  <span style={{ color: "var(--text-muted)" }}>
                    {s ? s.thickness_source.kind : "?"}
                  </span>
                )}
              </Td>
            </tr>
          ))}
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
        Trivial today (one shell · one material · one assignment), but the
        list is the one that holds many rows once stiffened-shell support
        lands — each region (skin / ring / stringer) gets its own row with
        its own material + thickness source.
      </div>
    </>
  );
}

function Th({ children }) {
  return (
    <th
      style={{
        textAlign: "left",
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

function Td({ children, accent }) {
  return (
    <td
      style={{
        padding: "7px 8px",
        verticalAlign: "top",
        color: accent ? "var(--accent)" : "var(--text-primary)",
        fontWeight: accent ? 700 : 500,
        textShadow: accent ? "var(--shadow-accent)" : "none",
      }}
    >
      {children}
    </td>
  );
}
