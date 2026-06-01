import React from "react";
import GlassPanel from "./ui/GlassPanel.jsx";
import SectionHeader from "./ui/SectionHeader.jsx";
import ResultRow from "./ui/ResultRow.jsx";
import KeyMetric from "./ui/KeyMetric.jsx";
import ToggleGroup from "./ui/ToggleGroup.jsx";
import Slider from "./ui/Slider.jsx";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useUI } from "../store.js";
import { MONO } from "../constants.js";
import { COLORMAPS, COLORMAP_OPTIONS, resolveColormap } from "../viewport/colormap.js";

/** Fallback LBA metadata used when no run.json is available yet (fresh
 * dev session, no Solve clicked). Mirrors the Session-2.7 validated case
 * — once a real run lands the GUI drives everything from
 * currentResults (output/run.json) instead. */
const LBA_META_FALLBACK = {
  kind: "lba",
  R: 1.0,
  L: 1.0,
  t: 0.01,
  E: 1.0,
  nu: 0.3,
  finestR: 5,
  classical: 6.052275e-3,
  computed: 6.022397e-3,
  deviationPct: -0.49,
  driver: "buckling_shell_multipatch_XML",
  coupling: "gsSmoothInterfaces (m=0)",
  modeEigs: {
    mode0: 6.0224e-3, mode1: 6.0314e-3, mode2: 6.0335e-3,
    mode3: 6.0496e-3, mode4: 6.0498e-3,
  },
  isFallback: true,
};

/** Project a currentResults manifest (from output/run.json) into the
 * shape the InspectorPanel consumes. Dispatches on analysisKind so the
 * static (LSA) sidecar — which has no eigenvalues, no critical load,
 * no per-mode list — doesn't fall into LBA's .toExponential traps on
 * undefined verdict fields. The render branches on `kind` further down
 * to show the right blocks per analysis type. */
function metaFromResults(r) {
  if (!r) return LBA_META_FALLBACK;
  const analysisKind = r.analysisKind ?? "lba";

  // ---- LSA (Linear Static Analysis) / GNA (Newton-Raphson) ----
  // Both run through static_shell_XML and produce the same sidecar shape
  // (qois[], deformed mesh + stress files) — only difference is whether
  // --NR was passed. We keep the inspector kind as "static" so all the
  // downstream renders work unchanged; the driver field below carries
  // the actual nonlinearity flag for the provenance block.
  if (analysisKind === "static" || analysisKind === "gna") {
    const qoi = (r.qois && r.qois[0]) || null;
    const segCase = r.case ?? {};
    return {
      kind: "static",
      analysisKind,
      // Geometry/material fields used by the "case" block. Segment cases
      // carry phi_deg too (rendered alongside R/L/t when present).
      R: segCase.R, L: segCase.L, t: segCase.t,
      phi_deg: segCase.phi_deg,
      E: segCase.E, nu: segCase.nu,
      driver: analysisKind === "gna"
        ? "static_shell_XML --NR"
        : "static_shell_XML",
      coupling: r.mesh?.coupling ?? "—",
      qoi,                                     // { name, label, qoiValue, qoiAbsValue, ... }
      finestR: r.mesh?.refinement,
      load: r.load,                            // { kind, magnitude }
      bcs: r.bcs,
      // Mode list is empty for static — keep an empty modeEigs map so
      // the "isMode && eig" guard short-circuits cleanly.
      modeEigs: {},
      generatedAt: r.generatedAt,
      isFallback: false,
    };
  }

  // ---- GNIA (arc-length knockdown OR Newton-Raphson with imperfections) ----
  if (analysisKind === "gnia") {
    const c = r.case ?? {};
    const v = r.verdict ?? {};
    // Distinguish by presence of arcLength field:
    // - Arc-length GNIA (cylinder_arclength.py): has arcLength field
    // - Newton-Raphson GNIA (cylinder_static.py): has maxIncrements field
    const isArcLength = r.analysis?.arcLength != null;
    const driver = isArcLength
      ? "arclength_shell_multipatch_XML"
      : "static_shell_XML --NR";
    return {
      kind: "gnia",
      analysisKind,
      R: c.R, L: c.L, t: c.t, E: c.E, nu: c.nu,
      driver,
      coupling: r.mesh?.coupling ?? "—",
      finestR: r.mesh?.refinement,
      lambdaCritical: v.lambdaCritical,
      knockdownFactor: v.knockdownFactor,
      criticalLoadComputed: v.criticalLoadComputed,
      criticalLoadClassical: v.criticalLoadClassical,
      bifurcationStep: v.bifurcationStep,
      imperfection: r.imperfections ?? null,
      modeEigs: {},
      generatedAt: r.generatedAt,
      isFallback: false,
    };
  }

  // ---- LBA (eigen-buckling) — the two engines write different run.json
  // shapes, so branch on engine. IGA (buckling_shell_multipatch_XML) carries
  // verdict.sigma{Classical,Finest}/deviationPct + a criticalLoad OBJECT;
  // Code_Aster MODE_FLAMB carries verdict.{criticalStress,classicalStress,
  // stressRatio} + criticalLoad as a bare NUMBER (F_cr). Mapping the wrong
  // shape makes `.toExponential` read undefined and crashes the panel.
  const modeEigs = {};
  for (const m of r.modes ?? []) {
    if (m.sigmaComputed != null) modeEigs[m.id] = m.sigmaComputed;
  }
  if (r.engine === "code_aster") {
    const c = r.case ?? {};
    const v = r.verdict ?? {};
    const computed = v.criticalStress ?? r.criticalStress;
    const classical = v.classicalStress ?? r.classicalStress;
    const ratio = v.stressRatio ?? r.stressRatio;
    const deviationPct = ratio != null
      ? (ratio - 1) * 100
      : (computed != null && classical ? (computed / classical - 1) * 100 : null);
    return {
      kind: "lba",
      R: c.R, L: c.L, t: c.t, E: c.E, nu: c.nu,
      finestR: null,                 // FE meshes by element-size, not r-refinement
      classical,
      computed,
      deviationPct,
      driver: "code_aster MODE_FLAMB",
      coupling: r.mesh?.element_family
        ? `${r.mesh.element_family} · h=${r.mesh.mesh_size}`
        : "—",
      modeEigs,
      // Rebuild the {applied,computed,classical} object the critical-load
      // block expects from the flat numbers. F_ref is scaled to the classical
      // F_cr estimate, so applied ≈ classical here.
      criticalLoad: r.criticalLoad != null
        ? {
            kind: r.load?.kind ?? "F",
            label: r.load?.kind ?? "load",
            applied: r.load?.magnitude,
            computed: r.criticalLoad,
            classical: r.load?.magnitude,
          }
        : null,
      generatedAt: r.generatedAt,
      isFallback: false,
    };
  }
  if (r.engine === "bb") {
    // Bernstein-Bézier triangle KL-shell element. Same IGA-shaped verdict /
    // criticalLoad fields (so the blocks below render unchanged), but honest
    // driver + mesh labels: there is no IGA coupling/refinement — the mesh is
    // an Nx×Nt BB triangulation of degree p.
    const c = r.case ?? {};
    const cm = r.verdict?.criticalMode;
    return {
      kind: "lba",
      R: c.R, L: c.L, t: c.t, E: c.E, nu: c.nu,
      finestR: null,                 // BB meshes by Nx/Nt, not r-refinement
      classical: r.verdict?.sigmaClassical,
      computed: r.verdict?.sigmaFinest,
      deviationPct: r.verdict?.deviationPct,
      driver: "bb_cylinder_lba_driver (BB triangle KL)",
      coupling: `BB C¹ · p=${r.mesh?.degree} · ${r.mesh?.Nx}×${r.mesh?.Nt} tris`
        + (cm ? ` · crit (m${cm.m},n${cm.n})` : ""),
      modeEigs,
      criticalLoad: r.criticalLoad,  // { kind, label, applied, computed, classical }
      generatedAt: r.generatedAt,
      isFallback: false,
    };
  }
  return {
    kind: "lba",
    R: r.case.R, L: r.case.L, t: r.case.t,
    E: r.case.E, nu: r.case.nu,
    finestR: r.verdict?.finestR,
    classical: r.verdict?.sigmaClassical,
    computed: r.verdict?.sigmaFinest,
    deviationPct: r.verdict?.deviationPct,
    driver: "buckling_shell_multipatch_XML",
    coupling: `${r.mesh?.coupling} (m=${r.mesh?.couplingMethod})`,
    modeEigs,
    criticalLoad: r.criticalLoad,    // { kind, label, applied, computed, classical }
    generatedAt: r.generatedAt,
    isFallback: false,
  };
}

export default function InspectorPanel() {
  const selectedId = useUI((s) => s.selectedResultId);
  const warpScale = useUI((s) => s.warpScale);
  const setWarpScale = useUI((s) => s.setWarpScale);
  const showEdges = useUI((s) => s.showEdges);
  const setShowEdges = useUI((s) => s.setShowEdges);
  const showUndeformed = useUI((s) => s.showUndeformed);
  const setShowUndeformed = useUI((s) => s.setShowUndeformed);
  const showMaxArrow = useUI((s) => s.showMaxArrow);
  const setShowMaxArrow = useUI((s) => s.setShowMaxArrow);
  const viewPreset = useUI((s) => s.viewPreset);
  const setViewPreset = useUI((s) => s.setViewPreset);
  const status = useUI((s) => s.status);
  const resultCache = useUI((s) => s.resultCache);
  const currentResults = useUI((s) => s.currentResults);
  const colormapName = useUI((s) => s.colormapName);
  const setColormap = useUI((s) => s.setColormap);
  const theme = useUI((s) => s.theme);
  const displayField = useUI((s) => s.displayField);
  const setDisplayField = useUI((s) => s.setDisplayField);

  const LBA_META = metaFromResults(currentResults);
  // resultCache is keyed by `${jobId}:${id}` in post-mode (Viewport3D
  // prefixes the jobId to avoid cross-job collisions), so look up the
  // cached patches under that same composite key when we have a jobId.
  // Falls back to the bare selectedId for the pre-job legacy path.
  const cacheKey = currentResults?.jobId
    ? `${currentResults.jobId}:${selectedId}`
    : selectedId;
  const cached = resultCache[cacheKey];
  const isMode = selectedId.startsWith("mode");
  // Treat stress AND strain results the same — both are scalar fields
  // on the undeformed mesh, no displacement-component projection
  // applies, and the warp slider has nothing to scale.
  const isStress = selectedId.startsWith("stress") || selectedId.startsWith("strain");
  const eig = LBA_META.modeEigs[selectedId];

  return (
    <GlassPanel style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <span className="codex-brand-title" style={{ fontSize: 11, letterSpacing: 0.1 }}>
          INSPECTOR
        </span>
        <span style={{ fontSize: 9.5, color: "var(--text-soft)", fontFamily: MONO }}>
          {selectedId}
        </span>
      </div>

      <div style={{ marginTop: 10, overflowY: "auto", flex: 1 }}>
        {/* Provenance pill — tells the user whether they're looking at the
            shipped fallback or their own freshly-computed run. */}
        <div
          style={{
            display: "inline-block",
            padding: "2px 8px",
            marginBottom: 8,
            borderRadius: 999,
            fontSize: 9,
            fontWeight: 700,
            fontFamily: MONO,
            letterSpacing: 0.08,
            textTransform: "uppercase",
            background: LBA_META.isFallback ? "var(--warning-soft-bg)" : "var(--success-soft-bg)",
            border: `1px solid ${LBA_META.isFallback ? "var(--warning-border)" : "var(--success-border)"}`,
            color: LBA_META.isFallback ? "var(--warning)" : "var(--success)",
          }}
          title={
            LBA_META.isFallback
              ? "No run.json on disk yet — showing Session-2.7 validated case as placeholder. Click SOLVE in the pre-processor to populate this with live data."
              : `Generated ${LBA_META.generatedAt}`
          }
        >
          {LBA_META.isFallback ? "fallback · session-2.7 case" : "live · run.json"}
        </div>

        {/* ----- 3D Visualization controls (hidden for chart results) ----- */}
        {selectedId !== "chart" && (
          <>
            {/* ----- Camera snap views ----- */}
            <SectionHeader>view</SectionHeader>
            <ToggleGroup
              fullWidth
              value={viewPreset}
              onChange={setViewPreset}
              options={[
                ["oblique", "OBLIQUE"],
                ["side", "SIDE"],
                ["end", "END"],
              ]}
            />

            {/* ----- Warp + display controls ----- */}
            <SectionHeader>display</SectionHeader>
            {/* Stress fields are written on the undeformed shell — no displacement
                vector to warp by, so we disable the slider and grey it out to make
                the lack of a deformed configuration obvious. */}
            <Slider
              label={isStress ? "Warp scale (n/a for stress)" : "Warp scale"}
              value={isStress ? 0 : warpScale}
              min={0}
              max={isMode ? 5 : 0.5}
              step={isMode ? 0.05 : 0.005}
              onChange={isStress ? () => {} : setWarpScale}
              fmt={(v) => v.toFixed(2)}
            />
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                marginTop: 6,
              }}
            >
              <button
                type="button"
                className={`codex-action-button ${showEdges ? "is-active" : ""}`}
                onClick={() => setShowEdges(!showEdges)}
              >
                {showEdges ? "EDGES ON" : "EDGES OFF"}
              </button>
              <button
                type="button"
                className={`codex-action-button ${showUndeformed ? "is-active" : ""}`}
                onClick={() => setShowUndeformed(!showUndeformed)}
              >
                {showUndeformed ? "UNDEF OVERLAY ON" : "UNDEF OVERLAY OFF"}
              </button>
              <button
                type="button"
                className={`codex-action-button ${showMaxArrow ? "is-active" : ""}`}
                onClick={() => setShowMaxArrow(!showMaxArrow)}
                title="Show a magenta arrow pointing at the vertex where the currently-displayed field reaches its maximum value (in the deformed configuration)."
              >
                {showMaxArrow ? "MAX ARROW ON" : "MAX ARROW OFF"}
              </button>
            </div>

            {/* Field selector — pick the scalar projection of the displacement
                vector to colour by. magnitude (= |u|, always positive) works
                with every colormap; the components (u_x / u_y / u_z) are
                signed but rendered as |component| with the signed range
                surfaced separately in the viewport legend.
                Hidden for stress results: the .vts ships a 1-component scalar
                field already (σ_vm has no x/y/z direction), so showing the
                displacement-component picker would just confuse the user. */}
            {!isStress && (
              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 10,
                    fontFamily: MONO,
                    textTransform: "uppercase",
                    letterSpacing: 0.08,
                    marginBottom: 4,
                  }}
                >
                  field
                </div>
                <ToggleGroup
                  fullWidth
                  value={displayField}
                  onChange={setDisplayField}
                  options={[
                    ["magnitude", "|u|"],
                    ["ux", "u_x"],
                    ["uy", "u_y"],
                    ["uz", "u_z"],
                  ]}
                />
              </div>
            )}

            {/* Colormap picker — one row per option with a real gradient swatch
                so the user picks by EYE, not by name. The active row is
                highlighted in accent so the current choice is obvious. */}
            <div style={{ marginTop: 10 }}>
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 10,
                  fontFamily: MONO,
                  textTransform: "uppercase",
                  letterSpacing: 0.08,
                  marginBottom: 4,
                }}
              >
                colormap
              </div>
              <div
                style={{
                  border: "1px solid var(--control-border)",
                  borderRadius: 4,
                  background: "var(--control-bg)",
                  overflow: "hidden",
                }}
              >
                {COLORMAP_OPTIONS.map(([key, label]) => {
                  const active = colormapName === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setColormap(key)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        padding: "5px 8px",
                        background: active ? "var(--control-active-bg)" : "transparent",
                        border: "none",
                        borderBottom: "1px solid var(--line-faint)",
                        color: active ? "var(--accent)" : "var(--text-secondary)",
                        fontFamily: MONO,
                        fontSize: 10.5,
                        fontWeight: active ? 700 : 500,
                        cursor: "pointer",
                        textAlign: "left",
                        textShadow: active ? "var(--shadow-accent)" : "none",
                      }}
                    >
                      <ColormapSwatch name={key} theme={theme} />
                      <span style={{ flex: 1 }}>{label}</span>
                      {active && <span style={{ color: "var(--accent)", fontSize: 9 }}>●</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* ----- Result metadata (only for 3D results) ----- */}
        {selectedId !== "chart" && (
          <>
            <SectionHeader>case</SectionHeader>
            <ResultRow label="R (radius)" value={LBA_META.R?.toFixed(2) ?? "—"} unit="–" />
            <ResultRow label="L (length)" value={LBA_META.L?.toFixed(2) ?? "—"} unit="–" />
            <ResultRow label="t (thickness)" value={LBA_META.t?.toFixed(3) ?? "—"} unit="–" />
            {LBA_META.phi_deg != null && (
              <ResultRow label="φ (half-angle)" value={LBA_META.phi_deg.toFixed(1)} unit="°" />
            )}
            <ResultRow label="E" value={LBA_META.E?.toFixed(1) ?? "—"} unit="–" />
            <ResultRow label="ν" value={LBA_META.nu?.toFixed(2) ?? "—"} unit="–" />
            {LBA_META.R != null && LBA_META.t != null && (
              <ResultRow label="R / t" value={(LBA_META.R / LBA_META.t).toFixed(0)} />
            )}
          </>
        )}

        {/* ----- LBA: eigenvalue / verdict / critical-load blocks ----- */}
        {LBA_META.kind === "lba" && (
          <>
            {isMode && eig != null && (
              <>
                <SectionHeader>eigenvalue</SectionHeader>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <KeyMetric
                    variant="primary"
                    label="σ_cr (computed)"
                    value={eig.toExponential(3)}
                  />
                  <KeyMetric
                    label="σ_cr (classical)"
                    value={LBA_META.classical != null ? LBA_META.classical.toExponential(3) : "—"}
                  />
                  <KeyMetric
                    label="Δ vs classical"
                    value={LBA_META.classical
                      ? `${((eig - LBA_META.classical) / LBA_META.classical * 100).toFixed(2)}`
                      : "—"}
                    unit="%"
                  />
                </div>
              </>
            )}

            {!isMode && (
              <>
                <SectionHeader>validation</SectionHeader>
                <KeyMetric
                  variant="primary"
                  label={LBA_META.finestR != null ? "σ_cr (finest r=5)" : "σ_cr (computed)"}
                  value={LBA_META.computed != null ? LBA_META.computed.toExponential(3) : "—"}
                />
                <div style={{ height: 6 }} />
                <KeyMetric
                  label="vs classical"
                  value={LBA_META.deviationPct != null ? `${LBA_META.deviationPct.toFixed(2)}` : "—"}
                  unit="%"
                />
              </>
            )}

            {LBA_META.criticalLoad && (
              <>
                <SectionHeader>critical load</SectionHeader>
                <KeyMetric
                  variant="primary"
                  label={`${LBA_META.criticalLoad.kind}_cr (computed)`}
                  value={LBA_META.criticalLoad.computed != null ? LBA_META.criticalLoad.computed.toExponential(3) : "—"}
                />
                <div style={{ height: 4 }} />
                <KeyMetric
                  label={`${LBA_META.criticalLoad.kind}_cr (classical)`}
                  value={LBA_META.criticalLoad.classical != null ? LBA_META.criticalLoad.classical.toExponential(3) : "—"}
                />
                <div style={{ height: 4 }} />
                <KeyMetric
                  label={`applied ${LBA_META.criticalLoad.label}`}
                  value={LBA_META.criticalLoad.applied != null ? LBA_META.criticalLoad.applied.toExponential(3) : "—"}
                />
              </>
            )}
          </>
        )}

        {/* ----- LSA / GNA: QoI block ----- */}
        {LBA_META.kind === "static" && LBA_META.qoi && (
          <>
            <SectionHeader>
              qoi ({LBA_META.analysisKind === "gna"
                      ? "geometrically nonlinear"
                      : "linear static"})
            </SectionHeader>
            <KeyMetric
              variant="primary"
              label={LBA_META.qoi.label ?? "QoI"}
              value={Number(LBA_META.qoi.qoiAbsValue).toFixed(5)}
            />
            <div style={{ height: 4 }} />
            <KeyMetric
              label="u_z (signed)"
              value={Number(LBA_META.qoi.qoiValue).toFixed(5)}
            />
            {LBA_META.load && (
              <>
                <div style={{ height: 4 }} />
                <KeyMetric
                  label={`load · ${LBA_META.load.kind}`}
                  value={String(LBA_META.load.magnitude)}
                />
              </>
            )}
          </>
        )}

        {/* ----- GNIA: Load-Deflection Chart ----- */}
        {selectedId === "chart" && (
          <div style={{ marginBottom: 20 }}>
            <SectionHeader>load-deflection (arc-length)</SectionHeader>
            {currentResults?.loadDeflection && currentResults.loadDeflection.length > 0 ? (
              <>
                {/* Chart visualization */}
                <div style={{ width: "100%", height: 280, marginBottom: 16 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={currentResults.loadDeflection} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--line-faint)" vertical={false} />
                      <XAxis
                        dataKey="u_qoi_abs"
                        type="number"
                        scale="linear"
                        label={{ value: "u (deflection)", position: "insideBottomRight", offset: -5, fill: "var(--text-muted)", fontSize: 10 }}
                        tick={{ fontSize: 9, fill: "var(--text-muted)" }}
                      />
                      <YAxis
                        label={{ value: "F (load)", angle: -90, position: "insideLeft", fill: "var(--text-muted)", fontSize: 10 }}
                        tick={{ fontSize: 9, fill: "var(--text-muted)" }}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "var(--control-bg)",
                          border: "1px solid var(--line-steel-soft)",
                          borderRadius: 4,
                          padding: 8,
                        }}
                        labelStyle={{ color: "var(--text-primary)", fontSize: 10 }}
                        formatter={(value) => Number(value).toFixed(2)}
                      />
                      <Line
                        type="monotone"
                        dataKey="F"
                        stroke="var(--accent)"
                        dot={false}
                        strokeWidth={2}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Summary metrics */}
                <div style={{ fontSize: 11, fontFamily: MONO, lineHeight: 1.6, color: "var(--text-secondary)" }}>
                  {(() => {
                    const ld = currentResults.loadDeflection;
                    const maxF = Math.max(...ld.map(d => d.F));
                    const maxU = Math.max(...ld.map(d => d.u_qoi_abs));
                    return (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "8px 12px", marginBottom: 12 }}>
                          <span>steps:</span> <span style={{ color: "var(--accent)" }}>{ld.length}</span>
                          <span>λ_max:</span> <span style={{ color: "var(--accent)" }}>{Number(ld[ld.length-1].loadFactor).toFixed(4)}</span>
                          <span>u_max:</span> <span style={{ color: "var(--accent)" }}>{Number(maxU).toFixed(4)}</span>
                          <span>F_max:</span> <span style={{ color: "var(--accent)" }}>{Number(maxF).toFixed(1)}</span>
                        </div>
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line-steel-soft)", fontSize: 9.5, color: "var(--text-muted)" }}>
                          Arc-length path through post-buckling limit point.
                          {currentResults.verdict?.bifurcationStep != null && ` Bifurcation at step ${currentResults.verdict.bifurcationStep}.`}
                        </div>
                      </>
                    );
                  })()}
                </div>
              </>
            ) : (
              <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
                (loading chart data…)
              </div>
            )}
          </div>
        )}

        {/* ----- GNIA: knockdown verdict ----- */}
        {LBA_META.kind === "gnia" && selectedId !== "chart" && (
          <>
            <SectionHeader>knockdown (GNIA)</SectionHeader>
            <KeyMetric
              variant="primary"
              label="knockdown factor  λ_cr"
              value={LBA_META.knockdownFactor != null
                ? Number(LBA_META.knockdownFactor).toFixed(4) : "—"}
            />
            <div style={{ height: 4 }} />
            <KeyMetric
              label="F_cr (computed)"
              value={LBA_META.criticalLoadComputed != null
                ? Number(LBA_META.criticalLoadComputed).toExponential(3) : "—"}
            />
            <div style={{ height: 4 }} />
            <KeyMetric
              label="F_cr (classical)"
              value={LBA_META.criticalLoadClassical != null
                ? Number(LBA_META.criticalLoadClassical).toExponential(3) : "—"}
            />
            {LBA_META.bifurcationStep != null && (
              <>
                <div style={{ height: 4 }} />
                <KeyMetric
                  label="bifurcation at step"
                  value={String(LBA_META.bifurcationStep)}
                />
              </>
            )}
            {LBA_META.imperfection && (
              <>
                <div style={{ height: 6 }} />
                <ResultRow label="imperfection"
                  value={LBA_META.imperfection.kind === "eigenmode"
                    ? `eigenmode ${LBA_META.imperfection.lbaMode ?? LBA_META.imperfection.mode ?? "?"}`
                    : (LBA_META.imperfection.kind ?? "—")} />
                {LBA_META.imperfection.amplitude != null && LBA_META.t != null && (
                  <ResultRow label="w / t"
                    value={(LBA_META.imperfection.amplitude / LBA_META.t).toFixed(3)} />
                )}
                {LBA_META.imperfection.lbaEigenvalue != null && (
                  <ResultRow label="LBA eig (λ₁)"
                    value={Number(LBA_META.imperfection.lbaEigenvalue).toFixed(3)} />
                )}
              </>
            )}
            <div style={{ marginTop: 6, fontSize: 9.5, color: "var(--text-muted)",
                          fontFamily: MONO, lineHeight: 1.4 }}>
              {LBA_META.driver?.includes("arclength")
                ? "λ_cr = imperfect ÷ classical buckling load. Reference auto-scaled so λ=1 ≡ classical F_cr. Arc-length traced through the limit point."
                : "Geometrically nonlinear analysis with imperfections using force-control Newton-Raphson iteration."}
            </div>
          </>
        )}

        {/* ----- Solver provenance ----- */}
        <SectionHeader>solver</SectionHeader>
        <ResultRow label="driver"
          value={LBA_META.driver?.replace(/^buckling_shell_|^static_shell_|^arclength_shell_/, "…") ?? "—"} />
        <ResultRow label="coupling" value={LBA_META.coupling} />
        <ResultRow label="finest r" value={LBA_META.finestR ?? "—"} />

        {/* ----- Loaded patch stats (only for 3D results) ----- */}
        {selectedId !== "chart" && (
          <>
            <SectionHeader>loaded</SectionHeader>
            <ResultRow
              label="patches"
              value={cached ? cached.patches.length : "—"}
            />
            <ResultRow
              label={isStress ? "field_max" : "|u|_max"}
              value={cached ? cached.magMax.toExponential(2) : "—"}
            />
            <ResultRow
              label="vertices"
              value={
                cached
                  ? cached.patches.reduce((a, p) => a + p.positions.length / 3, 0)
                  : "—"
              }
            />
          </>
        )}
      </div>

      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid var(--line-steel-soft)",
          fontSize: 10,
          color: "var(--text-muted)",
          fontFamily: MONO,
          lineHeight: 1.4,
        }}
      >
        <span style={{ color: "var(--accent-muted)" }}>status:</span> {status}
      </div>
    </GlassPanel>
  );
}

/** Small horizontal gradient strip rendered from the actual 256-entry
 * ramp bytes. Drawn into a canvas once per (name, theme) and memoised
 * as a data URL so the option list doesn't recompute the gradient on
 * every render. */
function ColormapSwatch({ name, theme }) {
  const dataUrl = React.useMemo(() => {
    const bytes = resolveColormap(name, theme);
    const w = 64, h = 8;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const imgData = ctx.createImageData(w, h);
    for (let x = 0; x < w; x++) {
      const i = Math.round((x / (w - 1)) * 255);
      const r = bytes[i * 3 + 0];
      const g = bytes[i * 3 + 1];
      const b = bytes[i * 3 + 2];
      for (let y = 0; y < h; y++) {
        const off = (y * w + x) * 4;
        imgData.data[off + 0] = r;
        imgData.data[off + 1] = g;
        imgData.data[off + 2] = b;
        imgData.data[off + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL("image/png");
  }, [name, theme]);

  return (
    <img
      src={dataUrl}
      alt=""
      width={56}
      height={8}
      style={{
        display: "block",
        flexShrink: 0,
        borderRadius: 2,
        border: "1px solid var(--line-faint)",
      }}
    />
  );
}
