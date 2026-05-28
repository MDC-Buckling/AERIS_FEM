import React from "react";
import { MONO } from "../constants.js";

/**
 * Physics Copilot contextual insights card — shows relevant analysis hints
 * based on current model configuration. Appears as an optional overlay in
 * the inspector or as a collapsible card in pre-processor mode.
 *
 * Session 3.2: Placeholder for future ML-driven insights (mesh resolution,
 * geometry feature detection, analysis stability warnings, etc.)
 */
export default function PhysicsInsightsCard({ insights = [] }) {
  if (!insights || insights.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        background: "rgba(232, 169, 77, 0.05)",
        border: "1px solid rgba(232, 169, 77, 0.15)",
        borderRadius: 5,
        fontSize: 10,
        fontFamily: MONO,
        color: "var(--text-secondary)",
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
          fontWeight: 600,
          color: "var(--warning)",
          textTransform: "uppercase",
          letterSpacing: 0.05,
        }}
      >
        <span>💡</span>
        <span>Physics Insights</span>
      </div>
      {insights.map((insight, idx) => (
        <div key={idx} style={{ marginBottom: idx < insights.length - 1 ? 4 : 0 }}>
          {insight}
        </div>
      ))}
    </div>
  );
}
