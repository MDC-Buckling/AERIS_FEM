/** Cyan-tinted "viridis-ish" gradient — picked so values look at home in the
 * MDC Codex dark theme. 5-stop, linearly interpolated in sRGB. Light theme
 * shifts to a more desaturated steel-blue ramp.
 *
 * Returns a 256x1 RGB Uint8Array suitable for a THREE.DataTexture. */
const STOPS_DARK = [
  [0.00, [10, 18, 38]],     // deep navy
  [0.25, [30, 80, 140]],    // deep blue
  [0.50, [0, 180, 220]],    // cyan
  [0.75, [120, 240, 230]],  // pale cyan
  [1.00, [255, 255, 230]],  // warm white
];
const STOPS_LIGHT = [
  [0.00, [210, 216, 220]],
  [0.25, [120, 150, 175]],
  [0.50, [60, 100, 135]],
  [0.75, [45, 70, 95]],
  [1.00, [30, 45, 65]],
];

function buildRamp(stops) {
  const N = 256;
  const out = new Uint8Array(N * 3);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    // find bracketing stops
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        a = stops[s];
        b = stops[s + 1];
        break;
      }
    }
    const u = (t - a[0]) / Math.max(b[0] - a[0], 1e-9);
    out[i * 3 + 0] = Math.round(a[1][0] + (b[1][0] - a[1][0]) * u);
    out[i * 3 + 1] = Math.round(a[1][1] + (b[1][1] - a[1][1]) * u);
    out[i * 3 + 2] = Math.round(a[1][2] + (b[1][2] - a[1][2]) * u);
  }
  return out;
}

export const RAMP_DARK = buildRamp(STOPS_DARK);
export const RAMP_LIGHT = buildRamp(STOPS_LIGHT);

// ---------------------------------------------------------------------------
// Standard scientific / engineering colormaps
// ---------------------------------------------------------------------------
//
// Each entry is a 256x3 Uint8Array suitable for direct upload as a 1-D
// DataTexture. Sources:
//   - JET: MATLAB classical rainbow (5-stop approx)
//   - VIRIDIS / PLASMA / INFERNO: matplotlib perceptually-uniform sequential,
//     5-stop linear-RGB approximations (close enough for visualisation;
//     the canonical 256-entry LUTs differ by < 2 %)
//   - COOLWARM: ParaView's diverging blue-white-red, mid-greyish at 0.5
//   - GRAYSCALE: simple luminance ramp
// User picks one in the inspector; the viewport swaps the DataTexture in
// place (no shader / mesh rebuild needed).

const STOPS_JET = [
  [0.000, [  0,   0, 143]],   // dark blue
  [0.125, [  0,   0, 255]],   // blue
  [0.375, [  0, 255, 255]],   // cyan
  [0.625, [255, 255,   0]],   // yellow
  [0.875, [255,   0,   0]],   // red
  [1.000, [128,   0,   0]],   // dark red
];

const STOPS_VIRIDIS = [
  [0.00, [ 68,   1,  84]],
  [0.25, [ 59,  82, 139]],
  [0.50, [ 33, 144, 141]],
  [0.75, [ 93, 201,  99]],
  [1.00, [253, 231,  37]],
];

const STOPS_PLASMA = [
  [0.00, [ 13,   8, 135]],
  [0.25, [ 84,   2, 163]],
  [0.50, [156,  23, 158]],
  [0.75, [229,  95,  60]],
  [1.00, [240, 249,  33]],
];

const STOPS_INFERNO = [
  [0.00, [  0,   0,   4]],
  [0.25, [ 50,  10,  94]],
  [0.50, [120,  28, 109]],
  [0.75, [221,  81,  58]],
  [1.00, [252, 254, 164]],
];

const STOPS_COOLWARM = [
  [0.00, [ 59,  76, 192]],    // blue
  [0.25, [144, 178, 254]],
  [0.50, [221, 221, 221]],    // light grey midpoint
  [0.75, [245, 156, 125]],
  [1.00, [180,   4,  38]],    // red
];

const STOPS_GRAYSCALE = [
  [0.00, [ 16,  16,  16]],
  [1.00, [240, 240, 240]],
];

/** Named registry. Keep stable — saved screenshots refer to these names. */
export const COLORMAPS = {
  "aeris-dark":  RAMP_DARK,
  "aeris-light": RAMP_LIGHT,
  "jet":         buildRamp(STOPS_JET),
  "viridis":     buildRamp(STOPS_VIRIDIS),
  "plasma":      buildRamp(STOPS_PLASMA),
  "inferno":     buildRamp(STOPS_INFERNO),
  "coolwarm":    buildRamp(STOPS_COOLWARM),
  "grayscale":   buildRamp(STOPS_GRAYSCALE),
};

/** Resolve a colormap name + theme into the actual ramp bytes. Used by
 * the viewport when (re)building the DataTexture. "aeris-auto" picks
 * dark/light by theme so the default keeps the on-brand look. */
export function resolveColormap(name, theme) {
  if (name === "aeris-auto" || !name) {
    return theme === "light" ? RAMP_LIGHT : RAMP_DARK;
  }
  return COLORMAPS[name] ?? RAMP_DARK;
}

/** Human labels for the inspector dropdown. Order = display order. */
export const COLORMAP_OPTIONS = [
  ["aeris-auto",  "Aeris (auto)"],
  ["jet",         "Jet"],
  ["viridis",     "Viridis"],
  ["plasma",      "Plasma"],
  ["inferno",     "Inferno"],
  ["coolwarm",    "Cool-Warm"],
  ["grayscale",   "Grayscale"],
];
