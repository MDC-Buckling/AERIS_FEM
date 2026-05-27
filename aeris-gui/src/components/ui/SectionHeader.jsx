import React from "react";
import { MONO } from "../../constants.js";

export default function SectionHeader({ children, style }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--accent-muted)",
        textTransform: "uppercase",
        letterSpacing: 1.5,
        marginTop: 12,
        marginBottom: 6,
        borderBottom: "1px solid var(--line-soft)",
        paddingBottom: 3,
        fontFamily: MONO,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
