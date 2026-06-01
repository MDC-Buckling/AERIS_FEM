import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { useUI } from "../store.js";
import { KNOWN_RESULTS, VIEW_PRESETS, viewPresets } from "../constants.js";
import { loadResult } from "../vtk/loadResult.js";
import { RAMP_DARK, RAMP_LIGHT, resolveColormap } from "./colormap.js";

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
  // Box-select rubber-band rectangle (container-relative px), or null.
  const [boxRect, setBoxRect] = React.useState(null);

  const theme = useUI((s) => s.theme);
  const mode = useUI((s) => s.mode);
  const selectedId = useUI((s) => s.selectedResultId);
  const warpScale = useUI((s) => s.warpScale);
  const showEdges = useUI((s) => s.showEdges);
  const showUndeformed = useUI((s) => s.showUndeformed);
  const showMaxArrow = useUI((s) => s.showMaxArrow);
  const viewPreset = useUI((s) => s.viewPreset);
  const resultCache = useUI((s) => s.resultCache);
  const cacheResult = useUI((s) => s.cacheResult);
  const setStatus = useUI((s) => s.setStatus);
  const setDisplayFieldStats = useUI((s) => s.setDisplayFieldStats);
  // In pre-mode the viewport renders a procedural shell driven LIVE
  // by the model's geometry — no .vts/.pvd round-trip, no solver
  // involvement. We subscribe to the geometry block as a whole and
  // dispatch on `shape` further down.
  const geometryShape = useUI((s) => s.model.geometry.shape);
  const cyl = useUI((s) => s.model.geometry.cylinder);
  const segment = useUI((s) => s.model.geometry.cylinder_segment);
  const sphere = useUI((s) => s.model.geometry.sphere);
  // Mesh refinement drives the edge-overlay density so the user gets
  // visual feedback when they bump r/p/k in the MESH inspector. We only
  // care about r here — p and k change DOF count but not the
  // element-grid layout.
  const meshRefinement = useUI((s) => s.model.mesh.refinement);
  // For the Code_Aster engine the preview grid tracks the FE element size
  // (h) instead of the IGA refinement r, so the 3D view matches the meshed
  // resolution the user enters.
  const engine = useUI((s) => s.model.solver?.engine ?? "gismo");
  const caMeshSize = useUI((s) => s.model.discretization?.code_aster?.mesh_size ?? 2.0);
  // BB triangle preview density (Nx axial × Nt circumferential, each quad cell
  // split into two triangles). Drives the live triangulation overlay so the
  // user sees the actual BB element mesh while tuning Nx/Nt — not the IGA grid.
  const bbNx = useUI((s) => s.model.discretization?.bb?.Nx ?? 4);
  const bbNt = useUI((s) => s.model.discretization?.bb?.Nt ?? 20);
  // The actual FE element edges from the last "Generate mesh" — when present
  // (Code_Aster), the cylinder preview draws the real mesh instead of the grid.
  const meshPreviewEdges = useUI((s) => s.meshPreviewEdges);
  // Load case drives the arrow indicators on the top edge so the user
  // sees axial-vs-bending at a glance. Subscribe to .kind only — magnitude
  // is "auto" today, so once that becomes editable we'll need to also
  // subscribe to .neumann_traction_axial.
  const loadKind = useUI((s) => s.model.load.kind);
  const loadActive = useUI((s) => s.model.load?.active);
  const loadNodes = useUI((s) => s.model.load.nodes);
  const pickingMode = useUI((s) => s.pickingMode);
  const pickTarget = useUI((s) => s.pickTarget);
  const bcSets = useUI((s) => s.model.bcs?.sets);
  const loadSets = useUI((s) => s.model.load?.sets);
  const uiMode = useUI((s) => s.model.uiMode);
  // bcs.kind drives the diaphragm-vs-free edge colouring on the
  // cylinder_segment preview. We skip the indicator for non-segment
  // shapes (closed cylinder BC topology is shown via the load-arrow
  // chevrons on top + the clamped bottom is implicit).
  const bcsKind = useUI((s) => s.model.bcs.kind);
  // Active colormap name. "aeris-auto" tracks theme; others are explicit
  // scientific maps (jet/viridis/plasma/etc.). Drives a DataTexture swap
  // in the theme/colormap effect below.
  const colormapName = useUI((s) => s.colormapName);
  // Which scalar to color by — magnitude (default) or one of the signed
  // Cartesian components of the displacement field. Drives a small
  // CPU projection inside apply() + a fresh magMax computation.
  const displayField = useUI((s) => s.displayField);
  // Post-mode result lookup: prefer the live run.json sidecar's modes[]
  // (carries the actual pvd paths the script just wrote), fall back to
  // the shipped KNOWN_RESULTS list if no run has landed yet.
  const currentResults = useUI((s) => s.currentResults);

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

    // Persistent "max field value" pointer arrow — lives in the scene from
    // startup, hidden until apply() has an anchor + the user toggles it on.
    // Updating its position via setDirection/setLength/position.copy avoids
    // any geometry rebuild when the warp slider is scrubbed.
    const maxArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, 0),
      1, 0xff3070, 0.3, 0.18,
    );
    maxArrow.visible = false;
    scene.add(maxArrow);

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
      maxArrow,
      maxAnchor: null,     // {posUndef, dispVec, value, diag, center} | null
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
      maxArrow.line.geometry.dispose();
      maxArrow.line.material.dispose();
      maxArrow.cone.geometry.dispose();
      maxArrow.cone.material.dispose();
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

  // Raycasting for interactive node picking (point load mode).
  useEffect(() => {
    const st = stateRef.current;
    if (!st.renderer || !st.camera || !st.scene || mode !== "pre") return;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    // Picking is active for the legacy point-load picker (pickingMode) OR when
    // an expert set is the active pick target (pickTarget).
    const active = pickingMode || !!pickTarget;
    if (!active) return;

    // Orbit stays ENABLED while picking: we distinguish a click (pick) from a
    // drag (orbit) by the pointer travel between down and up. A near-stationary
    // press = pick; anything past the threshold was a camera rotation/pan and
    // is ignored. This removes the old "camera locked during pick" annoyance —
    // rotate freely, click to pick. (View buttons give quick reorientation.)
    let downX = 0, downY = 0;
    const DRAG_PX = 5;
    let boxing = false, boxStart = null;
    const relPos = (e) => {
      const r = st.renderer.domElement.getBoundingClientRect();
      return { r, x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onPointerDown = (e) => {
      downX = e.clientX; downY = e.clientY;
      // Shift+drag over an active expert pick target = rubber-band box select.
      if (e.shiftKey && useUI.getState().pickTarget) {
        const { x, y } = relPos(e);
        boxing = true; boxStart = { x, y };
        st.controls.enabled = false;       // suppress orbit during the box
        setBoxRect({ x, y, w: 0, h: 0 });
        e.preventDefault();
      }
    };
    const onPointerMove = (e) => {
      if (!boxing) return;
      const { x, y } = relPos(e);
      setBoxRect({
        x: Math.min(boxStart.x, x), y: Math.min(boxStart.y, y),
        w: Math.abs(x - boxStart.x), h: Math.abs(y - boxStart.y),
      });
    };
    const onPointerUp = (e) => {
      if (boxing) {
        boxing = false;
        st.controls.enabled = true;
        const { r, x, y } = relPos(e);
        const x0 = Math.min(boxStart.x, x), x1 = Math.max(boxStart.x, x);
        const y0 = Math.min(boxStart.y, y), y1 = Math.max(boxStart.y, y);
        setBoxRect(null);
        if (x1 - x0 < 3 || y1 - y0 < 3) return;   // accidental tiny box → ignore
        const edges = useUI.getState().meshPreviewEdges;
        const setStatus = useUI.getState().setStatus;
        if (!edges || !edges.length) {
          setStatus && setStatus("Box-select needs the FE mesh — click ‘Generate mesh’ first.");
          return;
        }
        // Project every (deduped) mesh node and keep those inside the rectangle.
        // NB: selects front AND back of the cylinder (no occlusion test in v1).
        const seen = new Set(), picks = [];
        const v = new THREE.Vector3();
        for (let i = 0; i + 2 < edges.length; i += 3) {
          const px = edges[i], py = edges[i + 1], pz = edges[i + 2];
          const key = `${px.toFixed(3)},${py.toFixed(3)},${pz.toFixed(3)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          v.set(px, py, pz).project(st.camera);
          if (v.z > 1) continue;                 // behind the camera
          const sx = (v.x * 0.5 + 0.5) * r.width, sy = (-v.y * 0.5 + 0.5) * r.height;
          if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) picks.push({ x: px, y: py, z: pz });
        }
        if (picks.length) {
          useUI.getState().addPickedNodes(picks);
          setStatus && setStatus(`Box-select: +${picks.length} node(s)`);
        } else {
          setStatus && setStatus("Box-select: no nodes inside the rectangle.");
        }
        return;
      }
      // Single click vs drag (orbit).
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_PX) return;
      const r = st.renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      raycaster.setFromCamera(mouse, st.camera);
      const surfaceChildren = st.meshGroup.children.filter(
        (c) => c.userData.kind === "surface"
      );
      const intersects = raycaster.intersectObjects(surfaceChildren);
      if (intersects.length === 0) return;
      const pos = intersects[0].point;
      const { addPickedNode, addLoadNode, pickTarget: tgt } = useUI.getState();
      if (tgt) {
        addPickedNode({ x: pos.x, y: pos.y, z: pos.z });
      } else {
        addLoadNode({ x: pos.x, y: pos.y, z: pos.z, fx: 0, fy: 0, fz: 0 });
      }
    };

    const el = st.renderer.domElement;
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      st.controls.enabled = true;
    };
  }, [pickingMode, pickTarget, mode]);

  // Node marker visualization (magenta spheres + force arrows at picked positions).
  useEffect(() => {
    const st = stateRef.current;
    if (!st.scene || !st.meshGroup || mode !== "pre" || !loadNodes) return;

    // Remove old markers
    const oldMarkers = st.meshGroup.children.filter((c) => c.userData.kind === "node-marker");
    oldMarkers.forEach((m) => {
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
      st.meshGroup.remove(m);
    });

    // Add new markers for each node
    const markerRadius = Math.max(cyl.R, cyl.L) * 0.015;
    const markerGeom = new THREE.SphereGeometry(markerRadius, 16, 16);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xd946ef });

    for (const node of loadNodes) {
      // Sphere marker
      const marker = new THREE.Mesh(markerGeom, markerMaterial);
      marker.position.set(node.x, node.y, node.z);
      marker.userData.kind = "node-marker";
      st.meshGroup.add(marker);

      // Force arrow (if force is non-zero)
      const forceMag = Math.sqrt(node.fx * node.fx + node.fy * node.fy + node.fz * node.fz);
      if (forceMag > 1e-9) {
        const arrowLen = markerRadius * 5;
        const forceDir = new THREE.Vector3(
          node.fx / forceMag,
          node.fy / forceMag,
          node.fz / forceMag
        );
        const arrow = new THREE.ArrowHelper(
          forceDir,
          new THREE.Vector3(node.x, node.y, node.z),
          arrowLen,
          0xd946ef,
          arrowLen * 0.32,
          arrowLen * 0.2
        );
        arrow.userData.kind = "node-marker";
        st.meshGroup.add(arrow);
      }
    }
  }, [loadNodes, mode, cyl.R, cyl.L]);

  // Picked-node markers (cyan) for expert BC/Load sets with region="picked".
  // The active pick target's nodes glow brighter so the user sees which set
  // they're clicking into.
  useEffect(() => {
    const st = stateRef.current;
    if (!st.scene || !st.meshGroup || mode !== "pre") return;
    const old = st.meshGroup.children.filter((c) => c.userData.kind === "picked-marker");
    old.forEach((m) => {
      m.geometry?.dispose();
      m.material?.dispose();
      st.meshGroup.remove(m);
    });
    const r = Math.max(cyl.R, cyl.L) * 0.016;
    const geom = new THREE.SphereGeometry(r, 14, 14);
    const collect = (sets, kind) =>
      (sets ?? [])
        .filter((s) => s.region === "picked" && (s.pickedNodes?.length))
        .forEach((s) => {
          const isTarget = pickTarget && pickTarget.kind === kind && pickTarget.id === s.id;
          const mat = new THREE.MeshBasicMaterial({
            color: isTarget ? 0x22d3ee : 0x0e7490,
          });
          for (const p of s.pickedNodes) {
            const m = new THREE.Mesh(geom, mat);
            m.position.set(p.x, p.y, p.z);
            m.userData.kind = "picked-marker";
            st.meshGroup.add(m);
          }
        });
    collect(bcSets, "bc");
    collect(loadSets, "load");
  }, [bcSets, loadSets, pickTarget, mode, cyl.R, cyl.L]);

  // BC / Load region highlights on the closed cylinder — coloured rim rings so
  // the user sees at a glance WHICH rims carry a constraint (orange = BC) or a
  // load (green), confirming the model's BCs are active. Expert sets drive the
  // bottom/top rim highlight; picked nodes are already shown as markers above.
  useEffect(() => {
    const st = stateRef.current;
    if (!st.scene || !st.meshGroup || mode !== "pre" || geometryShape !== "cylinder") return;
    const old = st.meshGroup.children.filter((c) => c.userData.kind === "bc-highlight");
    old.forEach((m) => {
      m.geometry?.dispose();
      m.material?.dispose();
      st.meshGroup.remove(m);
    });

    const tube = Math.max(cyl.R, cyl.L) * 0.012;
    const ring = (z, ringR, color) => {
      const g = new THREE.TorusGeometry(ringR, tube, 10, 80);
      const m = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
      );
      m.position.set(0, 0, z); // TorusGeometry lies in XY → rim ring around z-axis
      m.userData.kind = "bc-highlight";
      st.meshGroup.add(m);
    };

    // Which rims carry a BC (orange ring). Loads are drawn as GREEN ARROWS in
    // a separate effect (direction matters — the ring couldn't show sign).
    const bcRims = new Set();
    if ((uiMode ?? "beginner") === "expert") {
      for (const s of bcSets ?? []) {
        if (s.region === "bottom") bcRims.add(0);
        else if (s.region === "top") bcRims.add(cyl.L);
      }
    }
    bcRims.forEach((z) => ring(z, cyl.R, 0xff7849));        // BC = orange, on the surface
  }, [bcSets, uiMode, mode, geometryShape, cyl.R, cyl.L]);

  // Expert LOAD arrows (green) — show the force DIRECTION (sign) of each expert
  // force set, so +F vs −F is visible. Rim regions get a ring of arrows; picked
  // sets get one arrow per node. (Moment-only sets + pressure: viz TODO.)
  useEffect(() => {
    const st = stateRef.current;
    if (!st.meshGroup || mode !== "pre" || geometryShape !== "cylinder") return;
    const old = st.meshGroup.children.filter((c) => c.userData.kind === "load-arrow");
    old.forEach((m) => {
      m.line?.geometry?.dispose();
      m.cone?.geometry?.dispose();
      st.meshGroup.remove(m);
    });
    if ((uiMode ?? "beginner") !== "expert") return;

    const R = cyl.R, L = cyl.L;
    const len = Math.max(R, L) * 0.18;
    const GREEN = 0x4ade80;   // force = single-head green arrow
    const PURPLE = 0xc084fc;  // moment = double-head purple arrow (vector ‖ axis)
    const addArrow = (origin, dirVec, color, doubleHead) => {
      const d = dirVec.clone().normalize();
      const a = new THREE.ArrowHelper(d, origin, len, color, len * 0.3, len * 0.18);
      a.userData.kind = "load-arrow";
      st.meshGroup.add(a);
      if (doubleHead) {
        // second cone short of the tip → the classic moment double-arrowhead.
        const b = new THREE.ArrowHelper(d, origin, len * 0.78, color, len * 0.3, len * 0.18);
        b.userData.kind = "load-arrow";
        st.meshGroup.add(b);
      }
    };
    const positionsFor = (s) => {
      if (s.region === "picked") {
        return (s.pickedNodes ?? []).map((p) => new THREE.Vector3(p.x, p.y, p.z));
      }
      const z = s.region === "top" ? L : 0;
      const N = 16, out = [];
      for (let i = 0; i < N; i++) {
        const th = (i / N) * 2 * Math.PI;
        out.push(new THREE.Vector3(R * Math.cos(th), R * Math.sin(th), z));
      }
      return out;
    };
    for (const s of loadSets ?? []) {
      if (s.type === "pressure") {
        // Pressure → a grid of radial arrows on the shell showing the normal
        // direction + sign (+p = external/inward compression, −p = outward).
        const p = Number(s.pressure) || 0;
        if (Math.abs(p) < 1e-12) continue;
        const sign = p > 0 ? -1 : 1;          // +p pushes inward (toward axis)
        const nA = 12, nZ = 4;
        for (let iz = 0; iz <= nZ; iz++) {
          const z = (iz / nZ) * L;
          for (let i = 0; i < nA; i++) {
            const th = (i / nA) * 2 * Math.PI;
            const radial = new THREE.Vector3(Math.cos(th), Math.sin(th), 0);
            addArrow(
              new THREE.Vector3(R * Math.cos(th), R * Math.sin(th), z),
              radial.multiplyScalar(sign), GREEN, false
            );
          }
        }
        continue;
      }
      const f = s.force ?? {}, m = s.moment ?? {};
      const fvec = new THREE.Vector3(f.f1 || 0, f.f2 || 0, f.f3 || 0);
      const mvec = new THREE.Vector3(m.m1 || 0, m.m2 || 0, m.m3 || 0);
      const hasF = fvec.length() > 1e-12, hasM = mvec.length() > 1e-12;
      if (!hasF && !hasM) continue;
      for (const origin of positionsFor(s)) {
        if (hasF) addArrow(origin, fvec, GREEN, false);
        if (hasM) addArrow(origin, mvec, PURPLE, true);
      }
    }
  }, [loadSets, uiMode, mode, geometryShape, cyl.R, cyl.L]);

  // Push warp / theme / edge changes to the live uniforms without rebuilding.
  useEffect(() => {
    const st = stateRef.current;
    if (!st.uniforms) return;
    st.uniforms.uWarp.value = warpScale;
    // Reposition the max-field arrow against the new warp without rebuilding
    // any mesh — the anchor (vertex of max) stays the same, only the warped
    // world-position shifts. Cheap (3 vec ops + setLength).
    updateMaxArrow(st, warpScale, useUI.getState().showMaxArrow);
  }, [warpScale]);

  // Show/hide the max-field arrow. The anchor is set by apply(); flipping
  // the toggle here just changes visibility (and re-runs the position
  // update in case warp moved between renders).
  useEffect(() => {
    const st = stateRef.current;
    if (!st.maxArrow) return;
    updateMaxArrow(st, useUI.getState().warpScale, showMaxArrow);
  }, [showMaxArrow]);

  useEffect(() => {
    const st = stateRef.current;
    if (!st.uniforms) return;
    const bytes = resolveColormap(colormapName, theme);
    const newTex = makeRampTexture(bytes);
    st.uniforms.uRamp.value.dispose?.();
    st.uniforms.uRamp.value = newTex;
    st.rampTex = newTex;
    if (st.grid) {
      st.grid.material.opacity = theme === "light" ? 0.10 : 0.18;
      st.grid.material.color.set(theme === "light" ? 0x788090 : 0x00a0c8);
    }
  }, [theme, colormapName]);

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

  // Pick the active geometry's bounding R/L for camera / scale ops. The
  // segment uses its own R/L (Scordelis-Lo's R=25, L=50 differs sharply
  // from the cylinder default R=33, L=100), sphere uses only R, so camera
  // limits need to follow whichever shape is currently selected.
  let activeR, activeL;
  if (geometryShape === "cylinder_segment") {
    activeR = segment.R;
    activeL = segment.L;
  } else if (geometryShape === "sphere") {
    activeR = sphere.R;
    activeL = sphere.R; // sphere has no axial length, use R for camera bounds
  } else {
    activeR = cyl.R;
    activeL = cyl.L;
  }

  // Rescale camera near/far + OrbitControls min/max distance to the current
  // bounding box. Without this, on a big cylinder (R=33, L=100) the snap-view
  // distance (~290 units) sat past the original far=200 plane and the geometry
  // vanished into the background when you scrolled out. Keying on R/L only,
  // so the limits update once per geometry change, not on every camera nudge.
  useEffect(() => {
    const st = stateRef.current;
    if (!st.camera || !st.controls) return;
    const scale = Math.max(activeR, activeL, 1);
    st.camera.near = scale * 0.002;
    st.camera.far = scale * 200;     // ~200x bbox — generous, no clipping
    st.camera.updateProjectionMatrix();
    st.controls.minDistance = scale * 0.1;
    st.controls.maxDistance = scale * 50;
  }, [activeR, activeL]);

  useEffect(() => {
    const st = stateRef.current;
    if (!st.camera || !st.controls) return;
    // Post-mode: frame the ACTUAL loaded result. FE meshes (and warped mode
    // shapes) don't necessarily sit in the procedural R/L box, so clicking
    // OBLIQUE/SIDE/END fits the real bbox — that's the "center" behaviour.
    if (mode === "post" && st.resultBBox) {
      fitCameraToBox(st, st.resultBBox.center, st.resultBBox.diag, viewPreset);
      return;
    }
    // Pre-mode (or no result yet): frame the geometry bounding box. Built from
    // the active shape's R/L so all 7 Abaqus views (front/back/top/…/iso) work
    // here too — this is the viewport the user picks nodes in.
    let center, diag;
    if (geometryShape === "cylinder_segment") {
      center = new THREE.Vector3(activeL / 2, 0, activeR * 0.5);
      diag = Math.hypot(activeL, 2 * activeR);
    } else if (geometryShape === "sphere") {
      center = new THREE.Vector3(0, 0, 0);
      diag = 2 * activeR;
    } else {
      // closed cylinder: axis Z, z∈[0,L], radius R
      center = new THREE.Vector3(0, 0, activeL / 2);
      diag = Math.hypot(2 * activeR, activeL);
    }
    fitCameraToBox(st, center, diag, viewPreset);
  }, [viewPreset, activeR, activeL, mode, geometryShape]);

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
    // No deformation field in pre-mode — drop the anchor + hide the arrow.
    st.maxAnchor = null;
    if (st.maxArrow) st.maxArrow.visible = false;

    // Dispatch on shape. For cylinder_segment we draw the surface + a
    // u/v wireframe driven by mesh.refinement, then BC edge highlights
    // (cyan for diaphragm, amber for free) and gravity arrows
    // distributed over the surface. The closed-cylinder path below uses
    // a different overlay set (partition rings + edge-Neumann arrows).
    if (geometryShape === "cylinder_segment") {
      const geom = buildRoofSegmentGeometry(segment.R, segment.L, segment.phi_deg);
      const mesh = new THREE.Mesh(geom, st.previewMaterial);
      mesh.userData.kind = "surface";
      st.meshGroup.add(mesh);

      // Wireframe overlay — u/v grid at the mesh-refinement density.
      const elementsPerPatch = Math.pow(2, Math.max(0, meshRefinement));
      const uSegs = Math.min(elementsPerPatch, 64);
      const vSegs = Math.min(elementsPerPatch, 64);
      const edges = new THREE.LineSegments(
        buildRoofSegmentEdges(segment.R, segment.L, segment.phi_deg, uSegs, vSegs),
        st.edgeMaterial
      );
      edges.userData.kind = "edges";
      edges.visible = showEdges;
      st.meshGroup.add(edges);

      // BC edge highlights — colour-coded so the user reads the shell's
      // constraint topology at a glance. scordelis_diaphragm: u=0 / u=L
      // are diaphragms (cyan, fixed in-plane), v=0 / v=1 are free
      // (amber, no BC). Any other bcs.kind on a segment is unusual; we
      // colour all four edges amber to make it visible that no useful
      // constraint is set.
      const bcGeoms = buildRoofSegmentBcEdges(segment.R, segment.L,
                                              segment.phi_deg, bcsKind);
      if (bcGeoms.diaphragm) {
        const dia = new THREE.LineSegments(
          bcGeoms.diaphragm,
          new THREE.LineBasicMaterial({
            color: 0x00e5ff, linewidth: 2,
            transparent: true, opacity: 0.95,
          }),
        );
        dia.userData.kind = "bc-diaphragm";
        st.meshGroup.add(dia);
      }
      if (bcGeoms.free) {
        const free = new THREE.LineSegments(
          bcGeoms.free,
          new THREE.LineBasicMaterial({
            color: 0xffb454, linewidth: 2,
            transparent: true, opacity: 0.95,
          }),
        );
        free.userData.kind = "bc-free";
        st.meshGroup.add(free);
      }

      // Gravity arrows — when load.kind=gravity, distribute downward
      // arrows across the surface so the user sees the body force
      // pattern. Skip for other load kinds (axial / bending don't
      // physically make sense on an open roof segment; the user can
      // still set them in the schema, but we don't fake an arrow
      // pattern that misrepresents what the solver would do).
      if (loadKind === "gravity") {
        const arrows = buildRoofGravityArrows(segment.R, segment.L,
                                              segment.phi_deg);
        if (arrows) {
          arrows.userData.kind = "load";
          st.meshGroup.add(arrows);
        }
      }

      setStatus(
        `live preview · roof R=${segment.R} L=${segment.L} t=${segment.t} φ=${segment.phi_deg}° · R/t=${(segment.R / segment.t).toFixed(0)} · ${loadKind} · ${bcsKind}`
      );
      return;
    }

    // ---- sphere (hemisphere or partial) ----
    if (geometryShape === "sphere") {
      // Sphere sector defined by opening_angle (in degrees).
      // 90° = hemisphere (half-sphere from pole)
      // 180° = full sphere
      // THREE.SphereGeometry parameters: thetaLength controls polar angle span.
      const sphereSegW = 64;  // azimuthal segments (meridians)
      const sphereSegH = 32;  // polar segments (parallels)
      const openingRad = (sphere.opening_angle_deg * Math.PI) / 180;

      const geom = new THREE.SphereGeometry(
        sphere.R, sphereSegW, sphereSegH,
        0,              // phiStart: full azimuth
        Math.PI * 2,    // phiLength: full azimuth
        0,              // thetaStart: start from north pole
        openingRad      // thetaLength: from pole, span by opening_angle
      );
      const mesh = new THREE.Mesh(geom, st.previewMaterial);
      mesh.userData.kind = "surface";
      st.meshGroup.add(mesh);

      // Wireframe overlay respecting the opening angle.
      const wireSegW = Math.min(Math.pow(2, Math.max(0, meshRefinement)) * 8, 64);
      const wireSegH = Math.min(Math.pow(2, Math.max(0, meshRefinement)) * 6, 32);
      const sphereWireGeom = new THREE.SphereGeometry(
        sphere.R, wireSegW, wireSegH,
        0, Math.PI * 2, 0, openingRad
      );
      const wireEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(sphereWireGeom),
        st.edgeMaterial
      );
      wireEdges.userData.kind = "edges";
      wireEdges.visible = showEdges;
      st.meshGroup.add(wireEdges);

      setStatus(
        `live preview · sphere R=${sphere.R} t=${sphere.t} θ=${sphere.opening_angle_deg}° · R/t=${(sphere.R / sphere.t).toFixed(0)} · ${loadKind}`
      );
      return;
    }

    // ---- cylinder (closed) ----
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
    if (engine === "bb") {
      // BB triangle element: draw the ACTUAL triangulation the solver uses —
      // an Nx×Nt grid of quad cells, each split into two BB triangles. So the
      // user sees triangles (rings + axial lines + per-cell diagonals) live as
      // they tune Nx/Nt, instead of the IGA tensor density grid. The diagonal
      // matches the driver's split (i,j)->(i+1,j+1).
      const triEdges = new THREE.LineSegments(
        buildCylinderTriEdges(cyl.R, cyl.L, Math.max(2, bbNx), Math.max(3, bbNt)),
        st.edgeMaterial
      );
      triEdges.userData.kind = "edges";
      triEdges.visible = showEdges;
      st.meshGroup.add(triEdges);
    } else if (engine === "code_aster" && meshPreviewEdges && meshPreviewEdges.length) {
      // TRUE FE mesh: draw the actual element edges (triangles for DKT, quads
      // for COQUE_3D) from the generated mesh — not the parametric density
      // grid. Cleared on any discretisation change (mesh goes stale), so the
      // view falls back to the density grid below until re-generated.
      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.Float32BufferAttribute(meshPreviewEdges, 3));
      const realEdges = new THREE.LineSegments(eg, st.edgeMaterial);
      realEdges.userData.kind = "edges";
      realEdges.visible = showEdges;
      st.meshGroup.add(realEdges);
    } else {
      const nBandsPreview = (cyl.partitions?.length ?? 0) + 1;
      let meridians, ringsPerBand;
      if (engine === "code_aster") {
        // No generated mesh yet → density grid tracking the element size h
        // (≈ circumference/h around, L/h along), so the preview reflects the
        // resolution the user enters; click "Generate mesh" for the real one.
        const h = Math.max(1e-6, caMeshSize);
        meridians = Math.min(Math.max(4, Math.round((2 * Math.PI * cyl.R) / h)), 256);
        const alongTotal = Math.max(1, Math.round(cyl.L / h));
        ringsPerBand = Math.min(Math.max(1, Math.round(alongTotal / nBandsPreview)), 96);
      } else {
        const elementsPerPatch = Math.pow(2, Math.max(0, meshRefinement));
        meridians = Math.min(4 * elementsPerPatch, 256);
        ringsPerBand = Math.min(elementsPerPatch, 96);
      }
      const ringZs = [];
      for (let b = 0; b < nBandsPreview; b++) {
        const z0 = b === 0 ? 0 : Number(cyl.partitions[b - 1].z);
        const z1 = b < nBandsPreview - 1 ? Number(cyl.partitions[b].z) : cyl.L;
        const span = z1 - z0;
        for (let i = 0; i <= ringsPerBand; i++) {
          const t = i / ringsPerBand;
          if (i === 0 && b > 0) continue;
          ringZs.push(z0 + t * span);
        }
      }
      const ringSegmentsAround = Math.max(96, meridians);
      const edges = new THREE.LineSegments(
        buildCylinderEdgesAt(cyl.R, cyl.L, ringZs, meridians, ringSegmentsAround),
        st.edgeMaterial
      );
      edges.userData.kind = "edges";
      edges.visible = showEdges;
      st.meshGroup.add(edges);
    }

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

    // Load indicators — arrows on the top edge that visualise the load case.
    // Hidden only when the load is toggled inactive (load.active === false).
    // The default model ships with NO load (active:false), so nothing is shown
    // until the user activates a load — no spurious default-load arrows.
    const loadGroup = loadActive === false ? null : buildLoadArrows(loadKind, cyl.R, cyl.L);
    if (loadGroup) {
      loadGroup.userData.kind = "load";
      st.meshGroup.add(loadGroup);
    }

    // Point load arrows for the pinched-cylinder benchmark.
    const pointLoadGroup = loadActive === false
      ? null
      : buildPointLoadArrows(loadKind, cyl.R, cyl.L, loadNodes);
    if (pointLoadGroup) {
      pointLoadGroup.userData.kind = "load";
      st.meshGroup.add(pointLoadGroup);
    }

    // BC rings — cyan=clamped, amber=free
    const bcRings = buildCylinderBcRings(cyl.R, cyl.L, bcsKind);
    st.meshGroup.add(bcRings);

    const seamNote = partitionZs.length
      ? ` · ${partitionZs.length} cut → ${partitionZs.length + 1} bands`
      : "";
    setStatus(
      `live preview · cylinder R=${cyl.R} L=${cyl.L} t=${cyl.t} · R/t=${(cyl.R / cyl.t).toFixed(0)}${seamNote} · ${loadKind}`
    );
    return () => {
      // Tear-down handled at next effect run (or on unmount inside init).
    };
  }, [
    mode, geometryShape,
    cyl.R, cyl.L, cyl.t, partitionsKey,
    segment.R, segment.L, segment.t, segment.phi_deg,
    sphere.R, sphere.t, sphere.opening_angle_deg,
    meshRefinement, engine, caMeshSize, bbNx, bbNt, meshPreviewEdges, loadKind, loadActive, bcsKind, showEdges, setStatus,
  ]);

  // -------------------------------------------------------------------
  // Post-mode: load + build result on selection change (existing path).
  // -------------------------------------------------------------------
  useEffect(() => {
    const st = stateRef.current;
    if (!st.meshGroup) return;
    if (mode !== "post") return;

    // Look up the selected result. Manifest entries take priority because
    // they reflect what's actually on disk after the last solve; fallback
    // to KNOWN_RESULTS for the pre-run case. Per-job results live under
    // /data/jobs/<jobId>/, so we prepend that here when the manifest
    // carries a jobId — keeps the sidecar paths clean (just "modes/…").
    const prefix = currentResults?.jobId ? `jobs/${currentResults.jobId}/` : "";
    // LBA manifests carry files.linearPrestress (pre-buckling solve).
    // LSA manifests carry files.solution (the deformed shape from the
    // static solve). Both map to id="linear" so the post-mode default
    // selector + the ResultsPanel can route to whichever the active
    // manifest has — without this branch the LSA case falls back to
    // KNOWN_RESULTS and loads a stale linearSolution.pvd from the
    // flat output/ (= a previous LBA run's closed-cylinder mesh).
    const linearPvd = currentResults?.files?.linearPrestress
                       ?? currentResults?.files?.solution;
    // Stress / strain files written by static_shell_XML --stress. σ_vm is
    // a true 1-component scalar (no projection needed); the Principal*
    // entries are 3-vec eigenvalue triplets that the loader projects to
    // max(|component|) per vertex via opts.projection.
    const files = currentResults?.files ?? {};
    const stressEntries = [
      { id: "stress-vm",         pvdKey: "stressVonMises",          projection: null,      field: "vmStress" },
      { id: "stress-princ-mem",  pvdKey: "principalMembraneStress", projection: "max-abs", field: "principalMembraneStress" },
      { id: "stress-princ-flex", pvdKey: "principalFlexuralStress", projection: "max-abs", field: "principalFlexuralStress" },
      { id: "strain-princ-mem",  pvdKey: "principalMembraneStrain", projection: "max-abs", field: "principalMembraneStrain" },
      { id: "strain-princ-flex", pvdKey: "principalFlexuralStrain", projection: "max-abs", field: "principalFlexuralStrain" },
    ];
    const fromManifest = currentResults
      ? [
          currentResults.files?.geometry && { id: "geometry", pvd: prefix + currentResults.files.geometry, kind: "geometry" },
          linearPvd && { id: "linear", pvd: prefix + linearPvd, kind: "displacement" },
          currentResults.analysisKind === "gnia" && currentResults.loadDeflection && { id: "chart", data: currentResults.loadDeflection, kind: "chart" },
          ...((currentResults.modes ?? []).map((m) => ({ id: m.id, pvd: prefix + m.pvd, kind: "mode" }))),
          ...stressEntries
            .filter((e) => files[e.pvdKey])
            .map((e) => ({
              id: e.id, pvd: prefix + files[e.pvdKey],
              kind: "stress", projection: e.projection, field: e.field,
            })),
        ].filter(Boolean)
      : null;
    const result =
      (fromManifest && fromManifest.find((r) => r.id === selectedId)) ||
      KNOWN_RESULTS.find((r) => r.id === selectedId);
    if (!result) return;

    // Cache key includes jobId because different jobs can have the same
    // result id (mode0 of job A and mode0 of job B are different .vts
    // files). Without this prefix the cache short-circuits the load when
    // the user picks a different job in the post-processor — numbers
    // update (they come from currentResults) but the mesh stays stuck
    // on the previous job's mode shape.
    const cacheKey = currentResults?.jobId
      ? `${currentResults.jobId}:${selectedId}`
      : selectedId;

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

      // Project the 3-component displacement to whichever scalar the
      // user picked in the inspector (|u| / u_x / u_y / u_z). For
      // signed components we use abs() for the color lookup because
      // the shipped colormaps are sequential 0..1; cool-warm diverging
      // around 0 is a follow-up. For scalar fields (e.g. stress) the
      // projectField helper ignores displayField and returns the raw
      // scalar's per-vertex magnitudes.
      const proj = projectField(data.patches, displayField);
      st.uniforms.uMagMax.value = Math.max(proj.fieldMaxAbs, 1e-9);
      // Push stats to the store so ViewportLegend can draw min / max /
      // mid ticks against whatever's actually being rendered. For
      // scalar-only patches we override the field label using the
      // manifest entry's own `field` (e.g. "vmStress" /
      // "principalMembraneStress"); ViewportLegend has FIELD_META
      // entries for each, so the bar gets the right symbol (σ_vm /
      // σ_p,mem / ε_p,flex / …) instead of the stale "|u|".
      const isScalar = data.patches.length > 0 && !!data.patches[0].scalar;
      setDisplayFieldStats({
        field: isScalar ? (result.field ?? "scalar") : displayField,
        min: proj.fieldMin,
        max: proj.fieldMax,
        maxAbs: proj.fieldMaxAbs,
      });

      // Anchor the max-field arrow on the vertex with the largest |field|
      // value across all patches. Position is recomputed each frame against
      // the live warp scale via updateMaxArrow().
      const bb = bboxOfPatches(data.patches);
      const maxInfo = findMaxFieldVertex(data.patches, proj.perPatch);
      if (maxInfo) {
        st.maxAnchor = {
          posUndef: maxInfo.posUndef,
          dispVec: maxInfo.dispVec,
          value: maxInfo.value,
          diag: bb.diag,
          center: bb.center,
        };
      } else {
        st.maxAnchor = null;
      }
      // Remember the result's real bounds so the view-preset buttons frame the
      // actual mesh, and auto-fit ONCE per distinct result (cacheKey). We must
      // NOT re-fit on field/colormap/edge toggles — apply() re-runs for those
      // with the same mesh, and re-fitting would yank a camera the user just
      // orbited.
      st.resultBBox = { center: bb.center, diag: bb.diag };
      if (st.lastFitKey !== cacheKey) {
        st.lastFitKey = cacheKey;
        fitCameraToBox(st, bb.center, bb.diag, useUI.getState().viewPreset);
      }
      const liveState = useUI.getState();
      updateMaxArrow(st, liveState.warpScale, liveState.showMaxArrow);

      for (let i = 0; i < data.patches.length; i++) {
        const p = data.patches[i];
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
          new THREE.BufferAttribute(proj.perPatch[i], 1),
        );
        geom.setIndex(new THREE.BufferAttribute(p.indices, 1));

        const mesh = new THREE.Mesh(geom, st.surfaceMaterial);
        mesh.userData.kind = "surface";
        st.meshGroup.add(mesh);

        // Patch-grid edge wires (cyan). Structured (.vts) → tensor grid;
        // unstructured (.vtu, e.g. BB triangles) → actual triangle edges.
        const edgeGeom = buildGridEdges(p.positions, p.nx, p.ny, p.indices);
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

    // For GNIA charts, don't try to load a PVD file — chart data is shown in Inspector instead
    if (result.kind === "chart") {
      // Clear the viewport and show a message in the status bar
      while (st.meshGroup.children.length) {
        const c = st.meshGroup.children.pop();
        c.geometry?.dispose();
      }
      while (st.wireGroup.children.length) {
        st.wireGroup.children.pop();
      }
      const ld = result.data;
      if (ld && ld.length > 0) {
        setStatus(`${ld.length} converged steps · λ_max=${Number(ld[ld.length-1].loadFactor).toFixed(3)} (details in Inspector →)`);
      }
      return () => { cancelled = true; };
    }

    // If meshGroup is empty but cache exists, it means we just returned from a chart view.
    // Rebuild the mesh from cache.
    if (st.meshGroup.children.length === 0 && resultCache[cacheKey]) {
      apply(resultCache[cacheKey]);
      return () => {
        cancelled = true;
      };
    }

    // Cache hit for non-empty mesh
    if (st.meshGroup.children.length > 0 && resultCache[cacheKey]) {
      return () => {
        cancelled = true;
      };
    }

    setStatus(`loading ${result.label}…`);
    (async () => {
      try {
        let data;
        const loadOpts = { projection: result.projection ?? null };
        try {
          data = await loadResult(result.pvd, "/data", loadOpts);
        } catch (e) {
          if (result.pvdFallback) {
            data = await loadResult(result.pvdFallback, "/data", loadOpts);
          } else {
            throw e;
          }
        }
        if (cancelled) return;
        cacheResult(cacheKey, data);
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
  }, [selectedId, resultCache, cacheResult, setStatus, showEdges, currentResults, displayField]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div
        ref={containerRef}
        style={{ position: "absolute", inset: 0, background: "transparent" }}
      />
      {boxRect && (
        <div
          style={{
            position: "absolute",
            left: boxRect.x, top: boxRect.y,
            width: boxRect.w, height: boxRect.h,
            border: "1px solid var(--accent)",
            background: "rgba(0,180,210,0.12)",
            pointerEvents: "none",
            zIndex: 7,
          }}
        />
      )}
    </div>
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

/** Build a cylindrical-segment "roof" surface mesh.
 *
 * Axis along x: x ∈ [0, L] (the roof length). Arc in the y-z plane
 * sweeping from θ = -phi to θ = +phi, measured from the apex. In
 * Cartesian: y = R·sin(θ), z = R·cos(θ). The arc's center is at
 * (0, 0, 0), apex of the arc at (·, 0, R), free-edge points at
 * (·, ±R·sin(phi), R·cos(phi)).
 *
 * Returns a BufferGeometry with positions + normals + a unit-square uv
 * (so the existing Lambertian preview material lights it correctly).
 * uSegs × vSegs tessellation; both default to 32 which is comfortable
 * for visual inspection. */
function buildRoofSegmentGeometry(R, L, phi_deg, uSegs = 32, vSegs = 32) {
  const phi = (phi_deg * Math.PI) / 180;
  const positions = new Float32Array((uSegs + 1) * (vSegs + 1) * 3);
  const normals = new Float32Array((uSegs + 1) * (vSegs + 1) * 3);
  const indices = [];

  let p = 0, n = 0;
  for (let j = 0; j <= vSegs; j++) {
    const v = j / vSegs;                 // 0 → 1 along v
    const theta = -phi + (2 * phi) * v;  // -phi → +phi
    const sy = R * Math.sin(theta);
    const sz = R * Math.cos(theta);
    // Outward normal at the mid-surface points radially: (0, sin θ, cos θ).
    const ny = Math.sin(theta);
    const nz = Math.cos(theta);
    for (let i = 0; i <= uSegs; i++) {
      const u = i / uSegs;
      positions[p++] = u * L;
      positions[p++] = sy;
      positions[p++] = sz;
      normals[n++] = 0;
      normals[n++] = ny;
      normals[n++] = nz;
    }
  }
  // Standard quad → 2 triangles, CCW from outward.
  for (let j = 0; j < vSegs; j++) {
    for (let i = 0; i < uSegs; i++) {
      const a = j * (uSegs + 1) + i;
      const b = a + 1;
      const c = a + (uSegs + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  g.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  return g;
}

/** Wireframe edge overlay for the roof segment: a u/v grid at the
 * mesh-refinement density (so bumping r densifies the preview),
 * plus the 4 boundary curves drawn explicitly so the user can
 * tell at a glance which edges are diaphragm (curved, at u=0 and
 * u=L) vs free (straight, at v=0 and v=1). */
function buildRoofSegmentEdges(R, L, phi_deg, uSegs = 16, vSegs = 16) {
  const phi = (phi_deg * Math.PI) / 180;
  const pts = [];
  const evalP = (u, v) => {
    const theta = -phi + (2 * phi) * v;
    return [u * L, R * Math.sin(theta), R * Math.cos(theta)];
  };
  const PUSH = (p1, p2) => {
    pts.push(p1[0], p1[1], p1[2]);
    pts.push(p2[0], p2[1], p2[2]);
  };
  // u-grid (parametric u = const lines, swept across v) → axial element edges
  for (let i = 0; i <= uSegs; i++) {
    const u = i / uSegs;
    for (let j = 0; j < vSegs; j++) {
      PUSH(evalP(u, j / vSegs), evalP(u, (j + 1) / vSegs));
    }
  }
  // v-grid (parametric v = const lines, swept along u) → arc-direction element edges
  for (let j = 0; j <= vSegs; j++) {
    const v = j / vSegs;
    for (let i = 0; i < uSegs; i++) {
      PUSH(evalP(i / uSegs, v), evalP((i + 1) / uSegs, v));
    }
  }
  const arr = new Float32Array(pts);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Project the 3-component displacement field of every patch onto a
 * single scalar (chosen by displayField) and return:
 *   - perPatch:    Float32Array per patch, one scalar per vertex
 *   - fieldMin / fieldMax: signed range across ALL patches
 *   - fieldMaxAbs: max(|min|, |max|) — what the shader uses as uMagMax
 *                 since the color lookup is currently abs-based.
 *
 * Components return signed values; only the lookup-time abs() drops the
 * sign. We keep the signed numbers around so the legend can show the
 * real min/max ticks (which matter for a u_z that goes from -0.30 to
 * +0.05 in Scordelis-Lo — you want to read both endpoints, not just
 * 0.30 either way).
 *
 * Special case: when patches carry a 1-component `scalar` (stress field
 * like von Mises), the `field` argument is ignored — there's no x/y/z
 * direction to project — and the per-patch output is just the scalar
 * itself. fieldMin/Max/MaxAbs report the scalar's signed range. */
function projectField(patches, field) {
  let fieldMin = Infinity;
  let fieldMax = -Infinity;
  let fieldMaxAbs = 0;

  // Scalar-field path: stress, strain, anything written by the C++
  // driver as a 1-component .vts. Loader put the values in p.scalar.
  if (patches.length > 0 && patches[0].scalar) {
    const perPatch = patches.map((p) => {
      if (!p.scalar) return new Float32Array(p.positions.length / 3);
      const out = new Float32Array(p.scalar.length);
      for (let i = 0; i < p.scalar.length; i++) {
        const v = p.scalar[i];
        out[i] = Math.abs(v);
        if (v < fieldMin) fieldMin = v;
        if (v > fieldMax) fieldMax = v;
        const a = Math.abs(v);
        if (a > fieldMaxAbs) fieldMaxAbs = a;
      }
      return out;
    });
    if (!Number.isFinite(fieldMin)) fieldMin = 0;
    if (!Number.isFinite(fieldMax)) fieldMax = 0;
    return { perPatch, fieldMin, fieldMax, fieldMaxAbs };
  }

  const perPatch = patches.map((p) => {
    const n = p.positions.length / 3;
    const out = new Float32Array(n);
    const disp = p.displacement;
    if (!disp) return out; // all zeros — no displacement field on this patch
    if (field === "ux" || field === "uy" || field === "uz") {
      const offset = field === "ux" ? 0 : field === "uy" ? 1 : 2;
      for (let i = 0; i < n; i++) {
        const v = disp[i * 3 + offset];
        out[i] = Math.abs(v);            // sequential colormaps use 0..1
        if (v < fieldMin) fieldMin = v;
        if (v > fieldMax) fieldMax = v;
        const a = Math.abs(v);
        if (a > fieldMaxAbs) fieldMaxAbs = a;
      }
    } else {
      // "magnitude" / default — L2 norm of the 3-vector, already
      // precomputed by loadResult.
      const mag = p.magnitude;
      if (mag) {
        for (let i = 0; i < n; i++) {
          out[i] = mag[i];
          if (mag[i] < fieldMin) fieldMin = mag[i];
          if (mag[i] > fieldMax) fieldMax = mag[i];
          if (mag[i] > fieldMaxAbs) fieldMaxAbs = mag[i];
        }
      } else {
        for (let i = 0; i < n; i++) {
          const x = disp[i * 3], y = disp[i * 3 + 1], z = disp[i * 3 + 2];
          const m = Math.sqrt(x * x + y * y + z * z);
          out[i] = m;
          if (m < fieldMin) fieldMin = m;
          if (m > fieldMax) fieldMax = m;
          if (m > fieldMaxAbs) fieldMaxAbs = m;
        }
      }
    }
    return out;
  });
  if (!Number.isFinite(fieldMin)) fieldMin = 0;
  if (!Number.isFinite(fieldMax)) fieldMax = 0;
  return { perPatch, fieldMin, fieldMax, fieldMaxAbs };
}

/** BC edge highlights for the roof segment — returns {diaphragm, free}
 * line geometries, either of which may be null when the active bcs.kind
 * doesn't carve up the edges the way Scordelis expects. The cyan +
 * amber rendering happens at the caller; here we just emit the
 * positions for the boundary curves.
 *
 * scordelis_diaphragm: u=0 + u=L (the two curved arcs) are diaphragm;
 *   v=0 + v=1 (the two straight side eaves) are free.
 * any other bcs.kind on a segment is unusual; we emit all 4 edges as
 *   "free" so the user sees clearly that nothing's constrained. */
function buildRoofSegmentBcEdges(R, L, phi_deg, bcsKind) {
  const phi = (phi_deg * Math.PI) / 180;
  const evalP = (u, v) => {
    const theta = -phi + (2 * phi) * v;
    return [u * L, R * Math.sin(theta), R * Math.cos(theta)];
  };

  // Sample each boundary curve with enough segments for the visible
  // curvature. The u=const arcs need ~32 steps for a smooth arc; the
  // v=const lines are straight along u, 2 points each is enough.
  const ARC_STEPS = 32;
  const arcPositions = (u_fixed) => {
    const pts = [];
    for (let j = 0; j < ARC_STEPS; j++) {
      const a = evalP(u_fixed, j / ARC_STEPS);
      const b = evalP(u_fixed, (j + 1) / ARC_STEPS);
      pts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    return pts;
  };
  const linePositions = (v_fixed) => {
    const a = evalP(0, v_fixed);
    const b = evalP(1, v_fixed);
    return [a[0], a[1], a[2], b[0], b[1], b[2]];
  };

  const mkGeom = (positions) => {
    if (positions.length === 0) return null;
    const arr = new Float32Array(positions);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    return g;
  };

  if (bcsKind === "scordelis_diaphragm") {
    const dia = [...arcPositions(0), ...arcPositions(1)];
    const free = [...linePositions(0), ...linePositions(1)];
    return { diaphragm: mkGeom(dia), free: mkGeom(free) };
  }
  // Other BC presets on a segment — treat all 4 edges as free so the
  // user sees the lack of constraints loudly (amber lines, no cyan).
  const free = [
    ...arcPositions(0), ...arcPositions(1),
    ...linePositions(0), ...linePositions(1),
  ];
  return { diaphragm: null, free: mkGeom(free) };
}

/** Gravity-load indicator for the roof segment — small downward arrows
 * distributed on a 5×5 parametric grid across the surface, so the user
 * sees the body force coverage at a glance. Arrow length scales with
 * max(R, L) so the visual reads consistently across geometries. */
function buildRoofGravityArrows(R, L, phi_deg, gridSize = 5) {
  const phi = (phi_deg * Math.PI) / 180;
  const group = new THREE.Group();
  const arrowLen = Math.max(R, L) * 0.15;
  const headLen = arrowLen * 0.32;
  const headWidth = arrowLen * 0.18;
  const downDir = new THREE.Vector3(0, 0, -1);
  const colour = 0xffb454;     // amber, matches the load-arrow palette
                               // used for the closed-cylinder compression case
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      // Avoid placing arrows exactly at the boundary edges so they
      // don't overlap the BC line highlights.
      const u = (i + 0.5) / gridSize;
      const v = (j + 0.5) / gridSize;
      const theta = -phi + (2 * phi) * v;
      const x = u * L;
      const y = R * Math.sin(theta);
      const z = R * Math.cos(theta);
      // Arrows sit ABOVE the surface and point down, tips touching the
      // shell at the sample point so the connection to the body force
      // is unambiguous.
      const origin = new THREE.Vector3(x, y, z + arrowLen);
      const arrow = new THREE.ArrowHelper(
        downDir, origin, arrowLen, colour, headLen, headWidth,
      );
      group.add(arrow);
    }
  }
  return group;
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

/** Wireframe of the BB triangle mesh on the cylinder: an Nx (axial) × Nt
 * (circumferential) grid of quad cells, each split into two triangles by the
 * (i,j)->(i+1,j+1) diagonal — exactly the triangulation the BB driver builds.
 * Draws Nx+1 circumferential rings (sampled as circles), Nt axial lines
 * (straight at fixed theta), and Nx*Nt diagonals (helical, sub-sampled to hug
 * the surface). Lets the pre-processor show the real triangle elements live. */
function buildCylinderTriEdges(R, L, Nx, Nt) {
  const pts = [];
  const node = (i, j) => {
    const x = (L * i) / Nx;
    const th = (2 * Math.PI * j) / Nt;
    return [R * Math.cos(th), R * Math.sin(th), x];
  };
  const seg = (a, b) => { pts.push(a[0], a[1], a[2], b[0], b[1], b[2]); };
  const ringSeg = Math.max(72, Nt * 3);
  for (let i = 0; i <= Nx; i++) {
    const x = (L * i) / Nx;
    for (let k = 0; k < ringSeg; k++) {
      const a0 = (k / ringSeg) * 2 * Math.PI;
      const a1 = ((k + 1) / ringSeg) * 2 * Math.PI;
      pts.push(R * Math.cos(a0), R * Math.sin(a0), x);
      pts.push(R * Math.cos(a1), R * Math.sin(a1), x);
    }
  }
  for (let j = 0; j < Nt; j++) seg(node(0, j), node(Nx, j));
  const dsub = 5;
  for (let i = 0; i < Nx; i++) {
    for (let j = 0; j < Nt; j++) {
      let prev = node(i, j);
      for (let s = 1; s <= dsub; s++) {
        const f = s / dsub;
        const x = (L * (i + f)) / Nx;
        const th = (2 * Math.PI * (j + f)) / Nt;
        const cur = [R * Math.cos(th), R * Math.sin(th), x];
        seg(prev, cur);
        prev = cur;
      }
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
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

/** Point load arrows for the pinched-cylinder benchmark.
 * If nodes[] is provided and non-empty, draw arrows from picked positions.
 * Otherwise, fall back to hardcoded ±y positions for benchmark default.
 * Returns a THREE.Group of ArrowHelpers, or null if not applicable. */
function buildPointLoadArrows(loadKind, R, L, nodes = []) {
  if (loadKind !== "point_load") return null;

  const group = new THREE.Group();
  const maxLen = Math.max(R, L) * 0.18;
  const POINT_LOAD = 0xd946ef;  // magenta/purple

  let loads;
  if (nodes && nodes.length > 0) {
    // User-picked nodes: draw arrow from force vector
    loads = nodes.map(n => {
      const forceMag = Math.sqrt(n.fx * n.fx + n.fy * n.fy + n.fz * n.fz);
      if (forceMag < 1e-9) {
        // No force set, skip this node
        return null;
      }
      const dir = new THREE.Vector3(n.fx / forceMag, n.fy / forceMag, n.fz / forceMag);
      return { pos: new THREE.Vector3(n.x, n.y, n.z), dir, mag: forceMag };
    }).filter(l => l !== null);
  } else {
    // Hardcoded benchmark defaults (Pinched Cylinder)
    const z_load = L * 0.5;
    loads = [
      { pos: new THREE.Vector3(0, R, z_load), dir: new THREE.Vector3(0, 1, 0), mag: 1 },
      { pos: new THREE.Vector3(0, -R, z_load), dir: new THREE.Vector3(0, -1, 0), mag: 1 },
    ];
  }

  for (const load of loads) {
    const arrowLen = maxLen;
    const headLen = arrowLen * 0.32;
    const headWidth = arrowLen * 0.20;
    group.add(new THREE.ArrowHelper(load.dir, load.pos, arrowLen, POINT_LOAD, headLen, headWidth));
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

function buildCylinderBcRings(R, L, bcsKind) {
  const makeRing = (z) => {
    const pts = [];
    const N = 128;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push(new THREE.Vector3(R * Math.cos(a), R * Math.sin(a), z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return geo;
  };
  const cyanMat  = new THREE.LineBasicMaterial({ color: 0x00e5ff, linewidth: 2 });
  const amberMat = new THREE.LineBasicMaterial({ color: 0xffb454, linewidth: 2 });
  const topFree = !bcsKind || bcsKind === "clamped_free";
  const group = new THREE.Group();
  group.add(new THREE.Line(makeRing(0), cyanMat));
  group.add(new THREE.Line(makeRing(L), topFree ? amberMat : cyanMat));
  group.userData.kind = "bc-rings";
  return group;
}

/** Walk the per-patch scalar arrays produced by projectField and return the
 * (patch, vertex) where the value peaks, along with its undeformed position
 * and displacement vector. updateMaxArrow then combines those with the
 * current warp scale to place the pointer. Returns null when no patches
 * carry any data (very early frames before loadResult resolves). */
function findMaxFieldVertex(patches, perPatch) {
  let best = -Infinity;
  let bestPatchIdx = -1;
  let bestVertIdx = -1;
  for (let pi = 0; pi < patches.length; pi++) {
    const arr = perPatch[pi];
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] > best) {
        best = arr[i];
        bestPatchIdx = pi;
        bestVertIdx = i;
      }
    }
  }
  if (bestPatchIdx < 0) return null;
  const p = patches[bestPatchIdx];
  const k = bestVertIdx;
  const posUndef = new THREE.Vector3(
    p.positions[k * 3], p.positions[k * 3 + 1], p.positions[k * 3 + 2],
  );
  const dispVec = p.displacement
    ? new THREE.Vector3(
        p.displacement[k * 3],
        p.displacement[k * 3 + 1],
        p.displacement[k * 3 + 2],
      )
    : new THREE.Vector3(0, 0, 0);
  return { posUndef, dispVec, value: best };
}

/** Axis-aligned bounding box (undeformed) across all patches — returns
 * {diag, center}. Used to scale the max-arrow length (so it stays
 * proportionally readable on tiny cylinders AND big silos) and to give
 * the arrow a sensible "outside" direction to point inward from. */
function bboxOfPatches(patches) {
  let xmin = Infinity, ymin = Infinity, zmin = Infinity;
  let xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;
  for (const p of patches) {
    const pos = p.positions;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      if (z < zmin) zmin = z; if (z > zmax) zmax = z;
    }
  }
  if (!Number.isFinite(xmin)) {
    return { diag: 1, center: new THREE.Vector3(0, 0, 0) };
  }
  const dx = xmax - xmin, dy = ymax - ymin, dz = zmax - zmin;
  return {
    diag: Math.sqrt(dx * dx + dy * dy + dz * dz),
    center: new THREE.Vector3((xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2),
  };
}

/** Frame the camera on a bounding box (center + space diagonal), keeping the
 * orientation implied by the named view preset. The distance is derived from
 * the vertical FOV so the box fills the frame with a small margin. This is the
 * "center / fit" behaviour: whatever the loaded result's real coordinates are
 * (FE meshes don't necessarily sit in the procedural R=33,L=100 box), it lands
 * centred and fully in view instead of squashed against the edge. */
function fitCameraToBox(st, center, diag, viewPreset = "oblique") {
  if (!st.camera || !st.controls || !center) return;
  const c = center.clone
    ? center.clone()
    : new THREE.Vector3(center[0], center[1], center[2]);
  const d = Math.max(diag, 1e-3);
  const fov = (st.camera.fov * Math.PI) / 180;
  const margin = 1.35;
  const dist = Math.max((d * 0.5 * margin) / Math.tan(fov / 2), d * 0.5 + 0.01);
  // Each view = direction from target to camera + an up vector. The cylinder
  // axis is Z (vertical), so axis-side views (front/back/left/right) keep up=Z;
  // axial views (top/bottom) look down Z so up=Y. oblique/side/end kept as
  // aliases for the legacy 3-button group.
  const Z_UP = [0, 0, 1], Y_UP = [0, 1, 0];
  const VIEWS = {
    iso:     { dir: [1, -1, 0.7], up: Z_UP },
    oblique: { dir: [1, -1, 0.35], up: Z_UP },
    front:   { dir: [0, -1, 0], up: Z_UP },
    back:    { dir: [0, 1, 0], up: Z_UP },
    right:   { dir: [1, 0, 0], up: Z_UP },
    left:    { dir: [-1, 0, 0], up: Z_UP },
    top:     { dir: [0, 0, 1], up: Y_UP },
    bottom:  { dir: [0, 0, -1], up: Y_UP },
    side:    { dir: [0, -1, 0], up: Z_UP },
    end:     { dir: [0, 0, 1], up: Y_UP },
  };
  const v = VIEWS[viewPreset] || VIEWS.oblique;
  const dir = new THREE.Vector3(...v.dir).normalize();
  st.controls.target.copy(c);
  st.camera.position.copy(c).addScaledVector(dir, dist);
  st.camera.up.set(...v.up);
  st.camera.near = Math.max(dist - d, d * 0.001, 0.001);
  st.camera.far = dist + d * 4;
  st.camera.updateProjectionMatrix();
  // Widen orbit limits so the freshly-fitted frame isn't immediately clamped
  // (the geometry-keyed effect sets these from R/L, which can be far off for
  // an FE result).
  st.controls.minDistance = Math.min(st.controls.minDistance, dist * 0.2);
  st.controls.maxDistance = Math.max(st.controls.maxDistance, dist * 4);
  st.controls.update();
}

/** Reposition + resize the persistent ArrowHelper so its tip lands on the
 * warped position of the max-field vertex. Direction = inward from the
 * model bounding-box centre, so the arrow comes from OUTSIDE the geometry
 * and points at the peak. Length scales with the bbox diagonal so the
 * pointer reads as the same visual size across geometries (a Scordelis
 * roof and a 100 m silo both get a sensibly-sized arrow). */
function updateMaxArrow(st, warpScale, visible) {
  if (!st.maxArrow) return;
  if (!st.maxAnchor || !visible) {
    st.maxArrow.visible = false;
    return;
  }
  const a = st.maxAnchor;
  const warped = a.posUndef.clone().addScaledVector(a.dispVec, warpScale);
  const radial = warped.clone().sub(a.center);
  if (radial.lengthSq() < 1e-12) radial.set(0, 0, 1);
  radial.normalize();
  const arrowLen = Math.max(a.diag * 0.18, 1e-6);
  const origin = warped.clone().addScaledVector(radial, arrowLen);
  st.maxArrow.position.copy(origin);
  // Arrow points from the outside (origin) back inward toward the peak.
  st.maxArrow.setDirection(radial.clone().negate());
  st.maxArrow.setLength(arrowLen, arrowLen * 0.32, arrowLen * 0.18);
  st.maxArrow.visible = true;
}

/** Build a line-segment geometry tracing the (nx × ny) structured grid edges. */
function buildGridEdges(positions, nx, ny, indices) {
  // Unstructured patches (BB triangle .vtu, Code_Aster FEM .vtu) carry no
  // (nx, ny) tensor grid — so draw the actual element edges from the triangle
  // index buffer (each triangle's 3 edges, deduped by sorted vertex pair). For
  // the BB engine this is what makes the triangular discretisation visible when
  // the user toggles "Edges". Falls back to an empty geometry if no indices.
  if (!nx || !ny) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (indices && indices.length >= 3) {
      const nPts = positions.length / 3;
      const seen = new Set();
      const idx = [];
      const addEdge = (u, v) => {
        const lo = u < v ? u : v;
        const hi = u < v ? v : u;
        const key = lo * nPts + hi;
        if (seen.has(key)) return;
        seen.add(key);
        idx.push(lo, hi);
      };
      for (let c = 0; c + 2 < indices.length; c += 3) {
        const a = indices[c], b = indices[c + 1], d = indices[c + 2];
        addEdge(a, b);
        addEdge(b, d);
        addEdge(d, a);
      }
      geom.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
    } else {
      geom.setIndex(new THREE.Uint32BufferAttribute([], 1));
    }
    return geom;
  }
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
