import React from "react";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";
import PickControls from "./PickControls.jsx";

/** Expert-mode loads — Abaqus-style. Each "load set" binds a geometry region
 * to either a force/moment (per-node components F1/F2/F3 + M1/M2/M3 on a rim
 * GROUP_NO) or a uniform pressure (on the shell GROUP_MA). Translated to
 * Code_Aster FORCE_NODALE / PRES_REP by aster_engine/comm.py::_expert_char.
 *
 * v1: drives the STATIC Code_Aster path (the LBA path keeps its auto-scaled
 * axial reference load). Global Cartesian frame; named regions. */

const FORCE_COMPS = [
  ["f1", "F1", "force x"],
  ["f2", "F2", "force y"],
  ["f3", "F3", "force z"],
];
const MOMENT_COMPS = [
  ["m1", "M1", "moment x"],
  ["m2", "M2", "moment y"],
  ["m3", "M3", "moment z"],
];
const FORCE_REGIONS = [
  ["top", "Top edge (z = L)"],
  ["bottom", "Bottom edge (z = 0)"],
  ["picked", "Picked nodes (3D)"],
];

export default function ExpertLoadEditor() {
  const sets = useUI((s) => s.model.load.sets) ?? [];
  const addLoadSet = useUI((s) => s.addLoadSet);
  const updateLoadSet = useUI((s) => s.updateLoadSet);
  const removeLoadSet = useUI((s) => s.removeLoadSet);

  return (
    <div style={{ fontFamily: MONO }}>
      <div style={{ fontSize: 9.5, color: "var(--text-muted)", lineHeight: 1.45, marginBottom: 10 }}>
        Per-region loads (global Cartesian frame). Force/moment = per-node
        components on the rim; pressure = uniform on the shell. Drives the
        static analysis (LBA uses its axial reference load).
      </div>

      {sets.length === 0 && (
        <div style={{ fontSize: 10.5, color: "var(--text-secondary)", padding: "8px 0" }}>
          No load sets yet — add one.
        </div>
      )}

      {sets.map((s) => (
        <LoadSetCard
          key={s.id}
          set={s}
          onChange={(patch) => updateLoadSet(s.id, patch)}
          onRemove={() => removeLoadSet(s.id)}
        />
      ))}

      <button
        onClick={addLoadSet}
        style={{
          marginTop: 8, width: "100%", padding: "7px 0",
          background: "rgba(0,180,210,0.12)", border: "1px solid var(--accent)",
          borderRadius: 5, color: "var(--accent)", fontFamily: MONO,
          fontWeight: 700, fontSize: 11, cursor: "pointer",
        }}
      >
        + Add load set
      </button>
    </div>
  );
}

function LoadSetCard({ set, onChange, onRemove }) {
  const isPressure = set.type === "pressure";
  const force = set.force ?? {};
  const moment = set.moment ?? {};

  const setComp = (group, comp, raw) => {
    const v = Number(raw);
    onChange({ [group]: { ...(set[group] ?? {}), [comp]: Number.isFinite(v) ? v : 0 } });
  };

  const setType = (type) =>
    onChange(type === "pressure" ? { type, region: "shell" } : { type, region: "top" });

  return (
    <div style={{
      marginBottom: 10, padding: "10px 12px", background: "var(--panel-bg-soft)",
      border: "1px solid var(--line-soft)", borderRadius: 5,
    }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
        <input
          value={set.name ?? ""}
          onChange={(e) => onChange({ name: e.target.value })}
          style={fieldStyle(82, "var(--accent)")}
        />
        {/* Force / Pressure type */}
        <select value={set.type ?? "force"} onChange={(e) => setType(e.target.value)}
          style={fieldStyle(null, "var(--text-secondary)")}>
          <option value="force">Force / moment</option>
          <option value="pressure">Pressure</option>
        </select>
        <button onClick={onRemove} title="Remove this load set"
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13, padding: "0 2px" }}>
          ✕
        </button>
      </div>

      {/* Region — rims for force, shell for pressure (fixed) */}
      <div style={{ marginBottom: 8 }}>
        {isPressure ? (
          <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
            Region: shell (whole surface)
          </span>
        ) : (
          <select value={set.region ?? "top"} onChange={(e) => onChange({ region: e.target.value })}
            style={{ ...fieldStyle(null, "var(--text-secondary)"), width: "100%" }}>
            {FORCE_REGIONS.map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
          </select>
        )}
      </div>

      {!isPressure && set.region === "picked" && <PickControls kind="load" set={set} />}

      {isPressure ? (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5, color: "var(--accent)" }}>
          <span style={{ flex: "0 0 70px", fontWeight: 600 }}>Pressure</span>
          <input type="number" step="any" value={set.pressure ?? 0}
            onChange={(e) => onChange({ pressure: Number(e.target.value) || 0 })}
            style={fieldStyle(80, "var(--text-secondary)")} />
        </label>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
          {[["force", FORCE_COMPS, force], ["moment", MOMENT_COMPS, moment]].map(
            ([group, comps, vals]) => (
              <div key={group} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {comps.map(([comp, label, hint]) => (
                  <label key={comp} title={hint}
                    style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--text-secondary)" }}>
                    <span style={{ flex: "0 0 28px", fontWeight: 600, color: "var(--accent)" }}>{label}</span>
                    <input type="number" step="any" value={vals[comp] ?? 0}
                      onChange={(e) => setComp(group, comp, e.target.value)}
                      style={fieldStyle(56, "var(--text-secondary)")} />
                  </label>
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function fieldStyle(width, color) {
  return {
    ...(width ? { width } : { flex: 1 }),
    background: "var(--input-bg, rgba(0,0,0,0.25))",
    border: "1px solid var(--line-soft)",
    borderRadius: 4,
    color,
    fontFamily: MONO,
    fontSize: 10.5,
    padding: "3px 6px",
  };
}
