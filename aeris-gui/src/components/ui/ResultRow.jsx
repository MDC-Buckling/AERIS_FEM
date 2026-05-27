import React from "react";
import { MONO } from "../../constants.js";

const FLAG_ICONS = { ok: "✓", warn: "▲", err: "✖" };

export default function ResultRow({ label, value, unit, flag, highlight }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "4px 0",
        borderBottom: "1px solid var(--line-faint)",
      }}
    >
      <span style={{ color: "var(--text-secondary)", fontSize: 11.5, fontFamily: MONO }}>
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        {flag && (
          <span style={{ fontSize: 10, color: `var(--${flag === "ok" ? "success" : flag === "warn" ? "warning" : "error"})` }}>
            {FLAG_ICONS[flag]}
          </span>
        )}
        <span
          className="num"
          style={{
            color: highlight ? "var(--accent)" : "var(--text-primary)",
            fontSize: 12.5,
            fontWeight: highlight ? 700 : 500,
            fontFamily: MONO,
            textShadow: highlight ? "var(--shadow-accent)" : "none",
          }}
        >
          {value}
          {unit && (
            <span style={{ fontSize: 10, color: "var(--accent-muted)", marginLeft: 3 }}>
              {unit}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
