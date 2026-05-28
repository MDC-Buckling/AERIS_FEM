import React from "react";
import NumberField from "../../components/ui/NumberField.jsx";
import ToggleGroup from "../../components/ui/ToggleGroup.jsx";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Functional inspector for IMPERFECTIONS > Definition.
 *
 * Lives at model.imperfections = { kind, mode, amplitude }. Consumed by
 * GNIA (analysis.kind = "gnia"); ignored by LBA / LSA / GNA.
 *
 *   kind "none"      — perfect shell. Arc-length may stall at the sharp
 *                      bifurcation (no smooth limit point to trace).
 *   kind "eigenmode" — textbook GNIA: the solver runs an LBA first, takes
 *                      buckling mode `mode`, scales it to `amplitude`,
 *                      superimposes it on the geometry, THEN runs the
 *                      nonlinear arc-length. All in one solver pass.
 *   kind "random"    — random radial CP perturbation of `amplitude`.
 *                      Quick symmetry-breaker, not code-compliant.
 *
 * Amplitude is a LENGTH (same units as t). The classic imperfection
 * sensitivity convention is w/t (imperfection-to-thickness ratio) — the
 * panel shows w/t live next to the absolute value. */

const KIND_OPTIONS = [
  ["none", "None"],
  ["eigenmode", "Eigenmode"],
  ["random", "Random"],
];

const KIND_INFO = {
  none: {
    title: "None — perfect shell",
    body: "No imperfection. The perfect cylinder follows the trivial axisymmetric branch; arc-length GNIA may stall at the sharp bifurcation because there's no smooth limit point. Use a small eigenmode imperfection to get a clean knockdown curve.",
  },
  eigenmode: {
    title: "Eigenmode-shaped (textbook GNIA)",
    body: "On Solve the solver runs an LBA first, extracts the chosen buckling mode, scales it so its peak displacement equals the amplitude, superimposes it on the geometry, then runs the nonlinear arc-length — all in one pass. This is the worst-case, code-compliant imperfection (NASA SP-8007 / EN 1993-1-6 style).",
  },
  random: {
    title: "Random radial",
    body: "Random radial perturbation of the control points. A quick symmetry-breaker that seeds buckling but isn't the worst-case shape and depends on the RNG seed — not code-compliant. Use eigenmode for real knockdown numbers.",
  },
};

export default function Imperfections() {
  const imp = useUI((s) => s.model.imperfections ?? { kind: "eigenmode", mode: 1, amplitude: 0.001 });
  const t = useUI((s) => s.model.geometry.cylinder.t);
  const analysisKind = useUI((s) => s.model.analysis.kind);
  const setField = useUI((s) => s.setImperfectionField);

  const info = KIND_INFO[imp.kind] ?? KIND_INFO.eigenmode;
  const isEigen = imp.kind === "eigenmode";
  const isActive = imp.kind !== "none";
  const wOverT = (t > 0 && imp.amplitude != null) ? imp.amplitude / t : 0;

  return (
    <>
      {analysisKind !== "gnia" && (
        <div
          style={{
            marginBottom: 10, padding: "8px 10px",
            background: "var(--panel-bg-soft)",
            border: "1px dashed var(--line-soft)",
            borderRadius: 4, fontSize: 10, color: "var(--text-muted)",
            fontFamily: MONO, lineHeight: 1.5,
          }}
        >
          Imperfections only affect{" "}
          <span style={{ color: "var(--accent-muted)" }}>analysis.kind = GNIA</span>.
          The current analysis ({analysisKind.toUpperCase()}) ignores this section —
          switch to GNIA in ANALYSIS STEP → Analysis Type to use it.
        </div>
      )}

      <div style={{ marginBottom: 9 }}>
        <div
          style={{
            color: "var(--text-secondary)", fontSize: 10.5,
            fontFamily: MONO, marginBottom: 4,
          }}
        >
          Imperfection kind
        </div>
        <ToggleGroup
          options={KIND_OPTIONS}
          value={imp.kind}
          onChange={(v) => setField("kind", v)}
          fullWidth
        />
      </div>

      {/* Mode number — eigenmode only. 1 = lowest (critical) buckling mode. */}
      {isEigen && (
        <NumberField
          label="Buckling mode number"
          symbol="N"
          unit="–"
          value={imp.mode ?? 1}
          onChange={(v) => setField("mode", Math.max(1, Math.round(v)))}
          min={1}
          max={20}
          step={1}
          hint="Which LBA eigenmode to use as the imperfection shape. 1 = lowest (critical) mode, the classic worst case. Higher modes seed different (usually less critical) patterns."
        />
      )}

      {/* Amplitude — eigenmode + random. */}
      {isActive && (
        <NumberField
          label="Amplitude  (length units)"
          symbol="w"
          unit="–"
          value={imp.amplitude ?? 0.001}
          onChange={(v) => setField("amplitude", Math.max(0, v))}
          min={0}
          step={0.001}
          precision={6}
          hint="Peak imperfection displacement, in the same units as the thickness t. Classic convention is w/t (shown below). w/t ≈ 0.01 is a typical 'clean' shell; w/t = 1 (amplitude = t) is a severe imperfection giving deep knockdown."
        />
      )}

      {isActive && (
        <div
          style={{
            marginTop: 8, padding: "10px 12px",
            background: "var(--panel-bg-soft)",
            border: "1px solid var(--line-soft)",
            borderRadius: 5, fontFamily: MONO,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between",
                        alignItems: "center", padding: "3px 0" }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
              Imperfection ratio  w / t
            </span>
            <span className="num" style={{ color: "var(--accent)", fontSize: 13,
                  fontWeight: 700, textShadow: "var(--shadow-accent)" }}>
              {wOverT.toFixed(3)}
            </span>
          </div>
        </div>
      )}

      <div
        style={{
          marginTop: 8, padding: "10px 12px",
          background: "var(--panel-bg-soft)",
          border: "1px solid var(--line-soft)",
          borderRadius: 5, fontFamily: MONO,
        }}
      >
        <div style={{ color: "var(--text-secondary)", fontSize: 11, marginBottom: 3 }}>
          {info.title}
        </div>
        <div style={{ color: "var(--accent)", fontSize: 11, fontWeight: 600,
              lineHeight: 1.5, textShadow: "var(--shadow-accent)" }}>
          {info.body}
        </div>
      </div>
    </>
  );
}
