import React from "react";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";
import PickControls from "./PickControls.jsx";

/** Expert-mode boundary conditions — Abaqus-style. Each "BC set" binds a
 * geometry region to a 6-component constraint (U1/U2/U3 translations + UR1/
 * UR2/UR3 rotations). A component is FREE (unchecked) or CONSTRAINED to a
 * prescribed value (checked; 0 = clamped). The buckling .comm translates these
 * to Code_Aster DDL_IMPO via aster_engine/comm.py::_expert_ddl_impo.
 *
 * v1: named rim regions (bottom/top) + global Cartesian frame. Cylindrical
 * frame + coordinate node-sets + 3D picking are later phases. */

const DOFS = [
  ["u1", "U1", "transl x"],
  ["u2", "U2", "transl y"],
  ["u3", "U3", "transl z"],
  ["ur1", "UR1", "rot x"],
  ["ur2", "UR2", "rot y"],
  ["ur3", "UR3", "rot z"],
];

const REGIONS = [
  ["bottom", "Bottom edge (z = 0)"],
  ["top", "Top edge (z = L)"],
  ["picked", "Picked nodes (3D)"],
];

export default function ExpertBcEditor() {
  const sets = useUI((s) => s.model.bcs.sets) ?? [];
  const addBcSet = useUI((s) => s.addBcSet);
  const updateBcSet = useUI((s) => s.updateBcSet);
  const removeBcSet = useUI((s) => s.removeBcSet);

  return (
    <div style={{ fontFamily: MONO }}>
      <div
        style={{
          fontSize: 9.5,
          color: "var(--text-muted)",
          lineHeight: 1.45,
          marginBottom: 10,
        }}
      >
        Per-region component constraints (global Cartesian frame: U1=x, U2=y,
        U3=z). Tick a component to constrain it; value 0 = clamped. Unticked =
        free. Currently wired for LBA (Code_Aster).
      </div>

      {sets.length === 0 && (
        <div
          style={{
            fontSize: 10.5,
            color: "var(--text-secondary)",
            padding: "8px 0",
          }}
        >
          No BC sets yet — add one to constrain a region.
        </div>
      )}

      {sets.map((s) => (
        <BcSetCard
          key={s.id}
          set={s}
          onChange={(patch) => updateBcSet(s.id, patch)}
          onRemove={() => removeBcSet(s.id)}
        />
      ))}

      <button
        onClick={addBcSet}
        style={{
          marginTop: 8,
          width: "100%",
          padding: "7px 0",
          background: "rgba(0,180,210,0.12)",
          border: "1px solid var(--accent)",
          borderRadius: 5,
          color: "var(--accent)",
          fontFamily: MONO,
          fontWeight: 700,
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        + Add BC set
      </button>
    </div>
  );
}

function BcSetCard({ set, onChange, onRemove }) {
  const dofs = set.dofs ?? {};

  const toggle = (comp) => {
    const cur = dofs[comp];
    onChange({ dofs: { ...dofs, [comp]: cur == null ? 0 : null } });
  };
  const setValue = (comp, raw) => {
    const v = Number(raw);
    onChange({ dofs: { ...dofs, [comp]: Number.isFinite(v) ? v : 0 } });
  };

  return (
    <div
      style={{
        marginBottom: 10,
        padding: "10px 12px",
        background: "var(--panel-bg-soft)",
        border: "1px solid var(--line-soft)",
        borderRadius: 5,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
        <input
          value={set.name ?? ""}
          onChange={(e) => onChange({ name: e.target.value })}
          style={{
            flex: "0 0 80px",
            background: "var(--input-bg, rgba(0,0,0,0.25))",
            border: "1px solid var(--line-soft)",
            borderRadius: 4,
            color: "var(--accent)",
            fontFamily: MONO,
            fontSize: 11,
            padding: "3px 6px",
          }}
        />
        <select
          value={set.region ?? "bottom"}
          onChange={(e) => onChange({ region: e.target.value })}
          style={{
            flex: 1,
            background: "var(--input-bg, rgba(0,0,0,0.25))",
            border: "1px solid var(--line-soft)",
            borderRadius: 4,
            color: "var(--text-secondary)",
            fontFamily: MONO,
            fontSize: 11,
            padding: "3px 6px",
          }}
        >
          {REGIONS.map(([v, lbl]) => (
            <option key={v} value={v}>{lbl}</option>
          ))}
        </select>
        <span
          title="reference frame (cylindrical option in a later phase)"
          style={{ fontSize: 9, color: "var(--accent-muted)", whiteSpace: "nowrap" }}
        >
          global
        </span>
        <button
          onClick={onRemove}
          title="Remove this BC set"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 13,
            padding: "0 2px",
          }}
        >
          ✕
        </button>
      </div>

      {set.region === "picked" && <PickControls kind="bc" set={set} />}

      {/* Two columns: translations (U1-3) left, rotations (UR1-3) right. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
        {[DOFS.slice(0, 3), DOFS.slice(3)].map((col, ci) => (
          <div key={ci} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {col.map(([comp, label, hint]) => {
              const constrained = dofs[comp] != null;
              return (
                <label
                  key={comp}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 10.5,
                    color: constrained ? "var(--accent)" : "var(--text-muted)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={constrained}
                    onChange={() => toggle(comp)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <span style={{ flex: "0 0 34px", fontWeight: 600 }}>{label}</span>
                  <input
                    type="number"
                    step="any"
                    disabled={!constrained}
                    value={constrained ? dofs[comp] : ""}
                    placeholder={constrained ? "" : "free"}
                    onChange={(e) => setValue(comp, e.target.value)}
                    title={hint}
                    style={{
                      width: 56,
                      background: constrained
                        ? "var(--input-bg, rgba(0,0,0,0.25))"
                        : "transparent",
                      border: "1px solid var(--line-soft)",
                      borderRadius: 3,
                      color: "var(--text-secondary)",
                      fontFamily: MONO,
                      fontSize: 10.5,
                      padding: "2px 4px",
                    }}
                  />
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
