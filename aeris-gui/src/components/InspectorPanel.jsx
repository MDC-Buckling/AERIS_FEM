import React from "react";
import GlassPanel from "./ui/GlassPanel.jsx";
import SectionHeader from "./ui/SectionHeader.jsx";
import ResultRow from "./ui/ResultRow.jsx";
import KeyMetric from "./ui/KeyMetric.jsx";
import ToggleGroup from "./ui/ToggleGroup.jsx";
import Slider from "./ui/Slider.jsx";
import { useUI } from "../store.js";
import { MONO } from "../constants.js";

/** Fallback LBA metadata used when no run.json is available yet (fresh
 * dev session, no Solve clicked). Mirrors the Session-2.7 validated case
 * — once a real run lands the GUI drives everything from
 * currentResults (output/run.json) instead. */
const LBA_META_FALLBACK = {
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

/** Project a currentResults manifest (from output/run.json) into the same
 * shape the InspectorPanel was already consuming. Keeps the render code
 * straight while the source-of-truth becomes the sidecar. */
function metaFromResults(r) {
  if (!r) return LBA_META_FALLBACK;
  const modeEigs = {};
  for (const m of r.modes ?? []) {
    if (m.sigmaComputed != null) modeEigs[m.id] = m.sigmaComputed;
  }
  return {
    R: r.case.R, L: r.case.L, t: r.case.t,
    E: r.case.E, nu: r.case.nu,
    finestR: r.verdict.finestR,
    classical: r.verdict.sigmaClassical,
    computed: r.verdict.sigmaFinest,
    deviationPct: r.verdict.deviationPct,
    driver: "buckling_shell_multipatch_XML",
    coupling: `${r.mesh.coupling} (m=${r.mesh.couplingMethod})`,
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
  const viewPreset = useUI((s) => s.viewPreset);
  const setViewPreset = useUI((s) => s.setViewPreset);
  const status = useUI((s) => s.status);
  const resultCache = useUI((s) => s.resultCache);
  const currentResults = useUI((s) => s.currentResults);

  const LBA_META = metaFromResults(currentResults);
  const cached = resultCache[selectedId];
  const isMode = selectedId.startsWith("mode");
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
        <Slider
          label="Warp scale"
          value={warpScale}
          min={0}
          max={isMode ? 5 : 0.5}
          step={isMode ? 0.05 : 0.005}
          onChange={setWarpScale}
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
        </div>

        {/* ----- Result metadata ----- */}
        <SectionHeader>case</SectionHeader>
        <ResultRow label="R (radius)" value={LBA_META.R.toFixed(2)} unit="–" />
        <ResultRow label="L (length)" value={LBA_META.L.toFixed(2)} unit="–" />
        <ResultRow label="t (thickness)" value={LBA_META.t.toFixed(3)} unit="–" />
        <ResultRow label="E" value={LBA_META.E.toFixed(1)} unit="–" />
        <ResultRow label="ν" value={LBA_META.nu.toFixed(2)} unit="–" />
        <ResultRow label="R / t" value={(LBA_META.R / LBA_META.t).toFixed(0)} />

        {/* ----- Eigenvalue / verdict (only for modes) ----- */}
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
                value={LBA_META.classical.toExponential(3)}
              />
              <KeyMetric
                label="Δ vs classical"
                value={`${((eig - LBA_META.classical) / LBA_META.classical * 100).toFixed(2)}`}
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
              label="σ_cr (finest r=5)"
              value={LBA_META.computed.toExponential(3)}
            />
            <div style={{ height: 6 }} />
            <KeyMetric
              label="vs classical"
              value={`${LBA_META.deviationPct.toFixed(2)}`}
              unit="%"
            />
          </>
        )}

        {/* ----- Critical load (only when sidecar carries it) ----- */}
        {LBA_META.criticalLoad && (
          <>
            <SectionHeader>critical load</SectionHeader>
            <KeyMetric
              variant="primary"
              label={`${LBA_META.criticalLoad.kind}_cr (computed)`}
              value={LBA_META.criticalLoad.computed.toExponential(3)}
            />
            <div style={{ height: 4 }} />
            <KeyMetric
              label={`${LBA_META.criticalLoad.kind}_cr (classical)`}
              value={LBA_META.criticalLoad.classical.toExponential(3)}
            />
            <div style={{ height: 4 }} />
            <KeyMetric
              label={`applied ${LBA_META.criticalLoad.label}`}
              value={LBA_META.criticalLoad.applied.toExponential(3)}
            />
          </>
        )}

        {/* ----- Solver provenance ----- */}
        <SectionHeader>solver</SectionHeader>
        <ResultRow label="driver" value={LBA_META.driver.replace("buckling_shell_", "…")} />
        <ResultRow label="coupling" value={LBA_META.coupling} />
        <ResultRow label="finest r" value={LBA_META.finestR} />

        {/* ----- Loaded patch stats ----- */}
        <SectionHeader>loaded</SectionHeader>
        <ResultRow
          label="patches"
          value={cached ? cached.patches.length : "—"}
        />
        <ResultRow
          label="|u|_max"
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
