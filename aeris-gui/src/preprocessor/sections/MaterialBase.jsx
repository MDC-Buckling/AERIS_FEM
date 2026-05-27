import React from "react";
import NumberField from "../../components/ui/NumberField.jsx";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Functional inspector for MATERIAL > Base Properties.
 *
 * Edits the default material (materials[0]) in store.model. Wired through
 * to the solver via the section assignment chain:
 *   assignments[].section_ref → sections[].material_ref → materials[].
 *
 * Linear isotropic only: E (Young's modulus, force/length²) + ν (Poisson,
 * dimensionless). Both flow to the solver's MaterialMatrix <Parameters>
 * block (index=0 = E, index=1 = ν) via gsMaterialMatrixLinear<3>
 * (Saint-Venant Kirchhoff).
 *
 * Thickness lives in geometry.cylinder.t and is intentionally NOT
 * duplicated here — single source of truth. We surface that fact in the
 * derived block below so it's obvious where t comes from. */
export default function MaterialBase() {
  const materials = useUI((s) => s.model.materials);
  const setField = useUI((s) => s.setMaterialField);

  // Session 3.3 wires the single default material; multi-material UI lands
  // when stiffened-shell sections need different materials per region.
  const mat = materials[0];
  if (!mat) return null;

  const incomp = mat.nu >= 0.49;

  return (
    <>
      <NumberField
        label="Young's modulus  (E)"
        symbol="E"
        unit="–"
        value={mat.E}
        onChange={(v) => setField(mat.id, "E", v)}
        min={1e-9}
        step={0.1}
        precision={6}
        hint="force / length² in whatever consistent units you picked for R, L, t (the model is dimensionless throughout — e.g. Pa with metres, or MPa with millimetres)"
      />

      <NumberField
        label="Poisson ratio  (ν)"
        symbol="ν"
        unit="–"
        value={mat.nu}
        onChange={(v) => setField(mat.id, "nu", v)}
        min={0}
        max={0.499}
        step={0.01}
        precision={4}
        hint="dimensionless; 0 ≤ ν < 0.5. Metals usually 0.27–0.33; rubbers approach 0.5 (incompressible)"
      />

      {incomp && (
        <div
          style={{
            fontSize: 9.5,
            color: "var(--warning)",
            fontFamily: MONO,
            paddingLeft: 2,
            marginTop: -4,
            marginBottom: 8,
            lineHeight: 1.4,
          }}
        >
          ⚠ ν ≥ 0.49 — near-incompressible. The linear material works but
          this is unusual for the metals/composites this tool targets;
          double-check this is intended.
        </div>
      )}

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
        <DerivedRow label="Material model" value={mat.model} mono />
        <DerivedRow label="Material id" value={mat.id} mono />
        <DerivedRow
          label="Thickness (t)"
          value="from geometry.cylinder.t"
          accent={false}
          note="single source of truth lives in GEOMETRY → Dimensions, not here"
        />
      </div>
    </>
  );
}

function DerivedRow({ label, value, accent = true, mono = false, note }) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "3px 0",
        }}
      >
        <span
          style={{
            color: "var(--text-secondary)",
            fontSize: 11,
            fontFamily: MONO,
          }}
        >
          {label}
        </span>
        <span
          className={mono ? "num" : ""}
          style={{
            color: accent ? "var(--accent)" : "var(--text-primary)",
            fontSize: accent ? 13 : 11.5,
            fontWeight: accent ? 700 : 500,
            fontFamily: MONO,
            textShadow: accent ? "var(--shadow-accent)" : "none",
          }}
        >
          {value}
        </span>
      </div>
      {note && (
        <div
          style={{
            fontSize: 9.5,
            color: "var(--text-muted)",
            fontFamily: MONO,
            paddingLeft: 2,
            lineHeight: 1.4,
            marginBottom: 4,
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}
