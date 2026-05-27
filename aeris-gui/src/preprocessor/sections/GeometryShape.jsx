import React from "react";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";
import { findItem } from "../modelTree.js";

/** Functional inspector for GEOMETRY > Shape & Type.
 * Cylinder is selectable; other families are listed and disabled, so the
 * model-tree structure already presents the full future surface — only the
 * radio is interactive on Cylinder. */
export default function GeometryShape() {
  const shape = useUI((s) => s.model.geometry.shape);
  const setShape = useUI((s) => s.setShape);

  const found = findItem("geometry.shape");
  const options = found.item.options;

  return (
    <div
      style={{
        background: "var(--panel-bg-soft)",
        border: "1px solid var(--control-border)",
        borderRadius: 5,
        padding: 4,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === shape;
        const enabled = !!opt.enabled;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={!enabled}
            onClick={() => enabled && setShape(opt.value)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "6px 8px",
              width: "100%",
              background: active ? "rgba(0, 200, 255, 0.10)" : "transparent",
              border: active
                ? "1px solid rgba(0, 229, 255, 0.34)"
                : "1px solid transparent",
              borderRadius: 3,
              cursor: enabled ? "pointer" : "not-allowed",
              fontFamily: MONO,
              fontSize: 11.5,
              fontWeight: active ? 700 : 500,
              color: enabled
                ? active
                  ? "var(--accent)"
                  : "var(--text-primary)"
                : "var(--text-soft)",
              textAlign: "left",
              textShadow: active ? "var(--shadow-accent)" : "none",
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                border: `1px solid ${
                  enabled ? "var(--accent-muted)" : "var(--text-soft)"
                }`,
                background: active ? "var(--accent)" : "transparent",
                boxShadow: active ? "0 0 6px var(--accent)" : "none",
                flex: "0 0 10px",
              }}
            />
            <span style={{ flex: 1 }}>{opt.label}</span>
            {(opt.note || !enabled) && (
              <span
                style={{
                  fontSize: 9.5,
                  color: enabled ? "var(--warning)" : "var(--text-soft)",
                  fontStyle: "italic",
                }}
              >
                {opt.note ?? "coming soon"}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
