import React from "react";
import { MONO } from "../../constants.js";

/** Themed numeric slider with label + live value readout. */
export default function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  unit,
  onChange,
  fmt,
}) {
  const formatted = fmt ? fmt(value) : String(value);
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            color: "var(--text-secondary)",
            fontSize: 10.5,
            fontFamily: MONO,
            textTransform: "uppercase",
            letterSpacing: 0.04,
          }}
        >
          {label}
        </span>
        <span
          className="num"
          style={{
            color: "var(--accent)",
            fontSize: 12,
            fontFamily: MONO,
            fontWeight: 700,
            textShadow: "var(--shadow-accent)",
          }}
        >
          {formatted}
          {unit && (
            <span style={{ fontSize: 10, color: "var(--accent-muted)", marginLeft: 3 }}>
              {unit}
            </span>
          )}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}
