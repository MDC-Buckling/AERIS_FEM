import React from "react";
import { MONO } from "../../constants.js";

/** Segmented control / pill variant. */
export default function ToggleGroup({ options, value, onChange, fullWidth = false }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 0,
        borderRadius: 5,
        overflow: "hidden",
        border: "1px solid var(--control-border)",
        width: fullWidth ? "100%" : "auto",
      }}
    >
      {options.map(([key, label], i) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            style={{
              flex: fullWidth ? 1 : "0 0 auto",
              padding: "5px 12px",
              fontSize: 10,
              fontFamily: MONO,
              fontWeight: active ? 700 : 400,
              border: "none",
              borderRight:
                i < options.length - 1 ? "1px solid var(--control-border)" : "none",
              background: active ? "var(--control-active-bg)" : "var(--control-bg)",
              color: active ? "var(--accent)" : "var(--text-muted)",
              textShadow: active ? "var(--shadow-accent)" : "none",
              cursor: "pointer",
              textTransform: "uppercase",
              letterSpacing: 0.04,
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
