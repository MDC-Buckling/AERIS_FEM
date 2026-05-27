import React from "react";
import ToggleGroup from "../../components/ui/ToggleGroup.jsx";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Functional inspector for BOUNDARY CONDITIONS & LOADS > Boundary Conditions.
 *
 * Today only `clamped_neumann` is wired in cylinder_lba.py (Session 2.7
 * validated). The other three presets are real shell-BC configurations
 * the multipatch driver could support, but each needs its own XML <bc>
 * block AND a re-derived classical reference for the verdict comparison,
 * so they stay disabled until a session pulls them in.
 *
 * Lives at model.bcs.kind in the schema. */

const BCS_OPTIONS = [
  ["clamped_neumann", "Clamped + Neumann"],
  ["scordelis_diaphragm", "Scordelis Diaphragm"],
  ["clamped_both", "Both Clamped",
    { disabled: true, title: "needs a Dirichlet block on the top edge instead of Neumann — not wired yet" }],
  ["ss_both", "Both SS",
    { disabled: true, title: "simply-supported on both ends — Clamped component dropped on each end; not wired yet" }],
  ["free_top", "Free Top",
    { disabled: true, title: "bottom clamped, top free — degenerate stress state for an LBA, not wired yet" }],
];

/** Per-preset explainer copy — swaps in/out the description block under
 * the toggle so the user sees what the picked BC actually constrains
 * before they hit SOLVE. Each entry: rows = list of [edge, condition]
 * pairs + note that names the geometry the preset was designed for. */
const BCS_INFO = {
  clamped_neumann: {
    title: "Cylinder buckling BC (Session-2.7 validated)",
    rows: [
      ["Bottom edge  (z = 0)", "Dirichlet u=0  +  Clamped (KL normal-rotation = 0)"],
      ["Top edge  (z = L)", "Neumann (load case sets the traction)"],
    ],
    note: (
      <>
        The KL-shell needs the explicit <span style={{ color: "var(--accent-muted)" }}>Clamped</span> rotation BC
        alongside the Dirichlet displacement clamp — without it, the bottom edge is only
        simply-supported and the LBA result drifts. Documented in the G+Smo XML quirks
        memory note from Session 2.7. Designed for the closed-cylinder buckling case.
      </>
    ),
  },
  scordelis_diaphragm: {
    title: "Roof-segment diaphragm BC (Scordelis-Lo)",
    rows: [
      ["Curved end edges  (u = 0, u = L)", "Dirichlet u_y = u_z = 0  (rigid in-plane diaphragm; u_x free)"],
      ["Corner pin  (SW corner)", "Dirichlet u_x = 0  (removes axial rigid-body mode)"],
      ["Straight edges  (v = ±φ)", "FREE  (no BC — the eaves)"],
    ],
    note: (
      <>
        Pair with <span style={{ color: "var(--accent-muted)" }}>shape = cylinder_segment</span>{" "}
        for the Belytschko obstacle-course Scordelis-Lo case. The diaphragm
        constrains the cross-section to stay rigid in its own plane while
        allowing axial sliding; the corner pin kills the remaining x rigid-
        body translation. Solver-side dispatch lands in Increment 3.
      </>
    ),
  },
};

export default function BcsKind() {
  const bcs = useUI((s) => s.model.bcs);
  const setKind = useUI((s) => s.setBcsKind);
  const info = BCS_INFO[bcs.kind] ?? BCS_INFO.clamped_neumann;

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
          BC preset
        </div>
        <ToggleGroup
          options={BCS_OPTIONS}
          value={bcs.kind}
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
        }}
      >
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 0.08,
            marginBottom: 6,
          }}
        >
          {info.title}
        </div>
        {info.rows.map(([edge, cond]) => (
          <Row key={edge} label={edge} value={cond} />
        ))}
        <div
          style={{
            marginTop: 6,
            fontSize: 9.5,
            color: "var(--text-muted)",
            lineHeight: 1.45,
          }}
        >
          {info.note}
        </div>
      </div>
    </>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ padding: "3px 0" }}>
      <div
        style={{
          color: "var(--text-secondary)",
          fontSize: 11,
          fontFamily: MONO,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          color: "var(--accent)",
          fontSize: 11.5,
          fontFamily: MONO,
          fontWeight: 600,
          textShadow: "var(--shadow-accent)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
