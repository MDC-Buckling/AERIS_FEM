import React from "react";
import NumberField from "../../components/ui/NumberField.jsx";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Functional inspector for GEOMETRY > Dimensions.
 *
 * Branches on `model.geometry.shape`:
 *   - cylinder         → R, L, t  (plus axial partitions for stepped wall)
 *   - cylinder_segment → R, L, t, phi_deg  (Scordelis-Lo class roof)
 *
 * Both kinds surface the derived R/t + L/R live, plus a gentle thin-shell
 * warning (R/t < 20 = Kirchhoff–Love validity edge). Solver dispatch on
 * the shape lands in Increment 3; until then the segment is preview-only,
 * which the GeometryShape selector flags with an inline note. */
export default function GeometryDimensions() {
  const shape = useUI((s) => s.model.geometry.shape);
  if (shape === "cylinder_segment") return <SegmentDimensions />;
  return <CylinderDimensions />;
}

function CylinderDimensions() {
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

      <AxialPartitionsEditor />
    </>
  );
}

/** Cylindrical-segment ("roof") dimensions panel. Adds phi_deg (half
 * subtended angle, ±phi measured from the apex) alongside R, L, t.
 * Derived block also shows the chord width 2R·sin(phi) and the sagitta
 * R·(1 - cos(phi)) so the user can see the actual roof footprint while
 * dialling the angle. */
function SegmentDimensions() {
  const seg = useUI((s) => s.model.geometry.cylinder_segment);
  const setDim = useUI((s) => s.setSegmentDim);

  const rOverT = seg.R / seg.t;
  const lOverR = seg.L / seg.R;
  const thin = rOverT >= 20;
  const phi = (seg.phi_deg * Math.PI) / 180;
  const chord = 2 * seg.R * Math.sin(phi);
  const sagitta = seg.R * (1 - Math.cos(phi));

  return (
    <>
      <NumberField
        label="Mid-surface radius"
        symbol="R"
        unit="–"
        value={seg.R}
        onChange={(v) => setDim("R", v)}
        min={1e-9}
        step={0.1}
        precision={5}
      />
      <NumberField
        label="Axial length"
        symbol="L"
        unit="–"
        value={seg.L}
        onChange={(v) => setDim("L", v)}
        min={1e-9}
        step={0.1}
        precision={5}
      />
      <NumberField
        label="Shell thickness"
        symbol="t"
        unit="–"
        value={seg.t}
        onChange={(v) => setDim("t", v)}
        min={1e-9}
        step={0.01}
        precision={6}
        hint="same unit system as R and L"
      />
      <NumberField
        label="Half-subtended angle"
        symbol="φ"
        unit="°"
        value={seg.phi_deg}
        onChange={(v) => setDim("phi_deg", v)}
        min={1}
        max={90}
        step={1}
        precision={3}
        showRange
        hint="arc opens from -φ to +φ around the apex. Scordelis-Lo classical case is φ=40°. Hard cap at 90° (full half-circle)."
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
        <DerivedRow label="Slenderness  R / t"  value={rOverT.toFixed(0)}
          warn={!thin} warnMsg="thin-shell regime: R/t ≥ 20" />
        <DerivedRow label="Aspect ratio  L / R" value={lOverR.toFixed(2)} />
        <DerivedRow label="Chord  2R·sin(φ)"    value={chord.toFixed(3)} />
        <DerivedRow label="Sagitta  R·(1−cos(φ))" value={sagitta.toFixed(3)} />
      </div>

      <div
        style={{
          marginTop: 8,
          padding: "8px 10px",
          background: "var(--panel-bg-soft)",
          border: "1px dashed var(--warning-border)",
          borderRadius: 4,
          fontSize: 9.5,
          color: "var(--text-muted)",
          fontFamily: MONO,
          lineHeight: 1.5,
        }}
      >
        <span style={{ color: "var(--warning)", fontWeight: 700 }}>
          Preview-only:{" "}
        </span>
        The viewport shows the geometry live, but{" "}
        <code style={{ color: "var(--accent-muted)" }}>SOLVE</code> won't
        run for cylinder_segment until the static-analysis dispatch lands
        (planned: Increment 3 of the Scordelis-Lo integration). The CLI
        benchmark already PASSes — see{" "}
        <code style={{ color: "var(--accent-muted)" }}>benchmarks/scordelis_lo/</code>.
      </div>
    </>
  );
}

/** Editor for geometry.cylinder.partitions — list of axial z-values that
 * split the cylinder into bands. Adding a partition creates band_i regions
 * + auto-generates one section per band (cloned from the first existing
 * section). Removing a partition merges the adjacent bands. */
function AxialPartitionsEditor() {
  const cyl = useUI((s) => s.model.geometry.cylinder);
  const addPartition = useUI((s) => s.addPartition);
  const removePartition = useUI((s) => s.removePartition);
  const setPartitionZ = useUI((s) => s.setPartitionZ);

  const partitions = cyl.partitions ?? [];
  const nBands = partitions.length + 1;

  // Suggested next-partition z: split the largest existing band in half.
  const suggestNextZ = () => {
    const edges = [0, ...partitions.map((p) => p.z), cyl.L];
    let bestMid = cyl.L / 2;
    let bestSpan = 0;
    for (let i = 0; i < edges.length - 1; i++) {
      const span = edges[i + 1] - edges[i];
      if (span > bestSpan) {
        bestSpan = span;
        bestMid = 0.5 * (edges[i] + edges[i + 1]);
      }
    }
    return bestMid;
  };

  return (
    <>
      <div
        style={{
          marginTop: 14,
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            color: "var(--text-secondary)",
            fontFamily: MONO,
            textTransform: "uppercase",
            letterSpacing: 0.06,
          }}
        >
          Axial partitions{partitions.length > 0 && ` · ${partitions.length} cut → ${nBands} bands`}
        </span>
        <button
          type="button"
          className="codex-action-button"
          onClick={() => addPartition(suggestNextZ())}
          title="Split the largest band in half"
          style={{ padding: "3px 9px", minHeight: 22, fontSize: 9.5 }}
        >
          + ADD CUT
        </button>
      </div>

      {partitions.length === 0 && (
        <div
          style={{
            marginTop: 6,
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
          Homogeneous cylinder · one section, one assignment. Add a cut to
          create axial bands with independent thickness.
        </div>
      )}

      {partitions.length > 0 && (
        <div
          style={{
            marginTop: 6,
            border: "1px solid var(--line-soft)",
            borderRadius: 4,
            overflow: "hidden",
            background: "var(--panel-bg-soft)",
          }}
        >
          {partitions.map((p, i) => (
            <PartitionRow
              key={i}
              index={i}
              z={p.z}
              L={cyl.L}
              onChange={(v) => setPartitionZ(i, v)}
              onRemove={() => removePartition(i)}
            />
          ))}
        </div>
      )}

      {partitions.length > 0 && (
        <div
          style={{
            marginTop: 6,
            fontSize: 9.5,
            color: "var(--text-muted)",
            fontFamily: MONO,
            lineHeight: 1.45,
          }}
        >
          Per-band thickness lives under{" "}
          <span style={{ color: "var(--accent-muted)" }}>
            SHELL CONSTRUCTION → Section Assignments
          </span>{" "}
          · each band has its own row.
        </div>
      )}
    </>
  );
}

function PartitionRow({ index, z, L, onChange, onRemove }) {
  const [text, setText] = React.useState(String(z));
  React.useEffect(() => setText(String(z)), [z]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        borderBottom: "1px solid var(--line-faint)",
        fontFamily: MONO,
      }}
    >
      <span
        style={{
          fontSize: 9.5,
          color: "var(--text-muted)",
          width: 22,
          textTransform: "uppercase",
        }}
      >
        cut {index + 1}
      </span>
      <span
        style={{
          fontSize: 11,
          color: "var(--accent-soft)",
          width: 16,
          textAlign: "right",
        }}
      >
        z =
      </span>
      <input
        type="number"
        step={0.5}
        min={0}
        max={L}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = Number(text);
          if (Number.isFinite(v) && v > 0 && v < L) onChange(v);
          else setText(String(z));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(String(z));
            e.currentTarget.blur();
          }
        }}
        style={{
          flex: 1,
          background: "var(--control-bg)",
          border: "1px solid var(--control-border)",
          borderRadius: 3,
          color: "var(--text-primary)",
          fontFamily: MONO,
          fontSize: 11.5,
          fontWeight: 700,
          padding: "3px 6px",
          textAlign: "right",
          fontVariantNumeric: "tabular-nums lining-nums",
          outline: "none",
        }}
      />
      <button
        type="button"
        className="codex-action-button"
        onClick={onRemove}
        title={`Remove cut ${index + 1}`}
        style={{ padding: "2px 7px", minHeight: 20, fontSize: 10 }}
      >
        −
      </button>
    </div>
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
