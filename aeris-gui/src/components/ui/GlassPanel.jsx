import React from "react";

/** Floating cinematic panel with soft layering, minimal borders.
 * AERIS 2026: spatial, immersive feel without sci-fi HUD aesthetic. */
export default function GlassPanel({ children, style, className = "", padding }) {
  return (
    <div
      className={`glass-panel ${className}`.trim()}
      style={padding !== undefined ? { padding, ...style } : style}
    >
      {children}
    </div>
  );
}
