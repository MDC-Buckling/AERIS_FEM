import React from "react";

/** Translucent surface with HUD corner brackets that fade in on hover.
 * Pure CSS — see .glass-panel + .hud-corner in theme.css. */
export default function GlassPanel({ children, style, className = "", padding }) {
  return (
    <div
      className={`glass-panel ${className}`.trim()}
      style={padding !== undefined ? { padding, ...style } : style}
    >
      <span className="hud-corner hud-tl" />
      <span className="hud-corner hud-tr" />
      <span className="hud-corner hud-bl" />
      <span className="hud-corner hud-br" />
      {children}
    </div>
  );
}
