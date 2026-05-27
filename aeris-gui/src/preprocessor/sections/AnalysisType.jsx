import React from "react";
import ToggleGroup from "../../components/ui/ToggleGroup.jsx";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Functional inspector for ANALYSIS STEP > Analysis Type.
 *
 * Lives at model.analysis.kind. Only "lba" is wired today (Session 2.7
 * onwards); the other three placeholders represent distinct solver
 * families that each need their own G+Smo driver and verdict path:
 *
 *  - gnia   → arc-length nonlinear (Riks / Crisfield) via gsALMBase
 *  - modal  → free-vibration eigenvalue (K x = λ M x) via gsModalSolver
 *  - static → linear elastic, single solve (no eigenproblem)
 *
 * Each shows a hover tooltip on the disabled toggle so the user knows
 * what's missing rather than wondering if the UI is broken — same
 * pattern as the coupling/load disabled options. */

const KIND_OPTIONS = [
  ["lba", "LBA"],
  ["static", "LSA"],
  ["gnia", "GNIA · Arc-Length",
    { disabled: true,
      title: "geometrically nonlinear / arc-length (Riks-Crisfield) — needs gsALMBase driver, post-buckling sweep, separate verdict pipeline. Not wired yet." }],
  ["modal", "Modal",
    { disabled: true,
      title: "free-vibration K x = λ M x — same Spectra machinery as LBA but K_geom is replaced by the mass matrix M. Not wired yet." }],
];

/** Per-kind explainer copy. Switching kind in the toggle swaps the panel
 * below so the user sees what the picked analysis actually solves +
 * which solver settings apply. LSA intentionally calls out the
 * Scordelis-Lo benchmark since that's the validated CLI reference. */
const KIND_INFO = {
  lba: {
    title: "LBA = Linear Buckling Analysis",
    body: (
      <>
        Solve the generalised eigenproblem{" "}
        <span style={{ color: "var(--accent)" }}>K_L · v = λ · K_geom · v</span>{" "}
        to find the smallest load factor λ_1 that drives static instability.
        Linear because both stiffness matrices are computed at the undeformed
        configuration — no large-displacement coupling. The result is the
        classical bifurcation load for a perfect shell; knockdown for
        imperfections is a separate analysis (later session).
      </>
    ),
    settingsHint: "Use SOLVER SETTINGS below to pick the Spectra eigenvalue mode, eigenvalue count and convergence knobs.",
  },
  static: {
    title: "LSA = Linear Static Analysis",
    body: (
      <>
        Solve{" "}
        <span style={{ color: "var(--accent)" }}>K · u = F</span>{" "}
        directly — one linear system, no eigenvalue iteration. Useful for the
        prestress response under a distributed load (e.g. self-weight roof
        deflection, axisymmetric pressurisation, … any case where you want
        the actual displacement field, not the buckling load factor).
        Validated against the Scordelis-Lo benchmark on the CLI side
        (benchmarks/scordelis_lo/, PASS at 0.031 % at r=6).
      </>
    ),
    settingsHint: "Solver settings: tolerance + interface penalty are honoured; eigenvalue-only knobs (nmodes, shift, Spectra mode) are skipped.",
  },
};

export default function AnalysisType() {
  const kind = useUI((s) => s.model.analysis.kind);
  const setKind = useUI((s) => s.setAnalysisKind);
  const info = KIND_INFO[kind] ?? KIND_INFO.lba;

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
          Analysis kind
        </div>
        <ToggleGroup
          options={KIND_OPTIONS}
          value={kind}
          onChange={setKind}
          fullWidth
        />
      </div>

      <div
        style={{
          marginTop: 8,
          padding: "10px 12px",
          background: "var(--panel-bg-soft)",
          border: "1px solid var(--line-soft)",
          borderRadius: 5,
          fontFamily: MONO,
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>
          {info.title}
        </div>
        <div style={{ color: "var(--text-primary)" }}>
          {info.body}
        </div>
        <div
          style={{
            marginTop: 8,
            fontSize: 10,
            color: "var(--text-muted)",
            lineHeight: 1.45,
          }}
        >
          {info.settingsHint}
        </div>
      </div>
    </>
  );
}
