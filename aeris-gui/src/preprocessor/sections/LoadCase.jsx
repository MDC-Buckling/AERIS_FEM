import React from "react";
import NumberField from "../../components/ui/NumberField.jsx";
import ToggleGroup from "../../components/ui/ToggleGroup.jsx";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Functional inspector for BOUNDARY CONDITIONS & LOADS > Load Case.
 *
 * Lives at model.load.kind. Two wired today: axial (uniform Tz on top
 * edge, σ_ref = E) and bending (cos(θ) Tz via Tz(x) = E·t·x/R, |σ_max| = E
 * at x = ±R). The other four cases (torsion / extpress / intpress /
 * combined) are real load configurations but each needs a new Neumann
 * function in build_cylinder_xml AND a new classical reference for the
 * verdict — stay disabled until those land.
 *
 * Per Session-2.7 / 3.6 derivations the reference state is set so that
 * the implied membrane stress |σ_max| = E exactly. That keeps K_geom
 * the same order as K_L and dodges the catastrophic cancellation that
 * bit the Session-3.3 large-E audit. Eigenvalues are then NORMALISED:
 * σ_cr_computed = |λ_1| · E. */

const LOAD_OPTIONS = [
  ["axial",   "Axial Compression"],
  ["bending", "Bending"],
  ["gravity", "Gravity (body force)"],
  ["torsion", "Torsion",
    { disabled: true, title: "needs an N·t shear-Neumann pattern on the top edge and a Donnell-style classical reference — not wired yet" }],
  ["extpress", "External Pressure",
    { disabled: true, title: "uniform pressure load (body / surface), different classical (Batdorf z-parameter) — not wired yet" }],
  ["intpress", "Internal Pressure",
    { disabled: true, title: "stabilising for axial buckling — needs combined-load path first" }],
  ["combined", "Combined",
    { disabled: true, title: "axial + bending + pressure superposition — needs each individual case wired first" }],
];

// Brief one-liner for each load (shown in the derived block below the
// selector so the user knows what the solver will actually do with the
// pick). Keyed off the canonical schema string.
const LOAD_DESCRIPTIONS = {
  axial:    "Uniform Tz on top edge → uniform tensile membrane (σ_ref = E). Smallest +λ_1 = compressive buckling load factor.",
  bending:  "Cos(θ) Tz on top edge via Tz(x) = E·t·x/R → tension on +x, compression on -x. Buckle localises on -x half.",
  gravity:  "Uniform body force per unit shell area, vertical-downward. Used by static analyses (e.g. Scordelis-Lo dead-load, q = 90/area).",
  torsion:  "Shear traction tangent to the top edge.",
  extpress: "Uniform external pressure on the shell surface.",
  intpress: "Uniform internal pressure (stabilising).",
  combined: "Superposition of axial + bending + pressure.",
};

/** Magnitude-field metadata per load.kind — what symbol to show, what
 * label, what hint text. Keeps the field semantics honest: a "load
 * magnitude" means very different things for axial (force), bending
 * (moment), and gravity (force per area). */
const MAGNITUDE_META = {
  axial: {
    symbol: "F",
    label: "Applied axial force  (F)",
    step: 0.1,
    hint: "in your consistent unit system (e.g. N if you used mm + MPa). Set to 1 to read the eigenvalue as F_cr directly; set to your real applied force to read the verdict as a safety factor.",
  },
  bending: {
    symbol: "M",
    label: "Applied bending moment  (M)",
    step: 1.0,
    hint: "in your consistent unit system (e.g. N·mm if you used mm + MPa). Set to 1 to read the eigenvalue as M_cr directly; set to your real applied moment to read the verdict as a safety factor.",
  },
  gravity: {
    symbol: "q",
    label: "Surface body force  (q per unit area, vertical -z)",
    step: 1.0,
    hint: "force-per-area in your consistent unit system. Scordelis-Lo literature uses q = 90; for self-weight q = ρ·t·g.",
  },
};

export default function LoadCase() {
  const load = useUI((s) => s.model.load);
  const setKind = useUI((s) => s.setLoadKind);
  const setMagnitude = useUI((s) => s.setLoadMagnitude);

  const desc = LOAD_DESCRIPTIONS[load.kind] ?? "?";
  const meta = MAGNITUDE_META[load.kind] ?? MAGNITUDE_META.axial;

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
          Load type
        </div>
        <ToggleGroup
          options={LOAD_OPTIONS}
          value={load.kind}
          onChange={setKind}
          fullWidth
        />
      </div>

      <NumberField
        label={meta.label}
        symbol={meta.symbol}
        unit="–"
        value={load.magnitude ?? 1.0}
        onChange={setMagnitude}
        min={1e-12}
        step={meta.step}
        precision={6}
        hint={meta.hint}
      />

      <div
        style={{
          marginTop: 8,
          padding: "10px 12px",
          background: "var(--panel-bg-soft)",
          border: "1px solid var(--line-soft)",
          borderRadius: 5,
          fontFamily: MONO,
        }}
      >
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: 11,
            marginBottom: 3,
          }}
        >
          What the solver sees
        </div>
        <div
          style={{
            color: "var(--accent)",
            fontSize: 11.5,
            fontWeight: 600,
            lineHeight: 1.45,
            textShadow: "var(--shadow-accent)",
          }}
        >
          {desc}
        </div>
        {load.kind !== "gravity" && (
          <div
            style={{
              marginTop: 8,
              fontSize: 10,
              color: "var(--text-muted)",
              lineHeight: 1.45,
            }}
          >
            Internal Neumann magnitude is E-scaled for numerical conditioning
            (the K_NL − K_L cancellation trick — see Session 3.3 README). Your{" "}
            <span style={{ color: "var(--accent-muted)" }}>{meta.symbol}</span>{" "}
            above does not change the eigenvalue, only how the verdict reports
            the critical load.
          </div>
        )}
        {load.kind === "gravity" && (
          <div
            style={{
              marginTop: 8,
              fontSize: 10,
              color: "var(--text-muted)",
              lineHeight: 1.45,
            }}
          >
            For static analysis the magnitude IS the actual applied
            force-per-area — no E-scaling trick, displacements scale linearly
            with{" "}
            <span style={{ color: "var(--accent-muted)" }}>{meta.symbol}</span>.
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: 8,
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
        {load.kind === "gravity" ? (
          <>
            Pair with <span style={{ color: "var(--accent-muted)" }}>
            analysis.kind = static
            </span>{" "}
            + <span style={{ color: "var(--accent-muted)" }}>
            shape = cylinder_segment
            </span>{" "}
            + <span style={{ color: "var(--accent-muted)" }}>
            BCs = scordelis_diaphragm
            </span>{" "}
            to set up the Scordelis-Lo roof case. Solver-side dispatch lands in
            Increment 3 of the integration; until then the SOLVE button will
            still bounce for this combination, but the model.json round-trips
            correctly.
          </>
        ) : (
          <>
            Both wired LBA cases are <span style={{ color: "var(--accent-muted)" }}>
            validated against classical
            </span>{" "}
            at the default geometry (R=L=1, t=0.01, E=1, ν=0.3, r=5):
            axial −0.49 %, bending −0.48 % vs σ_cr = E·t/(R·√(3(1−ν²))).
            For a perfect-shell LBA bending converges to the same critical
            stress as axial — knockdown for bending only kicks in once
            imperfections are added (separate session).
          </>
        )}
      </div>
    </>
  );
}
