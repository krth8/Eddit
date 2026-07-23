// Small shared helpers.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const el = (id) => document.getElementById(id);

let uidN = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${(uidN++).toString(36)}`;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// seconds -> HH:MM:SS.ff  (ff = hundredths)
export function fmtTC(sec, fps = 30) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec - Math.floor(sec)) * 100);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(f)}`;
}

export function fmtShort(sec) {
  if (!isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Evaluate a curve through control points at x: cubic Hermite with Catmull-Rom
// tangents, so dragging a point bends the whole curve smoothly (bezier-style)
// instead of flattening at every control point. Clamped to 0..1.
export function curveEval(ptsIn, x) {
  const pts = [...ptsIn].sort((a, b) => a.x - b.x);
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  let i = 1; while (pts[i].x < x) i++;
  const p0 = pts[i - 1], p1 = pts[i];
  const dx = Math.max(1e-6, p1.x - p0.x);
  const slope = (a, b) => (b.y - a.y) / Math.max(1e-6, b.x - a.x);
  const m0 = i > 1 ? slope(pts[i - 2], p1) : slope(p0, p1);
  const m1 = i < pts.length - 1 ? slope(p0, pts[i + 1]) : slope(p0, p1);
  const t = (x - p0.x) / dx, t2 = t * t, t3 = t2 * t;
  const y = (2 * t3 - 3 * t2 + 1) * p0.y + (t3 - 2 * t2 + t) * dx * m0
          + (-2 * t3 + 3 * t2) * p1.y + (t3 - t2) * dx * m1;
  return clamp(y, 0, 1);
}

let toastT;
export function toast(msg, isErr = false, ms = 2600) {
  const t = el('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms);
}

// tiny pub/sub bus
export function makeBus() {
  const map = new Map();
  return {
    on(ev, fn) { (map.get(ev) || map.set(ev, new Set()).get(ev)).add(fn); return () => map.get(ev)?.delete(fn); },
    emit(ev, ...a) { map.get(ev)?.forEach((fn) => fn(...a)); },
  };
}
