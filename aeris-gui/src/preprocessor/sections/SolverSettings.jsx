import React from "react";
import NumberField from "../../components/ui/NumberField.jsx";
import ToggleGroup from "../../components/ui/ToggleGroup.jsx";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Functional inspector for ANALYSIS STEP > Solver Settings.
 *
 * Wires model.analysis.{solver,nmodes,shift,tolerance,ncv_factor,
 * interface_penalty} end-to-end to cylinder_lba.py / Spectra. Two
 * groups: BASIC (solver mode + #modes + shift) always visible, ADVANCED
 * (tolerance + ncv_factor + interface penalty) behind a disclosure.
 *
 * Each field has a rich hint describing both the SOLUTION impact (does
 * tightening this make the eigenvalue more accurate?) and the RUNTIME
 * impact (does tightening this make the solve 2× slower?). User-facing
 * knobs only — Spectra's selectionRule + sortRule + verbose are
 * hardcoded in build_cylinder_xml because they're internal to the
 * shift-invert family. */

const SOLVER_OPTIONS = [
  // schema name → method label. All three are Spectra (Krylov-Schur =
  // Lanczos-family) eigen-transforms; named by method so the user reads
  // the algorithm, not an internal id.
  ["spectra-buckling",     "Lanczos · Buckling"],
  ["spectra-shift-invert", "Lanczos · Shift-Invert"],
  ["spectra-cayley",       "Lanczos · Cayley"],
];

/** Per-mode descriptive block — title + one-liner + when to pick + caveat
 * + how the shift behaves. Shown under the toggle so the user sees what's
 * actually different about the currently selected mode, not all three at
 * once. */
const SOLVER_INFO = {
  "spectra-buckling": {
    title: "Spectra GEigsMode::Buckling  (mode 3)",
    line: "Specialised for K_L · v = λ · K_geom · v with K_L SPD and K_geom indefinite — exactly our LBA shape.",
    bestWhen: "default for every load case we wire (axial, bending, …). Fastest convergence on the lowest physical buckling mode.",
    caveat: "demands a strictly positive shift below the smallest expected eigenvalue. The auto-shift handles this; with EXPLICIT, pick a number between 0 and your expected λ_1 (in normalised units, i.e. ≈ σ_cr / E).",
    shiftHint: "shift acts as a lower bound on the spectrum being hunted — eigenvalues nearest from above come back first.",
  },
  "spectra-shift-invert": {
    title: "Spectra GEigsMode::ShiftInvert  (mode 2)",
    line: "Generic shift-invert. Solves (K − σ·M)⁻¹ M v = θ v with θ = 1/(λ − σ); transforms the spectrum so eigenvalues closest to σ map to the largest |θ|.",
    bestWhen: "fallback when Buckling mode reports non-convergence or returns garbage at extreme parameters (very large E, very thin shell, bad conditioning).",
    caveat: "no positivity guarantee — may return spurious eigenvalues if the shift sits inside a cluster. Use the same auto-shift as Buckling; deviate only with a specific cluster target in mind.",
    shiftHint: "shift is a CENTER point. The N nearest eigenvalues (above OR below σ) come back first.",
  },
  "spectra-cayley": {
    title: "Spectra GEigsMode::Cayley  (mode 4)",
    line: "Cayley-transform shift-invert: maps the spectrum via (λ − σ) / (λ + σ), then shift-inverts. Often better separates clustered eigenvalues than mode 2.",
    bestWhen: "ablation / cross-check during validation, or when Shift-Invert gets stuck on a degenerate doublet pair. Rare in practice for cylinder LBA — keep around as a sanity-check tool.",
    caveat: "shift must NOT lie at zero or at any eigenvalue (Cayley transform singular there). Auto-shift = σ_cr/E is safely off both.",
    shiftHint: "shift is a pivot for the (λ−σ)/(λ+σ) transform. Picking close to an eigenvalue speeds convergence but risks numerical breakdown if exact.",
  },
};

export default function SolverSettings() {
  const analysis = useUI((s) => s.model.analysis);
  const setField = useUI((s) => s.setAnalysisField);
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  // "shift" lives in the model as either the string "auto" (default) or a
  // float. Surface as a NumberField with a separate "AUTO" / "EXPLICIT"
  // toggle so the user sees both options without us hiding the value.
  const shiftAuto = analysis.shift === "auto" || analysis.shift == null;
  const shiftValue = typeof analysis.shift === "number" ? analysis.shift : 0;

  const info = SOLVER_INFO[analysis.solver] ?? SOLVER_INFO["spectra-buckling"];

  // Static / GNA analysis = no eigenvalue iteration, so Spectra mode +
  // nmodes + spectral-shift are physically meaningless and get hidden.
  // tolerance + ncv_factor + interface_penalty stay visible because both
  // paths still use the same gsThinShellAssembler infrastructure
  // (tolerance applies to the linear solver inside each NR step,
  // ifc penalty to the patch-coupling fallback).
  const isStatic = analysis.kind === "static";
  const isGNA    = analysis.kind === "gna";
  const isGNIA   = analysis.kind === "gnia";
  // GNIA also hides the Spectra eigenvalue knobs (it's an arc-length
  // continuation, not an eigenproblem) — fold it into the linear-banner
  // path and give it its own arc-length parameter block below.
  const isLinear = isStatic || isGNA || isGNIA;
  const analysisLabel = isGNIA ? "GNIA (Geometrically Nonlinear Imperfection Analysis)"
                      : isGNA  ? "GNA (Geometrically Nonlinear Analysis)"
                               : "LSA (Linear Static Analysis)";

  return (
    <>
      {isLinear && (
        <div
          style={{
            marginBottom: 12,
            padding: "8px 10px",
            background: "var(--panel-bg-soft)",
            border: "1px dashed var(--accent-muted)",
            borderRadius: 4,
            fontSize: 10.5,
            color: "var(--text-secondary)",
            fontFamily: MONO,
            lineHeight: 1.5,
          }}
        >
          <span style={{ color: "var(--accent)", fontWeight: 700 }}>
            {analysisLabel} active.
          </span>{" "}
          Eigenvalue-only knobs (Spectra mode, nmodes, spectral shift) are
          hidden because they don't apply to{" "}
          {isGNIA ? "an arc-length continuation"
            : isGNA ? "a Newton-Raphson on K(u)·Δu = r(u)"
            : "a direct K · u = F"}{" "}
          solve. The advanced solver knobs below still affect the linear
          solver (tolerance) and patch-coupling fallback (interface penalty).
        </div>
      )}

      {/* LSA solver method — a single direct K·u=F solve. The linear
          backend (sparse LDLT) isn't user-tunable yet (iterative CG is a
          follow-up), so we show it as fixed info rather than a 1-option
          dropdown. */}
      {isStatic && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: "var(--text-secondary)", fontSize: 10.5,
                        fontFamily: MONO, marginBottom: 4 }}>
            Solver method
          </div>
          <div style={{ padding: "6px 10px", background: "var(--control-bg)",
                        border: "1px solid var(--control-border)",
                        borderRadius: 4, fontFamily: MONO, fontSize: 11,
                        color: "var(--text-primary)" }}>
            Direct · sparse LDLT
            <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 9.5 }}>
              (iterative CG — later)
            </span>
          </div>
        </div>
      )}

      {/* GNA-only: ABAQUS-style increment controls. Adaptive walker
          starts at initIncrement, bisects /2 on Newton divergence (floor
          minIncrement → halt below), grows ×1.5 after 3 ok steps
          (cap maxIncrement). maxIncrements is the hard cap on total
          attempts (retries + ok) — match ABAQUS's "MAXIMUM NUMBER OF
          INCREMENTS" semantics so the mental model carries over. Hidden
          for LSA (single direct solve, nothing to ramp). */}
      {/* GNA solver method — Newton-Raphson (default) or Dynamic
          Relaxation. Both drive static_shell_XML's composite solver;
          DR is explicit/robust for very unstable transients, NR is the
          standard implicit choice. */}
      {isGNA && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: "var(--text-secondary)", fontSize: 10.5,
                        fontFamily: MONO, marginBottom: 4 }}>
            Solver method
          </div>
          <ToggleGroup
            options={[["newton", "Newton-Raphson"], ["dr", "Dynamic Relaxation"]]}
            value={analysis.gnaSolver ?? "newton"}
            onChange={(v) => setField("gnaSolver", v)}
            fullWidth
          />
          <div style={{ fontSize: 9.5, color: "var(--text-muted)", fontFamily: MONO,
                        marginTop: 4, lineHeight: 1.4 }}>
            Newton-Raphson — implicit, quadratic convergence, the default.
            Dynamic Relaxation — pseudo-transient explicit, slower but
            robust when NR diverges on strongly snapping paths.
          </div>
        </div>
      )}

      {isGNA && (
        <div
          style={{
            marginTop: 6, marginBottom: 12,
            padding: "10px 12px",
            background: "var(--panel-bg-soft)",
            border: "1px solid var(--line-soft)",
            borderRadius: 4,
          }}
        >
          <div
            style={{
              color: "var(--accent)", fontSize: 10.5,
              fontWeight: 700, marginBottom: 8,
              textTransform: "uppercase", letterSpacing: 0.08,
              textShadow: "var(--shadow-accent)",
            }}
          >
            Load increment control · ABAQUS-style
          </div>
          <NumberField
            label="Maximum number of increments"
            value={analysis.maxIncrements ?? 100}
            min={1}
            max={10000}
            step={10}
            onChange={(v) => setField("maxIncrements", Math.max(1, Math.round(v)))}
            hint="Hard cap on TOTAL step attempts (retries + ok). The walker halts when reached even if λ < 1.0; bump if your run truncates short. ABAQUS default is 100."
          />
          <NumberField
            label="Initial increment  (Δλ_init)"
            value={analysis.initIncrement ?? 0.01}
            min={1e-9}
            max={1.0}
            step={0.01}
            precision={6}
            onChange={(v) => setField("initIncrement", Math.max(1e-9, v))}
            hint="Δλ at the start of the walk, as a fraction of full load (0.01 = 1 % per step). Smaller = better Newton starting guess on stiff problems; larger = faster on linear regions (adaptive grows back to maxIncrement anyway)."
          />
          <NumberField
            label="Maximum increment  (Δλ_max)"
            value={analysis.maxIncrement ?? 0.1}
            min={1e-9}
            max={1.0}
            step={0.01}
            precision={6}
            onChange={(v) => setField("maxIncrement", Math.max(1e-9, v))}
            hint="Ceiling for grow-back. Δλ never exceeds this even after long stable runs, so the curve stays detailed enough to catch softening. 0.1 = 10 % per step (max 10 points on a fully-linear path)."
          />
          <NumberField
            label="Minimum increment  (Δλ_min)"
            value={analysis.minIncrement ?? 1e-5}
            min={1e-12}
            max={1.0}
            step={1e-5}
            precision={9}
            onChange={(v) => setField("minIncrement", Math.max(1e-12, v))}
            hint="Floor for bisection. If a bisect would drop Δλ below this the walker halts and verdict.haltedReason records the load level it couldn't get past. Tight floor (1e-5) lets the walker hunt deep before giving up."
          />
        </div>
      )}

      {/* GNIA-only: arc-length continuation params. The reference load is
          auto-scaled so λ=1 == classical F_cr, so the peak λ the walk
          reaches reads directly as the knockdown factor. */}
      {isGNIA && (
        <div
          style={{
            marginTop: 6, marginBottom: 12,
            padding: "10px 12px",
            background: "var(--panel-bg-soft)",
            border: "1px solid var(--line-soft)",
            borderRadius: 4,
          }}
        >
          <div
            style={{
              color: "var(--accent)", fontSize: 10.5,
              fontWeight: 700, marginBottom: 8,
              textTransform: "uppercase", letterSpacing: 0.08,
              textShadow: "var(--shadow-accent)",
            }}
          >
            Arc-length continuation · GNIA
          </div>
          <NumberField
            label="Arc-length step  (Δs)"
            value={analysis.arcLength ?? 0.05}
            min={1e-4}
            max={1.0}
            step={0.01}
            precision={5}
            onChange={(v) => setField("arcLength", Math.max(1e-4, v))}
            hint="Arc length per step (couples load + displacement). Smaller = finer path resolution near the limit point but more steps. 0.05 is a good start; drop it if the walk stalls bisecting at the limit point."
          />
          <NumberField
            label="Max steps"
            value={analysis.maxSteps ?? 60}
            min={1}
            max={500}
            step={10}
            onChange={(v) => setField("maxSteps", Math.max(1, Math.round(v)))}
            hint="Arc-length steps. The solver traces PAST the limit point into post-buckling, so this also caps the softening-tail length. ~50 reaches well past the cylinder limit point."
          />
          <div style={{ color: "var(--text-secondary)", fontSize: 10.5,
                        fontFamily: MONO, marginBottom: 4 }}>
            Solver method
          </div>
          <ToggleGroup
            options={[
              ["0", "Newton-Raphson (Load control)"],
              ["1", "Riks"],
              ["2", "Crisfield"],
            ]}
            value={String(analysis.almMethod ?? 2)}
            onChange={(v) => setField("almMethod", Number(v))}
            fullWidth
          />
          <div style={{ fontSize: 9.5, color: "var(--text-muted)", fontFamily: MONO,
                        marginTop: 4, lineHeight: 1.4 }}>
            ALM method — Riks (cylindrical) is most robust through limit
            points with imperfections; Crisfield (spherical) can hit complex
            roots at the first step for larger imperfections; Load control
            can't pass a load limit point.
          </div>
          {/* The imperfection (kind / mode / amplitude) lives in its OWN
              section — IMPERFECTIONS → Definition — so there's a single
              source of truth. Pointer here to avoid the earlier duplicate
              amplitude field that lived in two places. */}
          <div style={{ marginTop: 8, padding: "7px 9px",
                        background: "rgba(0,200,255,0.06)",
                        border: "1px dashed var(--accent-muted)",
                        borderRadius: 4, fontSize: 9.5,
                        color: "var(--text-secondary)", fontFamily: MONO,
                        lineHeight: 1.45 }}>
            Imperfection shape + amplitude (eigenmode / random, mode #, w/t)
            are set in{" "}
            <span style={{ color: "var(--accent-muted)" }}>
              IMPERFECTIONS → Definition
            </span>{" "}
            — not here. This block is just the arc-length numerics.
          </div>
        </div>
      )}

      {!isLinear && (<>
      <div style={{ marginBottom: 9 }}>
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: 10.5,
            fontFamily: MONO,
            marginBottom: 4,
          }}
        >
          Solver method  ·  eigenvalue (Lanczos / Spectra)
        </div>
        <ToggleGroup
          options={SOLVER_OPTIONS}
          value={analysis.solver}
          onChange={(v) => setField("solver", v)}
          fullWidth
        />
        {/* Per-mode info panel — content swaps every time the user clicks a
            different mode. */}
        <div
          style={{
            marginTop: 6,
            padding: "8px 10px",
            background: "var(--panel-bg-soft)",
            border: "1px solid var(--line-soft)",
            borderRadius: 4,
            fontFamily: MONO,
            fontSize: 10.5,
            lineHeight: 1.5,
          }}
        >
          <div
            style={{
              color: "var(--accent)",
              fontWeight: 700,
              fontSize: 11,
              marginBottom: 4,
              textShadow: "var(--shadow-accent)",
            }}
          >
            {info.title}
          </div>
          <div style={{ color: "var(--text-primary)", marginBottom: 6 }}>
            {info.line}
          </div>
          <InfoLine label="Best when" color="var(--accent-muted)">
            {info.bestWhen}
          </InfoLine>
          <InfoLine label="Watch out" color="var(--warning)">
            {info.caveat}
          </InfoLine>
          <InfoLine label="Shift means" color="var(--text-secondary)">
            {info.shiftHint}
          </InfoLine>
        </div>
      </div>

      <NumberField
        label="Number of eigenvalues  (nmodes)"
        symbol="N"
        unit="–"
        value={analysis.nmodes}
        onChange={(v) => setField("nmodes", Math.max(1, Math.round(v)))}
        min={1}
        max={50}
        step={1}
        precision={0}
        showRange
        hint="how many eigenmodes Spectra returns. Solution: only λ_1 is the buckling load; larger N gives the next modes for free during the same Arnoldi iteration. Runtime: O(N·ncv) per matrix-vector product — going from 5 to 20 modes is maybe +25 % wall time, not 4×."
      />

      <div style={{ marginBottom: 9 }}>
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: 10.5,
            fontFamily: MONO,
            marginBottom: 4,
          }}
        >
          Spectral shift  (σ)
        </div>
        <ToggleGroup
          options={[
            ["auto", "AUTO  (≈ σ_cr / E)"],
            ["explicit", "EXPLICIT"],
          ]}
          value={shiftAuto ? "auto" : "explicit"}
          onChange={(v) => {
            if (v === "auto") setField("shift", "auto");
            else setField("shift", shiftValue || 1e-3);
          }}
          fullWidth
        />
        {!shiftAuto && (
          <div style={{ marginTop: 6 }}>
            <NumberField
              label="Shift value"
              symbol="σ"
              unit="–"
              value={shiftValue}
              onChange={(v) => setField("shift", v)}
              min={0}
              step={1e-4}
              precision={8}
              hint="Spectra finds eigenvalues nearest the shift FIRST. Solution: pick close to the eigenvalue cluster you want; default auto = classical_sigma_cr/E hunts the lowest physical mode. Runtime: a well-chosen shift converges in 1–2 Arnoldi cycles; a bad shift can need 10+."
            />
          </div>
        )}
        {shiftAuto && (
          <div
            style={{
              marginTop: 4,
              fontSize: 9.5,
              color: "var(--text-muted)",
              fontFamily: MONO,
              lineHeight: 1.45,
            }}
          >
            Auto-resolves to{" "}
            <span style={{ color: "var(--accent-muted)" }}>
              classical σ_cr / E
            </span>{" "}
            at solve time so the first mode found is the physical buckling
            load. Override only if you need to chase a higher mode cluster.
          </div>
        )}
      </div>
      </>)}

      {/* ----- ADVANCED disclosure ----- */}
      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          className="codex-action-button"
          onClick={() => setShowAdvanced((v) => !v)}
          style={{
            width: "100%",
            padding: "6px 10px",
            fontSize: 10,
            letterSpacing: 0.08,
            textTransform: "uppercase",
            background: showAdvanced
              ? "var(--control-active-bg)"
              : "var(--control-bg)",
            color: showAdvanced ? "var(--accent)" : "var(--text-muted)",
            border: "1px solid var(--control-border)",
          }}
        >
          {showAdvanced ? "▼" : "▶"}  Advanced solver knobs
        </button>
      </div>

      {/* InfoLine helper rendered inline so this file stays self-contained. */}
      {showAdvanced && (
        <div style={{ marginTop: 8 }}>
          <NumberField
            label="Convergence tolerance  (Arnoldi)"
            symbol="ε"
            unit="–"
            value={analysis.tolerance}
            onChange={(v) => setField("tolerance", v)}
            min={1e-14}
            max={1e-2}
            step={1e-9}
            precision={9}
            hint="how close consecutive Arnoldi iterates must be to declare convergence. Solution: 1e-8 (default) gives ~7 correct digits in λ_1 — well below the discretisation error at typical r. Tightening to 1e-10 is paranoia (no eigenvalue change), loosening to 1e-6 trades ~10–20 % faster runs for the same answer. Going to 1e-4 risks early stopping."
          />

          <NumberField
            label="ncv factor  (Krylov subspace = factor × nmodes)"
            symbol="ncv"
            unit="–"
            value={analysis.ncv_factor}
            onChange={(v) => setField("ncv_factor", Math.max(2, Math.round(v)))}
            min={2}
            max={10}
            step={1}
            precision={0}
            showRange
            hint="size of the Arnoldi Krylov subspace relative to nmodes. Spectra REQUIRES ncv ≥ nmodes+1. Solution: 3 (default) handles all cases we've hit; bump to 4–5 if Spectra reports non-convergence at the configured tolerance (rare). Runtime: linear in ncv per iteration, so 6× would roughly double the cost."
          />

          <NumberField
            label="Interface penalty  (IfcPenalty)"
            symbol="γ"
            unit="–"
            value={analysis.interface_penalty}
            onChange={(v) => setField("interface_penalty", v)}
            min={1}
            max={1e12}
            step={1e5}
            precision={3}
            hint="weak C0/C1 coupling penalty between patches. Solution: only used by the gsThinShellAssembler as a fallback when the smooth-basis path can't enforce C1 strongly (extraordinary vertices, broken topology). 1e6 (default) is the validated value for our regular cylinder; bumping helps when stepped wall partitions introduce poorly-conditioned interfaces. Runtime: no change."
          />
        </div>
      )}
    </>
  );
}

/** One labelled line inside the per-mode info panel. Label fixed-width on
 * the left, body wraps on the right. Color of the label communicates the
 * line's intent (accent = positive guidance, warning = caveat). */
function InfoLine({ label, color, children }) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 3 }}>
      <span
        style={{
          color,
          fontSize: 10,
          fontWeight: 700,
          minWidth: 78,
          flexShrink: 0,
          textTransform: "uppercase",
          letterSpacing: 0.06,
        }}
      >
        {label}
      </span>
      <span style={{ color: "var(--text-secondary)", fontSize: 10.5 }}>
        {children}
      </span>
    </div>
  );
}
