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
