import React from "react";
import GlassPanel from "./ui/GlassPanel.jsx";
import SectionHeader from "./ui/SectionHeader.jsx";
import ResultRow from "./ui/ResultRow.jsx";
import KeyMetric from "./ui/KeyMetric.jsx";
import ToggleGroup from "./ui/ToggleGroup.jsx";
import Slider from "./ui/Slider.jsx";
import { useUI } from "../store.js";
import { MONO } from "../constants.js";

/** Frozen LBA metadata for the current cylinder validation case
 * (matches DEFAULT_CASE in ../../scripts/cylinder_lba.py and the latest
 * smooth-coupled multipatch run from Session 2.7). A later session will
 * read this from a sidecar manifest written by cylinder_lba.py instead. */
const LBA_META = {
  R: 1.0,
  L: 1.0,
  t: 0.01,
  E: 1.0,
  nu: 0.3,
  refines: [3, 4, 5],
  finestR: 5,
  classical: 6.052275e-3,
  computed: 6.022397e-3,
  deviationPct: -0.49,
  driver: "buckling_shell_multipatch_XML",
  coupling: "gsSmoothInterfaces (m=0)",
  // Per-mode eigenvalues from the latest r=5 run (Session 2.7 STATUS).
  modeEigs: {
    mode0: 6.0224e-3,
    mode1: 6.0314e-3,
    mode2: 6.0335e-3,
    mode3: 6.0496e-3,
    mode4: 6.0498e-3,
  },
};

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
