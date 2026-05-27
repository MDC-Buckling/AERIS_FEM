import React, { useEffect, useState } from "react";
import { MONO } from "../../constants.js";

/** GlowInput-style numeric field — mono, right-aligned value, tabular-nums,
 * symbol + unit chips, animated bordered "glass" body. Commits on blur or
 * Enter; rejects non-positive when min > 0; reverts on invalid. */
export default function NumberField({
  label,
  symbol,
  unit,
  value,
  onChange,
  min = 0,
  max = Infinity,
  step = 0.001,
  precision = 4,
  hint,
  /** Set true to render a small "min..max" badge in the field's right
   * gutter. Off by default so existing free-form numeric inputs (E, ν,
   * R, L, t, …) stay clean; opt-in for fields with hard integer bounds
   * (refinement, degree, smoothness, …) where the user benefits from
   * seeing the valid window at a glance. */
  showRange = false,
}) {
  const [text, setText] = useState(formatVal(value, precision));
  useEffect(() => {
    setText(formatVal(value, precision));
  }, [value, precision]);

  const commit = () => {
    const v = Number(text);
    if (!Number.isFinite(v) || v < min || v > max) {
      setText(formatVal(value, precision));   // revert
      return;
    }
    if (v !== value) onChange(v);
  };

  return (
    <div style={{ marginBottom: 9 }}>
      <div style={{ marginBottom: 2 }}>
        <span
          style={{
            color: "var(--text-secondary)",
            fontSize: 10.5,
            fontFamily: MONO,
          }}
        >
          {label}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          background:
            "linear-gradient(90deg, rgba(0,20,45,0.50) 0%, " +
            "rgba(0,80,120,0.45) 60%, rgba(0,180,210,0.42) 100%)",
          border: "1px solid var(--control-border-strong)",
          borderRadius: 4,
          padding: "4px 7px",
          boxShadow:
            "inset 0 1px 0 rgba(0,229,255,0.20), 0 0 12px rgba(0,180,210,0.18)",
        }}
      >
        {symbol && (
          <span
            style={{
              color: "var(--accent-soft)",
              fontSize: 11,
              fontFamily: MONO,
              minWidth: 18,
              fontWeight: 600,
            }}
          >
            {symbol}
          </span>
        )}
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setText(formatVal(value, precision));
              e.currentTarget.blur();
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--text-primary)",
            fontSize: 13,
            fontFamily: MONO,
            fontWeight: 700,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums lining-nums",
          }}
        />
        {unit && (
          <span
            style={{
              color: "var(--text-muted)",
              fontSize: 13,
              fontFamily: MONO,
              minWidth: 28,
              fontWeight: 600,
            }}
          >
            {unit}
          </span>
        )}
        {showRange && (
          <span
            style={{
              color: "var(--text-soft)",
              fontSize: 10,
              fontFamily: MONO,
              fontWeight: 600,
              paddingLeft: 2,
              borderLeft: "1px solid var(--control-border)",
              marginLeft: 1,
              whiteSpace: "nowrap",
            }}
            title={`Valid range: ${min} ≤ value ≤ ${
              Number.isFinite(max) ? max : "∞"
            }`}
          >
            {min}..{Number.isFinite(max) ? max : "∞"}
          </span>
        )}
      </div>

      {hint && (
        <div
          style={{
            marginTop: 3,
            fontSize: 9.5,
            color: "var(--text-muted)",
            fontFamily: MONO,
            lineHeight: 1.4,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

function formatVal(v, precision) {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  // strip trailing zeros but keep significant digits up to `precision`.
  const s = Number(v).toFixed(precision);
  return s.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}
