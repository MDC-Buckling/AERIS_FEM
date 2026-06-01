import React from "react";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Pick / clear controls for an expert set whose region is "picked". Toggling
 * Pick makes this set the viewport's active pick target — clicking the model
 * surface then appends node coordinates (Viewport3D routes to addPickedNode).
 * `kind` is "bc" | "load". */
export default function PickControls({ kind, set }) {
  const pickTarget = useUI((s) => s.pickTarget);
  const setPickTarget = useUI((s) => s.setPickTarget);
  const clearPickedNodes = useUI((s) => s.clearPickedNodes);

  const n = set.pickedNodes?.length ?? 0;
  const active = pickTarget && pickTarget.kind === kind && pickTarget.id === set.id;

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
      <button
        onClick={() => setPickTarget(active ? null : { kind, id: set.id })}
        title="Toggle picking, then click nodes on the 3D model"
        style={{
          flex: 1,
          padding: "5px 0",
          background: active ? "rgba(34,211,238,0.22)" : "rgba(0,180,210,0.10)",
          border: `1px solid ${active ? "#22d3ee" : "var(--accent)"}`,
          borderRadius: 5,
          color: active ? "#22d3ee" : "var(--accent)",
          fontFamily: MONO,
          fontWeight: 700,
          fontSize: 10.5,
          cursor: "pointer",
          boxShadow: active ? "0 0 10px rgba(34,211,238,0.35)" : "none",
        }}
      >
        {active ? "● Picking — click model (done)" : `◎ Pick nodes (${n})`}
      </button>
      {n > 0 && (
        <button
          onClick={() => clearPickedNodes(kind, set.id)}
          title="Clear picked nodes"
          style={{
            padding: "5px 8px",
            background: "none",
            border: "1px solid var(--line-soft)",
            borderRadius: 5,
            color: "var(--text-muted)",
            fontFamily: MONO,
            fontSize: 10.5,
            cursor: "pointer",
          }}
        >
          clear
        </button>
      )}
    </div>
  );
}
