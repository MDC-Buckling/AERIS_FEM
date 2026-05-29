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
import StatusLine from "./components/StatusLine.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import ModelsPanel from "./components/ModelsPanel.jsx";

export default function App() {
  const theme = useUI((s) => s.theme);
  const mode = useUI((s) => s.mode);
  const selectedResultId = useUI((s) => s.selectedResultId);
  const loadResultsManifest = useUI((s) => s.loadResultsManifest);
  const loadJobs = useUI((s) => s.loadJobs);
  const expandedLeftPanels = useUI((s) => s.expandedLeftPanels);
  const toggleLeftPanel = useUI((s) => s.toggleLeftPanel);
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

  // Global keyboard handler for command palette and section shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;

      const store = useUI.getState();
      const { mode, setMode, selectTreeItem, expandSection, runSolver, setPaletteOpen, paletteOpen, loadModels } = store;

      // Command palette: Space or Cmd/Ctrl+K
      if ((e.key === " " && !e.ctrlKey && !e.metaKey) ||
          ((e.ctrlKey || e.metaKey) && e.key === "k")) {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
        return;
      }

      // New model: Cmd/Ctrl+N
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        // This would need a ref to ModelsPanel to trigger the new dialog
        // For now, just load models in case they need to be refreshed
        loadModels();
        return;
      }

      // Open model list: Cmd/Ctrl+O
      if ((e.ctrlKey || e.metaKey) && e.key === "o") {
        e.preventDefault();
        loadModels();
        return;
      }

      if (mode !== "pre") {
        if (e.key === "Tab") {
          e.preventDefault();
          setMode(mode === "pre" ? "post" : "pre");
        }
        return;
      }

      const jump = (sectionId, itemId) => {
        expandSection(sectionId);
        selectTreeItem(`${sectionId}.${itemId}`);
      };

      switch (e.key.toLowerCase()) {
        case "g":
          jump("geometry", "dimensions");
          break;
        case "m":
          jump("material", "base");
          break;
        case "b":
          jump("bcsLoads", "bcs");
          break;
        case "e":
          jump("mesh", "discretisation");
          break;
        case "s":
          jump("analysis", "type");
          break;
        case "r":
          if (!e.ctrlKey && !e.metaKey) runSolver();
          break;
        case "tab":
          e.preventDefault();
          setMode("post");
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
      <StatusLine />
      <CommandPalette />

      {mode === "hub" ? (
        // Hub: full-width single panel. No viewport — the hub is a
        // browsable catalog + per-card verdict + "open in post-processor"
        // affordance that flips to the post-mode for visualisation.
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            padding: 16,
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
        <>
          {/* Floating collapse button for left panels (visible when any are collapsed) */}
          {mode === "pre" && expandedLeftPanels.size < 2 && (
          <button
            style={{
              position: "fixed",
              left: 16,
              top: 120,
              zIndex: 100,
              padding: "6px 8px",
              background: "var(--bg-surface, #1f2937)",
              border: "1px solid var(--border-color, #374151)",
              color: "var(--accent, #06b6d4)",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "monospace",
            }}
            onClick={() => expandedLeftPanels.has("models") ? toggleLeftPanel("tree") : toggleLeftPanel("models")}
            title="Expand collapsed panel"
          >
            ▶
          </button>
        )}

        <main
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: (() => {
              if (mode !== "pre") return "400px minmax(640px, 1.15fr) 400px";
              const hasModels = expandedLeftPanels.has("models");
              const hasTree = expandedLeftPanels.has("tree");
              if (hasModels && hasTree) return "280px 400px minmax(640px, 1.15fr) 400px";
              if (hasModels) return "280px minmax(640px, 1.15fr) 400px";
              if (hasTree) return "400px minmax(640px, 1.15fr) 400px";
              return "minmax(640px, 1.15fr) 400px";
            })(),
            gridTemplateRows: "1fr",
            gap: 18,
            padding: 16,
            minHeight: 0,
          }}
        >
          {mode === "pre" && expandedLeftPanels.has("models") && <ModelsPanel />}
          {mode === "pre" && expandedLeftPanels.has("tree") ? <ModelTreePanel /> : mode !== "pre" ? <ResultsPanel /> : null}

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
                padding: "4px 10px",
                background: "rgba(0, 15, 40, 0.5)",
                border: "1px solid rgba(100, 180, 220, 0.1)",
                borderRadius: 999,
                fontSize: 9.5,
                fontFamily: "'JetBrains Mono', monospace",
                color: "var(--accent-muted)",
                textTransform: "uppercase",
                letterSpacing: 0.05,
                pointerEvents: "none",
                backdropFilter: "blur(6px)",
              }}
            >
              {mode === "pre"
                ? "live preview · model"
                : `result · ${selectedResultId}`}
            </div>
          </div>

          {mode === "pre" ? <PreInspectorPanel /> : <InspectorPanel />}
        </main>
        </>
      )}
    </div>
  );
}
