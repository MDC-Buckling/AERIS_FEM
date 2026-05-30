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
  //
  // Only Smooth Interfaces is validated for our regular 4·(N+1)-patch
  // cylinder topology (Session 2.7). The other three are real G+Smo
  // options that the multipatch driver accepts, but we haven't pinned a
  // reference case against them yet — disable here so the user knows
  // why nothing changes if they click them.
  ["gsSmoothInterfaces", "Smooth Interfaces"],
  ["gsAlmostC1",         "Almost C1",
    { disabled: true, title: "needed for extraordinary vertices (cone-cylinder, etc.) — enabled when those geometries land" }],
  ["gsDPatch",           "D-Patch",
    { disabled: true, title: "B-spline only; alternative G1 construction. Not validated for this topology yet." }],
  ["gsApproxC1Spline",   "Approx C1",
    { disabled: true, title: "approximate-C1 construction. Not validated for this topology yet." }],
];

// Discretisation engine — canonical values MUST match the Python contract
// (scripts/aeris_model.py solver.engine): "gismo" | "code_aster". The labels
// are cosmetic; the values are what the dispatcher routes on.
const ENGINE_OPTIONS = [
  ["gismo",      "NURBS / IGA"],
  ["code_aster", "Code_Aster / FEM"],
];

// Code_Aster shell element families. DKT (linear TRIA3) is the validated
// default; the others are real Code_Aster modelisations but not yet wired in
// the mesh layer / cross-checked.
const FAMILY_OPTIONS = [
  ["DKT",      "DKT (TRIA3)"],
  ["COQUE_3D", "COQUE_3D (QUAD9)"],
  ["DKTG",     "DKTG",
    { disabled: true, title: "thin shell + drilling DOF (TRIA3); used internally for GNA, not yet exposed as a static choice" }],
];

// Per-family derived properties surfaced in the FEM panel (ansatz order,
// element shape, shell theory). These follow from the element family — the
// mesh layer coerces the geometric order to match, so they're read-only here.
const FAMILY_INFO = {
  DKT:      { ansatz: "linear (P1)",    shape: "triangle · TRIA3",       theory: "thin shell (Kirchhoff)" },
  DKTG:     { ansatz: "linear (P1)",    shape: "triangle · TRIA3",       theory: "thin shell + drilling DOF" },
  COQUE_3D: { ansatz: "quadratic (P2)", shape: "quad · QUAD9 (+centre)", theory: "thick/curved shell (Mindlin)" },
};

export default function MeshDiscretisation() {
  const mesh = useUI((s) => s.model.mesh);
  const cyl = useUI((s) => s.model.geometry.cylinder);
  const setField = useUI((s) => s.setMeshField);
  const engine = useUI((s) => s.model.solver?.engine ?? "gismo");
  const setEngine = useUI((s) => s.setSolverEngine);
  const ca = useUI((s) => s.model.discretization?.code_aster ?? {});
  const setCa = useUI((s) => s.setCaDiscField);

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
      <div style={{ marginBottom: 9 }}>
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: 10.5,
            fontFamily: MONO,
            marginBottom: 4,
          }}
        >
          Discretisation engine
        </div>
        <ToggleGroup
          options={ENGINE_OPTIONS}
          value={engine}
          onChange={setEngine}
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
          NURBS/IGA (G+Smo multipatch, the validated default) vs classical FEM
          (Code_Aster). The model is engine-agnostic — switching changes how it
          is discretised &amp; solved, not the geometry/material/load.
        </div>
      </div>

      {engine === "gismo" && (
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
        showRange
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
        showRange
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
        showRange
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
      )}

      {engine === "code_aster" && (
        <CodeAsterPanel ca={ca} setCa={setCa} />
      )}
    </>
  );
}

/** Code_Aster (classical FEM) branch of the mesh inspector. No IGA r/p/k —
 * a real mesh is generated by GMSH from a target element size, with a shell
 * element family. The node/element count isn't known until solve time (GMSH
 * meshes then), so this panel shows intent, not a DOF estimate. */
function CodeAsterPanel({ ca, setCa }) {
  const family = String(ca.element_family ?? "DKT");
  const meshSize = Number(ca.mesh_size ?? 2.0);
  const info = FAMILY_INFO[family] ?? FAMILY_INFO.DKT;
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
          Element type  (Code_Aster shell modelisation)
        </div>
        <ToggleGroup
          options={FAMILY_OPTIONS}
          value={family}
          onChange={(v) => setCa("element_family", v)}
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
          DKT (linear TRIA3) is the thin-shell workhorse — validated vs the IGA
          engine on Scordelis-Lo to 0.1%. COQUE_3D is the curved thick-shell
          element (biquadratic QUAD9 with a centre node) — higher accuracy per
          element; it converges to the Scordelis reference (|u_z|→0.302) on a
          coarser mesh.
        </div>
      </div>

      <NumberField
        label="Element size  (h — target edge length of the FEM mesh)"
        symbol="h"
        unit="mm"
        value={meshSize}
        onChange={(v) => setCa("mesh_size", v)}
        min={0.01}
        step={0.5}
        precision={3}
        hint="in the model's length unit (mm). Smaller = finer mesh — there is no IGA refinement level here, GMSH meshes directly from h. Scordelis-Lo converges by h ≈ 0.5 (|u_z| → 0.300)."
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
        <DerivedRow label="Engine" value="Code_Aster (classical FEM)" />
        <DerivedRow label="Modelisation" value={family} accent />
        <DerivedRow label="Ansatz / order" value={info.ansatz} />
        <DerivedRow label="Element shape" value={info.shape} />
        <DerivedRow label="Shell theory" value={info.theory} />
        <DerivedRow label="Mesher" value="GMSH → MED (at solve)" />
        <div
          style={{
            marginTop: 6,
            fontSize: 9.5,
            color: "var(--text-muted)",
            lineHeight: 1.4,
          }}
        >
          The node/element count follows from geometry &amp; element size and is
          reported in the run sidecar after meshing. Code_Aster engine wired
          today: cylinder_segment + cylinder (static / GNA), cylinder buckling.
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
