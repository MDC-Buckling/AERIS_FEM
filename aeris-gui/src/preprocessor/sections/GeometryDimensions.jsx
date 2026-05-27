import React from "react";
import NumberField from "../../components/ui/NumberField.jsx";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Functional inspector for GEOMETRY > Dimensions (Cylinder).
 *
 * Three live number fields drive store.model.geometry.cylinder.{R,L,t}.
 * Show the derived R/t live, plus a gentle thin-shell-assumption warning
 * if R/t < 20 (Kirchhoff–Love thin-shell theory loses validity in that
 * regime — we don't hard-block, just flag, since the validation case has
 * R/t = 100 and we don't want to surprise the user). */
export default function GeometryDimensions() {
  const cyl = useUI((s) => s.model.geometry.cylinder);
  const setDim = useUI((s) => s.setCylinderDim);

  const rOverT = cyl.R / cyl.t;
  const lOverR = cyl.L / cyl.R;
  const thin = rOverT >= 20;

  return (
    <>
      <NumberField
        label="Mid-surface radius"
        symbol="R"
        unit="–"
        value={cyl.R}
        onChange={(v) => setDim("R", v)}
        min={1e-9}
        step={0.01}
        precision={5}
      />
      <NumberField
        label="Axial length"
        symbol="L"
        unit="–"
        value={cyl.L}
        onChange={(v) => setDim("L", v)}
        min={1e-9}
        step={0.01}
        precision={5}
      />
      <NumberField
        label="Shell thickness"
        symbol="t"
        unit="–"
        value={cyl.t}
        onChange={(v) => setDim("t", v)}
        min={1e-9}
        step={0.001}
        precision={6}
        hint="dimensionless throughout — pick consistent units (m / mm) and stick to them"
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
        <DerivedRow
          label="Slenderness  R / t"
          value={rOverT.toFixed(0)}
          warn={!thin}
          warnMsg="thin-shell regime: R/t ≥ 20"
        />
        <DerivedRow
          label="Aspect ratio  L / R"
          value={lOverR.toFixed(2)}
        />
      </div>
    </>
  );
}

function DerivedRow({ label, value, warn = false, warnMsg }) {
  return (
    <div style={{ marginBottom: warn ? 6 : 0 }}>
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
          className="num"
          style={{
            color: warn ? "var(--warning)" : "var(--accent)",
            fontSize: 13,
            fontWeight: 700,
            fontFamily: MONO,
            textShadow: warn ? "none" : "var(--shadow-accent)",
          }}
        >
          {value}
        </span>
      </div>
      {warn && warnMsg && (
        <div
          style={{
            fontSize: 9.5,
            color: "var(--warning)",
            fontFamily: MONO,
            paddingLeft: 2,
            lineHeight: 1.4,
          }}
        >
          ⚠ {warnMsg} — Kirchhoff–Love thin-shell theory assumed by the solver
        </div>
      )}
    </div>
  );
}
