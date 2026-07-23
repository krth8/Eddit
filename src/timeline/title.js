// Title/text generator. Renders a title clip's text to a canvas (with the given
// output size) which the compositor draws like any other layer — so titles get
// transforms, fades, dissolves and grading for free. Transparent everywhere
// except the text, so it overlays cleanly.
export function defaultTitle() {
  return { text: 'Title', font: 'Inter, system-ui, sans-serif', weight: 700, size: 0.09,
    color: '#ffffff', align: 'center', x: 0.5, y: 0.5, shadow: true, bg: '#000000', bgOpacity: 0,
    shadowAmt: 0.65, outline: 0, outlineColor: '#000000',
    anim: 'none', animIn: 0.8, animOut: 0.8 };
}

// Curated font stacks — every entry degrades to a same-family generic, so the
// look holds on ChromeOS/Android even when the named font is missing.
export const TITLE_FONTS = [
  { label: 'Sans', css: 'Inter, Roboto, system-ui, sans-serif' },
  { label: 'Serif', css: 'Georgia, "Tinos", "Times New Roman", serif' },
  { label: 'Condensed', css: '"Roboto Condensed", "Arial Narrow", sans-serif' },
  { label: 'Display', css: 'Impact, "Archivo Black", "Arial Black", sans-serif' },
  { label: 'Mono', css: '"JetBrains Mono", "Cousine", "Courier New", monospace' },
  { label: 'Rounded', css: '"Varela Round", "Comfortaa", "Trebuchet MS", sans-serif' },
  { label: 'Script', css: '"Segoe Script", "Dancing Script", "Brush Script MT", cursive' },
];

export const TITLE_ANIMS = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'slide-up', label: 'Slide up' },
  { id: 'slide-down', label: 'Slide down' },
  { id: 'pop', label: 'Pop' },
  { id: 'typewriter', label: 'Typewriter' },
  { id: 'tracking', label: 'Tracking' },
  { id: 'letters-fade', label: 'Letters fade' },
  { id: 'letters-up', label: 'Letters rise' },
  { id: 'letters-pop', label: 'Letters pop' },
];

function hexA(hex, a) {
  const h = (hex || '#000000').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

const cache = new Map(); // key -> {canvas, key}
// time (optional): { tl: secondsIntoClip, dur: clipDuration } — drives the
// animation presets. Omitted (or anim 'none') renders the static title.
export function renderTitleCanvas(t, W, H, time) {
  t = t || defaultTitle();
  const anim = (t.anim && t.anim !== 'none' && time) ? t.anim : null;
  const tq = anim ? Math.round((time.tl || 0) * 60) : -1;   // quantize for the cache
  const key = W + 'x' + H + '|' + tq + '|' + JSON.stringify(t);
  const hit = cache.get('c'); if (hit && hit.key === key) return hit.canvas;
  // reuse ONE scratch canvas — animated titles render every frame, and
  // allocating a fresh full-HD canvas per frame stutters playback. The
  // compositor copies the pixels out immediately, so mutation is safe.
  let cv = cache.get('scratch');
  if (!cv || cv.width !== W || cv.height !== H) {
    cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    cache.set('scratch', cv);
  }
  const cx = cv.getContext('2d');
  cx.setTransform(1, 0, 0, 1, 0, 0);
  cx.clearRect(0, 0, W, H);
  if (t.bg && t.bgOpacity > 0) { cx.fillStyle = hexA(t.bg, t.bgOpacity); cx.fillRect(0, 0, W, H); }
  const size = Math.max(8, (t.size || 0.09) * H);

  // ---- animation params (identity when static) ----
  let alpha = 1, dy = 0, scl = 1, spacing = 0, reveal = 1, perLetter = null;
  if (anim) {
    // dual-handle model: intro runs 0→animIn, text HOLDS static in the middle,
    // outro runs (dur-animOut)→dur. animDur is the legacy single-value fallback.
    const adIn = Math.max(0.05, t.animIn ?? t.animDur ?? 0.8);
    const adOut = Math.max(0.05, t.animOut ?? t.animDur ?? 0.8);
    const lin = (v) => Math.min(1, Math.max(0, v));
    const ip = lin((time.tl ?? 0) / adIn);                        // 0→1 over the intro
    const op = lin(((time.dur ?? 1e9) - (time.tl ?? 0)) / adOut); // 1 until the outro
    const easeOut = (v) => 1 - Math.pow(1 - v, 3);
    const back = (v) => 1 + 2.70158 * Math.pow(v - 1, 3) + 1.70158 * Math.pow(v - 1, 2);
    const ei = easeOut(ip), eo = easeOut(op);
    if (anim === 'fade') alpha = Math.min(ei, eo);
    else if (anim === 'slide-up') { alpha = Math.min(ei, eo); dy = (1 - ei) * size * 1.4; }
    else if (anim === 'slide-down') { alpha = Math.min(ei, eo); dy = -(1 - ei) * size * 1.4; }
    else if (anim === 'pop') { alpha = Math.min(ei, eo); scl = 0.6 + 0.4 * back(ip); }
    else if (anim === 'typewriter') { reveal = ip; alpha = eo; }
    else if (anim === 'tracking') { alpha = Math.min(ei, eo); spacing = (1 - ei) * size * 0.45; }
    else if (anim.startsWith('letters')) perLetter = { ip, op };   // staggered per-char, drawn below
  }

  cx.font = `${t.weight || 700} ${size}px ${t.font || 'Inter, system-ui, sans-serif'}`;
  // the canvas font parser silently REJECTS some family lists, leaving the
  // default 10px font (titles suddenly render tiny). Verify the size took and
  // fall back to a safe family at the SAME size if not.
  const fm = /([\d.]+)px/.exec(cx.font);
  if (!fm || Math.abs(parseFloat(fm[1]) - size) > 1) cx.font = `${t.weight || 700} ${size}px sans-serif`;
  cx.textBaseline = 'middle';
  cx.textAlign = t.align || 'center';
  const x = W * (t.align === 'left' ? 0.06 : t.align === 'right' ? 0.94 : (t.x ?? 0.5));
  const y = H * (t.y ?? 0.5);
  cx.save();
  cx.globalAlpha = alpha;
  if (dy) cx.translate(0, dy);
  if (scl !== 1) { cx.translate(x, y); cx.scale(scl, scl); cx.translate(-x, -y); }
  if (spacing && 'letterSpacing' in cx) cx.letterSpacing = spacing.toFixed(1) + 'px';
  // drop shadow: adjustable strength (legacy bool `shadow` maps to 0.65 / 0)
  const shAmt = typeof t.shadowAmt === 'number' ? t.shadowAmt : (t.shadow !== false ? 0.65 : 0);
  if (shAmt > 0.001) {
    cx.shadowColor = `rgba(0,0,0,${(0.35 + 0.6 * shAmt).toFixed(3)})`;
    cx.shadowBlur = size * (0.06 + 0.3 * shAmt);
    cx.shadowOffsetY = size * 0.09 * shAmt;
  }
  cx.fillStyle = t.color || '#ffffff';
  let lines = String(t.text ?? '').split('\n');
  if (reveal < 1) {   // typewriter: cumulative character reveal across lines
    let show = Math.ceil(lines.reduce((a, l) => a + l.length, 0) * reveal);
    lines = lines.map((l) => { const s = l.slice(0, Math.max(0, show)); show -= l.length; return s; });
  }
  const lh = size * 1.18;
  const yOf = (i) => y + (i - (lines.length - 1) / 2) * lh;
  const hasOutline = (t.outline || 0) > 0.001;
  if (hasOutline) {
    cx.lineWidth = Math.max(1, t.outline * size);
    cx.strokeStyle = t.outlineColor || '#000000';
    cx.lineJoin = 'round';
  }
  if (perLetter) {
    // staggered per-character: letter k's window slides across the SAME
    // in/hold/out range — first letters enter first, last letters leave first
    const q = 0.45;   // fraction of the intro/outro each letter animates for
    const easeOutF = (v) => 1 - Math.pow(1 - v, 3);
    const backF = (v) => 1 + 2.70158 * Math.pow(v - 1, 3) + 1.70158 * Math.pow(v - 1, 2);
    const lin2 = (v) => Math.min(1, Math.max(0, v));
    const N = Math.max(1, lines.reduce((a, l) => a + l.length, 0));
    cx.textAlign = 'left';
    let k = 0;
    lines.forEach((ln, i) => {
      const ly = yOf(i);
      const lw = cx.measureText(ln).width;
      let px = t.align === 'left' ? x : t.align === 'right' ? x - lw : x - lw / 2;
      for (const ch of ln) {
        const w = cx.measureText(ch).width;
        const li = lin2((perLetter.ip - (N > 1 ? (k / (N - 1)) * (1 - q) : 0)) / q);
        const lo = lin2((perLetter.op - (N > 1 ? ((N - 1 - k) / (N - 1)) * (1 - q) : 0)) / q);
        k++;
        const aL = easeOutF(li) * easeOutF(lo);
        if (aL > 0.002 && ch !== ' ') {
          let dyL = 0, scL = 1;
          if (anim === 'letters-up') dyL = (1 - easeOutF(li)) * size * 0.8;
          else if (anim === 'letters-pop') scL = Math.max(0.05, 0.3 + 0.7 * backF(li));
          cx.save();
          cx.globalAlpha = alpha * aL;
          const cxx = px + w / 2;
          cx.translate(cxx, ly + dyL);
          if (scL !== 1) cx.scale(scL, scL);
          cx.translate(-cxx, -ly);
          if (hasOutline) cx.strokeText(ch, px, ly);
          cx.fillText(ch, px, ly);
          cx.restore();
        }
        px += w;
      }
    });
  } else {
    if (hasOutline) lines.forEach((ln, i) => cx.strokeText(ln, x, yOf(i)));
    lines.forEach((ln, i) => cx.fillText(ln, x, yOf(i)));
  }
  cx.restore();
  cache.set('c', { canvas: cv, key });
  return cv;
}
