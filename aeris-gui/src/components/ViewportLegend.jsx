import React from "react";
import { useUI } from "../store.js";
import { MONO } from "../constants.js";
import { resolveColormap } from "../viewport/colormap.js";

/** Build a top-to-bottom CSS gradient string from a 256-entry RGB ramp.
 * 12 sampled stops is plenty visually; the shader does the smooth
 * interpolation, this is just for the screen-side colour bar. */
function rampToCssGradient(bytes) {
  const stops = [];
  const N = 12;
  for (let i = 0; i < N; i++) {
    const k = Math.round((i / (N - 1)) * 255);
    const r = bytes[k * 3 + 0];
    const g = bytes[k * 3 + 1];
    const b = bytes[k * 3 + 2];
    stops.push(`rgb(${r},${g},${b}) ${(i / (N - 1) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(180deg, ${stops.reverse().join(", ")})`;
}

/** Human label + LaTeX-ish tag for each displayField the viewport supports.
 * Keep the symbol short so the rotated label fits on the side of the
 * legend even on narrow viewports. */
const FIELD_META = {
  magnitude: { label: "|u|",          isSigned: false },
  ux:        { label: "u_x",          isSigned: true  },
  uy:        { label: "u_y",          isSigned: true  },
  uz:        { label: "u_z",          isSigned: true  },
};

/** Format a number compactly for the legend ticks. Switches between
 * fixed and scientific notation based on magnitude so small static
 * displacements (0.3, 1e-3, 1e-7) all render with similar character
 * count + readable precision. */
function fmtTick(v) {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e-2 && a < 1e4) return v.toFixed(a >= 10 ? 1 : a >= 1 ? 2 : 3);
  return v.toExponential(2);
}

export default function ViewportLegend() {
  const theme = useUI((s) => s.theme);
  const colormapName = useUI((s) => s.colormapName);
  const displayField = useUI((s) => s.displayField);
  const stats = useUI((s) => s.displayFieldStats);

  const ramp = resolveColormap(colormapName, theme);
  const meta = FIELD_META[displayField] ?? FIELD_META.magnitude;

  // What the shader actually maps to color: abs(value) ∈ [0, maxAbs]
  // for both signed and unsigned fields. We label the bar accordingly —
  // top tick = +maxAbs, bottom = 0 — and surface the signed range
  // separately below the bar so the user can read "u_z ranges from
  // −0.30 to 0" even though the colors only show magnitude.
  const maxAbs = stats?.maxAbs ?? 1;
  const signedMin = stats?.min ?? 0;
  const signedMax = stats?.max ?? 0;
  const tickValues = [
    maxAbs,
    0.75 * maxAbs,
    0.50 * maxAbs,
    0.25 * maxAbs,
    0,
  ];

  return (
    <div
      style={{
        position: "absolute",
        right: 18,
        bottom: 18,
        width: 88,
        height: 230,
        pointerEvents: "none",
        fontFamily: MONO,
      }}
    >
      {/* Field label above the bar */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: -22,
          width: 28,
          textAlign: "center",
          color: "var(--accent)",
          fontSize: 12,
          fontWeight: 700,
          textShadow: "var(--shadow-accent)",
          letterSpacing: 0.05,
        }}
      >
        {meta.label}
      </div>

      {/* Colour bar */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 16,
          height: 200,
          borderRadius: 2,
          background: rampToCssGradient(ramp),
          border: "1px solid var(--line-steel-soft)",
        }}
      />

      {/* Tick labels (5 evenly spaced) */}
      {tickValues.map((v, i) => {
        const topPct = (i / (tickValues.length - 1)) * 100;
        return (
          <React.Fragment key={i}>
            {/* tiny tick mark */}
            <div
              style={{
                position: "absolute",
                left: 16,
                top: `calc(${topPct}% - 0.5px)`,
                width: 5,
                height: 1,
                background: "var(--text-secondary)",
                opacity: 0.7,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 24,
                top: `calc(${topPct}% - 6px)`,
                color: i === 0 ? "var(--accent)" : "var(--text-secondary)",
                fontWeight: i === 0 ? 700 : 500,
                fontSize: 9.5,
                whiteSpace: "nowrap",
              }}
            >
              {fmtTick(v)}
            </div>
          </React.Fragment>
        );
      })}

      {/* Signed-range footnote for component fields — magnitude is
          always >= 0 so the bar already tells the whole story. */}
      {meta.isSigned && stats && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 210,
            width: 88,
            fontSize: 8.5,
            color: "var(--text-muted)",
            lineHeight: 1.3,
            letterSpacing: 0.02,
          }}
        >
          <div>signed range</div>
          <div style={{ color: "var(--text-secondary)" }}>
            {fmtTick(signedMin)} … {fmtTick(signedMax)}
          </div>
          <div style={{ color: "var(--text-soft)", marginTop: 1 }}>
            (color by |value|)
          </div>
        </div>
      )}
    </div>
  );
}
