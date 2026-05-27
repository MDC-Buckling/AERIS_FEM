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
        borderBottom: "1px solid var(--line-faint)",
        cursor: "pointer",
        color: "var(--text-primary)",
        fontFamily: MONO,
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.08,
      }}
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
 * Mirrors LivePreviewLine in PreInspectorPanel.jsx (kept tiny — only fields
 * that actually drive the run get a live line here; others stay static). */
function previewFor(dottedId, model) {
  if (dottedId === "geometry.dimensions") {
    const c = model.geometry.cylinder;
    return `R=${c.R}  L=${c.L}  t=${c.t}`;
  }
  if (dottedId === "geometry.shape") {
    return model.geometry.shape;
  }
  return null;
}

function SubItem({ section, item, active, onClick, dottedId }) {
  const model = useUI((s) => s.model);
  const live = previewFor(dottedId, model);
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
        background: active ? "rgba(0, 200, 255, 0.10)" : "transparent",
        border: active
          ? "1px solid rgba(0, 229, 255, 0.34)"
          : "1px solid transparent",
        borderLeft: active
          ? "2px solid var(--accent)"
          : "2px solid transparent",
        borderRadius: 3,
        cursor: "pointer",
        color: active ? "var(--accent)" : "var(--text-secondary)",
        fontFamily: MONO,
        position: "relative",
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
          MODEL TREE
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
        Structure locked Session 3.1.{" "}
        <span style={{ color: "var(--accent-muted)" }}>Geometry</span> fills first;
        then up the list.
      </div>
    </GlassPanel>
  );
}
