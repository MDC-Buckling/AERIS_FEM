import React from "react";
import { useUI } from "./store.js";
import TopChrome from "./components/TopChrome.jsx";
import ResultsPanel from "./components/ResultsPanel.jsx";
import InspectorPanel from "./components/InspectorPanel.jsx";
import Viewport3D from "./viewport/Viewport3D.jsx";
import ViewportLegend from "./components/ViewportLegend.jsx";
import ModelTreePanel from "./preprocessor/ModelTreePanel.jsx";
import PreInspectorPanel from "./preprocessor/PreInspectorPanel.jsx";
import BenchmarkHubPanel from "./benchmarks/BenchmarkHubPanel.jsx";

export default function App() {
  const theme = useUI((s) => s.theme);
  const mode = useUI((s) => s.mode);
  const selectedResultId = useUI((s) => s.selectedResultId);
  const loadResultsManifest = useUI((s) => s.loadResultsManifest);
  const loadJobs = useUI((s) => s.loadJobs);
  // The pre-mode viewport now builds its own procedural cylinder from
  // store.model.geometry.cylinder, so we no longer need to force
  // selectedResultId to "geometry" on mode switch (Session 3.0's hack).
  // selectedResultId is purely a post-mode concept now.

  // On startup: pull the on-disk jobs index, then try to load the legacy
  // flat run.json (Session 3.10 results) so a pre-jobs user's previous
  // solve still appears in the post-processor. New per-job results
  // surface via the Jobs panel + loadResultsManifest(jobId).
  React.useEffect(() => {
    loadJobs();
    loadResultsManifest();
  }, [loadJobs, loadResultsManifest]);

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

      {mode === "hub" ? (
        // Hub: full-width single panel. No viewport — the hub is a
        // browsable catalog + per-card verdict + "open in post-processor"
        // affordance that flips to the post-mode for visualisation.
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            padding: 12,
            minHeight: 0,
          }}
        >
          <div
            className="glass-panel"
            style={{
              flex: 1,
              minHeight: 0,
              padding: 0,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <BenchmarkHubPanel />
          </div>
        </main>
      ) : (
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
            {mode === "post" && <ViewportLegend />}

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
      )}
    </div>
  );
}
