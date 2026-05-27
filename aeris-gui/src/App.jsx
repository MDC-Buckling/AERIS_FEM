import React from "react";
import { useUI } from "./store.js";
import TopChrome from "./components/TopChrome.jsx";
import ResultsPanel from "./components/ResultsPanel.jsx";
import InspectorPanel from "./components/InspectorPanel.jsx";
import Viewport3D from "./viewport/Viewport3D.jsx";
import ViewportLegend from "./components/ViewportLegend.jsx";

export default function App() {
  const theme = useUI((s) => s.theme);

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
          gridTemplateColumns: "300px minmax(640px, 1fr) 320px",
          gridTemplateRows: "1fr",
          gap: 12,
          padding: 12,
          minHeight: 0, // critical for inner overflow handling
        }}
      >
        <ResultsPanel />

        {/* Central viewport — relative so the legend can absolute-position over it. */}
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
        </div>

        <InspectorPanel />
      </main>
    </div>
  );
}
