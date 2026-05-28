import React from "react";
import GlassPanel from "../components/ui/GlassPanel.jsx";
import SectionHeader from "../components/ui/SectionHeader.jsx";
import PhysicsInsightsCard from "../components/PhysicsInsightsCard.jsx";
import { MONO } from "../constants.js";
import { useUI } from "../store.js";
import { findItem, SECTIONS } from "./modelTree.js";
import GeometryShape from "./sections/GeometryShape.jsx";
import GeometryDimensions from "./sections/GeometryDimensions.jsx";
import MaterialBase from "./sections/MaterialBase.jsx";
import SectionAssignments from "./sections/SectionAssignments.jsx";
import MeshDiscretisation from "./sections/MeshDiscretisation.jsx";
import BcsKind from "./sections/BcsKind.jsx";
import LoadCase from "./sections/LoadCase.jsx";
import Imperfections from "./sections/Imperfections.jsx";
import AnalysisType from "./sections/AnalysisType.jsx";
import SolverSettings from "./sections/SolverSettings.jsx";
import RunSolve from "./sections/RunSolve.jsx";

/** Sub-items that have a real, wired inspector this session.
 * Adding to this set drops the "STUB · NOT WIRED" badge for that item. */
const WIRED_ITEMS = new Set([
  "geometry.shape",
  "geometry.dimensions",
  "material.base",
  "shellConstruction.sectionAssignments",
  "mesh.discretisation",
  "bcsLoads.bcs",
  "bcsLoads.load",
  "imperfections.definition",
  "analysis.type",
  "analysis.solver",
  "run.solve",
]);

/** Per-item real inspector dispatcher. Returns null if not wired (the
 * caller falls back to the generic StubBody renderer). */
function WiredInspector({ dottedId }) {
  switch (dottedId) {
    case "geometry.shape":                          return <GeometryShape />;
    case "geometry.dimensions":                     return <GeometryDimensions />;
    case "material.base":                           return <MaterialBase />;
    case "shellConstruction.sectionAssignments":    return <SectionAssignments />;
    case "mesh.discretisation":                     return <MeshDiscretisation />;
    case "bcsLoads.bcs":                            return <BcsKind />;
    case "bcsLoads.load":                           return <LoadCase />;
    case "imperfections.definition":               return <Imperfections />;
    case "analysis.type":                           return <AnalysisType />;
    case "analysis.solver":                         return <SolverSettings />;
    case "run.solve":                               return <RunSolve />;
    default: return null;
  }
}

/* ----------------------------------------------------------------------
 * Per-kind stub renderers — non-functional, just the structural sketch
 * of what each item will look like once the next sessions fill it in.
 * -------------------------------------------------------------------- */

function StubBadge() {
  return (
    <div
      style={{
        display: "inline-block",
        padding: "2px 7px",
        background: "var(--warning-soft-bg)",
        border: "1px solid var(--warning-border)",
        color: "var(--warning)",
        borderRadius: 999,
        fontSize: 9,
        fontWeight: 700,
        fontFamily: MONO,
        letterSpacing: 0.08,
        textTransform: "uppercase",
      }}
    >
      stub · not wired
    </div>
  );
}

/** Live one-liner showing the CURRENT value of a wired item, falling back
 * to the static default preview. */
function LivePreviewLine({ dottedId, fallback }) {
  const model = useUI((s) => s.model);
  const lastRun = useUI((s) => s.lastRun);
  const cyl = model.geometry.cylinder;

  let text = fallback;
  if (dottedId === "geometry.dimensions") {
    if (model.geometry.shape === "cylinder_segment") {
      const s = model.geometry.cylinder_segment;
      text = `R=${s.R}  L=${s.L}  t=${s.t}  φ=${s.phi_deg}°  ·  R/t=${(s.R / s.t).toFixed(0)}`;
    } else if (model.geometry.shape === "sphere") {
      const s = model.geometry.sphere;
      text = `R=${s.R}  t=${s.t}  θ=${s.opening_angle_deg}°  ·  R/t=${(s.R / s.t).toFixed(0)}`;
    } else {
      text = `R=${cyl.R}  L=${cyl.L}  t=${cyl.t}  ·  R/t=${(cyl.R / cyl.t).toFixed(0)}`;
    }
  } else if (dottedId === "geometry.shape") {
    text = model.geometry.shape;
  } else if (dottedId === "material.base") {
    const m = model.materials[0];
    text = m ? `${m.model} · E=${m.E}  ν=${m.nu}` : fallback;
  } else if (dottedId === "shellConstruction.sectionAssignments") {
    text = `${model.assignments.length} region · ${model.sections.length} section`;
  } else if (dottedId === "mesh.discretisation") {
    const m = model.mesh;
    text = `r=${m.refinement}  p=${m.degree}  s=${m.smoothness}  ·  ${m.coupling}`;
  } else if (dottedId === "bcsLoads.bcs") {
    text = model.bcs.kind;
  } else if (dottedId === "bcsLoads.load") {
    text = model.load.kind;
  } else if (dottedId === "imperfections.definition") {
    const im = model.imperfections ?? {};
    text = im.kind === "none"
      ? "none (perfect)"
      : im.kind === "eigenmode"
        ? `eigenmode · mode ${im.mode} · w=${im.amplitude}`
        : `random · w=${im.amplitude}`;
  } else if (dottedId === "analysis.type") {
    text = model.analysis.kind.toUpperCase();
  } else if (dottedId === "analysis.solver") {
    const a = model.analysis;
    const shiftLbl = a.shift === "auto" ? "auto" : Number(a.shift).toExponential(2);
    text = `${a.solver}  ·  N=${a.nmodes}  ·  σ=${shiftLbl}`;
  } else if (dottedId === "run.solve") {
    if (lastRun.status === "idle") text = "ready — click SOLVE";
    else if (lastRun.status === "running") text = "running…";
    else if (lastRun.status === "success") text = `last run: success (${(lastRun.durationMs / 1000).toFixed(1)} s)`;
    else if (lastRun.status === "failed") text = `last run: failed`;
  }
  return <>current value: {text}</>;
}

function ConfiguredBadge() {
  return (
    <div
      style={{
        display: "inline-block",
        padding: "2px 7px",
        background: "var(--success-soft-bg)",
        border: "1px solid var(--success-border)",
        color: "var(--success)",
        borderRadius: 999,
        fontSize: 9,
        fontWeight: 700,
        fontFamily: MONO,
        letterSpacing: 0.08,
        textTransform: "uppercase",
      }}
    >
      configured · live
    </div>
  );
}

function DisabledField({ name, label, unit, value = "—" }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          fontSize: 10.5,
          color: "var(--text-secondary)",
          fontFamily: MONO,
          marginBottom: 2,
        }}
      >
        {label} <span style={{ color: "var(--text-soft)" }}>· {name}</span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "5px 8px",
          background: "var(--control-bg)",
          border: "1px dashed var(--control-border)",
          borderRadius: 4,
          opacity: 0.7,
        }}
      >
        <span
          className="num"
          style={{
            color: "var(--text-soft)",
            fontSize: 12,
            fontFamily: MONO,
            fontWeight: 700,
            flex: 1,
            textAlign: "right",
          }}
        >
          {value}
        </span>
        {unit && (
          <span
            style={{
              color: "var(--text-soft)",
              fontSize: 11,
              fontFamily: MONO,
              minWidth: 22,
            }}
          >
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

function DisabledSelector({ options, activeValue }) {
  return (
    <div
      style={{
        border: "1px dashed var(--control-border)",
        borderRadius: 4,
        background: "var(--control-bg)",
        opacity: 0.85,
        padding: 4,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === activeValue;
        return (
          <div
            key={String(opt.value)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 7px",
              fontFamily: MONO,
              fontSize: 11,
              color: opt.enabled
                ? active
                  ? "var(--accent)"
                  : "var(--text-secondary)"
                : "var(--text-soft)",
              fontWeight: active ? 700 : 400,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                border: "1px solid var(--text-soft)",
                background: active ? "var(--accent)" : "transparent",
                flex: "0 0 8px",
              }}
            />
            <span style={{ flex: 1 }}>{opt.label}</span>
            {!opt.enabled && (
              <span
                style={{
                  fontSize: 9,
                  fontStyle: "italic",
                  color: "var(--text-soft)",
                }}
              >
                {opt.note ?? "later"}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DisabledToggle({ label, active = false }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 10px",
        background: "var(--control-bg)",
        border: "1px dashed var(--control-border)",
        borderRadius: 4,
        opacity: 0.85,
      }}
    >
      <span
        style={{
          color: "var(--text-secondary)",
          fontFamily: MONO,
          fontSize: 11,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 10,
          fontWeight: 700,
          color: active ? "var(--accent)" : "var(--text-soft)",
          textTransform: "uppercase",
          letterSpacing: 0.08,
        }}
      >
        {active ? "on" : "off"}
      </span>
    </div>
  );
}

function StubBody({ section, item }) {
  if (item.kind === "selector") {
    return (
      <>
        <DisabledSelector
          options={item.options}
          activeValue={item.options.find((o) => o.enabled)?.value}
        />
        <Note>
          The first enabled option above is what the next-session fill will use
          as the wired default.
        </Note>
      </>
    );
  }
  if (item.kind === "fields") {
    return (
      <>
        {item.fields.map((f) => (
          <DisabledField
            key={f.name}
            name={f.name}
            label={f.label}
            unit={f.unit}
          />
        ))}
      </>
    );
  }
  if (item.kind === "field") {
    return <DisabledField {...item.field} />;
  }
  if (item.kind === "toggle+config") {
    return (
      <>
        <DisabledToggle label={`Enable ${item.label.toLowerCase()}`} active={false} />
        <Note>
          When enabled the configuration form for this feature will land here.
        </Note>
      </>
    );
  }
  if (item.kind === "run-button") {
    return (
      <>
        <button
          type="button"
          className="codex-action-button codex-action-button--primary"
          disabled
          title="wired in a later session"
          style={{
            width: "100%",
            minHeight: 36,
            fontSize: 12,
            letterSpacing: 0.12,
          }}
        >
          ► SOLVE
        </button>
        <Note>
          Disabled until the solver wiring lands. Will POST the assembled XML to
          the running G+Smo container and stream eigenvalues + .vts back into{" "}
          <code style={{ color: "var(--accent-muted)" }}>output/</code> for the
          post-processor.
        </Note>
      </>
    );
  }
  return <Note>(no stub renderer for kind "{item.kind}")</Note>;
}

function Note({ children }) {
  return (
    <div
      style={{
        marginTop: 10,
        padding: "8px 10px",
        background: "var(--panel-bg-soft)",
        border: "1px solid var(--line-soft)",
        borderRadius: 4,
        fontSize: 10,
        color: "var(--text-muted)",
        fontFamily: MONO,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------- */

export default function PreInspectorPanel() {
  const selected = useUI((s) => s.selectedTreeItem);
  const found = findItem(selected);
  const totalItems = SECTIONS.reduce((a, s) => a + s.items.length, 0);

  return (
    <GlassPanel
      style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
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
        <span
          style={{
            fontSize: 9.5,
            color: "var(--text-soft)",
            fontFamily: MONO,
          }}
        >
          pre-processor
        </span>
      </div>

      <div
        style={{
          marginTop: 8,
          overflowY: "auto",
          flex: 1,
        }}
      >
        {!found?.item && (
          <Note>Select an item in the model tree to see its configuration.</Note>
        )}

        {found?.item && (() => {
          const wired = WIRED_ITEMS.has(selected);
          return (
            <>
              <div
                style={{
                  marginBottom: 6,
                  fontSize: 9.5,
                  color: "var(--text-muted)",
                  fontFamily: MONO,
                  textTransform: "uppercase",
                  letterSpacing: 0.1,
                }}
              >
                {found.section.label}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--text-primary)",
                    fontFamily: MONO,
                  }}
                >
                  {found.item.label}
                </span>
                {wired ? <ConfiguredBadge /> : <StubBadge />}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--accent-muted)",
                  fontFamily: MONO,
                  marginBottom: 10,
                }}
                className="num"
              >
                <LivePreviewLine dottedId={selected} fallback={found.item.defaultPreview} />
              </div>

              <SectionHeader>configuration</SectionHeader>
              {wired
                ? <WiredInspector dottedId={selected} />
                : <StubBody section={found.section} item={found.item} />
              }
            </>
          );
        })()}

        {/* Physics Copilot placeholder — future insights based on model state */}
        <PhysicsInsightsCard
          insights={[
            "Mesh may underresolve local buckling if r < 3 at high L/R",
            "Eigenmode imperfection tracking recommended for post-buckling",
          ]}
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
          lineHeight: 1.45,
        }}
      >
        {totalItems} model-tree items defined ·{" "}
        <span style={{ color: "var(--accent-muted)" }}>
          {WIRED_ITEMS.size} wired
        </span>{" "}
        · AERIS 2026 redesign
      </div>
    </GlassPanel>
  );
}
