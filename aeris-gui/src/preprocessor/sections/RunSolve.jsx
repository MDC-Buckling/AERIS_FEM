import React from "react";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Wired inspector for RUN > Solve — the Jobs panel.
 *
 * Session 4.1: ABAQUS-style jobs. Each Solve lands in its own
 * output/jobs/<id>/ folder so results stack up instead of overwriting.
 * The panel is split top-to-bottom into three blocks:
 *
 *   1. Jobs list   — every job on disk, status + threads + age. Click a
 *                    row to make it active.
 *   2. New job     — inline form: name + threads → POST /jobs which
 *                    mkdirs the folder, saves the current model into it,
 *                    and selects it as the new active job.
 *   3. Active SOLVE — big run button + live monitor (phase + progress +
 *                    elapsed + stdout tail) for the active job. Phase 2
 *                    will add re-loading past results into the post-
 *                    processor; today only the current run is observable.
 *
 * If no job exists yet, clicking SOLVE auto-creates a `quick-<timestamp>`
 * job so the existing one-click flow still works for tinkering. */

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

function statusColor(s) {
  if (s === "success") return "var(--success)";
  if (s === "failed")  return "var(--error)";
  if (s === "running") return "var(--accent)";
  return "var(--text-muted)";
}

function relTime(iso) {
  if (!iso) return "—";
  const diffSec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diffSec < 60)      return `${Math.round(diffSec)} s ago`;
  if (diffSec < 3600)    return `${Math.round(diffSec / 60)} min ago`;
  if (diffSec < 86400)   return `${Math.round(diffSec / 3600)} h ago`;
  return `${Math.round(diffSec / 86400)} d ago`;
}

export default function RunSolve() {
  const jobs = useUI((s) => s.jobs);
  const activeJobId = useUI((s) => s.activeJobId);
  const setActiveJob = useUI((s) => s.setActiveJob);
  const lastRun = useUI((s) => s.lastRun);
  const runSolver = useUI((s) => s.runSolver);
  const loadJobs = useUI((s) => s.loadJobs);
  const createJob = useUI((s) => s.createJob);
  const model = useUI((s) => s.model);

  // Pull the latest jobs index on mount so the list always reflects disk.
  React.useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const [newName, setNewName] = React.useState("");
  const [newThreads, setNewThreads] = React.useState(1);
  const [createErr, setCreateErr] = React.useState(null);

  const running = lastRun.status === "running";
  const activeJob = jobs.find((j) => j.id === activeJobId);

  const handleCreate = async () => {
    setCreateErr(null);
    const res = await createJob({
      name: newName,
      threads: newThreads,
    });
    if (!res.ok) {
      setCreateErr(res.error + (res.hint ? ` — ${res.hint}` : ""));
      return;
    }
    setNewName("");
  };

  return (
    <>
      {/* ----- Jobs list ----- */}
      <SectionLabel>Jobs ({jobs.length})</SectionLabel>
      {jobs.length === 0 && (
        <div
          style={{
            padding: "8px 10px",
            background: "var(--panel-bg-soft)",
            border: "1px dashed var(--line-soft)",
            borderRadius: 4,
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: MONO,
            lineHeight: 1.5,
          }}
        >
          No jobs yet — create one below, or click SOLVE to auto-create a
          quick-named job from the current model.
        </div>
      )}
      {jobs.length > 0 && (
        <div
          style={{
            border: "1px solid var(--line-soft)",
            borderRadius: 5,
            background: "var(--panel-bg-soft)",
            overflow: "hidden",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {jobs.map((j) => {
            const active = j.id === activeJobId;
            return (
              <button
                key={j.id}
                type="button"
                onClick={() => setActiveJob(j.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "6px 8px",
                  borderBottom: "1px solid var(--line-faint)",
                  border: "none",
                  background: active ? "var(--control-active-bg)" : "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: MONO,
                }}
              >
                <span
                  style={{
                    width: 8, height: 8, borderRadius: 999,
                    background: statusColor(j.lastRunStatus),
                    boxShadow: j.lastRunStatus === "running"
                      ? "0 0 6px var(--accent)" : "none",
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 11,
                    color: active ? "var(--accent)" : "var(--text-primary)",
                    fontWeight: active ? 700 : 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={j.id}
                >
                  {j.name}
                </span>
                <span style={{ fontSize: 9, color: "var(--text-soft)" }}>
                  {j.threads}×
                </span>
                <span style={{ fontSize: 9, color: "var(--text-muted)", minWidth: 60, textAlign: "right" }}>
                  {relTime(j.lastRunAt ?? j.createdAt)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ----- New-job form ----- */}
      <SectionLabel style={{ marginTop: 12 }}>New job</SectionLabel>
      <div
        style={{
          padding: "8px 10px",
          background: "var(--panel-bg-soft)",
          border: "1px solid var(--line-soft)",
          borderRadius: 5,
          fontFamily: MONO,
        }}
      >
        <SmallLabel>Name (slug)</SmallLabel>
        <input
          type="text"
          value={newName}
          placeholder="e.g. steel-r5-axial"
          onChange={(e) => setNewName(e.target.value)}
          style={{
            width: "100%",
            background: "var(--control-bg)",
            border: "1px solid var(--control-border)",
            borderRadius: 3,
            color: "var(--text-primary)",
            fontFamily: MONO,
            fontSize: 11,
            padding: "5px 7px",
            marginBottom: 6,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <SmallLabel>
          Threads (OMP_NUM_THREADS) ·{" "}
          <span style={{ color: "var(--text-muted)" }}>
            G+Smo uses OpenMP for matrix assembly + Spectra eigenvalue iteration
          </span>
        </SmallLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            min={1}
            max={64}
            value={newThreads}
            onChange={(e) => setNewThreads(Math.max(1, Math.min(64, Number(e.target.value) || 1)))}
            style={{
              width: 70,
              background: "var(--control-bg)",
              border: "1px solid var(--control-border)",
              borderRadius: 3,
              color: "var(--text-primary)",
              fontFamily: MONO,
              fontSize: 11,
              fontWeight: 700,
              padding: "5px 7px",
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
              outline: "none",
            }}
          />
          <input
            type="range"
            min={1}
            max={16}
            value={newThreads}
            onChange={(e) => setNewThreads(Number(e.target.value))}
            style={{ flex: 1 }}
          />
        </div>
        <button
          type="button"
          className="codex-action-button"
          onClick={handleCreate}
          style={{
            marginTop: 8,
            width: "100%",
            padding: "6px 10px",
            fontSize: 11,
            letterSpacing: 0.08,
            textTransform: "uppercase",
          }}
        >
          + Create job
        </button>
        {createErr && (
          <div
            style={{
              marginTop: 6,
              fontSize: 10,
              color: "var(--error)",
              lineHeight: 1.4,
            }}
          >
            {createErr}
          </div>
        )}
      </div>

      {/* ----- Active SOLVE + monitor ----- */}
      <SectionLabel style={{ marginTop: 12 }}>
        Submit  {activeJob ? `· ${activeJob.name}` : "· (auto-create on SOLVE)"}
      </SectionLabel>
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
        in <code style={{ color: "var(--accent-muted)" }}>aeris/gismo</code> with{" "}
        <span style={{ color: "var(--accent)" }}>
          r={model.mesh.refinement} · {activeJob ? `${activeJob.threads} thread${activeJob.threads === 1 ? "" : "s"}` : "1 thread (default)"}
        </span>
        . Results land in{" "}
        <code style={{ color: "var(--accent-muted)" }}>
          output/jobs/{activeJobId ?? "<auto>"}/
        </code>.
      </div>

      {lastRun.status !== "idle" && (
        <RunStatusPanel lastRun={lastRun} />
      )}
    </>
  );
}

function SectionLabel({ children, style }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: "var(--text-secondary)",
        fontFamily: MONO,
        textTransform: "uppercase",
        letterSpacing: 0.08,
        marginBottom: 4,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function SmallLabel({ children }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: "var(--text-secondary)",
        fontFamily: MONO,
        marginBottom: 3,
      }}
    >
      {children}
    </div>
  );
}

function RunStatusPanel({ lastRun }) {
  const { status } = lastRun;
  const running = status === "running";
  const success = status === "success";
  const failed  = status === "failed";

  const stdout = lastRun.stdout ?? lastRun.stdoutTail ?? "";
  const stderr = lastRun.stderr ?? "";
  const stdoutTail = stdout.split("\n").slice(-25).join("\n");
  const [showFull, setShowFull] = React.useState(false);

  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [running]);
  const elapsedMs = running && lastRun.startedAt
    ? Date.now() - lastRun.startedAt
    : (lastRun.durationMs ?? lastRun.elapsedMs ?? 0);

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
          {lastRun.threads != null && lastRun.threads > 1 && (
            <span style={{ marginLeft: 6, color: "var(--accent-muted)" }}>
              · {lastRun.threads}×
            </span>
          )}
        </span>
      </div>

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
