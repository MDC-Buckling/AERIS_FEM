import React from "react";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Wired inspector for RUN > Solve.
 *
 * Session 3.10: live solver monitor. /run-solver is async — returns a
 * runId, the GUI polls /run-status every 500 ms. cylinder_lba.py emits
 * [AERIS-PHASE] <name> markers at each transition (setup → solving →
 * solving_r3 → solving_r4 → solving_r5 → verdict → plot_export → done),
 * the server tails stdout for the latest marker and the GUI renders it
 * as a phase badge + progress bar + elapsed time + rolling stdout tail.
 *
 * The list of expected phases drives the progress percentage — at
 * "solving_r5" with --refines 5 we know we're ~70 % through, etc. */

/** Phases the solver walks through, in order. Includes the per-refinement
 * substeps so a single-r Solve at r=5 shows a smooth bar. The list is
 * derived from the [AERIS-PHASE] markers emitted by cylinder_lba.py. */
const PHASE_SEQUENCE = [
  { id: "starting",    label: "Starting docker" },
  { id: "setup",       label: "Building XML + classical reference" },
  { id: "solving",     label: "Convergence sweep — assembling" },
  { id: "solving_r0",  label: "Eigenvalues at r=0" },
  { id: "solving_r1",  label: "Eigenvalues at r=1" },
  { id: "solving_r2",  label: "Eigenvalues at r=2" },
  { id: "solving_r3",  label: "Eigenvalues at r=3" },
  { id: "solving_r4",  label: "Eigenvalues at r=4" },
  { id: "solving_r5",  label: "Eigenvalues at r=5" },
  { id: "solving_r6",  label: "Eigenvalues at r=6" },
  { id: "solving_r7",  label: "Eigenvalues at r=7" },
  { id: "solving_r8",  label: "Eigenvalues at r=8" },
  { id: "verdict",     label: "Verdict + load factor" },
  { id: "plot_export", label: "ParaView export (re-running at finest r)" },
  { id: "done",        label: "Done" },
];

function phaseIndex(phase) {
  const i = PHASE_SEQUENCE.findIndex((p) => p.id === phase);
  return i >= 0 ? i : 0;
}
function phaseLabel(phase) {
  const p = PHASE_SEQUENCE.find((p) => p.id === phase);
  return p?.label ?? phase;
}
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

  // While running we use stdoutTail from the /run-status poll (server
  // truncates to last 4 KB). When done, we have the full stdout in
  // lastRun.stdout. Either way pull the last ~25 lines.
  const stdout = lastRun.stdout ?? lastRun.stdoutTail ?? "";
  const stderr = lastRun.stderr ?? "";
  const stdoutTail = stdout.split("\n").slice(-25).join("\n");
  const [showFull, setShowFull] = React.useState(false);

  // Elapsed time refresh — while running the server's elapsedMs is stale
  // between polls (up to 500 ms behind). Tick a local clock at 100 ms so
  // the displayed time looks smooth, fall back to the server value once
  // the run is terminal.
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [running]);
  const elapsedMs = running && lastRun.startedAt
    ? Date.now() - lastRun.startedAt
    : (lastRun.durationMs ?? lastRun.elapsedMs ?? 0);

  // Progress fraction = current phase index / (last phase index − 1).
  // "done" maps to 100 %; "starting" maps to 0 %. The intermediate
  // solving_rN steps spread linearly in between so the bar moves
  // visibly as the script logs each refinement.
  const phase = lastRun.phase ?? "starting";
  const pIndex = phaseIndex(phase);
  const pMax = PHASE_SEQUENCE.length - 1;
  const pPct = Math.max(0, Math.min(100, Math.round(100 * pIndex / pMax)));

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
          {running ? `● ${phase}` : success ? "✓ success" : "✕ failed"}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
          {(elapsedMs / 1000).toFixed(1)} s
        </span>
      </div>

      {/* Live monitor: phase label + progress bar, only while running. */}
      {running && (
        <div style={{ marginBottom: 8 }}>
          <div
            style={{
              color: "var(--text-primary)",
              fontSize: 10.5,
              fontFamily: MONO,
              marginBottom: 4,
              lineHeight: 1.4,
            }}
          >
            {phaseLabel(phase)}
          </div>
          <div
            style={{
              height: 8,
              background: "var(--control-bg)",
              border: "1px solid var(--control-border)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pPct}%`,
                height: "100%",
                background: "linear-gradient(90deg, var(--accent-muted) 0%, var(--accent) 100%)",
                boxShadow: "0 0 10px var(--accent)",
                transition: "width 0.3s ease",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 2,
              fontSize: 9,
              color: "var(--text-soft)",
            }}
          >
            <span>phase {pIndex} / {pMax}</span>
            <span className="num" style={{ color: "var(--accent-muted)" }}>{pPct} %</span>
          </div>
        </div>
      )}

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
