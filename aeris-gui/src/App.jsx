import React, { useEffect } from "react";
import { useUI } from "./store.js";
import TopChrome from "./components/TopChrome.jsx";
import ResultsPanel from "./components/ResultsPanel.jsx";
import InspectorPanel from "./components/InspectorPanel.jsx";
import Viewport3D from "./viewport/Viewport3D.jsx";
import ViewportLegend from "./components/ViewportLegend.jsx";
import ModelTreePanel from "./preprocessor/ModelTreePanel.jsx";
import PreInspectorPanel from "./preprocessor/PreInspectorPanel.jsx";

export default function App() {
  const theme = useUI((s) => s.theme);
  const mode = useUI((s) => s.mode);
  const selectedResultId = useUI((s) => s.selectedResultId);
  const selectResult = useUI((s) => s.selectResult);

  // Pre-processor mode uses the viewport as a live-preview stand-in: force
  // it to the bare geometry. When the user switches back to post-processor
  // they see whatever result they had selected (last selection preserved
  // because selectedResultId stays around — we only override it on entry
  // to pre, and restore on entry to post via a remembered id).
  const lastPostId = React.useRef(selectedResultId);
  useEffect(() => {
    if (mode === "pre") {
      if (selectedResultId !== "geometry") {
        lastPostId.current = selectedResultId;
        selectResult("geometry");
      }
    } else {
      if (selectedResultId === "geometry" && lastPostId.current !== "geometry") {
        selectResult(lastPostId.current);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return (
    <div
      className="theme-root"
      data-theme={theme}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: "100vh",
      }}
    >
      <TopChrome />

      <main
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "320px minmax(640px, 1fr) 340px",
          gridTemplateRows: "1fr",
          gap: 12,
          padding: 12,
          minHeight: 0,
        }}
      >
        {mode === "pre" ? <ModelTreePanel /> : <ResultsPanel />}

        {/* Central viewport is shared between pre and post. */}
        <div
          className="glass-panel"
          style={{
            position: "relative",
            padding: 0,
            overflow: "hidden",
          }}
        >
          <span className="hud-corner hud-tl" />
          <span className="hud-corner hud-tr" />
          <span className="hud-corner hud-bl" />
          <span className="hud-corner hud-br" />
          <Viewport3D />
          <ViewportLegend />

          {/* Small mode badge in the corner so the viewport always says
              what it's showing (model preview vs result). */}
          <div
            style={{
              position: "absolute",
              top: 10,
              left: 12,
              padding: "3px 9px",
              background: "rgba(0, 15, 40, 0.65)",
              border: "1px solid var(--control-border)",
              borderRadius: 999,
              fontSize: 9.5,
              fontFamily: "'JetBrains Mono', monospace",
              color: "var(--accent-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.08,
              pointerEvents: "none",
              backdropFilter: "blur(4px)",
            }}
          >
            {mode === "pre"
              ? "live preview · model"
              : `result · ${selectedResultId}`}
          </div>
        </div>

        {mode === "pre" ? <PreInspectorPanel /> : <InspectorPanel />}
      </main>
    </div>
  );
}
