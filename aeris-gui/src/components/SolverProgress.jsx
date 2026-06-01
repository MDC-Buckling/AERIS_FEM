import React from "react";
import { useUI } from "../store.js";
import { MONO } from "../constants.js";

/** Live solver progress HUD — overlaid on the viewport while a solve runs.
 * Reads lastRun.{status,phase,startedAt}; the dispatcher streams the wrappers'
 * [AERIS-PHASE] markers into record.phase and the runSolver poll mirrors it
 * into lastRun.phase, so this just needs to render the current stage with an
 * animated stepper. Phases follow the Code_Aster wrappers (setup → meshing →
 * comm → solving → parsing → modes → verdict → done); unknown markers (IGA's
 * solving_rN) still light the "solving" step. */

const PHASES = [
  ["setup", "Setup"],
  ["meshing", "Meshing"],
  ["comm", "Build .comm"],
  ["solving", "Solving"],
  ["parsing", "Parsing"],
  ["modes", "Mode shapes"],
  ["verdict", "Verdict"],
  ["done", "Done"],
];

// Parse the wrapper's mesh line ("3953 nodes, 7740 DKT elements") out of the
// streamed stdout so we can show rough matrix stats while the solve runs.
function parseMeshStats(stdout) {
  if (!stdout) return null;
  const nodes = stdout.match(/(\d+)\s+nodes/);
  const elems = stdout.match(/(\d+)\s+([A-Za-z0-9_]+)\s+elements/);
  if (!nodes) return null;
  const n = parseInt(nodes[1], 10);
  return {
    nodes: n,
    elements: elems ? parseInt(elems[1], 10) : null,
    family: elems ? elems[2] : null,
  };
}

// Short "how the solver works" blurb per analysis kind.
function solverBlurb(kind) {
  switch (kind) {
    case "lba":
      return "Eigenvalue extraction: shift-invert Lanczos (Sorensen/IRAM) — factorise (K + σ₀·K_g) once near the cluster (σ₀≈1.2), then iterate to the lowest critical factors λ. The iteration is largely serial.";
    case "gna":
      return "Newton-Raphson: re-assemble + re-factorise the tangent K(u) each iteration, solve K·Δu = −r(u), until the residual drops below tolerance.";
    case "gnia":
      return "Arc-length continuation (Riks/Crisfield): traces the load-displacement path past the limit point, re-factorising the tangent each increment.";
    default:
      return "Direct sparse factorisation (MUMPS, LDLᵀ): factorise K once, back-substitute K·u = F. Parallelises well across threads.";
  }
}

// Map a raw phase marker to an index in PHASES (best-effort).
function phaseIndex(raw) {
  if (!raw) return 0;
  const p = String(raw).toLowerCase();
  if (p === "queued" || p === "starting") return 0;
  // exact match first
  const exact = PHASES.findIndex(([k]) => k === p);
  if (exact >= 0) return exact;
  // prefix match (e.g. "solving_r5" → solving)
  const pre = PHASES.findIndex(([k]) => p.startsWith(k));
  return pre >= 0 ? pre : 3; // default to "solving" for unrecognised work markers
}

export default function SolverProgress() {
  const lastRun = useUI((s) => s.lastRun) ?? {};
  const analysisKind = useUI((s) => s.model.analysis?.kind);
  const running = lastRun.status === "running" || lastRun.status === "queued";
  const [, force] = React.useReducer((x) => x + 1, 0);

  // The mesh line ("X nodes…") prints early, then Code_Aster floods stdout and
  // it scrolls out of the polled tail. Remember it per run so the matrix stats
  // stay shown for the whole solve.
  const statsRef = React.useRef({ runId: null, stats: null });
  if (lastRun.runId !== statsRef.current.runId) {
    statsRef.current = { runId: lastRun.runId, stats: null };
  }
  const freshStats = parseMeshStats(lastRun.stdoutTail || lastRun.stdout);
  if (freshStats) statsRef.current.stats = freshStats;

  // Tick once a second so the elapsed clock updates while running.
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(force, 1000);
    return () => clearInterval(id);
  }, [running]);

  if (!running) return null;

  const idx = phaseIndex(lastRun.phase);
  const elapsed = lastRun.startedAt ? Math.max(0, (Date.now() - lastRun.startedAt) / 1000) : 0;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 16px",
        background: "rgba(0, 15, 40, 0.7)",
        border: "1px solid rgba(100, 180, 220, 0.22)",
        borderRadius: 10,
        backdropFilter: "blur(8px)",
        zIndex: 6,
        minWidth: 460,
      }}
    >
      <style>{`
        @keyframes aeris-pulse { 0%,100%{opacity:.35;transform:scale(.85)} 50%{opacity:1;transform:scale(1.15)} }
        @keyframes aeris-spin  { to { transform: rotate(360deg) } }
      `}</style>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 12, height: 12, borderRadius: "50%",
            border: "2px solid var(--accent)", borderTopColor: "transparent",
            display: "inline-block", animation: "aeris-spin 0.8s linear infinite",
          }}
        />
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>
          {(PHASES[idx] && PHASES[idx][1]) || lastRun.phase || "Solving"}…
        </span>
        <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 10, color: "var(--text-muted)" }}>
          {elapsed.toFixed(0)} s
        </span>
      </div>

      {/* Stepper: filled = done, pulsing = current, dim = pending. */}
      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        {PHASES.map(([key, label], i) => {
          const done = i < idx;
          const active = i === idx;
          const color = done ? "var(--success)" : active ? "var(--accent)" : "var(--text-soft)";
          return (
            <React.Fragment key={key}>
              {i > 0 && (
                <span
                  style={{
                    flex: 1, height: 2,
                    background: i <= idx ? "var(--accent)" : "rgba(120,150,180,0.25)",
                  }}
                />
              )}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, minWidth: 44 }}>
                <span
                  style={{
                    width: 9, height: 9, borderRadius: "50%",
                    background: done || active ? color : "transparent",
                    border: `2px solid ${color}`,
                    animation: active ? "aeris-pulse 1.1s ease-in-out infinite" : "none",
                  }}
                />
                <span style={{ fontFamily: MONO, fontSize: 8, color, whiteSpace: "nowrap" }}>{label}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Solver internals — rough matrix stats (once meshed) + how it solves. */}
      {(() => {
        const stats = statsRef.current.stats;
        const dof = stats ? stats.nodes * 6 : null; // 6 DOF/node (shell: u + rot)
        const nnzPerRow = 42;                        // ~ (1 + ~6 neighbours)·6, rough
        const occupancy = dof ? (nnzPerRow / dof) * 100 : null;
        return (
          <div style={{ borderTop: "1px solid rgba(120,150,180,0.18)", paddingTop: 7, marginTop: 2 }}>
            <div style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {dof ? (
                <>
                  <span style={{ color: "var(--accent-muted)" }}>K matrix</span>{" "}
                  ≈ {dof.toLocaleString()} × {dof.toLocaleString()} DOF
                  {stats.elements ? ` · ${stats.nodes.toLocaleString()} nodes / ${stats.elements.toLocaleString()} ${stats.family || ""} elems` : ""}
                  {" · "}~{nnzPerRow} nonzeros/row (≈{occupancy.toFixed(occupancy < 0.1 ? 3 : 2)}% filled — sparse/banded)
                </>
              ) : (
                <span style={{ color: "var(--text-muted)" }}>meshing… (matrix size shown once the mesh is built)</span>
              )}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 9, color: "var(--text-muted)", lineHeight: 1.45, marginTop: 4 }}>
              {solverBlurb(analysisKind)}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
