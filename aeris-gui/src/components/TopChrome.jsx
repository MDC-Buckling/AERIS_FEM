import React, { useState } from "react";
import { useUI } from "../store.js";
import { MONO } from "../constants.js";

function ModeButton({ value, label, active, onClick, hint }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      style={{
        padding: "6px 14px",
        background: active ? "var(--control-active-bg)" : "transparent",
        border: "none",
        borderRight: "1px solid var(--control-border)",
        color: active ? "var(--accent)" : "var(--text-muted)",
        fontFamily: MONO,
        fontSize: 10.5,
        fontWeight: active ? 700 : 500,
        textTransform: "uppercase",
        letterSpacing: 0.08,
        cursor: "pointer",
        textShadow: active ? "var(--shadow-accent)" : "none",
      }}
    >
      {label}
    </button>
  );
}

export default function TopChrome() {
  const theme = useUI((s) => s.theme);
  const toggleTheme = useUI((s) => s.toggleTheme);
  const mode = useUI((s) => s.mode);
  const setMode = useUI((s) => s.setMode);
  const projectName = useUI((s) => s.projectName);

  return (
    <header
      style={{
        height: 42,
        flex: "0 0 42px",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        background: "var(--chrome-bg)",
        borderBottom: "1px solid var(--line-steel)",
        gap: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span className="codex-brand-title">AERIS</span>
        <span
          className="codex-case-line"
          style={{ borderLeft: "1px solid var(--line-steel-soft)", paddingLeft: 10 }}
        >
          shell-buckling FEM
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 10px",
          background: "var(--control-bg)",
          border: "1px solid var(--control-border)",
          borderRadius: 4,
          minWidth: 180,
        }}
      >
        <span
          style={{
            fontSize: 9,
            color: "var(--text-muted)",
            fontFamily: MONO,
            textTransform: "uppercase",
            letterSpacing: 0.08,
          }}
        >
          model
        </span>
        <span
          style={{
            color: "var(--text-primary)",
            fontSize: 11,
            fontFamily: MONO,
            fontWeight: 700,
          }}
        >
          {projectName}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 9,
            color: "var(--text-soft)",
            fontFamily: MONO,
            fontStyle: "italic",
          }}
        >
          ▾
        </span>
      </div>

      {/* Pre / Post mode switch */}
      <div
        style={{
          display: "flex",
          border: "1px solid var(--control-border)",
          borderRadius: 4,
          overflow: "hidden",
          background: "var(--control-bg)",
        }}
      >
        <ModeButton
          value="pre"
          label="Pre-Processor"
          active={mode === "pre"}
          onClick={() => setMode("pre")}
          hint="Model tree — define geometry, material, BCs, loads, analysis"
        />
        <ModeButton
          value="post"
          label="Post-Processor"
          active={mode === "post"}
          onClick={() => setMode("post")}
          hint="Results — load .pvd files, view modes interactively"
        />
      </div>

      <div style={{ flex: 1 }} />

      <span
        style={{
          fontSize: 9.5,
          color: "var(--text-soft)",
          fontFamily: MONO,
          letterSpacing: 0.05,
        }}
      >
        Session 3.2
      </span>

      <ExportModelButton />

      <button
        type="button"
        className="codex-action-button"
        onClick={toggleTheme}
        title="Toggle theme"
      >
        {theme === "dark" ? "LIGHT" : "DARK"}
      </button>
    </header>
  );
}

/** Writes the current in-memory model to ../output/model.json via the
 * dev-server's POST /save-model. Provides the GUI-to-disk link until
 * the Solve button lands and runs it implicitly. */
function ExportModelButton() {
  const exportModel = useUI((s) => s.exportModel);
  const [status, setStatus] = React.useState(null);

  const onClick = async () => {
    setStatus("…");
    try {
      const reply = await exportModel();
      if (reply.ok) {
        setStatus(`saved ${reply.bytes}B`);
        setTimeout(() => setStatus(null), 2200);
      } else {
        setStatus("err");
        console.error("export failed:", reply);
      }
    } catch (e) {
      setStatus("err");
      console.error(e);
    }
  };

  return (
    <button
      type="button"
      className="codex-action-button"
      onClick={onClick}
      title="Write current model state to ../output/model.json"
      style={{ minWidth: 110 }}
    >
      EXPORT MODEL{status && ` · ${status}`}
    </button>
  );
}
