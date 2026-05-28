import React from "react";
import { MONO } from "../../constants.js";

/** Inline live monitor for cylinder_static.py's GNA load-step sweep.
 *
 * Parses [AERIS-PROGRESS] lines out of the solver's stdout tail and
 * renders a tiny SVG load-deflection chart that grows as new
 * increments come in — so the user doesn't have to jump to the
 * post-processor mid-run to know "where am I on the F vs u curve".
 *
 * Plus a row of metadata badges (current step / total, DOFs, NR iter
 * count from the last step, solver tag NR|MNR|LIN). When no
 * AERIS-PROGRESS lines have been seen yet (LBA / scordelis-static /
 * pre-progress-protocol scripts) the whole panel renders nothing,
 * so it doesn't clutter the LBA monitor flow. */

const PROGRESS_LINE = /^\[AERIS-PROGRESS\]\s+(.+)$/;

/** Parse one line's `key=value key=value …` payload into a plain object.
 * Values are kept as strings here; numeric coercion happens at use site
 * (Number() not parseFloat — handles ints + scientific + signs). */
function parseFields(payload) {
  const out = {};
  for (const tok of payload.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

/** Walk stdout, pluck every AERIS-PROGRESS line, return parsed-field
 * objects split into two streams:
 *   - rows   : one per CONVERGED step (has u_qoi + F + loadFactor)
 *   - retries: one per bisection retry (has bisected="yes" + dlam +
 *              reason, no u_qoi because no convergence happened)
 *
 * Within rows, duplicate step numbers keep the LAST entry (the converged
 * value after any prior retries) — matches what the user sees on the
 * chart. retries[] is appended as-is so we can render a tiny annotation
 * sub-list under the chart.
 */
function parseProgressLines(stdout) {
  if (!stdout) return { rows: [], retries: [] };
  const byStep = new Map();
  const retries = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(PROGRESS_LINE);
    if (!m) continue;
    const fields = parseFields(m[1]);
    if (fields.bisected === "yes") {
      retries.push(fields);
      continue;
    }
    // The GNA scripts emit u_qoi/F/loadFactor; the GNIA arc-length C++
    // driver emits u/L/Dmin/bif. Normalise the GNIA keys onto the GNA
    // names so the chart + badges work for both, and keep Dmin/bif so we
    // can mark the bifurcation point.
    if (fields.u_qoi == null && fields.u != null) fields.u_qoi = fields.u;
    if (fields.loadFactor == null && fields.L != null) fields.loadFactor = fields.L;
    if (fields.F == null && fields.L != null) fields.F = fields.L; // λ as the F-axis
    const step = Number(fields.step);
    if (!Number.isFinite(step) || fields.u_qoi == null) continue;
    byStep.set(step, fields);
  }
  const rows = [...byStep.values()].sort(
    (a, b) => Number(a.step) - Number(b.step),
  );
  return { rows, retries };
}

/** Tight scientific / fixed-form number formatter that switches based on
 * magnitude. Same convention the post-processor's KeyMetric uses for
 * Newton-Raphson residuals + Tz values. */
function fmtNum(v, sig = 3) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e-2 && a < 1e4) return a >= 100 ? v.toFixed(0)
                                   : a >= 10  ? v.toFixed(1)
                                   :            v.toFixed(2);
  return v.toExponential(sig - 1);
}

/** Compute "nice" axis ticks for a given (min, max) range — same algorithm
 * matplotlib uses for AutoLocator (round step to 1·10ᵏ, 2·10ᵏ, 5·10ᵏ).
 * Returns at most `targetTicks` evenly spaced values. */
function niceTicks(lo, hi, targetTicks = 4) {
  if (!(hi > lo)) return [lo, hi];
  const span = hi - lo;
  const rawStep = span / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalised = rawStep / mag;
  const niceNorm = normalised < 1.5 ? 1
                 : normalised < 3   ? 2
                 : normalised < 7   ? 5
                 :                    10;
  const step = niceNorm * mag;
  const first = Math.ceil(lo / step) * step;
  const ticks = [];
  for (let v = first; v <= hi + 1e-9; v += step) ticks.push(v);
  return ticks;
}

/** Tiny SVG load-deflection chart. X = |u_qoi|, Y = F. Renders a
 * polyline through all increment points + a glowing dot on the
 * current (last) point. Auto-scales to the data range, with nice
 * round ticks on both axes. */
function MiniChart({ rows, width = 380, height = 180 }) {
  if (rows.length === 0) return null;
  const pad = { l: 46, r: 14, t: 12, b: 24 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const xs = rows.map((r) => Math.abs(Number(r.u_qoi)));
  const ys = rows.map((r) => Math.abs(Number(r.F)));
  const xMax = Math.max(...xs, 1e-12);
  const yMax = Math.max(...ys, 1e-12);
  // x always starts at 0 (the undeformed-undeformed origin reads "no
  // load, no displacement" — sane reference even before the first solve).
  const xMin = 0;
  const yMin = 0;
  const xTicks = niceTicks(xMin, xMax, 4);
  const yTicks = niceTicks(yMin, yMax, 4);

  const px = (v) => pad.l + ((v - xMin) / (xMax - xMin || 1)) * innerW;
  const py = (v) => pad.t + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;

  const points = rows
    .map((r, i) => `${px(Math.abs(Number(r.u_qoi)))},${py(Math.abs(Number(r.F)))}`)
    .join(" ");

  const last = rows[rows.length - 1];
  const lastX = px(Math.abs(Number(last.u_qoi)));
  const lastY = py(Math.abs(Number(last.F)));

  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block" }}
    >
      {/* axis frame */}
      <rect
        x={pad.l} y={pad.t} width={innerW} height={innerH}
        fill="rgba(0,0,0,0.25)" stroke="var(--line-faint)" strokeWidth={1}
      />
      {/* y gridlines + ticks */}
      {yTicks.map((t) => (
        <g key={`y-${t}`}>
          <line
            x1={pad.l} x2={pad.l + innerW}
            y1={py(t)}  y2={py(t)}
            stroke="var(--line-faint)" strokeWidth={0.5}
            strokeDasharray="2 3" opacity={0.5}
          />
          <text
            x={pad.l - 4} y={py(t) + 3}
            textAnchor="end"
            fill="var(--text-soft)" fontSize={9} fontFamily={MONO}
          >
            {fmtNum(t)}
          </text>
        </g>
      ))}
      {/* x gridlines + ticks */}
      {xTicks.map((t) => (
        <g key={`x-${t}`}>
          <line
            x1={px(t)} x2={px(t)}
            y1={pad.t}  y2={pad.t + innerH}
            stroke="var(--line-faint)" strokeWidth={0.5}
            strokeDasharray="2 3" opacity={0.5}
          />
          <text
            x={px(t)} y={pad.t + innerH + 12}
            textAnchor="middle"
            fill="var(--text-soft)" fontSize={9} fontFamily={MONO}
          >
            {fmtNum(t)}
          </text>
        </g>
      ))}
      {/* axis labels */}
      <text
        x={pad.l + innerW / 2} y={height - 4}
        textAnchor="middle"
        fill="var(--text-secondary)" fontSize={10} fontFamily={MONO}
      >
        |u|
      </text>
      <text
        x={10} y={pad.t + innerH / 2}
        textAnchor="middle"
        fill="var(--text-secondary)" fontSize={10} fontFamily={MONO}
        transform={`rotate(-90, 10, ${pad.t + innerH / 2})`}
      >
        F
      </text>
      {/* the curve */}
      <polyline
        points={points}
        fill="none"
        stroke="var(--accent)" strokeWidth={1.5}
      />
      {/* per-point dots. A row with bif=1 (GNIA limit/buckling point) is
          drawn as a larger amber-red marker so the knockdown load reads
          straight off the chart. */}
      {rows.map((r, i) => {
        const isLast = i === rows.length - 1;
        const isBif = Number(r.bif) === 1;
        return (
          <circle
            key={i}
            cx={px(Math.abs(Number(r.u_qoi)))}
            cy={py(Math.abs(Number(r.F)))}
            r={isBif ? 5 : isLast ? 4 : 2}
            fill={isBif ? "#ff5a3c" : isLast ? "var(--accent)" : "var(--accent-muted)"}
            stroke={isBif ? "#ff5a3c" : isLast ? "var(--accent)" : "none"}
            style={
              isBif ? { filter: "drop-shadow(0 0 6px #ff5a3c)" }
                : isLast ? { filter: "drop-shadow(0 0 4px var(--accent))" }
                : undefined
            }
          />
        );
      })}
      {/* leader to last-point readout */}
      <line
        x1={lastX} x2={pad.l + innerW + 2}
        y1={lastY} y2={lastY}
        stroke="var(--accent)" strokeWidth={0.5}
        strokeDasharray="2 2" opacity={0.6}
      />
    </svg>
  );
}

function Badge({ label, value, accent }) {
  return (
    <div
      style={{
        display: "flex", flexDirection: "column",
        gap: 1, padding: "3px 8px",
        background: "rgba(0,0,0,0.25)",
        border: "1px solid var(--line-faint)",
        borderRadius: 3,
        fontFamily: MONO,
        minWidth: 60,
      }}
    >
      <span
        style={{
          color: "var(--text-soft)", fontSize: 8.5,
          letterSpacing: 0.06, textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: accent ? "var(--accent)" : "var(--text-primary)",
          fontSize: 11, fontWeight: accent ? 700 : 500,
          textShadow: accent ? "var(--shadow-accent)" : "none",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export default function LoadDeflectionPanel({ stdout }) {
  const { rows, retries } = React.useMemo(
    () => parseProgressLines(stdout), [stdout]);
  if (rows.length === 0 && retries.length === 0) return null;

  // Pure-retry edge case: bisection happened but no step has converged
  // yet (or the run is on its very first attempt mid-bisection). Render
  // a minimal "waiting for first converged step" placeholder.
  if (rows.length === 0) {
    return (
      <div
        style={{
          marginTop: 10, padding: "8px 10px",
          background: "var(--panel-bg-soft)",
          border: "1px solid var(--warning-border)",
          borderRadius: 4, fontFamily: MONO,
          fontSize: 10, color: "var(--text-secondary)",
        }}
      >
        bisecting before first converged step · {retries.length}{" "}
        retry{retries.length === 1 ? "" : "s"} so far
      </div>
    );
  }

  const last = rows[rows.length - 1];
  const dofs = last.dofs && last.dofs !== "?" ? Number(last.dofs) : null;
  const nrIter = Number(last.nrIter);
  const innerSolves = last.innerSolves != null ? Number(last.innerSolves) : null;
  const F = Math.abs(Number(last.F));
  const u = Math.abs(Number(last.u_qoi));
  const stepN = Number(last.step);
  const stepTotal = Number(last.of);
  const solverTag = last.solver ?? "—";
  const dlam = last.dlam != null ? Number(last.dlam) : null;
  const controlMode = last.control ?? "force";
  // GNIA (arc-length) extras: solver tag "ALM", Dmin stability indicator,
  // bif flag. lambdaCr = peak load factor up to the bifurcation step =
  // the knockdown factor (reference load is auto-scaled to classical F_cr).
  const isGnia = solverTag === "ALM";
  const Dmin = last.Dmin != null ? Number(last.Dmin) : null;
  const bifRow = rows.find((r) => Number(r.bif) === 1);
  const lambdaCr = bifRow
    ? Math.max(...rows
        .filter((r) => Number(r.step) <= Number(bifRow.step))
        .map((r) => Math.abs(Number(r.loadFactor))))
    : null;

  return (
    <div
      style={{
        marginTop: 10,
        padding: "8px 10px",
        background: "var(--panel-bg-soft)",
        border: "1px solid var(--accent-muted)",
        borderRadius: 4,
        fontFamily: MONO,
        overflowX: "auto",
        minWidth: 0,
      }}
    >
      <div
        style={{
          color: "var(--accent)", fontSize: 9.5,
          textTransform: "uppercase", letterSpacing: 0.08,
          marginBottom: 6, fontWeight: 700,
        }}
      >
        {isGnia ? "live arc-length (GNIA)" : "live load-deflection"} · step {stepN} / {stepTotal}
        {controlMode === "displacement" && (
          <span style={{ marginLeft: 6, color: "var(--text-soft)", fontWeight: 500 }}>
            · disp control
          </span>
        )}
        {bifRow && (
          <span style={{ marginLeft: 6, color: "#ff5a3c", fontWeight: 700 }}>
            · ⚠ buckled (step {Number(bifRow.step)})
          </span>
        )}
      </div>

      <MiniChart rows={rows} />

      {/* Metadata badge row. GNIA shows λ (load factor) + Dmin (stability
          indicator) + the knockdown factor once buckled; GNA/LSA show
          F / NR-iter / Δλ. Wraps on narrow viewports. */}
      <div
        style={{
          marginTop: 6,
          display: "flex", flexWrap: "wrap", gap: 4,
        }}
      >
        {isGnia ? (
          <>
            <Badge label="λ" value={fmtNum(F)} accent />
            <Badge label="|u|" value={fmtNum(u)} accent />
            <Badge label="step" value={`${stepN} / ${stepTotal}`} />
            <Badge label="Dmin" value={Dmin != null ? fmtNum(Dmin) : "—"} />
            {lambdaCr != null && (
              <Badge label="knockdown" value={lambdaCr.toFixed(3)} accent />
            )}
            <Badge label="solver" value="ALM" />
            <Badge label="DOFs" value={dofs ? dofs.toLocaleString() : "—"} />
          </>
        ) : (
          <>
            <Badge label="F" value={fmtNum(F)} accent />
            <Badge label="|u|" value={fmtNum(u)} accent />
            <Badge label="step" value={`${stepN} / ${stepTotal}`} />
            <Badge label="solver" value={solverTag} />
            <Badge label="DOFs" value={dofs ? dofs.toLocaleString() : "—"} />
            <Badge label="NR iter" value={Number.isFinite(nrIter) ? String(nrIter) : "—"} />
            {dlam != null && Number.isFinite(dlam) && (
              <Badge label="Δλ" value={fmtNum(dlam)} />
            )}
            {innerSolves != null && innerSolves > 1 && (
              <Badge label="inner" value={String(innerSolves)} />
            )}
          </>
        )}
      </div>

      {/* Bisection-retry trace — shows when the adaptive walker had to
          halve Δλ. Each entry: at which λ the divergence trip fired +
          new Δλ + the heuristic that caught it. Stays collapsed (max
          80 px tall, scrolls) so it doesn't dominate the panel when
          there are many retries near a limit point. */}
      {retries.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              color: "var(--warning)", fontSize: 9,
              textTransform: "uppercase", letterSpacing: 0.06,
              marginBottom: 3, fontWeight: 700,
            }}
          >
            adaptive retries ({retries.length})
          </div>
          <div
            style={{
              maxHeight: 80, overflowY: "auto",
              background: "rgba(0,0,0,0.25)",
              border: "1px solid var(--warning-border)",
              borderRadius: 3,
              padding: "4px 6px",
              fontSize: 9.5, fontFamily: MONO,
              color: "var(--text-secondary)", lineHeight: 1.4,
            }}
          >
            {retries.map((r, i) => (
              <div key={i}>
                step {r.step} · λ={r.lam} · bisect Δλ → {r.dlam} ·{" "}
                <span style={{ color: "var(--warning)" }}>
                  {(r.reason ?? "?").replace(/_/g, " ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
