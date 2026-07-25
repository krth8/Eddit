// Camera Log -> scene-linear decodes, from each maker's published transfer
// functions. Input x = normalized code value 0..1, output = scene-linear
// (≈0.18 at 18% mid-grey). Used to bake accurate Log->Rec.709 conversion LUTs.
const p10 = (v) => Math.pow(10, v);

export const LOG = {
  // Sony S-Log3
  slog3: (x) => x >= 0.1673609920
    ? p10((x * 1023 - 420) / 261.5) * 0.19 - 0.01
    : (x * 1023 - 95) * 0.01125 / (171.2102946929 - 95),

  // ARRI LogC3 (EI 800)
  logc: (x) => x > 0.1496582
    ? (p10((x - 0.385537) / 0.247190) - 0.052272) / 5.555556
    : (x - 0.092809) / 5.367655,

  // Canon C-Log3 (3-segment, symmetric log for negatives)
  clog3: (x) => {
    if (x < 0.097465473) return -(p10((0.12783901 - x) / 0.36726845) - 1) / 14.98325;
    if (x <= 0.15277897) return (x - 0.12512219) / 2.3069815;
    return (p10((x - 0.12240537) / 0.36726845) - 1) / 14.98325;
  },

  // Canon C-Log2
  clog2: (x) => x < 0.092864125
    ? -(p10((0.092864125 - x) / 0.24136077) - 1) / 87.09937
    : (p10((x - 0.092864125) / 0.24136077) - 1) / 87.09937,

  // Panasonic V-Log  (c=0.241514, b=0.00873, d=0.598206, cut=0.181)
  vlog: (x) => x < 0.181
    ? (x - 0.125) / 5.6
    : p10((x - 0.598206) / 0.241514) - 0.00873,

  // Fujifilm F-Log (a=0.555556, b=0.009468, c=0.344676, d=0.790453, e=8.735631, f=0.092864)
  flog: (x) => x < 0.100537775223865
    ? (x - 0.092864) / 8.735631
    : (p10((x - 0.790453) / 0.344676) - 0.009468) / 0.555556,
};

// sRGB OETF (used as the Rec.709 display encode for previews)
export const toSRGB = (l) => {
  l = Math.min(1, Math.max(0, l));
  return l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
};

// ---- camera gamut -> Rec.709 matrices --------------------------------------
// Each maker's Log lives in its own wide gamut; decoding only the curve leaves
// the primaries wrong (desaturated, hue-skewed reds/greens). These 3x3s are
// computed from the published xy primaries — all D65, so no adaptation needed.
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const det = a * A + d * B + g * C;
  return [A / det, B / det, C / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
}
function mul3(m, n) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    o[r * 3 + c] = m[r * 3] * n[c] + m[r * 3 + 1] * n[3 + c] + m[r * 3 + 2] * n[6 + c];
  return o;
}
// RGB->XYZ from xy primaries + white point (Y=1)
function rgbToXyz([rx, ry, gx, gy, bx, by], [wx, wy]) {
  const col = (x, y) => [x / y, 1, (1 - x - y) / y];
  const R = col(rx, ry), G = col(gx, gy), B = col(bx, by), W = col(wx, wy);
  const P = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
  const Pi = inv3(P);
  const S = [
    Pi[0] * W[0] + Pi[1] * W[1] + Pi[2] * W[2],
    Pi[3] * W[0] + Pi[4] * W[1] + Pi[5] * W[2],
    Pi[6] * W[0] + Pi[7] * W[1] + Pi[8] * W[2]];
  return [P[0] * S[0], P[1] * S[1], P[2] * S[2],
    P[3] * S[0], P[4] * S[1], P[5] * S[2],
    P[6] * S[0], P[7] * S[1], P[8] * S[2]];
}
const D65 = [0.3127, 0.3290];
const XYZ_TO_709 = [
  3.2404542, -1.5371385, -0.4985314,
  -0.9692660, 1.8760108, 0.0415560,
  0.0556434, -0.2040259, 1.0572252];
const to709 = (prim) => mul3(XYZ_TO_709, rgbToXyz(prim, D65));

// keyed by inputTransform / LOG key
export const GAMUT = {
  slog3: to709([0.766, 0.275, 0.225, 0.800, 0.089, -0.087]),   // S-Gamut3.Cine
  logc:  to709([0.684, 0.313, 0.221, 0.848, 0.0861, -0.102]),  // ARRI Wide Gamut 3
  clog3: to709([0.740, 0.270, 0.170, 1.140, 0.080, -0.100]),   // Canon Cinema Gamut
  clog2: to709([0.740, 0.270, 0.170, 1.140, 0.080, -0.100]),   // Canon Cinema Gamut
  vlog:  to709([0.730, 0.280, 0.165, 0.840, 0.100, -0.030]),   // Panasonic V-Gamut
  flog:  to709([0.708, 0.292, 0.170, 0.797, 0.131, 0.046]),    // F-Gamut (BT.2020)
};
