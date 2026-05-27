import React from "react";
import { MONO } from "../../constants.js";

/** Segmented control / pill variant.
 *
 * Each option is a 2-tuple `[key, label]`, or a 3-tuple
 * `[key, label, { disabled?: boolean, title?: string }]`. Disabled options
 * render greyed out and ignore clicks; the optional `title` shows on hover
 * (use it to explain WHY the option is disabled, so the user isn't left
 * wondering whether the UI is broken). */
export default function ToggleGroup({ options, value, onChange, fullWidth = false }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 0,
        borderRadius: 5,
        overflow: "hidden",
        border: "1px solid var(--control-border)",
        width: fullWidth ? "100%" : "auto",
      }}
    >
      {options.map((opt, i) => {
        const [key, label, meta] = opt;
        const disabled = !!meta?.disabled;
        const title = meta?.title;
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => { if (!disabled) onChange(key); }}
            disabled={disabled}
            title={title}
            style={{
              flex: fullWidth ? 1 : "0 0 auto",
              padding: "5px 12px",
              fontSize: 10,
              fontFamily: MONO,
              fontWeight: active ? 700 : 400,
              border: "none",
              borderRight:
                i < options.length - 1 ? "1px solid var(--control-border)" : "none",
              background: active ? "var(--control-active-bg)" : "var(--control-bg)",
              color: disabled
                ? "var(--text-soft)"
                : active
                  ? "var(--accent)"
                  : "var(--text-muted)",
              textShadow: active && !disabled ? "var(--shadow-accent)" : "none",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.55 : 1,
              textTransform: "uppercase",
              letterSpacing: 0.04,
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
