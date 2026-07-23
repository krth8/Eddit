// Categorised LUTs, license-free.
//  · Conversion LUTs are baked from each maker's published Log transfer
//    function (math, not copyrightable) -> Rec.709. These are the real
//    "Log input" LUTs, grouped by manufacturer like DaVinci Resolve.
//  · Creative looks are generated procedurally.
import { LOG, toSRGB } from './gpu/logtransforms.js';

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// build a 3D LUT ({size,data}) from fn(r,g,b)->[r,g,b]
function build(size, fn) {
  const data = new Float32Array(size * size * size * 4);
  let i = 0;
  for (let bz = 0; bz < size; bz++)
    for (let gy = 0; gy < size; gy++)
      for (let rx = 0; rx < size; rx++) {
        const o = fn(rx / (size - 1), gy / (size - 1), bz / (size - 1));
        data[i++] = clamp01(o[0]); data[i++] = clamp01(o[1]); data[i++] = clamp01(o[2]); data[i++] = 1;
      }
  return { size, data };
}

// Log code value -> Rec.709 display, per channel
function conversion(decode) {
  return build(33, (r, g, b) => [toSRGB(decode(r)), toSRGB(decode(g)), toSRGB(decode(b))]);
}

// ---- creative-look helpers (operate on Rec.709-ish 0..1) ----
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const lift = (v, a) => v + a * (1 - v);
const scurve = (v, k) => { const x = v - 0.5; return 0.5 + Math.sign(x) * Math.pow(Math.abs(x) * 2, 1 / k) / 2; };

const CREATIVE = [
  { name: 'Teal & Orange', swatch: 'linear-gradient(90deg,#0f4d5c,#ff9a52)', fn: (r, g, b) => { const L = luma(r, g, b), s = 1 - L, h = L; return [r + h * 0.10 - s * 0.05, g + s * 0.04 - h * 0.02, b + s * 0.12 - h * 0.10]; } },
  { name: 'Warm Film', swatch: 'linear-gradient(90deg,#3a2a1a,#f6d9a8)', fn: (r, g, b) => [lift(scurve(r, 1.15), 0.03) * 1.02, lift(scurve(g, 1.12), 0.02), scurve(b, 1.1) * 0.97] },
  { name: 'Cool Cine', swatch: 'linear-gradient(90deg,#1a2333,#bcd2ff)', fn: (r, g, b) => [scurve(r, 1.08) * 0.97, scurve(g, 1.08), lift(scurve(b, 1.1), 0.04) * 1.03] },
  { name: 'Bleach Bypass', swatch: 'linear-gradient(90deg,#2a2a2a,#e8e8e0)', fn: (r, g, b) => { const L = scurve(luma(r, g, b), 1.4); return [scurve(r, 1.3) * 0.5 + L * 0.5, scurve(g, 1.3) * 0.5 + L * 0.5, scurve(b, 1.3) * 0.5 + L * 0.5]; } },
  { name: 'B&W Contrast', swatch: 'linear-gradient(90deg,#000,#fff)', fn: (r, g, b) => { const y = scurve(luma(r, g, b), 1.3); return [y, y, y]; } },
  { name: 'Faded Matte', swatch: 'linear-gradient(90deg,#4a4a52,#d8d2c8)', fn: (r, g, b) => [lift(r, 0.12) * 0.92 + 0.03, lift(g, 0.11) * 0.92 + 0.03, lift(b, 0.09) * 0.92 + 0.04] },
];

// Lazy-built so page load isn't blocked; each entry exposes get() -> {size,data}.
function lazy(fn) { let c; return () => (c ||= fn()); }

export const LUT_CATEGORIES = [
  {
    name: 'Conversion · Sony', luts: [
      { name: 'S-Log3 → Rec.709', swatch: 'linear-gradient(90deg,#5a5a5a,#efe7d8)', get: lazy(() => conversion(LOG.slog3)) },
    ],
  },
  {
    name: 'Conversion · Canon', luts: [
      { name: 'C-Log3 → Rec.709', swatch: 'linear-gradient(90deg,#585858,#f0e4d0)', get: lazy(() => conversion(LOG.clog3)) },
      { name: 'C-Log2 → Rec.709', swatch: 'linear-gradient(90deg,#585858,#f0e4d0)', get: lazy(() => conversion(LOG.clog2)) },
    ],
  },
  {
    name: 'Conversion · ARRI', luts: [
      { name: 'LogC3 (EI800) → Rec.709', swatch: 'linear-gradient(90deg,#565656,#e8e0d2)', get: lazy(() => conversion(LOG.logc)) },
    ],
  },
  {
    name: 'Conversion · Panasonic', luts: [
      { name: 'V-Log → Rec.709', swatch: 'linear-gradient(90deg,#555,#e6ddca)', get: lazy(() => conversion(LOG.vlog)) },
    ],
  },
  {
    name: 'Conversion · Fujifilm', luts: [
      { name: 'F-Log → Rec.709', swatch: 'linear-gradient(90deg,#555,#e6ddca)', get: lazy(() => conversion(LOG.flog)) },
    ],
  },
  {
    name: 'Creative', luts: CREATIVE.map((c) => ({ name: c.name, swatch: c.swatch, get: lazy(() => build(17, c.fn)) })),
  },
];

// flat lookup by name (used to resolve a saved grade's lutName)
export function findLut(name) {
  for (const cat of LUT_CATEGORIES) { const l = cat.luts.find((x) => x.name === name); if (l) return l; }
  return null;
}
