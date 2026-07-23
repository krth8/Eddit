// Touch-friendly slider layer. On touch devices every range input becomes a
// fat, tap-anywhere track: press or drag anywhere along the bar and the value
// follows the finger (no need to grab the tiny native thumb). Every slider row
// also gets a reset-to-default button. A CSS `--pct` variable drives the fill.
import { clamp } from './util.js';

export function initSliders() {
  // tap / drag anywhere along a range (capture so we pre-empt the native thumb)
  document.addEventListener('pointerdown', onPointerDown, true);
  // keep the fill variable in sync on every value change (native drag, keys, us)
  document.addEventListener('input', (e) => { if (isRange(e.target)) setFill(e.target); }, true);
  // decorate rows as they appear (inspector / color panels re-render often).
  // The observer must ignore the constant text-node churn of playback (timecode
  // and label updates are childList mutations too) — reacting to every one ran
  // two document-wide querySelectorAlls per frame. Only added ELEMENTS can
  // contain new slider rows, and a trailing debounce coalesces re-render bursts.
  const scan = () => { document.querySelectorAll('.slider-row:not([data-enh])').forEach(decorate); updateFills(); };
  scan();
  let scanT = 0;
  new MutationObserver((muts) => {
    let hasEl = false;
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { hasEl = true; break; }
    if (!hasEl) return;
    clearTimeout(scanT); scanT = setTimeout(scan, 60);
  }).observe(document.body, { childList: true, subtree: true });
}

const isTouch = () => document.documentElement.hasAttribute('data-touch');
// touch drags are geared down for fine control (mouse keeps 1:1 via the thumb)
export const TOUCH_GAIN = 0.25;
const isRange = (n) => n && n.tagName === 'INPUT' && n.type === 'range';

function setFill(input) {
  const min = parseFloat(input.min) || 0;
  const max = parseFloat(input.max); const mx = Number.isFinite(max) ? max : 100;
  const v = parseFloat(input.value) || 0;
  const pct = ((v - min) / ((mx - min) || 1)) * 100;
  input.style.setProperty('--pct', clamp(pct, 0, 100).toFixed(1) + '%');
}

// refresh fills for all ranges (call after programmatic value syncs)
export function updateFills(root = document) { root.querySelectorAll('input[type=range]').forEach(setFill); }

const RESET_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/></svg>';

function decorate(row) {
  row.setAttribute('data-enh', '1');
  const input = row.querySelector('input[type=range]');
  if (!input) return;
  setFill(input);
  if (row.querySelector('.sld-reset') || row.hasAttribute('data-noreset')) return;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'sld-reset'; btn.title = 'Reset to default'; btn.setAttribute('aria-label', 'Reset to default');
  btn.innerHTML = RESET_SVG;
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const def = input.getAttribute('data-default');
    input.value = def != null ? def : input.defaultValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setFill(input);
  });
  row.appendChild(btn);
}

function onPointerDown(e) {
  if (!isTouch()) return;
  // Drive from the ROW, not the input. On touch the input is pointer-events:none
  // so the native range can never snap its value to the touch point — the whole
  // interaction is relative and owned here.
  const row = e.target.closest?.('.slider-row');
  if (!row || e.target.closest('.sld-reset') || e.target.closest('label')) return;
  const input = row.querySelector('input[type=range]');
  if (!input || input.disabled) return;
  // DIRECTIONAL LOCK: don't grab the gesture yet. Decide on the first move —
  // a mostly-horizontal drag adjusts the slider (relative, no snap); a
  // mostly-vertical drag is left to the browser so the drawer scrolls. This is
  // why the row is touch-action:pan-y, not none.
  const r = input.getBoundingClientRect();
  const min = parseFloat(input.min) || 0;
  const max = parseFloat(input.max); const mx = Number.isFinite(max) ? max : 100;
  const range = (mx - min) || 1;
  const startX = e.clientX, startY = e.clientY;
  const startVal = parseFloat(input.value) || 0;
  const width = Math.max(1, r.width);
  let mode = 0; // 0 = undecided, 1 = horizontal (slider), -1 = vertical (scroll)
  const mv = (ev) => {
    if (mode === 0) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      if (Math.abs(dx) >= Math.abs(dy)) { mode = 1; try { row.setPointerCapture(e.pointerId); } catch {} }
      else { mode = -1; cleanup(); return; }   // hand the gesture back for scrolling
    }
    // quarter-speed gearing: 1cm of finger ≈ 0.25cm of value travel, so colour
    // moves stay gentle — repeat strokes to cover big distances (drag is relative)
    if (mode === 1) { if (ev.cancelable) ev.preventDefault(); apply(input, startVal + ((ev.clientX - startX) / width) * range * TOUCH_GAIN, min, mx); }
  };
  const cleanup = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); };
  const up = () => cleanup();
  document.addEventListener('pointermove', mv, { passive: false });
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

function apply(input, value, min, mx) {
  const step = parseFloat(input.step) || 0.01;
  let v = clamp(Math.round(value / step) * step, min, mx);
  const decimals = (String(step).split('.')[1] || '').length;
  const next = decimals ? v.toFixed(decimals) : String(v);
  if (next === input.value) return;
  input.value = next;
  setFill(input);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
