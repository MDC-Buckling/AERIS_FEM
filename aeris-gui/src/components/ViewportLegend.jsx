import React from "react";
import { useUI } from "../store.js";
import { MONO } from "../constants.js";
import { RAMP_DARK, RAMP_LIGHT } from "../viewport/colormap.js";

function rampToCssGradient(bytes) {
  const stops = [];
  const N = 8;
  for (let i = 0; i < N; i++) {
    const k = Math.round((i / (N - 1)) * 255);
    const r = bytes[k * 3 + 0];
    const g = bytes[k * 3 + 1];
    const b = bytes[k * 3 + 2];
    stops.push(`rgb(${r},${g},${b}) ${(i / (N - 1) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(180deg, ${stops.reverse().join(", ")})`;
}

export default function ViewportLegend() {
  const theme = useUI((s) => s.theme);
  const cached = useUI((s) => s.resultCache[s.selectedResultId]);
  const ramp = theme === "light" ? RAMP_LIGHT : RAMP_DARK;
  const max = cached?.magMax ?? 1;
  const min = cached?.magMin ?? 0;

  return (
    <div
      style={{
        position: "absolute",
        right: 12,
        bottom: 12,
        width: 26,
        height: 200,
        padding: "0 0 0 30px",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          width: 14,
          height: "100%",
          borderRadius: 2,
          background: rampToCssGradient(ramp),
          border: "1px solid var(--line-steel-soft)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 32,
          top: -2,
          color: "var(--text-secondary)",
          fontSize: 9.5,
          fontFamily: MONO,
        }}
      >
        {max.toExponential(2)}
      </div>
      <div
        style={{
          position: "absolute",
          left: 32,
          bottom: -4,
          color: "var(--text-muted)",
          fontSize: 9.5,
          fontFamily: MONO,
        }}
      >
        {min.toExponential(2)}
      </div>
      <div
        style={{
          position: "absolute",
          left: -52,
          top: "50%",
          transform: "rotate(-90deg) translateX(50%)",
          transformOrigin: "right",
          color: "var(--accent-muted)",
          fontSize: 9.5,
          fontFamily: MONO,
          textTransform: "uppercase",
          letterSpacing: 0.1,
        }}
      >
        |u|
      </div>
    </div>
  );
}
