import React from "react";
import { MONO } from "../../constants.js";

/** Primary/secondary KPI badge. */
export default function KeyMetric({ label, value, unit, variant = "default", flag }) {
  const isPrimary = variant === "primary";
  return (
    <div
      style={{
        background: "var(--panel-bg-soft)",
        border: isPrimary
          ? "1px solid var(--accent)"
          : "1px solid var(--panel-border)",
        boxShadow: isPrimary
          ? "inset 0 0 0 1px rgba(0,229,255,0.08), 0 0 14px rgba(0,229,255,0.18)"
          : "none",
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
      }}
    >
      <span
        style={{
          color: "var(--text-secondary)",
          fontSize: 11.5,
          fontFamily: MONO,
          textTransform: "uppercase",
          letterSpacing: 0.06,
        }}
      >
        {label}
      </span>
      <span
        className="num"
        style={{
          color: "var(--accent)",
          fontSize: isPrimary ? 18 : 15,
          fontWeight: isPrimary ? 800 : 700,
          fontFamily: MONO,
          textShadow: "var(--shadow-accent)",
        }}
      >
        {value}
        {unit && (
          <span style={{ fontSize: 10, color: "var(--accent-muted)", marginLeft: 4 }}>
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}
