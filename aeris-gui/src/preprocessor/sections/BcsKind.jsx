import React from "react";
import ToggleGroup from "../../components/ui/ToggleGroup.jsx";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";
import ExpertBcEditor from "./ExpertBcEditor.jsx";

const MODE_OPTIONS = [
  ["beginner", "Beginner"],
  ["expert", "Expert"],
];

/** Functional inspector for BOUNDARY CONDITIONS & LOADS > Boundary Conditions.
 *
 * Engine-aware: the BC vocabulary is FORMULATION-specific, so the preset list
 * + explainer copy switch on solver.engine.
 *   - NURBS / G+Smo (Kirchhoff-Love shell): displacement-only C¹ DOF, where
 *     "Clamped" is a normal-ROTATION (derivative) condition + a Neumann line
 *     force for the load.
 *   - Code_Aster (DKT/DKTG): displacement + 3 rotation DOF per node, where
 *     "simply supported" = rotations FREE and "clamped" = rotations fixed.
 * The same physical support is therefore expressed differently per engine —
 * you cannot copy the IGA BC to FEM. The buckling .comm reads model.bcs.kind
 * (see aster_engine/comm.py::_BUCKLING_BC) and builds the matching DDL_IMPO.
 *
 * Lives at model.bcs.kind in the schema. */

// ── NURBS / Kirchhoff-Love presets (G+Smo) ──────────────────────────────
const IGA_OPTIONS = [
  ["clamped_neumann", "Clamped + Neumann"],
  ["scordelis_diaphragm", "Scordelis Diaphragm"],
  ["clamped_both", "Both Clamped",
    { disabled: true, title: "needs a Dirichlet block on the top edge instead of Neumann — not wired yet" }],
  ["ss_both", "Both SS",
    { disabled: true, title: "simply-supported on both ends — Clamped component dropped on each end; not wired yet" }],
  ["free_top", "Free Top",
    { disabled: true, title: "bottom clamped, top free — degenerate stress state for an LBA, not wired yet" }],
];

// ── Code_Aster / DKTG presets (FEM) ─────────────────────────────────────
const FEM_OPTIONS = [
  ["ss_both", "Simply supported"],
  ["clamped_both", "Clamped both"],
  ["clamped_free", "Clamped / free top"],
];

const IGA_INFO = {
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

const FEM_INFO = {
  ss_both: {
    title: "Simply-supported both ends — classical Lorenz σ_cr",
    rows: [
      ["Bottom rim  (z = 0)", "DX=DY=DZ=0  (radial w + hoop v pinned, axial fixed)"],
      ["Top rim  (z = L)", "DX=DY=0  (radial+hoop pinned, axial DZ FREE for the load)"],
      ["Rotations", "FREE at both rims (= simply supported)"],
    ],
    note: (
      <>
        The textbook axial-buckling BC. Both rims hold the shell round (no edge
        mode); the loaded top slides axially. Needs the{" "}
        <span style={{ color: "var(--accent-muted)" }}>DKTG</span> element
        (drilling stiffness) since rotations are free. Validated: h-converges to
        σ_classical from above (h=2 → +8 %, h=1 → +2 %).
      </>
    ),
  },
  clamped_both: {
    title: "Clamped both ends",
    rows: [
      ["Bottom rim  (z = 0)", "DX=DY=DZ=0  +  DRX=DRY=DRZ=0  (fully fixed)"],
      ["Top rim  (z = L)", "DX=DY=0  +  DRX=DRY=DRZ=0  (axial DZ free for load)"],
    ],
    note: (
      <>
        Rotations fixed at both rims. Slightly stiffer than simply-supported, so
        σ_cr lands a touch ABOVE classical for short/medium cylinders — converges
        to the same interior buckling pattern.
      </>
    ),
  },
  clamped_free: {
    title: "Clamped bottom / free top  (IGA-style — NOT classical σ_cr)",
    rows: [
      ["Bottom rim  (z = 0)", "DX=DY=DZ=0  +  DRX=DRY=DRZ=0  (fully clamped)"],
      ["Top rim  (z = L)", "FREE  (loaded only)"],
    ],
    note: (
      <>
        Mirrors the nominal IGA clamped-bottom/free-top setup — but in FEM the
        free rim produces an <span style={{ color: "var(--warning)" }}>edge mode</span> at
        ~0.6·σ_classical (buckles only at the top, λ ~40 % low). Kept for
        cross-engine comparison; use simply-supported for the classical value.
      </>
    ),
  },
};

export default function BcsKind() {
  const bcs = useUI((s) => s.model.bcs);
  const engine = useUI((s) => s.model.solver?.engine) ?? "gismo";
  const setKind = useUI((s) => s.setBcsKind);
  const uiMode = useUI((s) => s.model.uiMode) ?? "beginner";
  const setUiMode = useUI((s) => s.setUiMode);

  const isFem = engine === "code_aster";
  const options = isFem ? FEM_OPTIONS : IGA_OPTIONS;
  const infoTable = isFem ? FEM_INFO : IGA_INFO;
  const defaultKind = isFem ? "ss_both" : "clamped_neumann";

  // Normalise: if the stored kind has no meaning for the active engine (e.g.
  // 'clamped_neumann' carried over after switching to Code_Aster), reset it to
  // the engine's default so the UI selection and the solved BC stay in sync.
  // Only ENABLED options count as valid — disabled IGA presets share keys with
  // the FEM presets (ss_both, clamped_both), so a FEM key must not "stick"
  // (and stay selected-but-disabled) when switching back to NURBS.
  const validKeys = options.filter(([, , opt]) => !opt?.disabled).map(([k]) => k);
  React.useEffect(() => {
    if (!validKeys.includes(bcs.kind)) setKind(defaultKind);
  }, [engine, bcs.kind]);

  const effectiveKind = validKeys.includes(bcs.kind) ? bcs.kind : defaultKind;
  const info = infoTable[effectiveKind] ?? infoTable[defaultKind];

  return (
    <>
      {/* Beginner ↔ Expert mode toggle — controls BC (and, from Phase 2, Load)
          across the whole BCs & Loads section. */}
      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: 10.5,
            fontFamily: MONO,
            marginBottom: 4,
          }}
        >
          Mode
        </div>
        <ToggleGroup
          options={MODE_OPTIONS}
          value={uiMode}
          onChange={setUiMode}
          fullWidth
        />
      </div>

      {uiMode === "expert" ? (
        <ExpertBcEditor />
      ) : (
      <>
      <div style={{ marginBottom: 9 }}>
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: 10.5,
            fontFamily: MONO,
            marginBottom: 4,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>BC preset</span>
          <span style={{ color: isFem ? "var(--warning)" : "var(--accent-muted)" }}>
            {isFem ? "Code_Aster · DKTG DOF" : "NURBS · KL-shell"}
          </span>
        </div>
        <ToggleGroup
          options={options}
          value={effectiveKind}
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
      )}
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
