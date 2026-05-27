import React from "react";
import { useUI } from "../store.js";
import { MONO } from "../constants.js";

export default function TopChrome() {
  const theme = useUI((s) => s.theme);
  const toggleTheme = useUI((s) => s.toggleTheme);

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
          shell-buckling FEM · post-processor
        </span>
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
        Session 3.0
      </span>

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
