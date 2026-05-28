import { create } from "zustand";

const THEME_KEY = "aeris_theme";

function initialTheme() {
  if (typeof window === "undefined") return "dark";
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "dark";
}

export const useUI = create((set) => ({
  theme: initialTheme(),
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {}
      return { theme: next };
    }),

  /** Top-level mode: pre-processor (model tree) | post-processor (results) |
   * hub (benchmark catalog + run + verdict). */
  mode: "pre",
  setMode: (m) => set({ mode: m }),

  /** Pre-processor: which model-tree sub-item is selected. Dotted id like
   * "geometry.dimensions". Drives the right inspector content. */
  selectedTreeItem: "geometry.shape",
  selectTreeItem: (id) => set({ selectedTreeItem: id }),

  /** Pre-processor: which sections are expanded. Default: only GEOMETRY open
   * (that's the first thing the user will touch when filling sections later). */
  expandedSections: new Set(["geometry"]),
  toggleSection: (sectionId) =>
    set((s) => {
      const next = new Set(s.expandedSections);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return { expandedSections: next };
    }),

  /** Pre-processor: per-section state — "default" | "configured" | "warning".
   * Sessions tick them to "configured" as their sections get wired. */
  sectionStatus: {
    geometry:          "configured",  // 3.2
    material:          "configured",  // 3.3
    shellConstruction: "configured",  // 3.3  (trivial section assignment view)
    imperfections:     "default",
    mesh:              "configured",  // 3.5
    bcsLoads:          "configured",  // 3.6 — bcs + axial/bending load wired
    analysis:          "configured",  // 3.8
    run:               "default",
  },
  setSectionStatus: (sectionId, status) =>
    set((s) => ({
      sectionStatus: { ...s.sectionStatus, [sectionId]: status },
    })),

  /** Project / model name shown in the top chrome. Editable later. */
  projectName: "Cylinder LBA",

  /** ----------------------------------------------------------------------
   *  THE MODEL — in-memory mirror of scripts/aeris_model.py's ModelConfig
   *  schema v2. Session 3.3 introduces the ABAQUS-style materials[] /
   *  sections[] / assignments[] split, replacing the v1 top-level
   *  `material: {...}`. Trivial today (one shell, one material, one
   *  assignment) but extensible for stiffeners / variable thickness.
   *  Serialised to model.json on EXPORT MODEL / Solve.
   *  --------------------------------------------------------------------*/
  model: {
    schemaVersion: 2,
    name: "Cylinder LBA",
    // Session-3.3 default: realistic steel-shell case in mm/MPa.
    // R=33, L=100, t=0.1 mm  (R/t = 330, very thin; L/R ≈ 3).
    // E=208 GPa, ν=0.3 (S235 mild-steel ballpark).
    // The whole pipeline is unit-agnostic — pick a consistent system and
    // stick to it. Old dimensionless E=1/R=1 path still works (see
    // build_cylinder_xml comment about the E-scaling fix for large E).
    geometry: {
      shape: "cylinder",
      // imperfectionForce: radial point-load perturbation at the
      // midheight + mid-quadrant point of patch 0 (parametric (0.5,
      // 0.5)). 0 = symmetric (no perturbation; classical LBA/LSA
      // path). Non-zero seeds the GNA load path off the trivial
      // symmetric branch so the Newton-Raphson actually traces the
      // bifurcation instead of converging to the trivial axisymmetric
      // solution past F_cr. Functional equivalent of ABAQUS's
      // "Pin radial DOF at midpoint" trick — a force imperfection
      // instead of a displacement one, but seeds the same modes.
      // Recommended starting value: 0.001 × F_applied.
      cylinder: { R: 33.0, L: 100.0, t: 0.1, partitions: [],
                  imperfectionForce: 0 },
      // Cylindrical-segment "roof" geometry (Increment 1 of the
      // Scordelis-Lo integration). Single biquadratic NURBS patch
      // swung ±phi_deg about the apex; axis along x. Solver wiring
      // lands in Increment 3 — for now the GUI lets you select the
      // shape, edit its dimensions, and see it in the pre-mode
      // viewport, but SOLVE will still bounce until the static
      // driver dispatch is in place. Defaults match the literature
      // Scordelis-Lo case (Belytschko 1985).
      cylinder_segment: { R: 25.0, L: 50.0, t: 0.25, phi_deg: 40.0 },
      sphere: { R: 10.0, t: 0.04, opening_angle_deg: 90.0 },
    },
    // Imperfection definition (used by GNIA). The textbook workflow: run
    // LBA first, take the chosen buckling mode, scale it to `amplitude`,
    // superimpose on the perfect geometry, THEN run the nonlinear
    // arc-length. All inside one solver pass (cylinder_arclength.py →
    // arclength_shell_multipatch_XML with -K/-M/-P).
    //   kind "none"      → perfect shell (sharp bifurcation; arc-length
    //                      may stall at the singular tangent)
    //   kind "eigenmode" → LBA mode `mode` scaled to `amplitude` (length
    //                      units; ≈ t/100 classical) — the gold standard
    //   kind "random"    → random radial CP perturbation of `amplitude`
    //                      (quick symmetry-breaker, not code-compliant)
    imperfections: { kind: "eigenmode", mode: 1, amplitude: 0.001 },
    materials: [
      {
        id: "mat-default",
        name: "Steel (linear isotropic)",
        model: "linear",
        E: 208000.0,   // MPa
        nu: 0.3,
      },
    ],
    sections: [
      {
        id: "sec-shell-1",
        name: "Shell — full cylinder",
        kind: "shell",
        material_ref: "mat-default",
        thickness_source: { kind: "geometry" },
        offset: "midsurface",
      },
    ],
    assignments: [
      { region: "shell_full", section_ref: "sec-shell-1" },
    ],
    mesh: {
      refinement: 5, degree: 3, smoothness: 2,
      coupling: "gsSmoothInterfaces",
    },
    bcs: { kind: "clamped_neumann" },
    // ABAQUS-LBA convention: magnitude is the applied F (axial) or M (bending)
    // in the user's consistent unit system. Default 1 means the eigenvalue
    // reads as the critical load directly (multiply by your real applied
    // load to get the safety factor). The solver's internal Neumann is
    // independently E-scaled for numerical conditioning.
    //
    // controlMode (cylinder GNA only, for now):
    //   "force"        — magnitude is the applied force F [N or your unit];
    //                    solver computes the resulting displacement.
    //   "displacement" — magnitude is the prescribed top-edge axial
    //                    displacement d [length]; solver iterates to find
    //                    the force F that produces that displacement.
    //                    Useful for the "ich gebe 1 mm vor, was sind die N?"
    //                    workflow + for tracing past peak load on softening
    //                    paths (where force-control would jump).
    // LSA / LBA ignore controlMode (LBA is eigenvalue-only; LSA is single
    // direct K·u=F).
    load: { kind: "axial", magnitude: 1.0, controlMode: "force" },
    analysis: {
      kind: "lba",
      nmodes: 5,
      // schema name (cylinder_lba.py maps to Spectra mode int via
      // SPECTRA_MODE_MAP). One of:
      //   spectra-buckling      → mode 3, our default (K_L SPD + K_g indef)
      //   spectra-shift-invert  → mode 2, generic shift-invert
      //   spectra-cayley        → mode 4, Cayley-transform shift-invert
      solver: "spectra-buckling",
      // Per-analysis solver method (named by method in the GUI):
      //   LBA  → `solver` above (Lanczos transform: buckling/shift-invert/cayley)
      //   LSA  → `lsaSolver`  (linear backend: "ldlt" direct, "cg" iterative)
      //   GNA  → `gnaSolver`  ("newton" Newton-Raphson, "dr" Dynamic Relaxation)
      //   GNIA → `almMethod`  (0 Load-control/NR, 1 Riks, 2 Crisfield)
      lsaSolver: "ldlt",
      gnaSolver: "newton",
      // "auto" resolves to classical_sigma_cr / E inside the solver, or
      // pass an explicit number to hunt a specific eigenvalue cluster.
      shift: "auto",
      // Arnoldi convergence tolerance. 1e-8 is well-conditioned; loosen
      // to 1e-6 for ~10–20 % faster runs, tighten to 1e-10 for paranoia.
      tolerance: 1e-8,
      // Krylov subspace size multiplier (ncv = ncv_factor · nmodes). Spectra
      // requires ≥ 2; 3 is generous and helps tough cases at modest cost.
      ncv_factor: 3,
      // gsThinShellAssembler IfcPenalty — weak C0/C1 fallback coupling.
      // 1e6 validated; bumping helps if patches couple poorly.
      interface_penalty: 1e6,
      // -------- GNA load-step adaptation (ABAQUS-style) --------
      // Mirrors the ABAQUS *STATIC / *DYNAMIC card semantics so the
      // mental model carries over cleanly. Adaptive walker uses these:
      //   maxIncrements : hard cap on total step attempts (retries + ok).
      //                   Halts when reached; bump if the run truncates
      //                   short of λ=1 with maxIncrements exhausted.
      //   initIncrement : Δλ at the start of the walk. ABAQUS default
      //                   is 1/maxIncrements; we default to 0.01 (= one
      //                   percent of total load per step), giving fine
      //                   resolution near the origin where most paths
      //                   are linear and grow-back kicks in quickly.
      //   maxIncrement  : ceiling for grow-back. Δλ never exceeds this
      //                   even after long stable runs — useful so the
      //                   curve stays detailed enough to capture
      //                   softening when it appears.
      //   minIncrement  : floor for bisection. If a bisect would drop
      //                   below this the walker halts with
      //                   verdict.haltedReason set, indicating the
      //                   solver couldn't get past that load level.
      // LSA + LBA ignore all four (LSA is single direct solve; LBA is
      // eigenvalue-only).
      maxIncrements: 100,
      initIncrement: 0.01,
      maxIncrement: 0.1,
      minIncrement: 1e-5,
      // -------- GNIA arc-length (cylinder only) --------
      // Drives cylinder_arclength.py → arclength_shell_multipatch_XML.
      //   arcLength    : Δs per Crisfield step (load+displacement coupled).
      //                  Smaller = finer path resolution near the limit
      //                  point; the reference load is auto-scaled so
      //                  λ=1 == classical F_cr (peak λ = knockdown factor).
      //   maxSteps     : arc-length steps (the solver traces past the
      //                  limit point into post-buckling, so this caps the
      //                  softening tail length too).
      //   imperfection : radial control-point perturbation amplitude
      //                  (length units; ≈ t/100 classical). 0 = perfect
      //                  shell — but then the limit point is a sharp
      //                  bifurcation the arc-length can't smoothly trace,
      //                  so a small value is recommended. Larger ⇒ deeper
      //                  knockdown.
      //   almMethod    : 0 load-control, 1 Riks, 2 Crisfield (default —
      //                  most robust through limit points).
      arcLength: 0.05,
      maxSteps: 60,
      imperfection: 0.001,
      almMethod: 2,
    },
  },

  /** Set cylinder geometry from the inspector. Validates positivity; on
   * non-positive value silently rejects (the input field clamps). */
  setCylinderDim: (key, value) =>
    set((s) => {
      const v = Number(value);
      if (!Number.isFinite(v)) return {};
      // imperfectionForce is allowed to be exactly zero (= disabled);
      // R/L/t must stay strictly positive.
      if (key !== "imperfectionForce" && v <= 0) return {};
      if (key === "imperfectionForce" && v < 0) return {};
      return {
        model: {
          ...s.model,
          geometry: {
            ...s.model.geometry,
            cylinder: { ...s.model.geometry.cylinder, [key]: v },
          },
        },
      };
    }),

  /** Set a cylinder-segment dimension (R / L / t / phi_deg). phi_deg is
   * clamped to (0, 90] — the geometry blows up at the closing 90° (full
   * half-circle) and is unphysical past it. R/L/t positivity enforced. */
  setSegmentDim: (key, value) =>
    set((s) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) return {};
      if (key === "phi_deg" && v > 90) return {};
      return {
        model: {
          ...s.model,
          geometry: {
            ...s.model.geometry,
            cylinder_segment: { ...s.model.geometry.cylinder_segment, [key]: v },
          },
        },
      };
    }),

  /** Set a sphere (hemisphere) dimension (R / t / opening_angle_deg).
   * R/t must stay strictly positive. opening_angle_deg clamped to (0, 180]. */
  setSphereDim: (key, value) =>
    set((s) => {
      const v = Number(value);
      if (!Number.isFinite(v)) return {};
      if (key === "opening_angle_deg") {
        if (v <= 0 || v > 180) return {};
      } else {
        if (v <= 0) return {};
      }
      return {
        model: {
          ...s.model,
          geometry: {
            ...s.model.geometry,
            sphere: { ...s.model.geometry.sphere, [key]: v },
          },
        },
      };
    }),

  /** Set the shape family. Only "cylinder" is wired. */
  setShape: (shape) =>
    set((s) => ({
      model: {
        ...s.model,
        geometry: { ...s.model.geometry, shape },
      },
    })),

  /** Patch a single field on a material by id. Silently rejects non-finite
   * numbers; positivity for E, [0, 0.5) for nu enforced by the inspector. */
  setMaterialField: (matId, key, value) =>
    set((s) => {
      const materials = s.model.materials.map((m) => {
        if (m.id !== matId) return m;
        let v = value;
        if (typeof v === "number" && !Number.isFinite(v)) return m;
        return { ...m, [key]: v };
      });
      return { model: { ...s.model, materials } };
    }),

  /** -------------------- Partitions + Section Assignments --------------
   * The wiring matches scripts/aeris_model.py: geometry.cylinder.partitions
   * carries [{z}] sorted; sections[] is a library; assignments[] maps each
   * "band_i" region to a section ref. When partitions[] is empty, the
   * single legacy "shell_full" assignment is used.
   * --------------------------------------------------------------------*/

  /** Add a partition at the given z (snapped into [0+ε, L-ε], rejected if
   * within tolerance of an existing partition). Auto-rebuilds the
   * assignments[] table so every band gets a section reference, creating
   * extra sections by cloning the first section's material+thickness
   * when needed. */
  addPartition: (z) =>
    set((s) => {
      const cyl = s.model.geometry.cylinder;
      const L = cyl.L;
      const zNum = Number(z);
      if (!Number.isFinite(zNum) || zNum <= 0 || zNum >= L) return {};
      const existing = (cyl.partitions || []).map((p) => Number(p.z));
      if (existing.some((zp) => Math.abs(zp - zNum) < 1e-9)) return {};
      const partitions = [...existing, zNum]
        .sort((a, b) => a - b)
        .map((zv) => ({ z: zv }));
      return rebuildAssignments({
        ...s.model,
        geometry: { ...s.model.geometry, cylinder: { ...cyl, partitions } },
      });
    }),

  /** Remove the partition at index `i` (0-based) from the sorted list. */
  removePartition: (i) =>
    set((s) => {
      const partitions = (s.model.geometry.cylinder.partitions || []).slice();
      if (i < 0 || i >= partitions.length) return {};
      partitions.splice(i, 1);
      return rebuildAssignments({
        ...s.model,
        geometry: {
          ...s.model.geometry,
          cylinder: { ...s.model.geometry.cylinder, partitions },
        },
      });
    }),

  /** Edit one partition's z value; auto-resorts. */
  setPartitionZ: (i, z) =>
    set((s) => {
      const cyl = s.model.geometry.cylinder;
      const zNum = Number(z);
      if (!Number.isFinite(zNum) || zNum <= 0 || zNum >= cyl.L) return {};
      const partitions = (cyl.partitions || []).slice();
      if (i < 0 || i >= partitions.length) return {};
      partitions[i] = { z: zNum };
      partitions.sort((a, b) => a.z - b.z);
      return {
        model: {
          ...s.model,
          geometry: { ...s.model.geometry, cylinder: { ...cyl, partitions } },
        },
      };
    }),

  /** Edit thickness_source.value on a section's constant-thickness mode.
   * Implicitly flips kind to "constant" — call site doesn't need to know
   * about the kind switch, only that "user typed a number → that number
   * is now the section's thickness". */
  setSectionThickness: (sectionId, value) =>
    set((s) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) return {};
      const sections = s.model.sections.map((sec) => {
        if (sec.id !== sectionId) return sec;
        const ts = sec.thickness_source ?? { kind: "geometry" };
        return {
          ...sec,
          thickness_source: { ...ts, kind: "constant", value: v },
        };
      });
      return { model: { ...s.model, sections } };
    }),

  /** Revert a section to geometry-driven thickness (kind:"geometry"). Drops
   * any stored constant value — the canonical scalar t lives in
   * geometry.cylinder.t, so there's no value to retain on the section. */
  resetSectionThickness: (sectionId) =>
    set((s) => {
      const sections = s.model.sections.map((sec) => {
        if (sec.id !== sectionId) return sec;
        return { ...sec, thickness_source: { kind: "geometry" } };
      });
      return { model: { ...s.model, sections } };
    }),

  /** Patch one field on the model.mesh block (refinement / degree /
   * smoothness / coupling). The smoothness-must-be-less-than-degree
   * invariant is enforced at the inspector level so we can clamp
   * silently without a redundant store-side check. Strings and ints
   * both flow through here, validated by the caller. */
  setMeshField: (key, value) =>
    set((s) => {
      if (typeof value === "number" && !Number.isFinite(value)) return {};
      return { model: { ...s.model, mesh: { ...s.model.mesh, [key]: value } } };
    }),

  /** Set the boundary-condition preset (model.bcs.kind). Currently only
   * "clamped_neumann" is wired in the solver; the inspector enforces the
   * narrower allow-list via disabled toggles. */
  setBcsKind: (kind) =>
    set((s) => ({ model: { ...s.model, bcs: { ...s.model.bcs, kind } } })),

  /** Set the load-case preset (model.load.kind). "axial" and "bending" are
   * wired end-to-end as of Session 3.6; "torsion" / "extpress" / "intpress"
   * / "combined" are disabled in the GUI until the solver-side branches
   * land. */
  setLoadKind: (kind) =>
    set((s) => ({ model: { ...s.model, load: { ...s.model.load, kind } } })),

  /** Switch between force-control and displacement-control. Only
   * affects cylinder GNA today (LBA is eigenvalue-only; LSA is
   * single K·u=F; segment static uses gravity body force, no
   * top-edge control to invert). */
  setLoadControlMode: (mode) =>
    set((s) => ({
      model: { ...s.model, load: { ...s.model.load, controlMode: mode } },
    })),

  /** Set the applied-load magnitude (model.load.magnitude). Cosmetic for
   * LBA — the eigenvalue is invariant under this scaling — but it lets
   * the user read the verdict's critical-load number in their own units
   * (ABAQUS-style: apply 1, get F_cr; apply 1000, get safety factor). */
  setLoadMagnitude: (value) =>
    set((s) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) return {};
      return { model: { ...s.model, load: { ...s.model.load, magnitude: v } } };
    }),

  /** ----- BENCHMARK HUB ---------------------------------------------------
   * Load + run flows for the Hub. Each benchmark carries its own model
   * preset; "Load" copies that preset wholesale into `model` so the user
   * can either Solve as-is (reproduces the benchmark) or tweak then Solve
   * (e.g. bump refinement). "Run" submits a job with the benchmark's id
   * so the Hub can find it later via `jobs.filter(j => j.benchmarkId)`.
   * --------------------------------------------------------------------*/

  /** Per-benchmark live state — { lastRunId, verdict, runningRunId }. Keyed
   * by benchmark id. Set by runBenchmark / interpretBenchmark. */
  benchmarkRuns: {},
  setBenchmarkRun: (benchmarkId, patch) =>
    set((s) => ({
      benchmarkRuns: {
        ...s.benchmarkRuns,
        [benchmarkId]: { ...(s.benchmarkRuns[benchmarkId] ?? {}), ...patch },
      },
    })),

  /** Copy a benchmark's preset into the current model. Returns the preset
   * so the caller can also flip mode → "pre" if it wants. */
  loadBenchmark: (preset) => {
    set({ model: JSON.parse(JSON.stringify(preset)) });
    return preset;
  },

  /** Run a benchmark — same end-to-end flow as runSolver but with an
   * auto-created job named `bench-<benchmarkId>-<timestamp>` and the
   * given refinement sweep. Pass a single-element refines array for a
   * single-r run, multiple for a convergence sweep (the script's CLI
   * --refines already accepts nargs="+", so one call covers both).
   *
   * Returns { ok, jobId, runId, statusData } or { ok:false, error }. */
  runBenchmark: async (benchmark, { refines } = {}) => {
    const POLL_INTERVAL_MS = 500;
    const state = useUI.getState();

    // 1) Load the preset so the in-memory model matches what we're solving.
    state.loadBenchmark(benchmark.modelPreset);

    // 2) Create a deterministic-ish job name. Timestamp suffix so reruns
    //    stack up instead of overwriting; the hub filters by `bench-<id>-`
    //    prefix to show the history per benchmark.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const jobName = `bench-${benchmark.id}-${stamp}`;
    const created = await state.createJob({ name: jobName, threads: 1 });
    if (!created.ok) {
      state.setBenchmarkRun(benchmark.id, {
        runningRunId: null,
        error: created.error,
      });
      return { ok: false, error: created.error };
    }
    const jobId = created.job.id;
    const sweep = refines && refines.length > 0
      ? refines
      : (benchmark.recipe?.refines ?? [5]);

    state.setLastRun({
      status: "running", phase: "starting",
      jobId, benchmarkId: benchmark.id,
      startedAt: Date.now(), elapsedMs: 0,
    });
    state.setBenchmarkRun(benchmark.id, {
      runningRunId: null, jobId, sweep, verdict: null, error: null,
    });

    try {
      // 3) Save model into the job folder.
      const saveRes = await fetch(
        `/save-model?jobId=${encodeURIComponent(jobId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state.serializeModel()),
        },
      );
      const saveData = await saveRes.json();
      if (!saveData.ok) throw new Error(`save failed: ${saveData.error}`);

      // 4) Submit the solver job. The dev-server accepts `refines` as an
      //    array now (see backwards-compat note in the server). For a
      //    single value we just pass it as { refinement } so the existing
      //    server path stays unchanged.
      const body = sweep.length === 1
        ? { jobId, threads: 1, refinement: sweep[0] }
        : { jobId, threads: 1, refines: sweep };
      const startRes = await fetch("/run-solver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const startData = await startRes.json();
      if (!startData.ok) throw new Error(`start failed: ${startData.error}`);
      const { runId } = startData;
      state.setBenchmarkRun(benchmark.id, { runningRunId: runId });

      // 5) Poll until terminal.
      while (true) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const statusRes = await fetch(`/run-status?id=${encodeURIComponent(runId)}`);
        const statusData = await statusRes.json();
        if (!statusData.ok) throw new Error(`poll failed: ${statusData.error}`);
        useUI.getState().setLastRun({
          ...statusData, runId, jobId, benchmarkId: benchmark.id,
        });
        if (["success", "failed", "cancelled"].includes(statusData.status)) {
          if (statusData.status === "success") {
            // 6) Load the manifest + run the benchmark's interpreter.
            const manifest = await useUI.getState().loadResultsManifest(jobId);
            const verdict = benchmark.interpret
              ? benchmark.interpret(manifest)
              : { status: "no-interpreter",
                  text: "no interpreter for this benchmark" };
            useUI.getState().setBenchmarkRun(benchmark.id, {
              runningRunId: null,
              lastRunAt: new Date().toISOString(),
              jobId,
              sweep,
              verdict,
            });
          } else {
            useUI.getState().setBenchmarkRun(benchmark.id, {
              runningRunId: null,
              lastRunAt: new Date().toISOString(),
              jobId,
              sweep,
              verdict: { status: statusData.status, text: statusData.error ?? "" },
            });
          }
          await useUI.getState().loadJobs();
          return { ok: statusData.status === "success", jobId, runId, statusData };
        }
      }
    } catch (err) {
      const msg = err?.message ?? String(err);
      useUI.getState().setLastRun({
        status: "failed", error: msg, jobId, finishedAt: Date.now(),
      });
      useUI.getState().setBenchmarkRun(benchmark.id, {
        runningRunId: null, error: msg,
      });
      return { ok: false, error: msg };
    }
  },

  /** Set model.analysis.kind. lba / static / gna / gnia all wired. */
  setAnalysisKind: (kind) =>
    set((s) => ({ model: { ...s.model, analysis: { ...s.model.analysis, kind } } })),

  /** Patch one field on model.imperfections (kind / mode / amplitude).
   * Used by the Imperfections inspector section; consumed by GNIA. */
  setImperfectionField: (key, value) =>
    set((s) => {
      if (typeof value === "number" && !Number.isFinite(value)) return {};
      return {
        model: {
          ...s.model,
          imperfections: { ...(s.model.imperfections ?? {}), [key]: value },
        },
      };
    }),

  /** Patch one field on model.analysis (solver / shift / nmodes / tolerance
   * / ncv_factor / interface_penalty). Strings ("auto", solver names) and
   * numbers both flow through; numeric validation done by the inspector. */
  setAnalysisField: (key, value) =>
    set((s) => {
      if (typeof value === "number" && !Number.isFinite(value)) return {};
      return {
        model: { ...s.model, analysis: { ...s.model.analysis, [key]: value } },
      };
    }),

  /** Serialise the current model state into the on-disk model.json schema
   * (mirrors scripts/aeris_model.py::ModelConfig.to_dict). JSON.stringify
   * always emits decimal POINTS for numbers regardless of browser locale,
   * so the German-comma display in <input type=number> never leaks into
   * the saved JSON. */
  serializeModel: () => {
    const s = useUI.getState();
    return JSON.parse(JSON.stringify(s.model));   // deep clone, no live refs
  },

  /** POST the current model to the dev server's /save-model endpoint, which
   * writes ../output/model.json. Returns the server's reply. */
  exportModel: async () => {
    const body = useUI.getState().serializeModel();
    const res = await fetch("/save-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  },

  /** Jobs registry — mirrors the on-disk index at output/jobs/index.json.
   * Each entry: { id, name, createdAt, threads, lastRunStatus, lastRunAt,
   * lastDurationMs }. Most-recent first. activeJobId picks which one the
   * monitor + post-processor track; null means "no job selected yet". */
  jobs: [],
  activeJobId: null,
  setJobs: (jobs) => set({ jobs }),
  /** Select a job as active. If the job has a successful past run, also
   * auto-load its run.json into currentResults so the post-processor
   * immediately reflects it (no extra click). */
  setActiveJob: (id) => {
    set({ activeJobId: id });
    if (!id) return;
    const job = useUI.getState().jobs.find((j) => j.id === id);
    if (job?.lastRunStatus === "success") {
      // fire-and-forget: GUI updates when promise resolves
      useUI.getState().loadResultsManifest(id);
    }
  },

  /** Cancel the in-flight run on the server. If it's queued, just marks
   * it as cancelled and the queue drain skips it; if it's running, the
   * docker child gets SIGKILL'd. The poll loop in runSolver picks up
   * the status transition on its next tick — no other client action
   * needed. */
  cancelRun: async (runId) => {
    if (!runId) return { ok: false, error: "no runId" };
    const res = await fetch(`/run-cancel?id=${encodeURIComponent(runId)}`, { method: "POST" });
    return res.json();
  },

  /** Delete a job from disk + index. If it was the active job, clears
   * activeJobId so the panel falls back to "(auto-create on SOLVE)". */
  deleteJob: async (id) => {
    const res = await fetch(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.error };
    await useUI.getState().loadJobs();
    if (useUI.getState().activeJobId === id) {
      set({ activeJobId: null, currentResults: null });
    }
    return { ok: true };
  },

  /** Last-run record for the ACTIVE job. Single-slot for now (Session
   * 4.1 — one in-flight run at a time); a Phase-3 queue will turn this
   * into a per-job map keyed by id. */
  lastRun: { status: "idle" },
  setLastRun: (next) => set({ lastRun: next }),

  /** Fetch the server's job index. Called at startup + after every
   * create / delete / solve so the GUI list stays fresh. */
  loadJobs: async () => {
    try {
      const res = await fetch("/jobs");
      const data = await res.json();
      if (!data.ok) return [];
      set({ jobs: data.jobs ?? [] });
      return data.jobs;
    } catch {
      return [];
    }
  },

  /** Create (or overwrite) a job on the server with the given name +
   * threads. Saves the CURRENT serialised model into the job's folder
   * so a subsequent runSolver picks it up. Auto-selects the new job. */
  createJob: async ({ name, threads = 1, overwrite = false } = {}) => {
    const model = useUI.getState().serializeModel();
    const res = await fetch("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, threads, overwrite, model }),
    });
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.error, hint: data.hint };
    await useUI.getState().loadJobs();
    set({ activeJobId: data.job.id, lastRun: { status: "idle" } });
    return { ok: true, job: data.job };
  },

  /** Parsed sidecar manifest (output/run.json) from the most recent
   * successful solve. null until the first run completes. Drives the
   * post-processor's ResultsPanel + InspectorPanel — replaces the
   * hardcoded LBA_META + KNOWN_RESULTS constants once a real run is
   * available. Shape: see scripts/cylinder_lba.py write-out block.
   *
   * generatedAt + command stamps let the GUI tell at a glance whether
   * what's on screen matches the model in the inspector (model edits
   * after a solve = stale results). */
  currentResults: null,
  setCurrentResults: (next) => set({ currentResults: next }),

  /** Fetch a job's run.json sidecar (output/jobs/<id>/run.json via
   * /data middleware) and store as currentResults. If no jobId given,
   * falls back to the legacy flat output/run.json so pre-jobs runs are
   * still visible. Cache-busted to dodge proxy caching. */
  loadResultsManifest: async (jobId) => {
    const path = jobId
      ? `/data/jobs/${jobId}/run.json?t=${Date.now()}`
      : `/data/run.json?t=${Date.now()}`;
    try {
      const res = await fetch(path);
      if (!res.ok) return null;
      const data = await res.json();
      // Stash the jobId alongside so consumers know which job this is.
      const tagged = { ...data, jobId };
      set({ currentResults: tagged });
      return tagged;
    } catch {
      return null;
    }
  },

  /** End-to-end Solve for a job. Saves the model into the job's folder,
   * spawns the docker container with the job's thread count, polls
   * /run-status, and on success auto-loads the job's run.json + flips
   * into post-mode with the first mode preselected.
   *
   * If no jobId is given, defaults to the active job. If there's no
   * active job either, creates an auto-named one on the fly (the
   * "Just Solve" Quick path — same UX as before jobs existed). */
  runSolver: async ({ jobId } = {}) => {
    const POLL_INTERVAL_MS = 500;
    const state = useUI.getState();
    let effectiveJobId = jobId || state.activeJobId;
    let threads = 1;
    if (!effectiveJobId) {
      // Auto-create a job so the run always has somewhere to land.
      const created = await state.createJob({
        name: `quick-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
        threads: 1,
      });
      if (!created.ok) {
        state.setLastRun({ status: "failed", error: `auto-create failed: ${created.error}` });
        return { ok: false, error: created.error };
      }
      effectiveJobId = created.job.id;
      threads = created.job.threads;
    } else {
      const j = state.jobs.find((x) => x.id === effectiveJobId);
      threads = j?.threads ?? 1;
    }

    state.setLastRun({
      status: "running",
      phase: "starting",
      jobId: effectiveJobId,
      threads,
      startedAt: Date.now(),
      elapsedMs: 0,
    });
    try {
      // 1) Save model into the job's folder
      const saveRes = await fetch(`/save-model?jobId=${encodeURIComponent(effectiveJobId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.serializeModel()),
      });
      const saveData = await saveRes.json();
      if (!saveData.ok) throw new Error(`save failed: ${saveData.error}`);

      // 2) Async-start solver in the job's folder with its threads
      const startRes = await fetch("/run-solver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: effectiveJobId,
          threads,
          refinement: state.model.mesh.refinement,
        }),
      });
      const startData = await startRes.json();
      if (!startData.ok) throw new Error(`start failed: ${startData.error}`);
      const { runId } = startData;

      // 3) Poll loop
      while (true) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const statusRes = await fetch(`/run-status?id=${encodeURIComponent(runId)}`);
        const statusData = await statusRes.json();
        if (!statusData.ok) throw new Error(`poll failed: ${statusData.error}`);
        useUI.getState().setLastRun({
          ...statusData,
          runId,
          jobId: effectiveJobId,
          threads,
        });
        const terminal = ["success", "failed", "cancelled"].includes(statusData.status);
        if (terminal) {
          if (statusData.status === "success") {
            const manifest = await useUI.getState().loadResultsManifest(effectiveJobId);
            // Default selection order: first mode (LBA result) → "linear"
            // (LSA deformed solution) → "geometry" (undeformed only).
            // Without this static manifests would leave the user looking
            // at a stale mode-id from a previous job (mode0 etc) which
            // doesn't exist in the new manifest, and the viewport would
            // silently show the previous job's cached mesh.
            const firstMode = manifest?.modes?.[0]?.id;
            const hasLinear = !!(manifest?.files?.linearPrestress
                                  || manifest?.files?.solution);
            const fallbackId = firstMode ?? (hasLinear ? "linear" : "geometry");
            useUI.setState((s) => ({
              ...s,
              selectedResultId: fallbackId,
              mode: "post",
              resultCache: {},
            }));
          }
          // Refresh jobs list so the row's lastRunStatus badge updates.
          await useUI.getState().loadJobs();
          return statusData;
        }
      }
    } catch (err) {
      const errorMsg = err?.message ?? String(err);
      useUI.getState().setLastRun({
        status: "failed",
        error: errorMsg,
        jobId: effectiveJobId,
        finishedAt: Date.now(),
      });
      return { ok: false, error: errorMsg };
    }
  },

  /** Which result is currently loaded into the viewport. */
  selectedResultId: "mode1",
  selectResult: (id) => set({ selectedResultId: id }),

  /** Live warp factor applied to SolutionField in the viewport. */
  warpScale: 1.5,
  setWarpScale: (v) => set({ warpScale: v }),

  /** Surface display options. */
  showEdges: true,
  setShowEdges: (b) => set({ showEdges: b }),
  showUndeformed: false,
  setShowUndeformed: (b) => set({ showUndeformed: b }),
  /** When on, the viewport draws a magenta arrow pointing at the vertex
   * where the currently-displayed scalar field reaches its maximum (in
   * the warped/deformed configuration). Re-located automatically when
   * displayField / warpScale / result change. Off by default — useful
   * for quickly answering "where on the model is the peak" without
   * having to orbit and eyeball the color. */
  showMaxArrow: false,
  setShowMaxArrow: (b) => set({ showMaxArrow: b }),

  /** Colormap for the post-mode result shader. "aeris-auto" tracks the
   * theme (dark/light) and keeps the on-brand look; otherwise it's one
   * of the named scientific colormaps (jet / viridis / plasma /
   * inferno / coolwarm / grayscale) from viewport/colormap.js. The
   * viewport rebuilds the DataTexture on change without recomputing
   * any geometry. */
  colormapName: "aeris-auto",
  setColormap: (name) => set({ colormapName: name }),

  /** Which scalar field the post-mode shader colors by. The .vts files
   * ship a 3-component displacement vector per node; we project it to
   * a scalar at render time. "magnitude" = |u| (always positive,
   * default — works with every colormap). "ux"/"uy"/"uz" = signed
   * Cartesian components, useful for diagnosing where deformation is
   * concentrated in a given direction (e.g. u_z for vertical
   * deflection in Scordelis-Lo). We use abs(component) for the color
   * lookup since most colormaps are sequential 0..1 — a future
   * cool-warm symmetric mapping for signed values is a follow-up. */
  displayField: "magnitude",
  setDisplayField: (name) => set({ displayField: name }),

  /** Stats of the currently-rendered scalar field — used by the
   * viewport legend to draw min / max / mid ticks. Populated by
   * Viewport3D inside apply() after the per-patch projection so the
   * legend always reflects what's actually being shown (changes
   * automatically when the user switches displayField). */
  displayFieldStats: null,
  setDisplayFieldStats: (s) => set({ displayFieldStats: s }),

  /** Current view preset name, set when user clicks oblique/side/end. */
  viewPreset: "oblique",
  setViewPreset: (name) => set({ viewPreset: name }),

  /** Loaded-result cache. {[id]: { patches: [...], magMax, valid }} */
  resultCache: {},
  cacheResult: (id, data) =>
    set((s) => ({ resultCache: { ...s.resultCache, [id]: data } })),

  /** UI status line for the inspector (e.g. "loading…", "loaded 4 patches"). */
  status: "ready",
  setStatus: (s) => set({ status: s }),
}));

/** Auto-rebuild the assignments[] (and sections[]) so that every band has a
 * section, in the right order, with sensible default thickness when a new
 * band is created. Idempotent: applying twice to the same partition layout
 * leaves the model unchanged. Returns a {model: ...} patch ready for set().
 *
 * Rules:
 *   - 0 partitions (homogeneous)  → single assignment "shell_full" → first
 *                                   section. Same as Session 3.3 default.
 *   - N+1 partitions (stepped)    → assignments [{region:"band_0", ...},
 *                                   {region:"band_1", ...}, …]; one per
 *                                   band. Reuses existing band_i sections
 *                                   when possible, clones the first
 *                                   section's material+thickness for any
 *                                   bands that don't have a section yet.
 *   - Sections orphaned by the rebuild are kept around (no destructive
 *     deletion — the user can clean them up later from the GUI).
 */
function rebuildAssignments(model) {
  const partitions = (model.geometry?.cylinder?.partitions ?? []).slice();
  const homogeneous = partitions.length === 0;
  const sections = (model.sections ?? []).slice();
  const assignments = (model.assignments ?? []).slice();

  if (homogeneous) {
    // Need exactly one assignment "shell_full" → first section.
    if (sections.length === 0) {
      return { model };
    }
    const newAssignments = [
      { region: "shell_full", section_ref: sections[0].id },
    ];
    return { model: { ...model, assignments: newAssignments } };
  }

  const nBands = partitions.length + 1;
  // Existing band assignments — keep them, but trim or extend the list.
  const existing = new Map();
  for (const a of assignments) {
    if (typeof a.region === "string" && a.region.startsWith("band_")) {
      existing.set(a.region, a.section_ref);
    }
  }
  // Source section for cloning new bands' thickness from. Prefer the first
  // existing band's section; else the very first section.
  const seedSec = sections[0];

  const newAssignments = [];
  const newSections = sections.slice();

  for (let i = 0; i < nBands; i++) {
    const region = `band_${i}`;
    let secId = existing.get(region);
    if (!secId || !newSections.find((s) => s.id === secId)) {
      // Clone the seed section under a band-named id; default to GEOMETRY
      // thickness for newly-created bands so the user gets a working
      // value out of the box.
      secId = `sec-${region}`;
      if (!newSections.find((s) => s.id === secId)) {
        newSections.push({
          id: secId,
          name: `Band ${i} section`,
          kind: "shell",
          material_ref: seedSec?.material_ref ?? "mat-default",
          thickness_source:
            seedSec?.thickness_source?.kind === "constant"
              ? { ...seedSec.thickness_source }
              : { kind: "geometry" },
          offset: "midsurface",
        });
      }
    }
    newAssignments.push({ region, section_ref: secId });
  }

  return {
    model: {
      ...model,
      sections: newSections,
      assignments: newAssignments,
    },
  };
}
