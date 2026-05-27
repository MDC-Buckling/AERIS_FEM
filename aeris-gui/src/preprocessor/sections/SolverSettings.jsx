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
  // schema name → human label. Disabled options carry a tooltip explaining
  // why they're greyed out (Cholesky / RegularInverse only work for K_g SPD
  // which is not our LBA case).
  ["spectra-buckling",     "Buckling"],
  ["spectra-shift-invert", "Shift-Invert"],
  ["spectra-cayley",       "Cayley"],
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

  // Static analysis = single linear solve (K · u = F) — no eigenvalue
  // iteration, so the Spectra mode + nmodes + spectral-shift knobs are
  // physically meaningless and get hidden. tolerance + ncv_factor +
  // interface_penalty stay visible because the static path still uses
  // the same gsThinShellAssembler infrastructure (tolerance applies to
  // the linear solver, ifc penalty to the patch-coupling fallback).
  const isStatic = analysis.kind === "static";

  return (
    <>
      {isStatic && (
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
            LSA (Linear Static Analysis) active.
          </span>{" "}
          Eigenvalue-only knobs (Spectra mode, nmodes, spectral shift) are
          hidden because they don't apply to a direct K · u = F solve. The
          advanced solver knobs below still affect the linear solver
          (tolerance) and patch-coupling fallback (interface penalty).
        </div>
      )}

      {!isStatic && (<>
      <div style={{ marginBottom: 9 }}>
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: 10.5,
            fontFamily: MONO,
            marginBottom: 4,
          }}
        >
          Spectra mode
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
