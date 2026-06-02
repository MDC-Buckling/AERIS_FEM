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
  ["bb",         "Bernstein-Bézier"],
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
  DKT:      { ansatz: "linear (P1)",    theory: "thin shell (Kirchhoff)" },
  DKTG:     { ansatz: "linear (P1)",    theory: "thin shell + drilling DOF" },
  COQUE_3D: { ansatz: "quadratic (P2)", theory: "thick/curved shell (Mindlin)" },
};

// Abaqus-style mesh controls, independent of the element type.
const SHAPE_OPTIONS = [
  ["triangle", "Triangle"],
  ["quad",     "Quad"],
];
const TECHNIQUE_OPTIONS = [
  ["free",       "Free"],
  ["structured", "Structured"],
];

// Stable empty default so the Zustand selector below never returns a fresh
// object (which would make useSyncExternalStore loop — "getSnapshot should be
// cached" → Maximum update depth). Models saved before the discretization
// schema simply have no code_aster block; we default to this shared ref.
const CA_EMPTY = {};
const BB_EMPTY = {};

export default function MeshDiscretisation() {
  const mesh = useUI((s) => s.model.mesh);
  const cyl = useUI((s) => s.model.geometry.cylinder);
  const setField = useUI((s) => s.setMeshField);
  const engine = useUI((s) => s.model.solver?.engine ?? "gismo");
  const setEngine = useUI((s) => s.setSolverEngine);
  const ca = useUI((s) => s.model.discretization?.code_aster) ?? CA_EMPTY;
  const setCa = useUI((s) => s.setCaDiscField);
  const bb = useUI((s) => s.model.discretization?.bb) ?? BB_EMPTY;
  const setBb = useUI((s) => s.setBbDiscField);

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
      {/* Solver engine — the top-level choice that drives the whole solver
          (and the rest of this panel). Styled as a prominent accent card so
          it doesn't read as just another sub-option. */}
      <div
        style={{
          marginBottom: 14,
          padding: "11px 12px 12px",
          background: "var(--accent-soft-bg, rgba(0,180,210,0.08))",
          border: "1px solid var(--accent)",
          borderRadius: 6,
          boxShadow: "0 0 14px rgba(0,180,210,0.12)",
        }}
      >
        <div
          style={{
            color: "var(--accent)",
            fontSize: 11.5,
            fontWeight: 700,
            fontFamily: MONO,
            letterSpacing: 0.12,
            textTransform: "uppercase",
            marginBottom: 7,
            textShadow: "var(--shadow-accent)",
          }}
        >
          ⚙ Discretisation engine
        </div>
        <ToggleGroup
          options={ENGINE_OPTIONS}
          value={engine}
          onChange={setEngine}
          fullWidth
        />
        <div
          style={{
            marginTop: 6,
            fontSize: 9.5,
            color: "var(--text-muted)",
            fontFamily: MONO,
            lineHeight: 1.45,
          }}
        >
          NURBS/IGA (G+Smo multipatch, the validated default), Bernstein-Bézier
          triangle KL-shell (Ludwig/Hühne — cylinder axial LBA), or classical
          FEM (Code_Aster). The model is engine-agnostic — switching changes how
          it is discretised &amp; solved, not the geometry/material/load.
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

      {engine === "bb" && (
        <BbPanel bb={bb} setBb={setBb} cyl={cyl} />
      )}

      {engine === "code_aster" && (
        <CodeAsterPanel ca={ca} setCa={setCa} />
      )}
    </>
  );
}

/** Bernstein-Bézier triangle KL-shell branch of the mesh inspector. No IGA
 * r/p/k and no FE element-size: the mesh is a structured Nx×Nt triangulation
 * of the cylinder, each quad cell split into two degree-p BB triangles. The
 * three knobs (degree p, Nx, Nt) map 1:1 onto model.discretization.bb, which
 * bb_cylinder_lba.py forwards to the BB driver. The dense generalized
 * eigensolve makes this best suited to the moderate-R/t regime; the panel
 * warns when Nt is too coarse to resolve the short circumferential wave
 * n_cr ≈ √(R/t) of the critical Koiter mode. */
function BbPanel({ bb, setBb, cyl }) {
  const p = Number(bb.degree ?? 5);
  const Nx = Number(bb.Nx ?? 4);
  const Nt = Number(bb.Nt ?? 20);
  const nmodes = Number(bb.nmodes ?? 8);

  const RoverT = cyl.t > 0 ? cyl.R / cyl.t : 0;
  const nCr = RoverT > 0 ? Math.sqrt(RoverT) : 0;
  // The circumferential mesh must resolve the n_cr full waves of the critical
  // mode — at least ~2 elements per wave, i.e. Nt ≳ 2·n_cr (Nyquist-ish). The
  // validated R/t=20 case uses Nt=20 against n_cr≈4.5 (≈4.4 elems/wave).
  const NtMin = Math.ceil(2.2 * nCr);
  const underResolved = nCr > 0 && Nt < NtMin;
  // Accuracy limit (NOT speed — the sparse solver is fast): BB's polynomial
  // geom_C¹ can't represent the circle exactly, so it UNDER-estimates σ_cr at
  // thin shells. Cross-checked vs the exact-geometry NURBS engine at R/t=330:
  // BB gave 0.78–0.94·σ_cl (wrong, too-long mode) vs NURBS 1.00·σ_cl (−0.01%).
  const tooThin = RoverT > 60;

  const nTri = 2 * Nx * Nt;
  const cpPerTri = ((p + 1) * (p + 2)) / 2;
  const ndApprox = 3 * Nx * Nt * p * p;   // empirical ≈ (R/t=20: ~6.3k actual)

  // Geometry-driven mesh suggestion — operationalises the cylinder buckling
  // meshing rule (element length ℓ≈0.5√(Rt), i.e. finer for thinner shells),
  // p=5-adjusted and CAPPED to the sparse-solver budget. Grounded in the two
  // validated/measured cases (both fit Nt≈4·n_cr; axial wants ~2.5 half-waves
  // of length π√(Rt) → Nx≈0.8·L/√(Rt)). When the ideal mesh exceeds the solver
  // budget (thin shells need huge meshes) it scales down + flags under-resolution.
  const sqrtRt = cyl.R > 0 && cyl.t > 0 ? Math.sqrt(cyl.R * cyl.t) : 0;
  const NtIdeal = nCr > 0 ? Math.round(4 * nCr) : Nt;
  const NxIdeal = sqrtRt > 0 ? Math.max(2, Math.round((0.8 * cyl.L) / sqrtRt)) : Nx;
  const ND_CAP = 80000;
  const ndIdeal = 3 * NxIdeal * NtIdeal * p * p;
  const meshCapped = ndIdeal > ND_CAP;
  const meshScale = meshCapped ? Math.sqrt(ND_CAP / ndIdeal) : 1;
  const NxSug = Math.max(2, Math.round(NxIdeal * meshScale));
  const NtSug = Math.max(4, Math.round(NtIdeal * meshScale));
  const ndSug = 3 * NxSug * NtSug * p * p;
  const atSuggested = Nx === NxSug && Nt === NtSug;

  return (
    <>
      <div
        style={{
          marginBottom: 11,
          padding: "9px 11px",
          background: "var(--panel-bg-soft)",
          border: "1px solid var(--line-soft)",
          borderRadius: 5,
          fontFamily: MONO,
          fontSize: 9.5,
          color: "var(--text-muted)",
          lineHeight: 1.5,
        }}
      >
        <div style={{ color: "var(--text-secondary)", fontWeight: 700, marginBottom: 4, fontSize: 10 }}>
          Choosing the four parameters
        </div>
        <div><b style={{ color: "var(--accent-muted)" }}>p</b> — leave at 5 (locking-safe, Ludwig). Higher rarely pays off; lower risks membrane locking.</div>
        <div><b style={{ color: "var(--accent-muted)" }}>Nx</b> — ~4 for L/R≈1; scale with L/R for longer cylinders.</div>
        <div><b style={{ color: "var(--accent-muted)" }}>Nt</b> — the critical one: resolve n_cr≈√(R/t) → Nt ≳ 2.2·n_cr. Watch the warning below.</div>
        <div><b style={{ color: "var(--accent-muted)" }}>N</b> — 8 captures the Koiter cluster; raise only to inspect more modes.</div>
        <div style={{ marginTop: 4 }}>Dense solve → keep R/t ≈ 20 (set t≈R/20 in Geometry). Cost grows ≈ (Nx·Nt·p²)³.</div>
      </div>

      <NumberField
        label="Bernstein degree  (p — triangle polynomial order)"
        symbol="p"
        unit="–"
        value={p}
        onChange={(v) => setBb("degree", v)}
        min={2}
        max={6}
        step={1}
        precision={0}
        showRange
        hint="p=5 is the validated default — Ludwig 9.3.2: p≥5 avoids membrane locking on arbitrary triangulations. The element carries 2nd derivatives (rotation-free KL)."
      />

      <NumberField
        label="Axial elements  (Nx — cells along the axis)"
        symbol="Nx"
        unit="–"
        value={Nx}
        onChange={(v) => setBb("Nx", v)}
        min={2}
        max={64}
        step={1}
        precision={0}
        showRange
        hint="along the cylinder length (each quad cell → 2 BB triangles). Axial half-wave ≈ π√(Rt) → Nx ≈ 0.8·L/√(Rt). Use the geometry suggestion below."
      />

      <NumberField
        label="Circumferential elements  (Nt — cells around)"
        symbol="Nt"
        unit="–"
        value={Nt}
        onChange={(v) => setBb("Nt", v)}
        min={4}
        max={128}
        step={1}
        precision={0}
        showRange
        hint="the key knob: resolves the short n_cr≈√(R/t) wave AND the curved geometry → Nt ≈ 4·n_cr (validated). Use the geometry suggestion below."
      />

      <NumberField
        label="Modes to report  (lowest cluster size)"
        symbol="N"
        unit="–"
        value={nmodes}
        onChange={(v) => setBb("nmodes", v)}
        min={1}
        max={16}
        step={1}
        precision={0}
        showRange
        hint="the closed-cylinder spectrum is densely near-degenerate at σ_cl (Koiter circle) — read the cluster, not bare λ_min"
      />

      {sqrtRt > 0 && (
        <div
          style={{
            marginTop: 8,
            padding: "9px 11px",
            background: "var(--accent-soft-bg, rgba(0,180,210,0.07))",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            fontFamily: MONO,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 10, fontWeight: 700 }}>
              ⟂ Suggested mesh (from R, t, L)
            </span>
            <button
              type="button"
              onClick={() => { setBb("Nx", NxSug); setBb("Nt", NtSug); }}
              disabled={atSuggested}
              style={{
                fontFamily: MONO, fontSize: 10, padding: "2px 9px", borderRadius: 4,
                border: "1px solid var(--accent)", cursor: atSuggested ? "default" : "pointer",
                background: atSuggested ? "transparent" : "var(--accent-soft-bg, rgba(0,180,210,0.14))",
                color: atSuggested ? "var(--text-muted)" : "var(--accent)",
              }}
            >
              {atSuggested ? "✓ applied" : "Apply"}
            </button>
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: "var(--accent)", fontWeight: 700, textShadow: "var(--shadow-accent)" }}>
            Nx = {NxSug} · Nt = {NtSug}{" "}
            <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: 9.5 }}>
              (≈ {ndSug.toLocaleString()} DOF)
            </span>
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 9.5,
              color: meshCapped ? "var(--warning)" : "var(--text-muted)",
              lineHeight: 1.45,
            }}
          >
            {meshCapped
              ? `⚠ ideal mesh (Nx≈${NxIdeal}, Nt≈${NtIdeal}, ~${(ndIdeal / 1000).toFixed(0)}k DOF) exceeds the solver budget — scaled down. Under-resolved at R/t=${RoverT.toFixed(0)} → σ_cr under-estimated; for thin shells the NURBS engine is exact (fewer DOF, exact circle).`
              : `resolves the buckling half-wavelength π√(Rt) + the curved geometry (Nt≈4·n_cr, Nx≈0.8·L/√(Rt)). Fits the sparse solver.`}
          </div>
        </div>
      )}

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
        <DerivedRow label="Engine" value="Bernstein-Bézier triangle (KL, Ludwig)" />
        <DerivedRow label="Mesh" value={`${nTri} triangles  (2 × ${Nx} × ${Nt})`} />
        <DerivedRow label="CPs / triangle" value={`${cpPerTri}  (p=${p})`} />
        <DerivedRow
          label="DOFs  (approx)"
          value={`≈ ${ndApprox.toLocaleString()}`}
          accent
        />
        <DerivedRow
          label="n_cr ≈ √(R/t)"
          value={RoverT > 0 ? `${nCr.toFixed(1)}  (R/t = ${RoverT.toFixed(0)})` : "—"}
        />
        <div
          style={{
            marginTop: 6,
            fontSize: 9.5,
            color: underResolved || tooThin ? "var(--warning)" : "var(--text-muted)",
            lineHeight: 1.45,
          }}
        >
          {underResolved
            ? `⚠ Nt = ${Nt} is coarse for n_cr ≈ ${nCr.toFixed(1)} — raise Nt ≳ ${NtMin} so the circumferential wave is resolved (else the cluster reads too stiff).`
            : tooThin
              ? `⚠ R/t = ${RoverT.toFixed(0)} is thin — BB's polynomial geometry UNDER-estimates σ_cr here (cross-checked vs NURBS at R/t=330: BB 0.78–0.94 vs exact 1.00·σ_cl). Validated at R/t≈20; for thin shells use the NURBS / IGA engine (exact circle).`
              : "Closed-cylinder axial LBA: uniform axial prestress (by construction), SS hinged ends, dense generalized eigensolve. Validated at R/t≈20 → lowest cluster [m0,n8] ≈ 0.90·σ_cl (the classical Koiter short-wave mode)."}
        </div>
      </div>
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
  const shape = String(ca.element_shape ?? "triangle");
  const technique = String(ca.technique ?? "free");
  const isCoque = family === "COQUE_3D";
  const effShape = isCoque ? "quad" : shape;     // COQUE_3D is quad-only
  const elementLabel = isCoque
    ? "QUAD9 (+centre)"
    : effShape === "quad" ? "QUAD4 (DKQ)" : "TRIA3";
  // COQUE_3D can't use triangles (its QUAD9 needs a centre node) — disable it.
  const shapeOptions = isCoque
    ? [["triangle", "Triangle", { disabled: true, title: "COQUE_3D needs the QUAD9 centre node — quad only" }], ["quad", "Quad"]]
    : SHAPE_OPTIONS;
  const meshPreview = useUI((s) => s.meshPreview);
  const busy = useUI((s) => s.meshPreviewBusy);
  const preview = useUI((s) => s.meshPreviewResult);
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

      {/* Abaqus-style mesh controls, independent of the element type. */}
      <div style={{ display: "flex", gap: 8, marginBottom: 9 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: "var(--text-secondary)", fontSize: 10.5, fontFamily: MONO, marginBottom: 4 }}>
            Element shape
          </div>
          <ToggleGroup
            options={shapeOptions}
            value={effShape}
            onChange={(v) => setCa("element_shape", v)}
            fullWidth
          />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: "var(--text-secondary)", fontSize: 10.5, fontFamily: MONO, marginBottom: 4 }}>
            Mesh technique
          </div>
          <ToggleGroup
            options={TECHNIQUE_OPTIONS}
            value={technique}
            onChange={(v) => setCa("technique", v)}
            fullWidth
          />
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
        <DerivedRow label="Element" value={elementLabel} />
        <DerivedRow label="Ansatz / order" value={info.ansatz} />
        <DerivedRow label="Shell theory" value={info.theory} />
        <DerivedRow label="Mesh" value={`${effShape} · ${technique} · GMSH→MED`} />
        <div
          style={{
            marginTop: 6,
            fontSize: 9.5,
            color: "var(--text-muted)",
            lineHeight: 1.4,
          }}
        >
          Click “Generate mesh” to mesh now (no solve) and see the actual
          node/element counts. Code_Aster engine wired today: cylinder_segment
          + cylinder (static / GNA), cylinder buckling.
        </div>
      </div>

      <button
        type="button"
        onClick={() => meshPreview()}
        disabled={busy}
        className="codex-action-button"
        title="Generate the FE mesh now (no solve) and report its node/element counts — the Abaqus 'Mesh Part' step"
        style={{
          width: "100%",
          marginTop: 8,
          minHeight: 34,
          fontSize: 11,
          fontFamily: MONO,
          letterSpacing: 0.1,
        }}
      >
        {busy ? "⏳ Meshing…" : "⚙ Generate mesh (preview)"}
      </button>

      {preview && (
        <div
          style={{
            marginTop: 6,
            padding: "8px 12px",
            background: "var(--panel-bg-soft)",
            border: "1px solid var(--line-soft)",
            borderRadius: 5,
            fontFamily: MONO,
          }}
        >
          {preview.ok ? (
            <>
              <DerivedRow label="Nodes" value={Number(preview.n_nodes).toLocaleString()} accent />
              <DerivedRow
                label="Elements"
                value={`${Number(preview.n_elements).toLocaleString()} · ${preview.element_family}`}
              />
              <DerivedRow label="Element size" value={`${preview.mesh_size} mm`} />
            </>
          ) : (
            <div style={{ fontSize: 10, color: "var(--warning)", fontFamily: MONO, lineHeight: 1.4 }}>
              mesh failed: {preview.error}
            </div>
          )}
        </div>
      )}
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
