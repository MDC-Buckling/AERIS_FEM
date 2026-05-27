import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { useUI } from "../store.js";
import { KNOWN_RESULTS, VIEW_PRESETS, viewPresets } from "../constants.js";
import { loadResult } from "../vtk/loadResult.js";
import { RAMP_DARK, RAMP_LIGHT } from "./colormap.js";

/** Vertex shader: warp position by displacement * uWarp, pass magnitude
 * (normalised 0..1 against uMagMax) to the fragment shader. */
const VERT = /* glsl */ `
  attribute vec3 aDisp;
  attribute float aMag;
  uniform float uWarp;
  uniform float uMagMax;
  varying float vMagN;
  void main() {
    vec3 p = position + aDisp * uWarp;
    vMagN = clamp(aMag / max(uMagMax, 1e-9), 0.0, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

/** Fragment shader: sample 1D colormap by normalised magnitude.
 * Mild Lambert-ish shading via cheap face-normal-from-derivatives so the
 * cylinder reads as solid even without precomputed normals. */
const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uRamp;
  uniform float uEdgeMix;
  uniform vec3 uLightDir;
  varying float vMagN;
  void main() {
    vec3 base = texture2D(uRamp, vec2(vMagN, 0.5)).rgb;
    // Fake shading via screen-space derivatives of view position.
    vec3 dx = dFdx(vec3(gl_FragCoord.xyz));
    vec3 dy = dFdy(vec3(gl_FragCoord.xyz));
    vec3 n = normalize(cross(dx, dy));
    float lambert = clamp(dot(n, normalize(uLightDir)) * 0.5 + 0.55, 0.0, 1.0);
    vec3 col = base * mix(0.85, lambert, 0.6);
    gl_FragColor = vec4(col, 1.0);
  }
`;

function makeRampTexture(rgbBytes) {
  // three.js removed RGBFormat in r137, so DataTexture only takes RGBA / R / RG /
  // RGB-Integer now. Repack the 256x3 ramp into 256x4 (alpha=255) before upload.
  const N = 256;
  const rgba = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    rgba[i * 4 + 0] = rgbBytes[i * 3 + 0];
    rgba[i * 4 + 1] = rgbBytes[i * 3 + 1];
    rgba[i * 4 + 2] = rgbBytes[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(rgba, N, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

export default function Viewport3D() {
  const containerRef = useRef(null);
  const stateRef = useRef({});

  const theme = useUI((s) => s.theme);
  const mode = useUI((s) => s.mode);
  const selectedId = useUI((s) => s.selectedResultId);
  const warpScale = useUI((s) => s.warpScale);
  const showEdges = useUI((s) => s.showEdges);
  const showUndeformed = useUI((s) => s.showUndeformed);
  const viewPreset = useUI((s) => s.viewPreset);
  const resultCache = useUI((s) => s.resultCache);
  const cacheResult = useUI((s) => s.cacheResult);
  const setStatus = useUI((s) => s.setStatus);
  // In pre-mode the viewport renders a procedural cylinder driven LIVE
  // by these dimensions — no .vts/.pvd round-trip, no solver involvement.
  const cyl = useUI((s) => s.model.geometry.cylinder);
  // Mesh refinement drives the edge-overlay density so the user gets
  // visual feedback when they bump r/p/k in the MESH inspector. We only
  // care about r here — p and k change DOF count but not the
  // element-grid layout.
  const meshRefinement = useUI((s) => s.model.mesh.refinement);
  // Load case drives the arrow indicators on the top edge so the user
  // sees axial-vs-bending at a glance. Subscribe to .kind only — magnitude
  // is "auto" today, so once that becomes editable we'll need to also
  // subscribe to .neumann_traction_axial.
  const loadKind = useUI((s) => s.model.load.kind);

  // One-time three.js init.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      // Needed for dFdx/dFdy in fragment shader on WebGL1.
      // (WebGL2 enables them by default; three's WebGLRenderer prefers WebGL2.)
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    // near/far + control limits get rescaled per cylinder bounds in a
    // later effect — these are just the initial values for the R=L=1
    // default load. Without this, scrolling out past ~200 units on a
    // big cylinder (R=33, L=100) used to clip the geometry into the
    // background.
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
    camera.position.set(...VIEW_PRESETS.oblique.pos);
    camera.up.set(...VIEW_PRESETS.oblique.up);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...VIEW_PRESETS.oblique.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.minDistance = 0.5;
    controls.maxDistance = 60;
    controls.update();

    // Group that holds the per-patch meshes for the current result.
    const meshGroup = new THREE.Group();
    scene.add(meshGroup);

    // Optional secondary group for the undeformed wireframe overlay.
    const wireGroup = new THREE.Group();
    wireGroup.visible = false;
    scene.add(wireGroup);

    // Ambient backdrop ring for visual depth in the dark theme.
    const grid = new THREE.GridHelper(8, 16, 0x00a0c8, 0x004060);
    grid.material.opacity = 0.18;
    grid.material.transparent = true;
    grid.position.y = -0.01;
    grid.rotation.x = Math.PI / 2; // grid in xy-plane (cylinder base)
    scene.add(grid);

    // Lighting — only the pre-mode preview MeshLambertMaterial honours these;
    // the post-mode ShaderMaterial ignores lights (does its own dFdx shading).
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xeaf4ff, 0.85);
    sun.position.set(4, -5, 6);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x88aabb, 0.35);
    fill.position.set(-3, 3, -2);
    scene.add(fill);

    // Shared shader material parameters.
    const rampTex = makeRampTexture(RAMP_DARK);
    const uniforms = {
      uWarp: { value: 1.5 },
      uMagMax: { value: 1.0 },
      uRamp: { value: rampTex },
      uEdgeMix: { value: 1.0 },
      uLightDir: { value: new THREE.Vector3(1.0, 1.5, 2.0).normalize() },
    };
    const surfaceMaterial = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      // dFdx/dFdy: WebGL1 needs the standard derivatives extension on.
      extensions: { derivatives: true },
    });

    // Edge / wireframe material (cyan hairline).
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.22,
    });
    const wireMaterial = new THREE.LineBasicMaterial({
      color: 0x6090a0,
      transparent: true,
      opacity: 0.35,
    });
    // Partition-seam material — punchy amber ring around each axial cut in
    // pre-mode. Bright enough to stand out from the cyan edge overlay so the
    // user can tell at a glance "yes, my cut landed where I asked".
    const seamMaterial = new THREE.LineBasicMaterial({
      color: 0xffb454,
      transparent: true,
      opacity: 0.85,
    });

    // Pre-mode preview material — a Lambertian dark-cyan that stands out
    // against the navy backdrop and shades properly under the lights above,
    // unlike the result ShaderMaterial whose lowest ramp colour blends
    // straight into the page background.
    const previewMaterial = new THREE.MeshLambertMaterial({
      color: 0x2a6580,
      emissive: 0x06151c,
      side: THREE.DoubleSide,
      flatShading: false,
    });

    // -----------------------------------------------------------------
    // Coordinate-system gizmo — small XYZ axis triad in the bottom-left
    // corner, kept rotation-locked to the main camera so the user always
    // knows which way is up. Lives in its own scene + perspective camera,
    // drawn in a second render pass via setViewport/setScissor so it
    // doesn't need its own canvas. Red = X, green = Y, blue = Z, matching
    // the three.js convention (and ABAQUS / ParaView / most CAD).
    // -----------------------------------------------------------------
    const gizmo = buildAxesGizmo();
    const gizmoSize = 120;       // CSS px square in the corner
    const gizmoMarginX = 14;     // CSS px gap to the left edge
    const gizmoMarginY = 36;     // CSS px gap to the bottom edge — extra
                                 // headroom so the triad isn't kissing the
                                 // canvas bottom (also dodges any future
                                 // status-bar overlay).

    let canvasW = 1;
    let canvasH = 1;
    function resize() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvasW = w;
      canvasH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let raf = 0;
    function tick() {
      raf = requestAnimationFrame(tick);
      controls.update();

      // Main scene fills the canvas. setViewport takes CSS pixels (three
      // r155+), so we pass the container size — NOT domElement.width,
      // which is already DPR-scaled and would push everything off-screen.
      renderer.setViewport(0, 0, canvasW, canvasH);
      renderer.setScissor(0, 0, canvasW, canvasH);
      renderer.setScissorTest(false);
      renderer.render(scene, camera);

      // Gizmo: sync rotation to the main camera, then draw into the
      // bottom-left corner. setScissorTest gates clearDepth so we get
      // the gizmo drawn over the previous frame without wiping the
      // surrounding pixels. Distance is arbitrary for the ortho camera
      // — only direction + up matter — but kept finite and >> arrow
      // length so nothing sits behind the camera.
      const dir = camera.position.clone().sub(controls.target).normalize();
      gizmo.camera.position.copy(dir).multiplyScalar(4);
      gizmo.camera.up.copy(camera.up);
      gizmo.camera.lookAt(0, 0, 0);
      renderer.setViewport(gizmoMarginX, gizmoMarginY, gizmoSize, gizmoSize);
      renderer.setScissor(gizmoMarginX, gizmoMarginY, gizmoSize, gizmoSize);
      renderer.setScissorTest(true);
      renderer.clearDepth();
      renderer.render(gizmo.scene, gizmo.camera);
      renderer.setScissorTest(false);
    }
    tick();

    stateRef.current = {
      renderer,
      scene,
      camera,
      controls,
      meshGroup,
      wireGroup,
      rampTex,
      uniforms,
      surfaceMaterial,
      previewMaterial,
      edgeMaterial,
      wireMaterial,
      seamMaterial,
      grid,
    };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      surfaceMaterial.dispose();
      previewMaterial.dispose();
      edgeMaterial.dispose();
      wireMaterial.dispose();
      seamMaterial.dispose();
      rampTex.dispose();
      gizmo.dispose();
      while (meshGroup.children.length) {
        const c = meshGroup.children.pop();
        c.geometry?.dispose();
      }
      while (wireGroup.children.length) {
        const c = wireGroup.children.pop();
        c.geometry?.dispose();
      }
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Push warp / theme / edge changes to the live uniforms without rebuilding.
  useEffect(() => {
    const st = stateRef.current;
    if (!st.uniforms) return;
    st.uniforms.uWarp.value = warpScale;
  }, [warpScale]);

  useEffect(() => {
    const st = stateRef.current;
    if (!st.uniforms) return;
    const bytes = theme === "light" ? RAMP_LIGHT : RAMP_DARK;
    const newTex = makeRampTexture(bytes);
    st.uniforms.uRamp.value.dispose?.();
    st.uniforms.uRamp.value = newTex;
    st.rampTex = newTex;
    if (st.grid) {
      st.grid.material.opacity = theme === "light" ? 0.10 : 0.18;
      st.grid.material.color.set(theme === "light" ? 0x788090 : 0x00a0c8);
    }
  }, [theme]);

  useEffect(() => {
    const st = stateRef.current;
    if (!st.meshGroup) return;
    st.meshGroup.children.forEach((m) => {
      // Toggle the cyan edge line objects (added as siblings during result load).
      if (m.userData?.kind === "edges") m.visible = showEdges;
    });
  }, [showEdges]);

  useEffect(() => {
    const st = stateRef.current;
    if (!st.wireGroup) return;
    st.wireGroup.visible = showUndeformed;
  }, [showUndeformed]);

  // Rescale camera near/far + OrbitControls min/max distance to the current
  // bounding box. Without this, on a big cylinder (R=33, L=100) the snap-view
  // distance (~290 units) sat past the original far=200 plane and the geometry
  // vanished into the background when you scrolled out. Keying on R/L only,
  // so the limits update once per geometry change, not on every camera nudge.
  useEffect(() => {
    const st = stateRef.current;
    if (!st.camera || !st.controls) return;
    const scale = Math.max(cyl.R, cyl.L, 1);
    st.camera.near = scale * 0.002;
    st.camera.far = scale * 200;     // ~200x bbox — generous, no clipping
    st.camera.updateProjectionMatrix();
    st.controls.minDistance = scale * 0.1;
    st.controls.maxDistance = scale * 50;
  }, [cyl.R, cyl.L]);

  useEffect(() => {
    const st = stateRef.current;
    if (!st.camera || !st.controls) return;
    // Camera snaps auto-scale to the current cylinder bounding box so the
    // procedural preview stays in frame across user-edited R/L. Post-mode
    // results are also dimensioned at R=1, L=1 for now so this works there
    // too; later the result loader will set its own bounds.
    const presets = viewPresets(cyl.R, cyl.L);
    const p = presets[viewPreset];
    if (!p) return;
    st.camera.position.set(...p.pos);
    st.camera.up.set(...p.up);
    st.controls.target.set(...p.target);
    st.controls.update();
  }, [viewPreset, cyl.R, cyl.L]);

  // -------------------------------------------------------------------
  // Pre-mode: procedural cylinder driven LIVE by the model dimensions.
  // -------------------------------------------------------------------
  // Partitions: bright amber rings at each axial cut so the user sees
  // their stepped-wall layout as soon as they hit "+ ADD CUT". Cheap to
  // recompute (a handful of rings vs. the cylinder tessellation), so we
  // just rebuild the whole pre-mode group when partitions change.
  const partitions = cyl.partitions ?? [];
  const partitionsKey = partitions.map((p) => p.z).join(",");

  useEffect(() => {
    const st = stateRef.current;
    if (!st.meshGroup) return;
    if (mode !== "pre") return;

    tearDownGroups(st);
    st.uniforms.uMagMax.value = 1.0;

    // THREE.CylinderGeometry default axis is Y; rotate so axis is Z and shift
    // so bottom is at z=0, top at z=L (matches our solver convention).
    const segR = 64;       // around circumference
    const segH = 24;       // along axis — preview-light, not solver mesh
    const geom = new THREE.CylinderGeometry(cyl.R, cyl.R, cyl.L, segR, segH, true);
    geom.rotateX(Math.PI / 2);
    geom.translate(0, 0, cyl.L / 2);

    // Pre-mode uses its own Lambertian preview material (lit) — visually
    // distinct from the result shader, and crucially actually visible
    // against the dark backdrop (the result ramp's lowest colour blends
    // straight into the page background, which is fine for results but
    // not for a "this is your model" preview).
    const mesh = new THREE.Mesh(geom, st.previewMaterial);
    mesh.userData.kind = "surface";
    st.meshGroup.add(mesh);

    // Edge overlay traces the IGA element grid implied by the current
    // mesh.refinement value. At r=0 each patch is a single element →
    // 4 meridians (one per θ-seam) + 1 axial ring per band. Each +1 in
    // r doubles both counts (the solver sees 2^r elements per patch per
    // direction). Visual count = real count, with a soft cap that only
    // kicks in at the very top of the supported r range (NumberField
    // max=8) so r=5/6 still visibly densify before saturation. Costs
    // ~O(meridians × segmentsAround + rings × segmentsAround) line
    // segments, still trivial for three.js at the cap.
    const nBandsPreview = (cyl.partitions?.length ?? 0) + 1;
    const elementsPerPatch = Math.pow(2, Math.max(0, meshRefinement));
    const meridians = Math.min(4 * elementsPerPatch, 256);
    const ringsPerBand = Math.min(elementsPerPatch, 96);
    const ringZs = [];
    for (let b = 0; b < nBandsPreview; b++) {
      // Skip the very last ring of each band — it's the band boundary
      // (also the start of the next band / top of the cylinder), drawn
      // by the band edges below to avoid double-drawing.
      const z0 = b === 0 ? 0 : Number(cyl.partitions[b - 1].z);
      const z1 = b < nBandsPreview - 1 ? Number(cyl.partitions[b].z) : cyl.L;
      const span = z1 - z0;
      for (let i = 0; i <= ringsPerBand; i++) {
        const t = i / ringsPerBand;
        // Skip ring at t=0 except for the very bottom (avoids
        // double-drawing at band boundaries when partitions land here).
        if (i === 0 && b > 0) continue;
        ringZs.push(z0 + t * span);
      }
    }
    // Ring segment count tracks meridian count so the ring → meridian
    // intersections land cleanly without visible kinks at the corners.
    // 96 minimum keeps low-r rings round-looking.
    const ringSegmentsAround = Math.max(96, meridians);
    const edges = new THREE.LineSegments(
      buildCylinderEdgesAt(cyl.R, cyl.L, ringZs, meridians, ringSegmentsAround),
      st.edgeMaterial
    );
    edges.userData.kind = "edges";
    edges.visible = showEdges;
    st.meshGroup.add(edges);

    // Partition seam rings — one bright ring at each cut z, drawn slightly
    // outside R so the line sits proud of the surface and doesn't z-fight.
    const partitionZs = partitions
      .map((p) => Number(p.z))
      .filter((z) => Number.isFinite(z) && z > 0 && z < cyl.L);
    if (partitionZs.length > 0) {
      const seamGeom = buildPartitionRings(cyl.R * 1.003, partitionZs, 96);
      const seams = new THREE.LineSegments(seamGeom, st.seamMaterial);
      seams.userData.kind = "seams";
      st.meshGroup.add(seams);
    }

    // Load indicators — arrows on the top edge that visualise the load
    // case currently selected in the BCs+LOADS inspector.
    const loadGroup = buildLoadArrows(loadKind, cyl.R, cyl.L);
    if (loadGroup) {
      loadGroup.userData.kind = "load";
      st.meshGroup.add(loadGroup);
    }

    const seamNote = partitionZs.length
      ? ` · ${partitionZs.length} cut → ${partitionZs.length + 1} bands`
      : "";
    setStatus(
      `live preview · cylinder R=${cyl.R} L=${cyl.L} t=${cyl.t} · R/t=${(cyl.R / cyl.t).toFixed(0)}${seamNote} · ${loadKind}`
    );
    return () => {
      // Tear-down handled at next effect run (or on unmount inside init).
    };
  }, [mode, cyl.R, cyl.L, cyl.t, partitionsKey, meshRefinement, loadKind, showEdges, setStatus]);

  // -------------------------------------------------------------------
  // Post-mode: load + build result on selection change (existing path).
  // -------------------------------------------------------------------
  useEffect(() => {
    const st = stateRef.current;
    if (!st.meshGroup) return;
    if (mode !== "post") return;

    const result = KNOWN_RESULTS.find((r) => r.id === selectedId);
    if (!result) return;

    let cancelled = false;

    const apply = (data) => {
      if (cancelled) return;
      // Tear down previous meshes.
      while (st.meshGroup.children.length) {
        const c = st.meshGroup.children.pop();
        c.geometry?.dispose();
      }
      while (st.wireGroup.children.length) {
        const c = st.wireGroup.children.pop();
        c.geometry?.dispose();
      }

      st.uniforms.uMagMax.value = Math.max(data.magMax, 1e-9);

      for (const p of data.patches) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
        geom.setAttribute(
          "aDisp",
          new THREE.BufferAttribute(
            p.displacement || new Float32Array(p.positions.length),
            3
          )
        );
        geom.setAttribute(
          "aMag",
          new THREE.BufferAttribute(
            p.magnitude || new Float32Array(p.positions.length / 3),
            1
          )
        );
        geom.setIndex(new THREE.BufferAttribute(p.indices, 1));

        const mesh = new THREE.Mesh(geom, st.surfaceMaterial);
        mesh.userData.kind = "surface";
        st.meshGroup.add(mesh);

        // Patch-grid edge wires (cyan).
        const edgeGeom = buildGridEdges(p.positions, p.nx, p.ny);
        const edges = new THREE.LineSegments(edgeGeom, st.edgeMaterial);
        edges.userData.kind = "edges";
        edges.visible = showEdges;
        st.meshGroup.add(edges);

        // Undeformed overlay (positions only, no warp), shown when toggled.
        const wireGeom = new THREE.BufferGeometry();
        wireGeom.setAttribute(
          "position",
          new THREE.BufferAttribute(p.positions, 3)
        );
        wireGeom.setIndex(new THREE.BufferAttribute(p.indices, 1));
        const wire = new THREE.Mesh(
          wireGeom,
          new THREE.MeshBasicMaterial({
            color: 0x6090a0,
            wireframe: true,
            transparent: true,
            opacity: 0.25,
          })
        );
        st.wireGroup.add(wire);
      }
    };

    if (resultCache[selectedId]) {
      apply(resultCache[selectedId]);
      return () => {
        cancelled = true;
      };
    }

    setStatus(`loading ${result.label}…`);
    (async () => {
      try {
        let data;
        try {
          data = await loadResult(result.pvd);
        } catch (e) {
          if (result.pvdFallback) {
            data = await loadResult(result.pvdFallback);
          } else {
            throw e;
          }
        }
        if (cancelled) return;
        cacheResult(selectedId, data);
        apply(data);
        setStatus(`loaded ${data.patches.length} patch(es) — |u|_max=${data.magMax.toExponential(3)}`);
      } catch (e) {
        console.error(e);
        setStatus(`load failed: ${e.message || e}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedId, resultCache, cacheResult, setStatus, showEdges]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        background: "transparent",
      }}
    />
  );
}

/** Tear down both group's meshes + dispose geometries. */
function tearDownGroups(st) {
  while (st.meshGroup.children.length) {
    const c = st.meshGroup.children.pop();
    c.geometry?.dispose();
  }
  while (st.wireGroup.children.length) {
    const c = st.wireGroup.children.pop();
    c.geometry?.dispose();
  }
}

/** Edge overlay for the procedural cylinder driven by an explicit list of
 * ring z-values plus a meridian count. Used to mirror the IGA element
 * grid implied by the current mesh.refinement: caller supplies one z per
 * element row, we draw a full circle at each + `meridians` vertical
 * lines at evenly-spaced θ. Top + bottom rings are always included. */
function buildCylinderEdgesAt(R, L, ringZs, meridians, segmentsAround = 96) {
  const pts = [];
  const zs = [0, ...ringZs.filter((z) => z > 0 && z < L), L];
  for (const z of zs) {
    for (let i = 0; i < segmentsAround; i++) {
      const a0 = (i / segmentsAround) * 2 * Math.PI;
      const a1 = ((i + 1) / segmentsAround) * 2 * Math.PI;
      pts.push(R * Math.cos(a0), R * Math.sin(a0), z);
      pts.push(R * Math.cos(a1), R * Math.sin(a1), z);
    }
  }
  for (let m = 0; m < meridians; m++) {
    const a = (m / meridians) * 2 * Math.PI;
    pts.push(R * Math.cos(a), R * Math.sin(a), 0);
    pts.push(R * Math.cos(a), R * Math.sin(a), L);
  }
  const arr = new Float32Array(pts);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  return geom;
}

/** Sparse edge overlay for the procedural cylinder: top + bottom rims +
 * `meridians` axial lines + `axialRings` intermediate rings. Kept for
 * any caller that wants the legacy uniform-spacing layout. */
function buildCylinderEdges(R, L, segmentsAround = 64, axialRings = 4, meridians = 12) {
  const pts = [];
  const ringZ = [];
  for (let i = 0; i <= axialRings + 1; i++) {
    ringZ.push((i / (axialRings + 1)) * L);
  }
  // Rings (full circles)
  for (const z of ringZ) {
    for (let i = 0; i < segmentsAround; i++) {
      const a0 = (i / segmentsAround) * 2 * Math.PI;
      const a1 = ((i + 1) / segmentsAround) * 2 * Math.PI;
      pts.push(R * Math.cos(a0), R * Math.sin(a0), z);
      pts.push(R * Math.cos(a1), R * Math.sin(a1), z);
    }
  }
  // Meridians (top → bottom lines at evenly spaced angles)
  for (let m = 0; m < meridians; m++) {
    const a = (m / meridians) * 2 * Math.PI;
    pts.push(R * Math.cos(a), R * Math.sin(a), 0);
    pts.push(R * Math.cos(a), R * Math.sin(a), L);
  }
  const arr = new Float32Array(pts);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  return geom;
}

/** Build the corner XYZ axis triad. Red = X, green = Y, blue = Z arrows
 * from origin out to length 1, with sprite labels just past each tip. Owns
 * its own scene + camera; the render loop syncs the camera rotation to the
 * main view each frame and draws the triad into a fixed-size corner viewport
 * via setScissor. Returns {scene, camera, dispose} so the caller can render
 * + tear down without knowing the internals. */
function buildAxesGizmo() {
  const scene = new THREE.Scene();
  // Orthographic camera so the triad doesn't get perspective-foreshortened
  // (axes from a CAD gizmo should read as equal lengths regardless of view
  // angle). Bounds are sized to leave headroom for the labels at +1.32
  // along each axis no matter how the camera is rotated — diagonal worst
  // case is sqrt(3)·1.32 ≈ 2.29, so [-1.7, 1.7] keeps the worst-axis tip
  // inside the box with a small margin.
  const camera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 20);
  camera.position.set(0, 0, 4);
  camera.lookAt(0, 0, 0);

  const origin = new THREE.Vector3(0, 0, 0);
  const len = 1.0;
  const headLen = 0.28;
  const headWidth = 0.16;

  const xArr = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), origin, len, 0xff4040, headLen, headWidth);
  const yArr = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), origin, len, 0x40dd60, headLen, headWidth);
  const zArr = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), origin, len, 0x4090ff, headLen, headWidth);
  scene.add(xArr, yArr, zArr);

  // Tiny origin dot so the arrow tails read as anchored to a point, not
  // floating in space.
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xaad6e8 }),
  );
  scene.add(dot);

  const xLbl = makeAxisLabel("x", "#ff6060");
  const yLbl = makeAxisLabel("y", "#60e080");
  const zLbl = makeAxisLabel("z", "#60a8ff");
  xLbl.position.set(len + 0.32, 0, 0);
  yLbl.position.set(0, len + 0.32, 0);
  zLbl.position.set(0, 0, len + 0.32);
  scene.add(xLbl, yLbl, zLbl);

  function dispose() {
    [xArr, yArr, zArr].forEach((a) => {
      a.line.geometry.dispose();
      a.line.material.dispose();
      a.cone.geometry.dispose();
      a.cone.material.dispose();
    });
    dot.geometry.dispose();
    dot.material.dispose();
    [xLbl, yLbl, zLbl].forEach((l) => {
      l.material.map?.dispose();
      l.material.dispose();
    });
  }

  return { scene, camera, dispose };
}

/** Canvas-textured sprite for the axis tip labels (x/y/z). Drawn into a
 * small power-of-two canvas at high contrast so the letter stays readable
 * against either the dark or light viewport backdrop. */
function makeAxisLabel(letter, color) {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = color;
  ctx.font = "bold 44px JetBrains Mono, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 6;
  ctx.fillText(letter, size / 2, size / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.55, 0.55, 1);
  return sprite;
}

/** Top-edge load arrows for the live pre-mode preview.
 *
 *   axial:   N uniform downward arrows whose tips touch the top rim —
 *            "the column is being squeezed against the clamped bottom".
 *   bending: N arrows around the rim with magnitude ∝ |cos(θ)| and
 *            direction sgn(cos(θ)). +x side gets upward (tension) cyan
 *            arrows, -x side gets downward (compression) amber arrows.
 *            Exactly what build_cylinder_xml emits as Tz(x) = (E·t/R)·x.
 *
 * Returns a THREE.Group of ArrowHelpers (so tear-down only has to dispose
 * the group), or null for unsupported load kinds — keeps the dispatch
 * narrow and avoids drawing misleading indicators for cases the solver
 * hasn't wired yet (torsion / extpress / …). */
function buildLoadArrows(loadKind, R, L, nArrows = 16) {
  if (loadKind !== "axial" && loadKind !== "bending") return null;

  const group = new THREE.Group();
  // Arrow size scales with the cylinder so big-R steel cases (R=33, L=100)
  // and unit-default cases (R=1, L=1) both produce readable arrows. 18% of
  // the larger dimension feels right — long enough to see, short enough
  // not to dominate.
  const maxLen = Math.max(R, L) * 0.22;
  const COMPRESS = 0xffb454;   // amber (matches partition-seam material)
  const TENSION  = 0x40dd60;   // green (matches Y-axis in the gizmo)

  for (let i = 0; i < nArrows; i++) {
    const theta = (i / nArrows) * 2 * Math.PI;
    const x = R * Math.cos(theta);
    const y = R * Math.sin(theta);

    // Signed Tz weight in [-1, +1]. Compression = -1.
    let w;
    if (loadKind === "axial") {
      w = -1;                          // uniform compression: all arrows down
    } else {
      w = Math.cos(theta);             // bending: tension on +x, compression on -x
    }
    if (Math.abs(w) < 0.03) continue;  // skip near-zero arrows (avoid speckle on ±y)

    const len = maxLen * Math.abs(w);
    const headLen = len * 0.32;
    const headWidth = len * 0.20;
    const color = w > 0 ? TENSION : COMPRESS;

    // Place compression arrows ABOVE the rim pointing DOWN (tip on rim);
    // place tension arrows AT the rim pointing UP (tail on rim). Either
    // way the arrow visually emerges from the cylinder's top edge.
    let origin, dir;
    if (w > 0) {
      origin = new THREE.Vector3(x, y, L);
      dir    = new THREE.Vector3(0, 0, +1);
    } else {
      origin = new THREE.Vector3(x, y, L + len);
      dir    = new THREE.Vector3(0, 0, -1);
    }
    group.add(new THREE.ArrowHelper(dir, origin, len, color, headLen, headWidth));
  }
  return group;
}

/** Bright ring at each axial cut z — used in pre-mode to flag the partition
 * layout. Radius bumped slightly outside the cylinder so the line sits proud
 * of the surface (no z-fighting with the Lambertian preview mesh). */
function buildPartitionRings(R, zs, segmentsAround = 96) {
  const pts = [];
  for (const z of zs) {
    for (let i = 0; i < segmentsAround; i++) {
      const a0 = (i / segmentsAround) * 2 * Math.PI;
      const a1 = ((i + 1) / segmentsAround) * 2 * Math.PI;
      pts.push(R * Math.cos(a0), R * Math.sin(a0), z);
      pts.push(R * Math.cos(a1), R * Math.sin(a1), z);
    }
  }
  const arr = new Float32Array(pts);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  return geom;
}

/** Build a line-segment geometry tracing the (nx × ny) structured grid edges. */
function buildGridEdges(positions, nx, ny) {
  const idx = [];
  // horizontal segments (per row)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx - 1; i++) {
      idx.push(j * nx + i, j * nx + i + 1);
    }
  }
  // vertical segments (per column)
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny - 1; j++) {
      idx.push(j * nx + i, (j + 1) * nx + i);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  return geom;
}
