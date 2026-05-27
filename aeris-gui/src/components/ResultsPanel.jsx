import React from "react";
import GlassPanel from "./ui/GlassPanel.jsx";
import SectionHeader from "./ui/SectionHeader.jsx";
import { KNOWN_RESULTS } from "../constants.js";
import { useUI } from "../store.js";
import { MONO } from "../constants.js";

function ResultItem({ r, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        marginBottom: 4,
        border: active
          ? "1px solid rgba(0, 229, 255, 0.4)"
          : "1px solid var(--line-steel-soft)",
        background: active ? "rgba(0, 200, 255, 0.09)" : "rgba(255,255,255,0.015)",
        borderRadius: 5,
        cursor: "pointer",
        color: active ? "var(--accent)" : "var(--text-secondary)",
        fontFamily: MONO,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: active ? 700 : 600,
          textShadow: active ? "var(--shadow-accent)" : "none",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: active ? "var(--accent)" : "var(--text-soft)",
            boxShadow: active ? "0 0 6px var(--accent)" : "none",
          }}
        />
        {r.label}
      </div>
      {r.description && (
        <div
          style={{
            marginTop: 3,
            fontSize: 10,
            color: "var(--text-muted)",
            lineHeight: 1.35,
          }}
        >
          {r.description}
        </div>
      )}
    </button>
  );
}

export default function ResultsPanel() {
  const selected = useUI((s) => s.selectedResultId);
  const select = useUI((s) => s.selectResult);

  const groups = [
    { id: "geom", title: "Geometry", items: KNOWN_RESULTS.filter((r) => r.kind === "geometry") },
    { id: "pre", title: "Pre-buckling", items: KNOWN_RESULTS.filter((r) => r.kind === "displacement") },
    { id: "modes", title: "Eigenmodes", items: KNOWN_RESULTS.filter((r) => r.kind === "mode") },
  ];

  return (
    <GlassPanel style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <span
          className="codex-brand-title"
          style={{ fontSize: 11, letterSpacing: 0.1 }}
        >
          RESULTS
        </span>
        <span style={{ fontSize: 9.5, color: "var(--text-soft)", fontFamily: MONO }}>
          cylinder LBA — r=5
        </span>
      </div>

      <div style={{ marginTop: 10, overflowY: "auto", flex: 1 }}>
        {groups.map((g) => (
          <div key={g.id}>
            <SectionHeader>{g.title}</SectionHeader>
            {g.items.map((r) => (
              <ResultItem
                key={r.id}
                r={r}
                active={selected === r.id}
                onClick={() => select(r.id)}
              />
            ))}
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid var(--line-steel-soft)",
          fontSize: 10,
          color: "var(--text-muted)",
          fontFamily: MONO,
          lineHeight: 1.45,
        }}
      >
        Read from <span style={{ color: "var(--accent-muted)" }}>../output/</span> via
        the dev server's <span style={{ color: "var(--accent-muted)" }}>/data</span>{" "}
        middleware. Re-run <span style={{ color: "var(--accent-muted)" }}>cylinder_lba.py</span>{" "}
        to refresh.
      </div>
    </GlassPanel>
  );
}
