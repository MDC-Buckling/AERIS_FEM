import React from "react";
import { MONO } from "../constants.js";
import { useUI } from "../store.js";
import { BENCHMARKS, formatConvergenceRow } from "./catalog.js";

/** BENCHMARK HUB — full-width view that browses the validation suite,
 * loads a benchmark's case into the model, runs it, and auto-interprets
 * the result vs the published reference. Replaces the three-column
 * pre/post layout when mode === "hub".
 *
 * Each card carries: title + category chip + reference number + description
 * + LOAD INTO MODEL button + RUN button (single r) + RUN CONVERGENCE
 * button (multi-r sweep). After a run the card flips to show the
 * benchmark's structured verdict (PASS/FAIL + % error + critical-load
 * + per-r convergence rows). The hub stays useful across reloads: the
 * latest verdict is recomputed from each benchmark's most recent job
 * folder on disk, so closing + reopening the GUI doesn't lose history.
 */
export default function BenchmarkHubPanel() {
  const jobs = useUI((s) => s.jobs);
  const benchmarkRuns = useUI((s) => s.benchmarkRuns);
  const loadJobs = useUI((s) => s.loadJobs);
  const loadResultsManifest = useUI((s) => s.loadResultsManifest);
  const setBenchmarkRun = useUI((s) => s.setBenchmarkRun);

  // Rehydrate per-benchmark verdicts from the on-disk job index on mount
  // so closing + reopening the GUI doesn't lose the PASS/FAIL state.
  // We pick the newest `bench-<benchmark-id>-` job that exited "success".
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadJobs();
      if (cancelled) return;
      const latest = useUI.getState().jobs;
      for (const bench of BENCHMARKS) {
        if (!bench.enabled) continue;
        const prefix = `bench-${bench.id}-`;
        // jobs[] is newest-first; the first success match is the latest run.
        const success = latest.find(
          (j) => j.id.startsWith(prefix) && j.lastRunStatus === "success",
        );
        if (!success) continue;
        if (benchmarkRuns[bench.id]?.jobId === success.id) continue;
        const manifest = await loadResultsManifest(success.id);
        if (cancelled) return;
        const verdict = bench.interpret ? bench.interpret(manifest) : null;
        setBenchmarkRun(bench.id, {
          jobId: success.id,
          lastRunAt: success.lastRunAt,
          verdict,
          runningRunId: null,
        });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: 16,
      }}
    >
      <HeaderBar />
      <CardGrid jobs={jobs} benchmarkRuns={benchmarkRuns} />
    </div>
  );
}

function HeaderBar() {
  const enabledCount = BENCHMARKS.filter((b) => b.enabled).length;
  const plannedCount = BENCHMARKS.length - enabledCount;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        marginBottom: 16,
        paddingBottom: 12,
        borderBottom: "1px solid var(--line-steel-soft)",
      }}
    >
      <div>
        <div className="codex-brand-title" style={{ fontSize: 13, letterSpacing: 0.12 }}>
          BENCHMARK HUB
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 10.5,
            color: "var(--text-muted)",
            fontFamily: MONO,
            lineHeight: 1.55,
            maxWidth: 720,
          }}
        >
          Standard shell benchmarks with auto-interpreted PASS / FAIL verdicts.
          Click <span style={{ color: "var(--accent)" }}>LOAD INTO MODEL</span>{" "}
          to copy a case into the pre-processor, or{" "}
          <span style={{ color: "var(--accent)" }}>RUN</span> to submit a job
          and see the verdict here without leaving the hub.
        </div>
      </div>
      <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 10 }}>
        <div style={{ color: "var(--success)" }}>{enabledCount} live</div>
        <div style={{ color: "var(--warning)" }}>{plannedCount} planned</div>
      </div>
    </div>
  );
}

function CardGrid({ jobs, benchmarkRuns }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))",
        gap: 14,
      }}
    >
      {BENCHMARKS.map((bench) => (
        <BenchmarkCard
          key={bench.id}
          bench={bench}
          jobs={jobs}
          state={benchmarkRuns[bench.id] ?? null}
        />
      ))}
    </div>
  );
}

function BenchmarkCard({ bench, jobs, state }) {
  const loadBenchmark = useUI((s) => s.loadBenchmark);
  const runBenchmark = useUI((s) => s.runBenchmark);
  const setMode = useUI((s) => s.setMode);
  const loadResultsManifest = useUI((s) => s.loadResultsManifest);
  const setActiveJob = useUI((s) => s.setActiveJob);

  const running = !!state?.runningRunId;
  const verdict = state?.verdict ?? null;
  const passed = verdict?.status === "pass";
  const failed = verdict?.status === "fail";
  const accent = !bench.enabled
    ? "var(--warning)"
    : passed
      ? "var(--success)"
      : failed
        ? "var(--error)"
        : bench.category.color;

  // History: all past jobs whose id starts with this benchmark's prefix.
  const history = bench.enabled
    ? jobs.filter((j) => j.id.startsWith(`bench-${bench.id}-`)).slice(0, 5)
    : [];

  const handleLoad = () => {
    if (!bench.enabled) return;
    loadBenchmark(bench.modelPreset);
    setMode("pre");
  };
  const handleRun = (refines) => {
    if (!bench.enabled || running) return;
    runBenchmark(bench, { refines });
  };
  const handleOpenResult = async () => {
    if (!state?.jobId) return;
    // Wipe the result cache before loading. A stale cached entry under
    // the same (jobId, selectedId) — e.g. one that loaded the wrong
    // mesh on a previous open — would short-circuit the fresh .vts
    // fetch and we'd render the bad data again.
    useUI.setState({ resultCache: {} });
    const manifest = await loadResultsManifest(state.jobId);
    setActiveJob(state.jobId);
    // Pick a result-id that ACTUALLY exists in the new manifest before
    // flipping to post-mode. Without this we'd land in post with a stale
    // "mode0" id from a previous LBA viewing → the inspector tries to
    // render LBA-only fields on the new (possibly static) manifest and
    // can crash on undefined .toExponential() calls.
    const firstMode = manifest?.modes?.[0]?.id;
    const hasLinear = !!(manifest?.files?.linearPrestress
                          || manifest?.files?.solution);
    const fallbackId = firstMode ?? (hasLinear ? "linear" : "geometry");
    useUI.setState({ selectedResultId: fallbackId });
    setMode("post");
  };

  return (
    <div
      style={{
        position: "relative",
        padding: "14px 16px",
        background: "var(--panel-bg)",
        border: `1px solid ${bench.enabled ? "var(--line-soft)" : "var(--line-faint)"}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 6,
        fontFamily: MONO,
        opacity: bench.enabled ? 1 : 0.72,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              color: bench.enabled ? "var(--text-primary)" : "var(--text-muted)",
              lineHeight: 1.35,
            }}
          >
            {bench.name}
          </div>
          <CategoryChip category={bench.category} />
        </div>
        {verdict && (
          <VerdictBadge verdict={verdict} />
        )}
        {!bench.enabled && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "var(--warning)",
              background: "var(--warning-soft-bg)",
              border: "1px solid var(--warning-border)",
              borderRadius: 999,
              padding: "2px 8px",
              textTransform: "uppercase",
              letterSpacing: 0.08,
              flexShrink: 0,
            }}
          >
            coming soon
          </span>
        )}
      </div>

      <p
        style={{
          margin: "8px 0",
          fontSize: 10.5,
          color: "var(--text-secondary)",
          lineHeight: 1.55,
        }}
      >
        {bench.shortDescription}
      </p>

      <Row label="Reference" value={bench.referenceSource} />
      <Row label="QoI" value={bench.referenceQoI} valueAccent />
      <Row label="Tolerance" value={`${bench.tolerancePct.toFixed(1)} %`} />

      {!bench.enabled && bench.comingSoonReason && (
        <div
          style={{
            marginTop: 10,
            padding: "7px 9px",
            background: "var(--panel-bg-soft)",
            border: "1px dashed var(--warning-border)",
            borderRadius: 4,
            fontSize: 9.5,
            color: "var(--text-muted)",
            lineHeight: 1.5,
          }}
        >
          <span style={{ color: "var(--warning)", fontWeight: 700 }}>What's missing: </span>
          {bench.comingSoonReason}
        </div>
      )}

      {bench.enabled && (
        <>
          {/* Actions */}
          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              className="codex-action-button"
              onClick={handleLoad}
              title="Copy this benchmark's case into the pre-processor model"
              style={{ flex: "1 1 140px", fontSize: 10, padding: "6px 10px" }}
            >
              Load into Model
            </button>
            <button
              type="button"
              className="codex-action-button codex-action-button--primary"
              onClick={() => handleRun(bench.recipe.refines)}
              disabled={running}
              style={{
                flex: "1 1 110px", fontSize: 10, padding: "6px 10px",
                opacity: running ? 0.6 : 1,
                cursor: running ? "wait" : "pointer",
              }}
              title={`Submit a job at r=${bench.recipe.refines.join(",")} and show the verdict here`}
            >
              {running ? "⏳ Solving…" : `► Run (r=${bench.recipe.refines.join(",")})`}
            </button>
            <button
              type="button"
              className="codex-action-button"
              onClick={() => handleRun(bench.recipe.convergenceRefines)}
              disabled={running}
              title={`Convergence sweep over r=${bench.recipe.convergenceRefines.join(",")}`}
              style={{
                flex: "1 1 120px", fontSize: 10, padding: "6px 10px",
                opacity: running ? 0.6 : 1,
                cursor: running ? "wait" : "pointer",
              }}
            >
              {running ? "⏳" : `↗ Sweep (r=${bench.recipe.convergenceRefines.join(",")})`}
            </button>
          </div>

          {/* Verdict + convergence (when a run has landed) */}
          {verdict && (
            <VerdictPanel
              verdict={verdict}
              state={state}
              onOpenResult={handleOpenResult}
            />
          )}

          {/* History */}
          {history.length > 0 && (
            <HistoryStrip
              history={history}
              activeJobId={state?.jobId ?? null}
              onPick={async (jid) => {
                await loadResultsManifest(jid);
                const manifest = useUI.getState().currentResults;
                const v = bench.interpret ? bench.interpret(manifest) : null;
                useUI.getState().setBenchmarkRun(bench.id, {
                  jobId: jid,
                  lastRunAt: history.find((h) => h.id === jid)?.lastRunAt ?? null,
                  verdict: v,
                  runningRunId: null,
                });
              }}
            />
          )}

          {state?.error && (
            <div
              style={{
                marginTop: 10,
                padding: "6px 9px",
                background: "var(--error-soft-bg)",
                border: "1px solid var(--error-border)",
                borderRadius: 4,
                fontSize: 10,
                color: "var(--error)",
                lineHeight: 1.5,
              }}
            >
              {state.error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CategoryChip({ category }) {
  return (
    <span
      style={{
        display: "inline-block",
        marginTop: 4,
        padding: "1px 7px",
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.06,
        textTransform: "uppercase",
        color: category.color,
        background: "var(--panel-bg-soft)",
        border: `1px solid ${category.color}`,
        borderRadius: 999,
      }}
    >
      {category.label}
    </span>
  );
}

function VerdictBadge({ verdict }) {
  if (verdict.status === "pass") {
    return (
      <span style={badgeStyle("var(--success)", "var(--success-soft-bg)", "var(--success-border)")}>
        ✓ PASS
      </span>
    );
  }
  if (verdict.status === "fail") {
    return (
      <span style={badgeStyle("var(--error)", "var(--error-soft-bg)", "var(--error-border)")}>
        ✕ FAIL
      </span>
    );
  }
  return (
    <span style={badgeStyle("var(--warning)", "var(--warning-soft-bg)", "var(--warning-border)")}>
      {verdict.status}
    </span>
  );
}

function badgeStyle(color, bg, border) {
  return {
    fontSize: 9.5,
    fontWeight: 700,
    color,
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 999,
    padding: "2px 9px",
    textTransform: "uppercase",
    letterSpacing: 0.08,
    flexShrink: 0,
  };
}

function VerdictPanel({ verdict, state, onOpenResult }) {
  if (!verdict || verdict.status === "no-data") return null;

  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        background: "var(--panel-bg-soft)",
        border: "1px solid var(--line-soft)",
        borderRadius: 4,
      }}
    >
      <Row label="Headline" value={verdict.headline} valueAccent />
      {verdict.deviationPct != null && (
        <Row
          label="Δ vs reference"
          value={`${verdict.deviationPct >= 0 ? "+" : ""}${verdict.deviationPct.toFixed(3)} %  (tol ${verdict.tolerance ?? 1}%)`}
          valueAccent
        />
      )}

      {verdict.convergence && verdict.convergence.length > 1 && (
        <>
          <div
            style={{
              marginTop: 8,
              fontSize: 9,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
              letterSpacing: 0.08,
              marginBottom: 4,
            }}
          >
            convergence ({verdict.convergence.length} runs)
          </div>
          <pre
            style={{
              margin: 0,
              padding: "6px 8px",
              background: "rgba(0,0,0,0.35)",
              border: "1px solid var(--line-faint)",
              borderRadius: 3,
              fontSize: 9.5,
              color: "var(--text-primary)",
              lineHeight: 1.5,
              fontFamily: MONO,
            }}
          >
{verdict.convergence.map(formatConvergenceRow).join("\n")}
          </pre>
        </>
      )}

      {state?.jobId && (
        <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
          <button
            type="button"
            className="codex-action-button"
            onClick={onOpenResult}
            style={{ fontSize: 9.5, padding: "4px 9px" }}
          >
            Open in Post-Processor →
          </button>
          <span style={{ fontSize: 9, color: "var(--text-soft)", alignSelf: "center" }}>
            job: {state.jobId}
          </span>
        </div>
      )}
    </div>
  );
}

function HistoryStrip({ history, activeJobId, onPick }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          fontSize: 9,
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: 0.08,
          marginBottom: 4,
        }}
      >
        history (last {history.length})
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 3,
          maxHeight: 130,
          overflowY: "auto",
        }}
      >
        {history.map((h) => {
          const active = h.id === activeJobId;
          const colour = h.lastRunStatus === "success"
            ? "var(--success)"
            : h.lastRunStatus === "failed"
              ? "var(--error)"
              : "var(--text-muted)";
          return (
            <button
              key={h.id}
              type="button"
              onClick={() => onPick(h.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 8px",
                background: active ? "var(--control-active-bg)" : "var(--panel-bg-soft)",
                border: "1px solid var(--line-faint)",
                borderRadius: 3,
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: 10,
                textAlign: "left",
                color: active ? "var(--accent)" : "var(--text-secondary)",
              }}
            >
              <span
                style={{
                  width: 7, height: 7, borderRadius: 999,
                  background: colour,
                  flexShrink: 0,
                }}
              />
              <span style={{
                flex: 1, minWidth: 0,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {h.id}
              </span>
              <span style={{ fontSize: 9, color: "var(--text-muted)" }}>
                {h.lastDurationMs ? `${(h.lastDurationMs / 1000).toFixed(1)} s` : "—"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Row({ label, value, valueAccent }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "2px 0",
        fontSize: 10.5,
        lineHeight: 1.5,
        fontFamily: MONO,
      }}
    >
      <span
        style={{
          color: "var(--text-secondary)",
          minWidth: 96,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: valueAccent ? "var(--accent)" : "var(--text-primary)",
          fontWeight: valueAccent ? 700 : 500,
          flex: 1,
          minWidth: 0,
          wordBreak: "break-word",
        }}
      >
        {value}
      </span>
    </div>
  );
}
