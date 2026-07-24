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

// Lazy-built so page load isn't blocked; each entry exposes get() -> {size,data}.
function lazy(fn) { let c; return () => (c ||= fn()); }

// user-loaded .cube files, registered at load and persisted in IndexedDB —
// they appear in the LUT browser and the thumbnail-look picker like any
// bundled conversion. (The old procedural 'Creative' pack is gone: creative
// looks are the user's own grade presets now.)
export const USER_LUTS = { name: 'My LUTs', luts: [] };
export function addUserLut(name, lut) {
  const entry = { name, swatch: 'linear-gradient(90deg,#5fd598,#8aa2ff)', get: () => lut };
  const i = USER_LUTS.luts.findIndex((l) => l.name === name);
  if (i >= 0) USER_LUTS.luts[i] = entry; else USER_LUTS.luts.push(entry);
}

export const LUT_CATEGORIES = [
  USER_LUTS,
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
];

// flat lookup by name (used to resolve a saved grade's lutName)
export function findLut(name) {
  for (const cat of LUT_CATEGORIES) { const l = cat.luts.find((x) => x.name === name); if (l) return l; }
  return null;
}
