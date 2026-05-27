import React from "react";
import GlassPanel from "./ui/GlassPanel.jsx";
import SectionHeader from "./ui/SectionHeader.jsx";
import { KNOWN_RESULTS } from "../constants.js";
import { useUI } from "../store.js";
import { MONO } from "../constants.js";

/** Project the run.json sidecar's modes[] entries into the same shape
 * KNOWN_RESULTS uses (id / label / pvd / kind / description). Lets us
 * keep the rendering code uniform across "live run" and "shipped
 * fallback" cases. */
function resultsFromManifest(r) {
  if (!r) return null;
  const items = [];
  if (r.files?.geometry) {
    items.push({
      id: "geometry",
      label: "Geometry (undeformed)",
      pvd: r.files.geometry,
      kind: "geometry",
      description: `${r.geometry.n_patches}-patch${r.geometry.n_bands > 1 ? ` · ${r.geometry.n_bands} bands` : ""} cylinder · R=${r.case.R}, L=${r.case.L}, t=${r.case.t}`,
    });
  }
  if (r.files?.linearPrestress) {
    items.push({
      id: "linear",
      label: "Linear elastic (pre-buckling)",
      pvd: r.files.linearPrestress,
      kind: "displacement",
      description: r.load.kind === "bending"
        ? "Cos(θ) Tz prestress — tension on +x, compression on -x"
        : "Uniform axial Tz prestress at the E-scaled reference state",
    });
  }
  for (const m of r.modes ?? []) {
    items.push({
      id: m.id,
      label: m.label,
      pvd: m.pvd,
      kind: "mode",
      description: m.sigmaComputed != null
        ? `σ_cr = ${m.sigmaComputed.toExponential(3)} · λ = ${m.lambda.toExponential(3)}`
        : "eigenvalue not separately captured (see Mode 1 for λ_1)",
    });
  }
  return items;
}

function ResultItem({ r, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        marginBottom: 4,
        border: active
          ? "1px solid rgba(0, 229, 255, 0.4)"
          : "1px solid var(--line-steel-soft)",
        background: active ? "rgba(0, 200, 255, 0.09)" : "rgba(255,255,255,0.015)",
        borderRadius: 5,
        cursor: "pointer",
        color: active ? "var(--accent)" : "var(--text-secondary)",
        fontFamily: MONO,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: active ? 700 : 600,
          textShadow: active ? "var(--shadow-accent)" : "none",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: active ? "var(--accent)" : "var(--text-soft)",
            boxShadow: active ? "0 0 6px var(--accent)" : "none",
          }}
        />
        {r.label}
      </div>
      {r.description && (
        <div
          style={{
            marginTop: 3,
            fontSize: 10,
            color: "var(--text-muted)",
            lineHeight: 1.35,
          }}
        >
          {r.description}
        </div>
      )}
    </button>
  );
}

export default function ResultsPanel() {
  const selected = useUI((s) => s.selectedResultId);
  const select = useUI((s) => s.selectResult);
  const currentResults = useUI((s) => s.currentResults);
  const jobs = useUI((s) => s.jobs);
  const loadResultsManifest = useUI((s) => s.loadResultsManifest);
  const setActiveJob = useUI((s) => s.setActiveJob);
  const loadJobs = useUI((s) => s.loadJobs);

  // Keep the jobs list in sync — the pre-processor's Jobs panel does
  // this on mount too, but the user can park in the post-processor for
  // long stretches and we don't want a stale list.
  React.useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // Drive the list from the sidecar manifest if a real solve has landed;
  // otherwise fall back to the shipped KNOWN_RESULTS so a fresh dev
  // session still has something to look at.
  const items = resultsFromManifest(currentResults) ?? KNOWN_RESULTS;
  const isLive = !!currentResults;
  const headerHint = isLive
    ? `r=${currentResults.verdict.finestR} · ${currentResults.mesh.coupling}`
    : "cylinder LBA — r=5 (fallback)";

  // Only jobs with a successful past run have results to load. Sort by
  // newest-first so the most recent solve is at the top — matches the
  // Pre-Processor's Jobs panel ordering.
  const viewableJobs = jobs.filter((j) => j.lastRunStatus === "success");
  const loadedJobId = currentResults?.jobId ?? null;

  const handlePickJob = async (jobId) => {
    if (jobId === loadedJobId) return;
    const manifest = await loadResultsManifest(jobId);
    setActiveJob(jobId);
    // If the previously-selected result id (mode5 say) doesn't exist in
    // the newly-loaded job (which might only have 4 modes), fall back
    // to the first available item so the viewport always has something
    // valid to render.
    const newIds = new Set([
      "geometry", "linear",
      ...((manifest?.modes ?? []).map((m) => m.id)),
    ]);
    if (!newIds.has(selected)) {
      const first = manifest?.modes?.[0]?.id ?? "geometry";
      select(first);
    }
  };

  const groups = [
    { id: "geom", title: "Geometry", items: items.filter((r) => r.kind === "geometry") },
    { id: "pre", title: "Pre-buckling", items: items.filter((r) => r.kind === "displacement") },
    { id: "modes", title: "Eigenmodes", items: items.filter((r) => r.kind === "mode") },
  ];

  return (
    <GlassPanel style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <span
          className="codex-brand-title"
          style={{ fontSize: 11, letterSpacing: 0.1 }}
        >
          RESULTS
        </span>
        <span style={{ fontSize: 9.5, color: "var(--text-soft)", fontFamily: MONO }}>
          {headerHint}
        </span>
      </div>

      {/* Job picker — switch which job's results are loaded into the
          post-processor without leaving for the Pre-Processor's Jobs
          panel. Only jobs with a successful past run are listed
          (others have no run.json to load). */}
      <JobPicker
        jobs={viewableJobs}
        currentJobId={loadedJobId}
        onPick={handlePickJob}
      />

      <div style={{ marginTop: 10, overflowY: "auto", flex: 1 }}>
        {groups.map((g) => (
          <div key={g.id}>
            <SectionHeader>{g.title}</SectionHeader>
            {g.items.map((r) => (
              <ResultItem
                key={r.id}
                r={r}
                active={selected === r.id}
                onClick={() => select(r.id)}
              />
            ))}
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid var(--line-steel-soft)",
          fontSize: 10,
          color: "var(--text-muted)",
          fontFamily: MONO,
          lineHeight: 1.45,
        }}
      >
        Read from{" "}
        <span style={{ color: "var(--accent-muted)" }}>
          {loadedJobId ? `output/jobs/${loadedJobId}/` : "output/"}
        </span>{" "}
        via the dev server's <span style={{ color: "var(--accent-muted)" }}>/data</span>{" "}
        middleware. Re-solve from the Pre-Processor's Jobs panel to refresh.
      </div>
    </GlassPanel>
  );
}

/** Tight job picker dropdown. Renders as a single button showing the
 * currently-loaded job name; click to expand a list of all
 * success-status jobs. Each row picks that job and reloads its
 * manifest. Header chip shows total job count. */
function JobPicker({ jobs, currentJobId, onPick }) {
  const [open, setOpen] = React.useState(false);

  if (jobs.length === 0) {
    return (
      <div
        style={{
          marginTop: 10,
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
        No jobs with results yet. Create + solve a job from the
        Pre-Processor's <span style={{ color: "var(--accent-muted)" }}>RUN → Solve</span>{" "}
        panel, then come back here.
      </div>
    );
  }

  const current = jobs.find((j) => j.id === currentJobId);
  const buttonLabel = current ? current.name : "(pick a job)";

  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            color: "var(--text-secondary)",
            fontSize: 10,
            fontFamily: MONO,
            textTransform: "uppercase",
            letterSpacing: 0.08,
          }}
        >
          job ({jobs.length})
        </span>
        {current && (
          <span style={{ fontSize: 9, color: "var(--text-soft)", fontFamily: MONO }}>
            {current.threads}× · {relTime(current.lastRunAt ?? current.createdAt)}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          background: "var(--control-bg)",
          border: "1px solid var(--control-border-strong)",
          borderRadius: 4,
          color: "var(--accent)",
          fontFamily: MONO,
          fontSize: 11.5,
          fontWeight: 700,
          textAlign: "left",
          cursor: "pointer",
          textShadow: "var(--shadow-accent)",
        }}
      >
        <span
          style={{
            width: 8, height: 8, borderRadius: 999,
            background: "var(--success)",
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {buttonLabel}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 400 }}>
          {open ? "▼" : "▶"}
        </span>
      </button>

      {open && (
        <div
          style={{
            marginTop: 4,
            border: "1px solid var(--line-soft)",
            borderRadius: 4,
            background: "var(--panel-bg-soft)",
            maxHeight: 180,
            overflowY: "auto",
          }}
        >
          {jobs.map((j) => {
            const active = j.id === currentJobId;
            return (
              <button
                key={j.id}
                type="button"
                onClick={() => { onPick(j.id); setOpen(false); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "6px 10px",
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
                    width: 6, height: 6, borderRadius: 999,
                    background: "var(--success)",
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
                <span style={{ fontSize: 9, color: "var(--text-soft)" }}>{j.threads}×</span>
                <span style={{ fontSize: 9, color: "var(--text-muted)", minWidth: 56, textAlign: "right" }}>
                  {relTime(j.lastRunAt ?? j.createdAt)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function relTime(iso) {
  if (!iso) return "—";
  const diffSec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diffSec < 60)    return `${Math.round(diffSec)} s ago`;
  if (diffSec < 3600)  return `${Math.round(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)} h ago`;
  return `${Math.round(diffSec / 86400)} d ago`;
}
