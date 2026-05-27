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

export default function SolverSettings() {
  const analysis = useUI((s) => s.model.analysis);
  const setField = useUI((s) => s.setAnalysisField);
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  // "shift" lives in the model as either the string "auto" (default) or a
  // float. Surface as a NumberField with a separate "AUTO" / "EXPLICIT"
  // toggle so the user sees both options without us hiding the value.
  const shiftAuto = analysis.shift === "auto" || analysis.shift == null;
  const shiftValue = typeof analysis.shift === "number" ? analysis.shift : 0;

  return (
    <>
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
        <div
          style={{
            marginTop: 4,
            fontSize: 9.5,
            color: "var(--text-muted)",
            fontFamily: MONO,
            lineHeight: 1.45,
          }}
        >
          <b>Buckling</b> (mode 3) is the right tool for K_L SPD + K_geom
          indefinite — fastest convergence for our case.{" "}
          <b>Shift-Invert</b> (mode 2) is the generic fallback if Buckling
          mode misbehaves at extreme parameters.{" "}
          <b>Cayley</b> (mode 4) is rarely needed but kept as ablation /
          cross-check during validation.
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
