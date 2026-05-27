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
