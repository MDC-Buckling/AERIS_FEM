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
  ["clamped_both", "Both Clamped",
    { disabled: true, title: "needs a Dirichlet block on the top edge instead of Neumann — not wired yet" }],
  ["ss_both", "Both SS",
    { disabled: true, title: "simply-supported on both ends — Clamped component dropped on each end; not wired yet" }],
  ["free_top", "Free Top",
    { disabled: true, title: "bottom clamped, top free — degenerate stress state for an LBA, not wired yet" }],
];

export default function BcsKind() {
  const bcs = useUI((s) => s.model.bcs);
  const setKind = useUI((s) => s.setBcsKind);

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
        <Row label="Bottom edge  (z = 0)" value="Dirichlet u=0  +  Clamped (KL normal-rotation = 0)" />
        <Row label="Top edge  (z = L)" value="Neumann (load case sets the traction)" />
        <div
          style={{
            marginTop: 6,
            fontSize: 9.5,
            color: "var(--text-muted)",
            lineHeight: 1.45,
          }}
        >
          The KL-shell needs the explicit <span style={{ color: "var(--accent-muted)" }}>Clamped</span> rotation BC
          alongside the Dirichlet displacement clamp — without it, the bottom edge is only
          simply-supported and the LBA result drifts. Documented in the G+Smo XML quirks
          memory note from Session 2.7.
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
