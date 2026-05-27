import React from "react";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Wired inspector for RUN > Solve.
 *
 * Session 3.9: blocking SOLVE. Clicking the button serialises the model,
 * POSTs to /save-model (writes ../output/model.json on disk), then POSTs
 * to /run-solver which spawns the docker container and waits for the
 * cylinder_lba.py exit. The button shows a spinner while the run is in
 * flight; the panel below it renders the last lines of stdout (where
 * the Verdict block lives) plus exit code + duration on completion.
 *
 * No streaming, no job queue, no auto-switch into the post-processor —
 * those land separately. */
export default function RunSolve() {
  const lastRun = useUI((s) => s.lastRun);
  const runSolver = useUI((s) => s.runSolver);
  const setMode = useUI((s) => s.setMode);
  const model = useUI((s) => s.model);

  const running = lastRun.status === "running";
  const success = lastRun.status === "success";
  const failed  = lastRun.status === "failed";

  return (
    <>
      <button
        type="button"
        className={`codex-action-button codex-action-button--primary${running ? " codex-action-button--busy" : ""}`}
        onClick={() => { if (!running) runSolver(); }}
        disabled={running}
        style={{
          width: "100%",
          minHeight: 38,
          fontSize: 12,
          letterSpacing: 0.12,
          opacity: running ? 0.7 : 1,
          cursor: running ? "wait" : "pointer",
        }}
      >
        {running ? "⏳  SOLVING…" : "►  SOLVE"}
      </button>

      <div
        style={{
          marginTop: 8,
          fontSize: 10,
          color: "var(--text-muted)",
          fontFamily: MONO,
          lineHeight: 1.5,
        }}
      >
        Runs <code style={{ color: "var(--accent-muted)" }}>cylinder_lba.py</code>{" "}
        inside the <code style={{ color: "var(--accent-muted)" }}>aeris/gismo</code>{" "}
        container at refinement{" "}
        <span style={{ color: "var(--accent)" }}>r={model.mesh.refinement}</span>{" "}
        with the current model. Wall time depends on r (typically 10–60 s at
        r=5, faster at lower r). The dev server pipes stdout/stderr back here
        when the run finishes — no streaming yet.
      </div>

      {/* ----- status panel ----- */}
      {lastRun.status !== "idle" && (
        <RunStatusPanel lastRun={lastRun} onOpenPostMode={() => setMode("post")} />
      )}
    </>
  );
}

function RunStatusPanel({ lastRun, onOpenPostMode }) {
  const { status } = lastRun;
  const running = status === "running";
  const success = status === "success";
  const failed  = status === "failed";

  // Pull the last ~25 lines of stdout — the Verdict block plus the
  // critical-load summary always lands there, so the user sees the
  // headline result without scrolling. Full stdout is available via
  // the "Show full output" disclosure below.
  const stdout = lastRun.stdout ?? "";
  const stderr = lastRun.stderr ?? "";
  const stdoutTail = stdout.split("\n").slice(-25).join("\n");
  const [showFull, setShowFull] = React.useState(false);

  const accentColor = success ? "var(--success)" : failed ? "var(--error)" : "var(--accent)";

  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        background: "var(--panel-bg-soft)",
        border: `1px solid ${success ? "var(--success-border)" : failed ? "var(--error-border)" : "var(--line-soft)"}`,
        borderRadius: 5,
        fontFamily: MONO,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span
          style={{
            color: accentColor,
            fontWeight: 700,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.08,
          }}
        >
          {running ? "running" : success ? "success" : "failed"}
        </span>
        {lastRun.durationMs != null && (
          <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
            {(lastRun.durationMs / 1000).toFixed(1)} s
          </span>
        )}
      </div>

      {failed && lastRun.error && (
        <div
          style={{
            color: "var(--error)",
            fontSize: 11,
            marginBottom: 6,
            lineHeight: 1.5,
          }}
        >
          {lastRun.error}
        </div>
      )}

      {(success || failed) && lastRun.exitCode != null && (
        <div style={{ color: "var(--text-secondary)", fontSize: 10, marginBottom: 6 }}>
          exit code: <span className="num" style={{ color: accentColor, fontWeight: 700 }}>{lastRun.exitCode}</span>
          {lastRun.killedByTimeout && (
            <span style={{ marginLeft: 8, color: "var(--warning)" }}>
              (killed by 5-min timeout)
            </span>
          )}
        </div>
      )}

      {stdoutTail && (
        <>
          <div
            style={{
              color: "var(--text-secondary)",
              fontSize: 10,
              marginBottom: 3,
              textTransform: "uppercase",
              letterSpacing: 0.05,
            }}
          >
            output (last 25 lines)
          </div>
          <pre
            style={{
              margin: 0,
              padding: "8px 10px",
              background: "rgba(0,0,0,0.35)",
              border: "1px solid var(--line-faint)",
              borderRadius: 3,
              fontSize: 10,
              color: "var(--text-primary)",
              lineHeight: 1.4,
              maxHeight: 260,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
{stdoutTail}
          </pre>
        </>
      )}

      {stderr && stderr.trim().length > 0 && (
        <>
          <div
            style={{
              marginTop: 8,
              color: "var(--warning)",
              fontSize: 10,
              marginBottom: 3,
              textTransform: "uppercase",
              letterSpacing: 0.05,
            }}
          >
            stderr
          </div>
          <pre
            style={{
              margin: 0,
              padding: "8px 10px",
              background: "rgba(0,0,0,0.35)",
              border: "1px solid var(--warning-border)",
              borderRadius: 3,
              fontSize: 10,
              color: "var(--warning)",
              lineHeight: 1.4,
              maxHeight: 180,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
{stderr}
          </pre>
        </>
      )}

      {success && (
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <button
            type="button"
            className="codex-action-button"
            onClick={onOpenPostMode}
            style={{
              padding: "6px 12px",
              fontSize: 10,
              letterSpacing: 0.08,
              textTransform: "uppercase",
            }}
          >
            Open Post-Processor →
          </button>
        </div>
      )}

      {stdout.length > stdoutTail.length && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            className="codex-action-button"
            onClick={() => setShowFull((v) => !v)}
            style={{
              padding: "4px 8px",
              fontSize: 9.5,
              letterSpacing: 0.05,
              textTransform: "uppercase",
            }}
          >
            {showFull ? "▼" : "▶"}  full output ({stdout.split("\n").length} lines)
          </button>
          {showFull && (
            <pre
              style={{
                marginTop: 6,
                padding: "8px 10px",
                background: "rgba(0,0,0,0.35)",
                border: "1px solid var(--line-faint)",
                borderRadius: 3,
                fontSize: 9.5,
                color: "var(--text-secondary)",
                lineHeight: 1.4,
                maxHeight: 360,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
{stdout}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
