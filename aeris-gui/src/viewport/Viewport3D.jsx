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

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
    camera.position.set(...VIEW_PRESETS.oblique.pos);
    camera.up.set(...VIEW_PRESETS.oblique.up);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...VIEW_PRESETS.oblique.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
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

    function resize() {
      const w = container.clientWidth;
      const h = container.clientHeight;
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
      renderer.render(scene, camera);
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
      edgeMaterial,
      wireMaterial,
      grid,
    };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      surfaceMaterial.dispose();
      edgeMaterial.dispose();
      wireMaterial.dispose();
      rampTex.dispose();
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

    // The shared shader expects per-vertex aDisp + aMag; zero them so the
    // procedural mesh draws as the colormap's base colour (deep navy in dark).
    const nVerts = geom.attributes.position.count;
    geom.setAttribute("aDisp", new THREE.BufferAttribute(new Float32Array(nVerts * 3), 3));
    geom.setAttribute("aMag", new THREE.BufferAttribute(new Float32Array(nVerts), 1));

    const mesh = new THREE.Mesh(geom, st.surfaceMaterial);
    mesh.userData.kind = "surface";
    st.meshGroup.add(mesh);

    // Edge overlay = rims + meridians, sparser than the surface tessellation.
    const edges = new THREE.LineSegments(
      buildCylinderEdges(cyl.R, cyl.L, 16, 4),
      st.edgeMaterial
    );
    edges.userData.kind = "edges";
    edges.visible = showEdges;
    st.meshGroup.add(edges);

    setStatus(
      `live preview · cylinder R=${cyl.R} L=${cyl.L} t=${cyl.t} · R/t=${(cyl.R / cyl.t).toFixed(0)}`
    );
    return () => {
      // Tear-down handled at next effect run (or on unmount inside init).
    };
  }, [mode, cyl.R, cyl.L, cyl.t, showEdges, setStatus]);

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

/** Sparse edge overlay for the procedural cylinder: top + bottom rims +
 * `meridians` axial lines + `axialRings` intermediate rings. */
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
