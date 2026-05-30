import React from "react";
import GlassPanel from "../components/ui/GlassPanel.jsx";
import { MONO } from "../constants.js";
import { useUI } from "../store.js";
import { SECTIONS } from "./modelTree.js";

const STATUS_COLOR = {
  default: "var(--text-soft)",
  configured: "var(--accent)",
  warning: "var(--warning)",
};
const STATUS_LABEL = {
  default: "default",
  configured: "set",
  warning: "check",
};

function StatusDot({ status }) {
  return (
    <span
      title={STATUS_LABEL[status]}
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: STATUS_COLOR[status] ?? "var(--text-soft)",
        boxShadow:
          status === "configured" ? "0 0 6px var(--accent)" : "none",
        flex: "0 0 8px",
      }}
    />
  );
}

function Chevron({ open }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        textAlign: "center",
        color: "var(--text-muted)",
        fontFamily: MONO,
        fontSize: 10,
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s ease",
      }}
    >
      ▶
    </span>
  );
}

function SectionHeader({ section, expanded, status, sectionIndex, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        textAlign: "left",
        padding: "7px 8px",
        marginTop: 4,
        background: "transparent",
        border: "none",
        borderBottom: "1px solid transparent",
        cursor: "pointer",
        color: "var(--text-primary)",
        fontFamily: MONO,
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.08,
        transition: "border-color 0.18s ease, color 0.18s ease",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderBottomColor = "var(--line-steel-soft)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderBottomColor = "transparent")}
    >
      <Chevron open={expanded} />
      <span
        style={{
          width: 18,
          textAlign: "right",
          color: "var(--text-soft)",
          fontWeight: 400,
          fontSize: 10,
        }}
      >
        {String(sectionIndex + 1).padStart(2, "0")}
      </span>
      <span style={{ flex: 1 }}>{section.label}</span>
      <StatusDot status={status} />
    </button>
  );
}

/** For wired items, build the small preview line from live store state.
 * Mirrors LivePreviewLine in PreInspectorPanel.jsx — must be kept in sync
 * with the WIRED_ITEMS set there; missing a case here means the tree
 * shows the static defaultPreview from modelTree.js even after the
 * user edits the live value. */
function previewFor(dottedId, model, lastRun) {
  if (dottedId === "geometry.dimensions") {
    if (model.geometry.shape === "cylinder_segment") {
      const s = model.geometry.cylinder_segment;
      return `R=${s.R}  L=${s.L}  t=${s.t}  φ=${s.phi_deg}°`;
    }
    const c = model.geometry.cylinder;
    return `R=${c.R}  L=${c.L}  t=${c.t}`;
  }
  if (dottedId === "geometry.shape") {
    return model.geometry.shape;
  }
  if (dottedId === "material.base") {
    const m = model.materials?.[0];
    return m ? `${m.model} · E=${m.E}  ν=${m.nu}` : null;
  }
  if (dottedId === "shellConstruction.sectionAssignments") {
    return `${model.assignments?.length ?? 0} region · ${model.sections?.length ?? 0} section`;
  }
  if (dottedId === "mesh.discretisation") {
    // Lead with the discretisation engine so it's unambiguous in the tree
    // which solver the model targets (the toggle lives in this section's
    // inspector). IGA shows the h/p/k refinement; Code_Aster shows the FEM
    // element family + target element size.
    const engine = model.solver?.engine ?? "gismo";
    if (engine === "code_aster") {
      const ca = model.discretization?.code_aster ?? {};
      return `Code_Aster FEM · ${ca.element_family ?? "DKT"} · h=${ca.mesh_size ?? 2.0}`;
    }
    const m = model.mesh;
    return `NURBS / IGA · r=${m.refinement} p=${m.degree} s=${m.smoothness}`;
  }
  if (dottedId === "bcsLoads.bcs") {
    return model.bcs?.kind;
  }
  if (dottedId === "bcsLoads.load") {
    return `${model.load?.kind}  ·  mag=${model.load?.magnitude ?? 1}`;
  }
  if (dottedId === "analysis.type") {
    const k = model.analysis?.kind;
    // Match the human-readable label users see in AnalysisType.jsx.
    const LABEL = { lba: "LBA", static: "LSA", gna: "GNA", gnia: "GNIA", modal: "MODAL" };
    return LABEL[k] ?? k;
  }
  if (dottedId === "analysis.solver") {
    const a = model.analysis;
    if (a?.kind === "static") return "linear K·u=F · no eigensolver";
    if (a?.kind === "gna")    return "Newton-Raphson · K(u)·Δu = r(u) · no eigensolver";
    if (a?.kind === "gnia")   return `arc-length (Crisfield) · Δs=${a?.arcLength ?? 0.05} · imperf=${a?.imperfection ?? 0.001}`;
    const shiftLbl = a?.shift === "auto" ? "auto" : Number(a?.shift).toExponential(2);
    return `${a?.solver}  ·  N=${a?.nmodes}  ·  σ=${shiftLbl}`;
  }
  if (dottedId === "run.solve") {
    if (!lastRun || lastRun.status === "idle") return "ready — click SOLVE";
    if (lastRun.status === "running") return "running…";
    if (lastRun.status === "success") return `last run: success (${(lastRun.durationMs / 1000).toFixed(1)} s)`;
    if (lastRun.status === "failed") return "last run: failed";
    return null;
  }
  return null;
}

function SubItem({ section, item, active, onClick, dottedId }) {
  const model = useUI((s) => s.model);
  const lastRun = useUI((s) => s.lastRun);
  const live = previewFor(dottedId, model, lastRun);
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 10px 6px 32px",
        marginBottom: 2,
        background: active ? "rgba(100, 180, 220, 0.08)" : "transparent",
        border: "1px solid transparent",
        borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
        borderRadius: 4,
        cursor: "pointer",
        color: active ? "var(--accent)" : "var(--text-secondary)",
        fontFamily: MONO,
        position: "relative",
        transition: "background 0.18s ease, color 0.18s ease",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: active ? 700 : 500,
          textShadow: active ? "var(--shadow-accent)" : "none",
        }}
      >
        {item.label}
      </div>
      <div
        style={{
          marginTop: 2,
          fontSize: 10,
          color: active ? "var(--accent-muted)" : "var(--text-muted)",
          fontFamily: MONO,
          lineHeight: 1.35,
          letterSpacing: 0.01,
        }}
        className="num"
      >
        {live ?? item.defaultPreview ?? "—"}
        {item.disabled && (
          <span
            style={{
              marginLeft: 6,
              color: "var(--text-soft)",
              fontStyle: "italic",
            }}
          >
            (disabled)
          </span>
        )}
      </div>
    </button>
  );
}

export default function ModelTreePanel() {
  const expanded = useUI((s) => s.expandedSections);
  const toggleSection = useUI((s) => s.toggleSection);
  const selected = useUI((s) => s.selectedTreeItem);
  const selectItem = useUI((s) => s.selectTreeItem);
  const sectionStatus = useUI((s) => s.sectionStatus);
  const projectName = useUI((s) => s.projectName);
  const engine = useUI((s) => s.model.solver?.engine ?? "gismo");
  const expandedLeftPanels = useUI((s) => s.expandedLeftPanels);
  const toggleLeftPanel = useUI((s) => s.toggleLeftPanel);
  const isFem = engine === "code_aster";

  return (
    <GlassPanel
      style={{ display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <span className="codex-brand-title" style={{ fontSize: 11, letterSpacing: 0.1 }}>
          MODEL TREE
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Always-visible engine badge — the discretisation engine drives
              which solver (and image) runs; set it in MESH / DISCRETISATION. */}
          <span
            title="Discretisation engine — change it in MESH / DISCRETISATION"
            style={{
              fontSize: 8.5,
              fontFamily: MONO,
              fontWeight: 700,
              letterSpacing: 0.05,
              textTransform: "uppercase",
              padding: "2px 7px",
              borderRadius: 4,
              border: "1px solid",
              borderColor: isFem ? "rgba(255,170,60,0.55)" : "var(--control-border)",
              color: isFem ? "#ffb347" : "var(--accent)",
              background: isFem ? "rgba(255,170,60,0.10)" : "var(--control-active-bg)",
            }}
          >
            {isFem ? "Code_Aster FEM" : "NURBS / IGA"}
          </span>
          <span
            style={{
              fontSize: 9.5,
              color: "var(--text-soft)",
              fontFamily: MONO,
            }}
          >
            {projectName}
          </span>
        </div>
      </div>

      <div
        style={{
          marginTop: 4,
          fontSize: 9.5,
          color: "var(--text-muted)",
          fontFamily: MONO,
          letterSpacing: 0.02,
        }}
      >
        scaffold only · stubs in inspector
      </div>

      <div
        style={{
          marginTop: 8,
          overflowY: "auto",
          flex: 1,
          marginLeft: -4,
          marginRight: -4,
        }}
      >
        {SECTIONS.map((section, sIdx) => {
          const isOpen = expanded.has(section.id);
          const status = sectionStatus[section.id] ?? "default";
          return (
            <div key={section.id} style={{ marginBottom: 2 }}>
              <SectionHeader
                section={section}
                expanded={isOpen}
                status={status}
                sectionIndex={sIdx}
                onToggle={() => toggleSection(section.id)}
              />
              {isOpen && (
                <div style={{ marginTop: 4, marginBottom: 6 }}>
                  {section.items.map((item) => {
                    const dotted = `${section.id}.${item.id}`;
                    return (
                      <SubItem
                        key={dotted}
                        section={section}
                        item={item}
                        dottedId={dotted}
                        active={selected === dotted}
                        onClick={() => selectItem(dotted)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
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
        Structure locked. Fill order:{" "}
        <span style={{ color: "var(--accent-muted)" }}>Geometry</span> first, then
        up the tree. AERIS 2026.
      </div>

    </GlassPanel>
  );
}
