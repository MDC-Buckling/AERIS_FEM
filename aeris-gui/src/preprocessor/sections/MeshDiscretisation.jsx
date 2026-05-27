import React from "react";
import NumberField from "../../components/ui/NumberField.jsx";
import ToggleGroup from "../../components/ui/ToggleGroup.jsx";
import { MONO } from "../../constants.js";
import { useUI } from "../../store.js";

/** Functional inspector for MESH > Discretisation.
 *
 * Edits the model.mesh block (refinement / degree / smoothness / coupling).
 * In IGA the mesh surface is much narrower than classical FEM — no element
 * types, no normals, no element-size knob — just the three h/p/k refinement
 * choices plus the inter-patch coupling strategy. All four flow through to
 * the multipatch driver via cylinder_lba.py (-r, -p, -s, -m).
 *
 * Smoothness must stay < degree (it's the C^k continuity inside a patch,
 * which is capped at p-1 by spline theory). We enforce that here by
 * clamping smoothness when the user lowers degree.
 *
 * The DOF / patch / interface count at the bottom is a live estimate
 * derived from the current geometry partitions, so the user sees the cost
 * shift when they bump r or p before they actually hit Solve. */

const COUPLING_OPTIONS = [
  // value matches the schema string in model.mesh.coupling; the GUI never
  // touches the integer -m flag, only the names. The Python side maps
  // names → method ints via COUPLING_METHOD in cylinder_lba.py.
  ["gsSmoothInterfaces", "Smooth Interfaces"],
  ["gsAlmostC1",         "Almost C1"],
  ["gsDPatch",           "D-Patch"],
  ["gsApproxC1Spline",   "Approx C1"],
];

export default function MeshDiscretisation() {
  const mesh = useUI((s) => s.model.mesh);
  const cyl = useUI((s) => s.model.geometry.cylinder);
  const setField = useUI((s) => s.setMeshField);

  const r = Number(mesh.refinement);
  const p = Number(mesh.degree);
  const k = Number(mesh.smoothness);
  const coupling = String(mesh.coupling);

  // Live DOF + topology estimate. Per-patch element count after r knot
  // insertions = (1 + 2^r)² (one initial bilinear interval per direction,
  // each split into 2^r at refinement r). Total CPs per patch with degree
  // p and smoothness k = (2^r·(p-k) + k + 1)². Multiply by 3 DOFs per CP
  // (Kirchhoff–Love shell: u, v, w). This is an upper bound — the smooth-
  // basis builder collapses CPs at G1 interfaces, so the actual count is
  // lower, but the SCALING is what matters for "is r=6 affordable".
  const nPatches = 4 * ((cyl.partitions?.length ?? 0) + 1);
  const cpsPerSide = Math.pow(2, r) * (p - k) + k + 1;
  const dofPerPatch = cpsPerSide * cpsPerSide * 3;
  const dofTotal = dofPerPatch * nPatches;
  // Interfaces: 4 θ-seams per band + 4 z-seams per partition.
  const nBands = (cyl.partitions?.length ?? 0) + 1;
  const nInterfaces = 4 * nBands + 4 * (cyl.partitions?.length ?? 0);

  const onDegree = (v) => {
    const next = Math.max(1, Math.round(v));
    setField("degree", next);
    if (k >= next) setField("smoothness", Math.max(0, next - 1));
  };
  const onSmoothness = (v) => {
    // Clamp into [0, degree-1] silently. The bound matches what spline
    // theory requires; the solver would crash otherwise.
    const clamped = Math.max(0, Math.min(p - 1, Math.round(v)));
    setField("smoothness", clamped);
  };
  const onRefinement = (v) => {
    setField("refinement", Math.max(0, Math.min(8, Math.round(v))));
  };

  return (
    <>
      <NumberField
        label="Refinement  (h — number of knot insertions per patch)"
        symbol="r"
        unit="–"
        value={r}
        onChange={onRefinement}
        min={0}
        max={8}
        step={1}
        precision={0}
        hint="each +1 quadruples the element count per patch (2^r per direction). Session-2.7 validated at r=5"
      />

      <NumberField
        label="Spline degree  (p — polynomial order after elevation)"
        symbol="p"
        unit="–"
        value={p}
        onChange={onDegree}
        min={1}
        max={6}
        step={1}
        precision={0}
        hint="cubic (p=3) is the validated default. Bumping p improves accuracy but costs O(p²) DOFs per patch"
      />

      <NumberField
        label="Smoothness  (k — C^k continuity inside each patch)"
        symbol="k"
        unit="–"
        value={k}
        onChange={onSmoothness}
        min={0}
        max={Math.max(0, p - 1)}
        step={1}
        precision={0}
        hint={`must stay strictly < degree (current cap: k ≤ ${p - 1}). Higher k = fewer DOFs and smoother basis`}
      />

      <div style={{ marginBottom: 9 }}>
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: 10.5,
            fontFamily: MONO,
            marginBottom: 4,
          }}
        >
          Inter-patch coupling
        </div>
        <ToggleGroup
          options={COUPLING_OPTIONS}
          value={coupling}
          onChange={(v) => setField("coupling", v)}
          fullWidth
        />
        <div
          style={{
            marginTop: 4,
            fontSize: 9.5,
            color: "var(--text-muted)",
            fontFamily: MONO,
            lineHeight: 1.45,
          }}
        >
          Smooth Interfaces (m=0) for our regular 4·(N+1)-patch cylinder
          topology. Almost C1 (m=1) becomes mandatory for extraordinary
          vertices (cone–cylinder junctions etc.) — switch when those
          geometries land. D-Patch and Approx-C1 are alternative G1
          constructions kept here for ablation.
        </div>
      </div>

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
        <DerivedRow label="Patches" value={`${nPatches}  (4 × ${nBands} band${nBands === 1 ? "" : "s"})`} />
        <DerivedRow label="Interfaces" value={String(nInterfaces)} />
        <DerivedRow
          label="DOFs per patch  (upper bound)"
          value={`≈ ${cpsPerSide}² × 3 = ${dofPerPatch.toLocaleString()}`}
        />
        <DerivedRow
          label="Total DOFs  (upper bound)"
          value={`≈ ${dofTotal.toLocaleString()}`}
          accent
        />
        <div
          style={{
            marginTop: 6,
            fontSize: 9.5,
            color: "var(--text-muted)",
            lineHeight: 1.4,
          }}
        >
          Smooth-basis G1 stitching collapses control points across
          interfaces, so the actual DOF count is lower. The number above is
          the right yardstick for cost-scaling decisions ("is r=6
          affordable?"), not for solver memory budgeting.
        </div>
      </div>
    </>
  );
}

function DerivedRow({ label, value, accent = false }) {
  return (
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
          color: accent ? "var(--accent)" : "var(--text-primary)",
          fontSize: accent ? 13 : 11.5,
          fontWeight: accent ? 700 : 500,
          fontFamily: MONO,
          textShadow: accent ? "var(--shadow-accent)" : "none",
        }}
      >
        {value}
      </span>
    </div>
  );
}
