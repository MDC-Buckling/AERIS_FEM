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

/** Load options depend on the engine: External Pressure is wired in the
 * Code_Aster engine for the cylinder (uniform lateral PRES_REP → membrane
 * hoop σ=pR/t, validated 0.26%). The IGA path doesn't have it yet, so it
 * stays disabled there. */
function loadOptions(engine, shape) {
  const caCyl = engine === "code_aster" && shape === "cylinder";
  return [
    ["axial",   "Axial Compression"],
    ["bending", "Bending"],
    ["gravity", "Gravity (body force)"],
    ["point_load", "Point load (concentrated)",
      { title: "concentrated load(s) at specified node(s). Positions set per-benchmark in the catalog." }],
    ["torsion", "Torsion",
      { disabled: true, title: "needs an N·t shear-Neumann pattern on the top edge and a Donnell-style classical reference — not wired yet" }],
    ["extpress", "External Pressure", caCyl
      ? { title: "uniform lateral pressure on the shell (Code_Aster) → membrane hoop σ_θ = pR/t" }
      : { disabled: true, title: "Code_Aster engine + cylinder only — switch the engine in MESH / DISCRETISATION" }],
    ["intpress", "Internal Pressure",
      { disabled: true, title: "stabilising for axial buckling — needs combined-load path first" }],
    ["combined", "Combined",
      { disabled: true, title: "axial + bending + pressure superposition — needs each individual case wired first" }],
  ];
}

// Brief one-liner for each load (shown in the derived block below the
// selector so the user knows what the solver will actually do with the
// pick). Keyed off the canonical schema string.
const LOAD_DESCRIPTIONS = {
  axial:    "Uniform Tz on top edge → uniform tensile membrane (σ_ref = E). Smallest +λ_1 = compressive buckling load factor.",
  bending:  "Cos(θ) Tz on top edge via Tz(x) = E·t·x/R → tension on +x, compression on -x. Buckle localises on -x half.",
  gravity:  "Uniform body force per unit shell area, vertical-downward. Used by static analyses (e.g. Scordelis-Lo dead-load, q = 90/area).",
  point_load: "Concentrated force at specified node(s). Positions and directions determined by the benchmark definition.",
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
  point_load: {
    symbol: "F",
    label: "Concentrated load per point  (F)",
    step: 0.1,
    hint: "force magnitude at each load point in your consistent unit system. Positions set by the benchmark; see the catalog entry for which nodes are loaded.",
  },
  extpress: {
    symbol: "p",
    label: "Applied pressure  (p)",
    step: 0.1,
    hint: "uniform lateral pressure in your consistent unit system. Code_Aster forms the membrane hoop σ_θ = pR/t; set p to your real external pressure.",
  },
};

export default function LoadCase() {
  const load = useUI((s) => s.model.load);
  const analysisKind = useUI((s) => s.model.analysis.kind);
  const engine = useUI((s) => s.model.solver?.engine ?? "gismo");
  const shape = useUI((s) => s.model.geometry.shape);
  const pickingMode = useUI((s) => s.pickingMode);
  const setKind = useUI((s) => s.setLoadKind);
  const setMagnitude = useUI((s) => s.setLoadMagnitude);
  const setControlMode = useUI((s) => s.setLoadControlMode);
  const setPickingMode = useUI((s) => s.setPickingMode);
  const addLoadNode = useUI((s) => s.addLoadNode);
  const removeLoadNode = useUI((s) => s.removeLoadNode);
  const updateLoadNode = useUI((s) => s.updateLoadNode);
  const clearLoadNodes = useUI((s) => s.clearLoadNodes);

  const desc = LOAD_DESCRIPTIONS[load.kind] ?? "?";
  const meta = MAGNITUDE_META[load.kind] ?? MAGNITUDE_META.axial;
  // Control mode is only meaningful for cylinder GNA today — LBA is
  // eigenvalue-only, LSA is single direct K·u=F, segment static uses a
  // body force (no top-edge dual). For force-control or any non-GNA
  // case the magnitude reads as F; for disp-control GNA it reads as d.
  const isControllable = analysisKind === "gna" && load.kind === "axial";
  const controlMode = load.controlMode ?? "force";
  const isDispControl = isControllable && controlMode === "displacement";
  const effectiveMeta = isDispControl
    ? {
        symbol: "d",
        label: "Prescribed top-edge axial displacement  (d)",
        step: 0.01,
        hint: "Target axial compression at the top edge in your consistent length unit (mm if you used mm + MPa). The solver searches for the F that produces this u_z via secant iteration on F — 1-2 inner solves per load step at small d, more as the cylinder approaches its bifurcation point.",
      }
    : meta;

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
          options={loadOptions(engine, shape)}
          value={load.kind}
          onChange={setKind}
          fullWidth
        />
      </div>

      {/* GNA-only: pick force vs displacement control. For force control
          (default) you specify F, the solver computes u. For displacement
          control you specify the target u_z at the top edge, the script
          does an outer secant search over F per load step. Hidden for
          LBA / LSA / non-axial cases — they don't have the dual-quantity
          inversion. */}
      {isControllable && (
        <div style={{ marginBottom: 9 }}>
          <div
            style={{
              color: "var(--text-secondary)",
              fontSize: 10.5,
              fontFamily: MONO,
              marginBottom: 4,
            }}
          >
            Control mode
          </div>
          <ToggleGroup
            options={[
              ["force", "Force control"],
              ["displacement", "Displacement control"],
            ]}
            value={controlMode}
            onChange={setControlMode}
            fullWidth
          />
        </div>
      )}

      {/* GNIA doesn't show a force/displacement toggle on purpose: the
          arc-length continuation IS its own control method (it couples
          load + displacement and traces through the limit point, which
          neither pure force- nor pure displacement-control can do
          robustly). Explain that here so the toggle vanishing when you
          switch GNA→GNIA isn't a mystery. */}
      {analysisKind === "gnia" && load.kind === "axial" && (
        <div
          style={{
            marginBottom: 9, padding: "8px 10px",
            background: "rgba(0,200,255,0.06)",
            border: "1px dashed var(--accent-muted)",
            borderRadius: 4, fontSize: 10, color: "var(--text-secondary)",
            fontFamily: MONO, lineHeight: 1.5,
          }}
        >
          <span style={{ color: "var(--accent)", fontWeight: 700 }}>
            GNIA uses arc-length control.
          </span>{" "}
          No separate force/displacement toggle — arc-length couples both and
          traces THROUGH the buckling limit point (where force-control NR
          diverges and displacement-control can miss snap-back). The
          magnitude below is the reference load; it's auto-scaled so the peak
          load factor reads as the knockdown. Step size lives in{" "}
          <span style={{ color: "var(--accent-muted)" }}>
            SOLVER SETTINGS → Arc-length
          </span>.
        </div>
      )}

      <NumberField
        label={effectiveMeta.label}
        symbol={effectiveMeta.symbol}
        unit="–"
        value={load.magnitude ?? 1.0}
        onChange={setMagnitude}
        min={1e-12}
        step={effectiveMeta.step}
        precision={6}
        hint={effectiveMeta.hint}
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
            For LSA (linear static) the magnitude IS the actual applied
            force-per-area — no E-scaling trick, displacements scale linearly
            with{" "}
            <span style={{ color: "var(--accent-muted)" }}>{meta.symbol}</span>.
          </div>
        )}
      </div>

      {/* Point load node picker */}
      {load.kind === "point_load" && (
        <div style={{ marginTop: 12 }}>
          <button
            onClick={() => setPickingMode(!pickingMode)}
            style={{
              width: "100%",
              padding: "10px 12px",
              background: pickingMode ? "var(--accent)" : "var(--button-bg)",
              color: pickingMode ? "var(--button-text-alt)" : "var(--button-text)",
              border: "1px solid var(--accent)",
              borderRadius: 4,
              fontWeight: 600,
              cursor: "pointer",
              fontSize: 11,
              fontFamily: MONO,
              transition: "all 0.15s",
            }}
          >
            {pickingMode ? "⏹ STOP PICKING" : "⊕ PICK NODES"}
          </button>

          {pickingMode && (
            <div
              style={{
                marginTop: 8,
                padding: "8px 10px",
                background: "rgba(13,200,255,0.08)",
                border: "1px dashed var(--accent)",
                borderRadius: 4,
                fontSize: 10,
                color: "var(--text-secondary)",
                fontFamily: MONO,
              }}
            >
              Click the cylinder surface to add a load point.
            </div>
          )}

          {/* Node list with force editors */}
          {load.nodes && load.nodes.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {load.nodes.map((node, i) => (
                <div
                  key={i}
                  style={{
                    padding: "10px",
                    background: "var(--panel-bg-soft)",
                    border: "1px solid var(--line-soft)",
                    borderRadius: 4,
                    marginBottom: 8,
                    fontSize: 10,
                    fontFamily: MONO,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span>pos: ({node.x.toFixed(2)}, {node.y.toFixed(2)}, {node.z.toFixed(2)})</span>
                    <button
                      onClick={() => removeLoadNode(i)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--accent-error)",
                        cursor: "pointer",
                        fontSize: 12,
                        padding: 0,
                      }}
                    >
                      ✕
                    </button>
                  </div>

                  {/* Force component editors */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                    <NumberField
                      label="fx"
                      symbol=""
                      unit=""
                      value={node.fx ?? 0}
                      onChange={(v) => updateLoadNode(i, { fx: v })}
                      min={-Infinity}
                      step={0.1}
                      precision={3}
                    />
                    <NumberField
                      label="fy"
                      symbol=""
                      unit=""
                      value={node.fy ?? 0}
                      onChange={(v) => updateLoadNode(i, { fy: v })}
                      min={-Infinity}
                      step={0.1}
                      precision={3}
                    />
                    <NumberField
                      label="fz"
                      symbol=""
                      unit=""
                      value={node.fz ?? 0}
                      onChange={(v) => updateLoadNode(i, { fz: v })}
                      min={-Infinity}
                      step={0.1}
                      precision={3}
                    />
                  </div>
                </div>
              ))}

              {load.nodes.length > 0 && (
                <button
                  onClick={clearLoadNodes}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    background: "var(--panel-bg-soft)",
                    border: "1px dashed var(--accent-error)",
                    borderRadius: 4,
                    fontSize: 10,
                    fontFamily: MONO,
                    color: "var(--accent-error)",
                    cursor: "pointer",
                    marginTop: 6,
                  }}
                >
                  Clear all
                </button>
              )}
            </div>
          )}
        </div>
      )}

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
