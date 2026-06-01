import React from "react";
import { useUI } from "../store.js";
import { MONO } from "../constants.js";

/** Abaqus-style standard-view toolbar, overlaid top-centre of the viewport.
 * Snaps the camera to a canonical orientation (front/back/left/right/top/
 * bottom/iso) via store.viewPreset → Viewport3D's fitCameraToBox. Lets the user
 * reorient instantly instead of orbiting — especially handy while node-picking
 * (where a drag rotates and a click picks). Cylinder axis = Z (vertical). */

const VIEWS = [
  ["iso", "ISO", "Isometric"],
  ["front", "FRT", "Front (−Y)"],
  ["back", "BCK", "Back (+Y)"],
  ["left", "LFT", "Left (−X)"],
  ["right", "RGT", "Right (+X)"],
  ["top", "TOP", "Top — look down the axis (see the circle)"],
  ["bottom", "BOT", "Bottom — look up the axis"],
];

export default function ViewToolbar() {
  const viewPreset = useUI((s) => s.viewPreset);
  const setViewPreset = useUI((s) => s.setViewPreset);

  return (
    <div
      style={{
        position: "absolute",
        top: 10,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 3,
        padding: 3,
        background: "rgba(0, 15, 40, 0.55)",
        border: "1px solid rgba(100, 180, 220, 0.18)",
        borderRadius: 8,
        backdropFilter: "blur(6px)",
        zIndex: 5,
      }}
    >
      {VIEWS.map(([key, label, title]) => {
        const active = viewPreset === key;
        return (
          <button
            key={key}
            onClick={() => setViewPreset(key)}
            title={title}
            style={{
              minWidth: 26,
              padding: "4px 6px",
              background: active ? "rgba(0,180,210,0.25)" : "transparent",
              border: `1px solid ${active ? "var(--accent)" : "transparent"}`,
              borderRadius: 5,
              color: active ? "var(--accent)" : "var(--accent-muted)",
              fontFamily: MONO,
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: 0.04,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
