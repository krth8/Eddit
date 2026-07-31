// Color tab: input transform, color wheels (lift/gamma/gain/offset), primary
// sliders, curves editor, and LUTs (bundled + load from disk).
import { state, defaultGrade, isGraded, videoProgram, programAt, bus, getMedia } from '../state.js';
import { isMcraw } from '../media/mcraw.js';
import { el, $$, clamp, toast, fmtShort, curveEval } from '../util.js';
import { parseCube } from '../gpu/lut.js';
import { LUT_CATEGORIES, findLut, addUserLut, USER_LUTS } from '../luts.js';
import { kvGet, kvSet } from '../store.js';
import { updateFills, TOUCH_GAIN } from '../slider.js';
import { toggleSheet } from '../layout.js';

let engine = null;
let curveCh = 'rgb';
// grade keys driven by an a_<key> range input (Adjust + FX panels)
const SLIDER_KEYS = ['exposure', 'contrast', 'saturation', 'temp', 'tint', 'pivot',
  'toneSh', 'toneHi', 'toneMap',
  'rawExposure', 'rawTemp', 'rawTint',
  'vignette', 'vignetteSize', 'vignetteFeather', 'glow', 'glowThreshold', 'glowRadius',
  'distort', 'distortScale', 'distortSpeed', 'wiggle', 'wiggleFreq'];
// develop settings live with the SOURCE clip — they never travel with
// creative grades (copy/paste/apply-to-all/presets)
const RAW_KEYS = ['rawExposure', 'rawTemp', 'rawTint'];
const pickRaw = (g) => { const o = {}; for (const k of RAW_KEYS) o[k] = g?.[k] || 0; return o; };
let gradeClipboard = null;   // copied grade (survives clip switches, not reloads)
// strip visibility (persisted so the layout survives reloads)
let showThumbs = localStorage.getItem('eddit.colorThumbs') !== '0';
let showMini = localStorage.getItem('eddit.colorMini') !== '0';

export function initColor(eng) {
  engine = eng;

  // sub-tabs (data-driven: each panel carries a matching data-cs)
  $$('#colorSub button').forEach((b) => b.onclick = () => {
    $$('#colorSub button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    $$('.color-tools').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.cs !== b.dataset.cs));
  });

  // HSL curves (hue-vs-hue / sat / lum sub-modes)
  buildHslRows();
  $$('#hslMode button').forEach((b) => b.onclick = () => {
    $$('#hslMode button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); hslMode = b.dataset.m; syncHsl();
  });
  el('resetHsl').onclick = () => { const g = grade(); if (!g) return; ensureHsl(g); g[HSL_KEYS[hslMode]] = [0, 0, 0, 0, 0, 0, 0, 0]; syncHsl(); commit(); };

  // secondary mask (qualifier + window)
  initMask();

  // FX accordion — headers fold each effect; active effects auto-open
  $$('#csFx .card[data-fx]').forEach((card) => {
    card.classList.add('closed');
    card.querySelector('h3').onclick = () => card.classList.toggle('closed');
  });

  // input transform
  el('inputTransform').onchange = (e) => { const g = grade(); if (g) { g.inputTransform = e.target.value; commit(); } };

  // RAW develop — back to as-shot metadata
  if (el('rawAsShot')) el('rawAsShot').onclick = () => {
    const g = grade(); if (!g) return;
    for (const k of RAW_KEYS) g[k] = 0;
    syncUI(true); commit();
  };

  // adjust + fx sliders
  for (const key of SLIDER_KEYS) {
    const inp = el('a_' + key);
    inp.oninput = () => {
      const g = grade(); if (!g) return;
      g[key] = parseFloat(inp.value);
      inp.nextElementSibling.textContent = g[key].toFixed(2);
      commit();
    };
  }

  // color wheels
  $$('.wheel-pad').forEach((pad) => setupWheel(pad));
  $$('.master').forEach((m) => m.oninput = () => {
    const g = grade(); if (!g) return;
    ensureWheels(g);
    g.wheels[m.dataset.master].m = parseFloat(m.value);
    recomposeWheel(g, m.dataset.master); commit();
  });

  // curves
  $$('#curveCh button').forEach((b) => b.onclick = () => {
    $$('#curveCh button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); curveCh = b.dataset.ch; drawCurve();
  });
  el('resetCurve').onclick = () => { const g = grade(); if (!g) return; g.curves[curveCh] = [{ x: 0, y: 0 }, { x: 1, y: 1 }]; drawCurve(); commit(); };
  setupCurveCanvas();

  // LUTs
  renderLutList();
  el('lutMix').oninput = () => { const g = grade(); if (!g) return; g.lutMix = parseFloat(el('lutMix').value); commit(); };
  el('loadLut').onclick = () => el('lutFile').click();
  el('lutFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const lut = parseCube(await f.text());
      const name = f.name.replace(/\.cube$/i, '');
      // register + persist: loaded LUTs become part of the library ("My LUTs")
      // and are usable everywhere, including as a thumbnail look
      addUserLut(name, lut);
      persistUserLuts();
      bus.emit('luts:changed');
      const g = grade();
      if (g) { g.lut = lut; g.lutName = name; commit(); }
      renderLutList();
      toast('LUT added to My LUTs: ' + name);
    } catch (err) { toast('LUT error: ' + err.message, true); }
    e.target.value = '';
  };
  // restore persisted user LUTs + grade presets
  (async () => {
    try {
      const saved = (await kvGet('userLuts')) || [];
      for (const u of saved) if (u?.name && u?.lut?.size) addUserLut(u.name, u.lut);
      if (saved.length) { bus.emit('luts:changed'); renderLutList(); }
    } catch {}
    try { gradePresets = (await kvGet('gradePresets')) || []; } catch {}
    renderPresets();
  })();
  if (el('presetSave')) el('presetSave').onclick = savePreset;

  el('cResetGrade').onclick = () => {
    if (!state.selectedClipId) return;
    state.grades[state.selectedClipId] = defaultGrade();
    syncUI(); commit();
  };

  // grade clipboard + apply-to-all + preview bypass
  const cc = el('cCopy');
  if (cc) cc.onclick = () => {
    const g = grade(); if (!g) return toast('Select a clip first', true);
    gradeClipboard = structuredClone(g); toast('Grade copied');
  };
  const cp = el('cPaste');
  if (cp) cp.onclick = () => {
    if (!state.selectedClipId || !grade()) return toast('Select a clip first', true);
    if (!gradeClipboard) return toast('Nothing copied yet', true);
    state.grades[state.selectedClipId] = { ...structuredClone(gradeClipboard), ...pickRaw(grade()) };
    syncUI(); commit(); toast('Grade pasted');
  };
  const ca = el('cAll');
  if (ca) ca.onclick = () => {
    const g = grade(); if (!g) return toast('Select a clip first', true);
    const ids = new Set();
    for (const seg of videoProgram()) if (seg.clip.id !== state.selectedClipId) ids.add(seg.clip.id);
    for (const id of ids) state.grades[id] = { ...structuredClone(g), ...pickRaw(state.grades[id]) };
    commit(); toast(ids.size ? `Grade applied to ${ids.size} other clip${ids.size === 1 ? '' : 's'}` : 'No other clips');
  };
  const cb = el('cBypass');
  if (cb) cb.onclick = () => {
    state.gradeBypass = !state.gradeBypass;
    cb.classList.toggle('on', state.gradeBypass);
    el('eBypass')?.classList.toggle('on', state.gradeBypass);   // Edit-page twin
    engine.markGradeDirty();
  };

  // thumbnail-strip / mini-timeline visibility toggles
  const applyStripView = () => {
    el('cThumbsWrap').classList.toggle('hidden', !showThumbs);
    el('cMiniWrap').classList.toggle('hidden', !showMini);
    el('cThumbsBtn').classList.toggle('on', showThumbs);
    el('cMiniBtn').classList.toggle('on', showMini);
    renderStrip();
  };
  el('cThumbsBtn').onclick = () => { showThumbs = !showThumbs; localStorage.setItem('eddit.colorThumbs', showThumbs ? '1' : '0'); applyStripView(); };
  el('cMiniBtn').onclick = () => { showMini = !showMini; localStorage.setItem('eddit.colorMini', showMini ? '1' : '0'); applyStripView(); };
  applyStripView();

  // mini timeline: tap or drag anywhere to scrub; selection follows the segment under the pointer
  const mini = el('colorMini');
  const miniSeek = (e) => {
    const segs = videoProgram(); if (!segs.length) return;
    const total = segs.at(-1).end;
    const r = mini.getBoundingClientRect();
    const t = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 0.9995) * total;
    const seg = segs.find((s) => t >= s.start && t < s.end);
    if (seg && seg.clip.id !== state.selectedClipId) { state.selectedClipId = seg.clip.id; bus.emit('clip:selected', seg.clip.id); }
    engine.seek(t);
  };
  mini.addEventListener('pointerdown', (e) => {
    e.preventDefault(); miniSeek(e);
    const mv = (ev) => miniSeek(ev);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });

  // colour-tools sheet trigger (narrow only — replaces the header panels button
  // on the Color tab, sitting in the player row with a colour-wheel icon)
  const tb = el('cToolsBtn');
  if (tb) tb.onclick = () => toggleSheet();

  // ⋯ drawer with the secondary controls (narrow layouts only — on wide the
  // .ctrl-more wrapper renders inline via display:contents)
  const moreBtn = el('cMoreBtn'), more = el('cMore');
  if (moreBtn && more) {
    const close = () => { more.classList.remove('open'); moreBtn.classList.remove('on'); };
    moreBtn.onclick = () => {
      const open = !more.classList.contains('open');
      if (open) { more.classList.add('open'); moreBtn.classList.add('on'); } else close();
    };
    document.addEventListener('pointerdown', (e) => {
      if (more.classList.contains('open') && !more.contains(e.target) && !moreBtn.contains(e.target)) close();
    });
    // one-shot actions close the drawer; the view toggles keep it open
    for (const id of ['cCopy', 'cPaste', 'cAll', 'cResetGrade']) el(id)?.addEventListener('click', close);
  }

  bus.on('clip:selected', () => syncUI());
  bus.on('color:enter', () => { autoSelect(); syncUI(true); });
  // playback pauses → the light in-playback sync ends and the controls catch up
  bus.on('play:changed', (p) => { if (!p && state.activeTab === 'color') syncUI(true); });
  // a selection must always exist on the Color tab (deletes, first-added clip…)
  bus.on('timeline:changed', () => {
    if (state.activeTab === 'color' && !grade()) { autoSelect(); syncUI(true); }
  });

  // during playback the graded clip tracks the playhead (Resolve-style);
  // frame:drawn also fires on scrub/seek, which keeps the strip progress live
  let stripT = 0;
  bus.on('frame:drawn', () => {
    if (state.activeTab !== 'color') return;
    // …but NOT while a clip loop is running: the loop is pinned to the selected
    // clip, and re-selecting whatever sits on top mid-loop would move the loop
    // with it and walk off down the timeline.
    if (state.playing && !state.clipLoop) {
      const seg = programAt(state.playhead);
      if (seg && seg.clip.id !== state.selectedClipId) {
        state.selectedClipId = seg.clip.id;
        bus.emit('clip:selected', seg.clip.id);
      }
    }
    // strip/mini-timeline DOM writes don't need every frame — throttle
    const now = performance.now();
    if (now - stripT > (state.playing ? 150 : 40)) { stripT = now; updateStripProgress(); }
  });
}

function grade() { return state.selectedClipId ? state.grades[state.selectedClipId] : null; }
function selMedia() {
  if (!state.selectedClipId) return null;
  for (const tr of state.tracks.video) {
    const c = tr.clips.find((x) => x.id === state.selectedClipId);
    if (c) return getMedia(c.mediaId);
  }
  return null;
}

// the Color tab always grades SOMETHING: with no (valid) selection, pick the
// program clip nearest the playhead — the empty splash is for empty timelines
function autoSelect() {
  if (grade()) return;
  const segs = videoProgram(); if (!segs.length) return;
  let best = segs[0], bd = Infinity;
  for (const s of segs) {
    const d = state.playhead < s.start ? s.start - state.playhead
      : (state.playhead >= s.end ? state.playhead - s.end : 0);
    if (d < bd) { bd = d; best = s; }
  }
  state.selectedClipId = best.clip.id;
  bus.emit('clip:selected', best.clip.id);
}

function commit() {
  engine.markGradeDirty();
  bus.emit('timeline:changed');
  renderStrip();
  updateSubDots();
}

// which sub-sections hold non-neutral values? → activity dots on the sub-tabs
function sectionActivity(g) {
  const d = defaultGrade();
  return {
    wheels: g.inputTransform !== 'none' || ['lift', 'gamma', 'gain', 'offset'].some((k) => (g[k] || []).some((v) => Math.abs(v) > 1e-4)),
    adjust: ['exposure', 'contrast', 'saturation', 'temp', 'tint', 'pivot', 'toneSh', 'toneHi', 'toneMap'].some((k) => Math.abs((g[k] ?? d[k]) - d[k]) > 1e-4),
    raw: RAW_KEYS.some((k) => Math.abs(g[k] ?? 0) > 1e-4),
    curves: ['rgb', 'r', 'g', 'b'].some((ch) => { const c = g.curves?.[ch]; return c && (c.length !== 2 || c[0].x !== 0 || c[0].y !== 0 || c[1].x !== 1 || c[1].y !== 1); }),
    hsl: [...(g.hsl || []), ...(g.hslHue || []), ...(g.hslLum || [])].some((v) => Math.abs(v) > 1e-4),
    mask: !!(g.maskQ?.on || (g.maskW?.shape && g.maskW.shape !== 'off')),
    luts: !!g.lut,
    fx: ['vignette', 'glow', 'distort', 'wiggle'].some((k) => (g[k] || 0) > 1e-4),
  };
}
function updateSubDots() {
  const g = grade();
  const act = g ? sectionActivity(g) : {};
  $$('#colorSub button').forEach((b) => b.classList.toggle('hasval', !!act[b.dataset.cs]));
}

function ensureWheels(g) {
  if (!g.wheels) g.wheels = { lift: { x: 0, y: 0, m: 0 }, gamma: { x: 0, y: 0, m: 0 }, gain: { x: 0, y: 0, m: 0 }, offset: { x: 0, y: 0, m: 0 } };
}

// map wheel (x,y in -1..1) + master to an RGB 3-vector
function recomposeWheel(g, name) {
  ensureWheels(g);
  const w = g.wheels[name];
  const strength = name === 'offset' ? 0.25 : 0.3;
  const ang = Math.atan2(w.y, w.x);
  const rad = Math.min(1, Math.hypot(w.x, w.y));
  const aR = -Math.PI / 2, aG = aR + (2 * Math.PI) / 3, aB = aR + (4 * Math.PI) / 3;
  const dR = rad * Math.cos(ang - aR) * strength;
  const dG = rad * Math.cos(ang - aG) * strength;
  const dB = rad * Math.cos(ang - aB) * strength;
  g[name] = [w.m + dR, w.m + dG, w.m + dB];
}

function setupWheel(pad) {
  const name = pad.dataset.wheel;
  const knob = pad.querySelector('.knob');
  const setXY = (g, x, y) => {
    const d = Math.hypot(x, y); if (d > 1) { x /= d; y /= d; }
    g.wheels[name].x = x; g.wheels[name].y = y;
    knob.style.left = (x * 0.5 + 0.5) * 100 + '%';
    knob.style.top = (y * 0.5 + 0.5) * 100 + '%';
    recomposeWheel(g, name); commit();
  };
  const reset = () => {
    const g = grade(); if (!g) return; ensureWheels(g);
    g.wheels[name] = { x: 0, y: 0, m: 0 }; g[name] = [0, 0, 0];
    knob.style.left = '50%'; knob.style.top = '50%';
    const master = pad.parentElement.querySelector('.master'); if (master) { master.value = 0; updateFills(pad.parentElement); }
    commit();
  };
  let lastTap = 0;
  pad.addEventListener('pointerdown', (e) => {
    const g = grade(); if (!g) return;
    ensureWheels(g);
    // touch: RELATIVE drag (no snap-to-finger) + double-tap to reset —
    // matches the b33 slider philosophy. Mouse keeps absolute positioning.
    const touch = e.pointerType === 'touch';
    if (touch) {
      const now = performance.now();
      if (now - lastTap < 350) { lastTap = 0; reset(); return; }
      lastTap = now;
    }
    const r = pad.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    const w = g.wheels[name], wx0 = w.x, wy0 = w.y;
    const move = (ev) => {
      const gg = grade(); if (!gg) return; ensureWheels(gg);
      // touch: geared-down relative drag (TOUCH_GAIN) so colour moves stay gentle
      if (touch) setXY(gg, wx0 + (ev.clientX - x0) / r.width * 2 * TOUCH_GAIN, wy0 + (ev.clientY - y0) / r.height * 2 * TOUCH_GAIN);
      else setXY(gg, (ev.clientX - r.left) / r.width * 2 - 1, (ev.clientY - r.top) / r.height * 2 - 1);
    };
    if (!touch) move(e);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });
  pad.addEventListener('dblclick', reset);
  // the reset icon next to the wheel label
  const rb = pad.parentElement.querySelector('.wheel-reset');
  if (rb) rb.onclick = reset;
}

// ---- curves canvas ----
function setupCurveCanvas() {
  const cv = el('curveCanvas');
  let drag = null;
  const pt = (e) => { const r = cv.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp(1 - (e.clientY - r.top) / r.height, 0, 1) }; };
  cv.addEventListener('pointerdown', (e) => {
    const g = grade(); if (!g) return;
    const pts = g.curves[curveCh]; const p = pt(e);
    let near = -1, best = 0.04;
    pts.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < best) { best = d; near = i; } });
    if (e.button === 2 || (e.shiftKey && near > 0 && near < pts.length - 1)) {
      if (near > 0 && near < pts.length - 1) { pts.splice(near, 1); drawCurve(); commit(); }
      return;
    }
    if (near < 0) { pts.push({ ...p }); pts.sort((a, b) => a.x - b.x); near = pts.findIndex((q) => q.x === p.x); }
    drag = near;
    const mv = (ev) => {
      const q = pt(ev); const isEnd = drag === 0 || drag === pts.length - 1;
      pts[drag].y = q.y; if (!isEnd) pts[drag].x = clamp(q.x, pts[drag - 1].x + 0.01, pts[drag + 1].x - 0.01);
      drawCurve(); commit();
    };
    const up = () => { drag = null; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  drawCurve();
}

function drawCurve() {
  const cv = el('curveCanvas'); const cx = cv.getContext('2d');
  // back the canvas at devicePixelRatio × its CSS size so it stays sharp in
  // wide drawers (it was a fixed 300² regardless of display width)
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rw = Math.round((cv.getBoundingClientRect().width || 300) * dpr);
  if (rw > 0 && cv.width !== rw) { cv.width = rw; cv.height = rw; }
  const W = cv.width, H = cv.height, sc = W / 300;
  cx.clearRect(0, 0, W, H);
  cx.strokeStyle = 'rgba(255,255,255,.08)'; cx.lineWidth = sc;
  for (let i = 1; i < 4; i++) { const p = i / 4; cx.beginPath(); cx.moveTo(p * W, 0); cx.lineTo(p * W, H); cx.moveTo(0, p * H); cx.lineTo(W, p * H); cx.stroke(); }
  // dashed identity diagonal as a visual reference for the applied curve
  cx.strokeStyle = 'rgba(255,255,255,.12)'; cx.setLineDash([4 * sc, 4 * sc]);
  cx.beginPath(); cx.moveTo(0, H); cx.lineTo(W, 0); cx.stroke(); cx.setLineDash([]);
  const g = grade();
  const pts = g ? g.curves[curveCh] : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const col = { rgb: '#f5f5f7', r: '#ff8a7a', g: '#8ef07a', b: '#8aa2ff' }[curveCh];
  cx.strokeStyle = col; cx.lineWidth = 2 * sc; cx.beginPath();
  for (let px = 0; px <= W; px++) { const y = curveEval(pts, px / W); const cy = (1 - y) * H; px === 0 ? cx.moveTo(px, cy) : cx.lineTo(px, cy); }
  cx.stroke();
  cx.fillStyle = col;
  for (const p of pts) { cx.beginPath(); cx.arc(p.x * W, (1 - p.y) * H, 4 * sc, 0, 7); cx.fill(); }
}

// ---- user LUT persistence + grade presets ----
function persistUserLuts() {
  kvSet('userLuts', USER_LUTS.luts.map((l) => { try { return { name: l.name, lut: l.get() }; } catch { return null; } }).filter(Boolean)).catch(() => {});
}

let gradePresets = [];
function savePreset() {
  const g = grade(); if (!g) return toast('Select a clip first', true);
  const name = (prompt('Preset name', 'My look') || '').trim();
  if (!name) return;
  const snap = structuredClone({ ...g, lut: null, rawExposure: 0, rawTemp: 0, rawTint: 0 });   // lutName re-resolves on apply
  const i = gradePresets.findIndex((p) => p.name === name);
  if (i >= 0) gradePresets[i] = { name, grade: snap }; else gradePresets.push({ name, grade: snap });
  kvSet('gradePresets', gradePresets).catch(() => {});
  renderPresets();
  toast('Preset saved: ' + name);
}
function applyPreset(p) {
  if (!state.selectedClipId || !grade()) return toast('Select a clip first', true);
  const ng = { ...structuredClone(p.grade), ...pickRaw(grade()) };
  if (ng.lutName) { const l = findLut(ng.lutName); if (l) { try { ng.lut = l.get(); } catch {} } }
  state.grades[state.selectedClipId] = ng;
  syncUI(); commit();
  toast(`Preset "${p.name}" applied`);
}
function renderPresets() {
  const box = el('presetList'); if (!box) return;
  box.innerHTML = '';
  if (!gradePresets.length) { box.innerHTML = '<div class="statline">Save a grade you like and apply it to any clip.</div>'; return; }
  for (const p of gradePresets) {
    const row = document.createElement('div');
    row.className = 'lut-item';
    row.innerHTML = `<span class="lsw" style="background:linear-gradient(90deg,#5fd598,#2ba7d8)"></span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${p.name}</span><span class="preset-del" title="Delete preset">✕</span>`;
    row.onclick = () => applyPreset(p);
    row.querySelector('.preset-del').onclick = (e) => {
      e.stopPropagation();
      gradePresets = gradePresets.filter((x) => x !== p);
      kvSet('gradePresets', gradePresets).catch(() => {});
      renderPresets();
    };
    box.appendChild(row);
  }
}

// ---- categorised LUT browser (Resolve-style folders) ----
const openCats = new Set(['My LUTs', 'Conversion · Sony']);
function renderLutList() {
  const list = el('lutList'); list.innerHTML = '';
  const g = grade();

  const none = document.createElement('div');
  none.className = 'lut-item' + (g && !g.lut ? ' on' : '');
  none.innerHTML = `<span class="lsw" style="background:#26262a"></span>None`;
  none.onclick = () => { const gg = grade(); if (!gg) return toast('Select a clip first', true); gg.lut = null; gg.lutName = null; renderLutList(); commit(); };
  list.appendChild(none);

  // a category for any loaded-from-disk LUT
  const cats = [...LUT_CATEGORIES];
  if (g?.lut && g.lutName && !findLut(g.lutName)) cats.unshift({ name: 'Custom', luts: [{ name: g.lutName, swatch: 'linear-gradient(90deg,#5fd598,#8aa2ff)', get: () => g.lut }] });

  for (const cat of cats) {
    if (!cat.luts.length) continue;   // e.g. "My LUTs" before anything is loaded
    const open = openCats.has(cat.name);
    const head = document.createElement('div');
    head.className = 'lut-cat';
    head.innerHTML = `<span class="caret">${open ? '▾' : '▸'}</span>${cat.name}<span class="bn">${cat.luts.length}</span>`;
    head.onclick = () => { open ? openCats.delete(cat.name) : openCats.add(cat.name); renderLutList(); };
    list.appendChild(head);
    if (!open) continue;
    for (const it of cat.luts) {
      const on = g?.lutName === it.name;
      const row = document.createElement('div');
      row.className = 'lut-item sub' + (on ? ' on' : '');
      row.innerHTML = `<span class="lsw" style="background:${it.swatch}"></span>${it.name}`;
      row.onclick = () => {
        const gg = grade(); if (!gg) return toast('Select a clip first', true);
        try { gg.lut = it.get(); gg.lutName = it.name; } catch (e) { return toast('LUT error: ' + e.message, true); }
        renderLutList(); commit();
      };
      list.appendChild(row);
    }
  }
}

// ---- HSL curves: 8 hue bands × three modes (hue shift / sat / lum) ----
const HSL_BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Purple', 'Magenta'];
const HSL_KEYS = { hue: 'hslHue', sat: 'hsl', lum: 'hslLum' };
let hslMode = 'sat';
function ensureHsl(g) {
  for (const k of Object.values(HSL_KEYS)) if (!Array.isArray(g[k]) || g[k].length !== 8) g[k] = [0, 0, 0, 0, 0, 0, 0, 0];
}
function buildHslRows() {
  const host = el('hslRows'); if (!host) return;
  host.innerHTML = '';
  HSL_BANDS.forEach((name, i) => {
    const hue = ((i + 0.5) / 8) * 360;
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML = `<label><span class="hsl-sw" style="background:hsl(${hue}deg 80% 55%)"></span>${name}</label>` +
      `<input type="range" class="hsl-in" data-i="${i}" min="-1" max="1" step="0.01" value="0" data-default="0"><span class="val">0.00</span>`;
    const inp = row.querySelector('input');
    inp.oninput = () => {
      const g = grade(); if (!g) return; ensureHsl(g);
      const arr = g[HSL_KEYS[hslMode]];
      arr[i] = parseFloat(inp.value);
      inp.nextElementSibling.textContent = arr[i].toFixed(2);
      commit();
    };
    host.appendChild(row);
  });
}
function syncHsl() {
  const g = grade(); if (g) ensureHsl(g);
  $$('.hsl-in').forEach((inp) => {
    const i = +inp.dataset.i;
    const v = g ? g[HSL_KEYS[hslMode]][i] : 0;
    inp.value = v; inp.nextElementSibling.textContent = Number(v).toFixed(2);
  });
  updateFills(el('hslRows'));
}

// selection highlight only — no DOM rebuild (the in-playback path)
function updateStripSelection() {
  const strip = el('colorStrip');
  if (strip) for (const d of strip.children) if (d.dataset?.id) d.classList.toggle('on', d.dataset.id === state.selectedClipId);
  const mini = el('colorMini');
  if (mini) for (const b of mini.children) if (b.dataset?.id) b.classList.toggle('on', b.dataset.id === state.selectedClipId);
}

// ---- secondary mask: qualifier eyedrop + window shape ----
function ensureMask(g) {
  if (!g.maskQ) g.maskQ = { on: 0, h: 0, s: 0, y: 0, range: 0.25, soft: 0.12 };
  if (!g.maskW) g.maskW = { shape: 'off', cx: 0.5, cy: 0.5, rx: 0.35, ry: 0.35, feather: 0.2, angle: 0 };
}
let pickArmed = false;

function initMask() {
  if (!el('csMask')) return;
  const bind = (id, obj, key) => {
    const inp = el(id); if (!inp) return;
    inp.oninput = () => {
      const g = grade(); if (!g) return; ensureMask(g);
      g[obj][key] = parseFloat(inp.value);
      inp.nextElementSibling.textContent = (+inp.value).toFixed(2);
      commit();
    };
  };
  bind('mqRange', 'maskQ', 'range'); bind('mqSoft', 'maskQ', 'soft');
  bind('mwRx', 'maskW', 'rx'); bind('mwRy', 'maskW', 'ry');
  bind('mwFeather', 'maskW', 'feather'); bind('mwAngle', 'maskW', 'angle');

  $$('#mwShape button').forEach((b) => b.onclick = () => {
    const g = grade(); if (!g) return toast('Select a clip first', true);
    ensureMask(g);
    g.maskW.shape = b.dataset.shape;
    $$('#mwShape button').forEach((x) => x.classList.toggle('on', x === b));
    commit();
  });
  el('mInvert').onclick = () => {
    const g = grade(); if (!g) return; ensureMask(g);
    g.maskInvert = !g.maskInvert;
    el('mInvert').classList.toggle('on', g.maskInvert);
    commit();
  };
  el('mShow').onclick = () => {
    const g = grade(); if (!g) return; ensureMask(g);
    g.maskShow = !g.maskShow;
    el('mShow').classList.toggle('on', g.maskShow);
    commit();
  };
  el('mReset').onclick = () => {
    const g = grade(); if (!g) return;
    g.maskQ = { on: 0, h: 0, s: 0, y: 0, range: 0.25, soft: 0.12 };
    g.maskW = { shape: 'off', cx: 0.5, cy: 0.5, rx: 0.35, ry: 0.35, feather: 0.2, angle: 0 };
    g.maskInvert = false; g.maskShow = false;
    pickArmed = false; el('mqPick').classList.remove('on');
    syncMask(); commit();
  };
  el('mqPick').onclick = () => {
    if (!grade()) return toast('Select a clip first', true);
    pickArmed = !pickArmed;
    el('mqPick').classList.toggle('on', pickArmed);
    if (pickArmed) toast('Tap the video to pick a colour');
  };

  // canvas interactions: eyedrop tap (armed) or drag-to-move the window
  const cv = el('colorCanvas');
  cv.addEventListener('pointerdown', (e) => {
    const g = grade(); if (!g) return;
    ensureMask(g);
    const r = cv.getBoundingClientRect();
    const u = clamp((e.clientX - r.left) / r.width, 0, 1);
    const v = clamp((e.clientY - r.top) / r.height, 0, 1);
    if (pickArmed) { e.preventDefault(); pickColour(u, v); return; }
    if (g.maskW.shape === 'off') return;
    e.preventDefault();
    const cx0 = g.maskW.cx, cy0 = g.maskW.cy, x0 = e.clientX, y0 = e.clientY;
    const mv = (ev) => {
      g.maskW.cx = clamp(cx0 + (ev.clientX - x0) / r.width, 0, 1);
      g.maskW.cy = clamp(cy0 + (ev.clientY - y0) / r.height, 0, 1);
      engine.markGradeDirty();
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); commit(); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });
}

// sample the UNGRADED frame at (u,v): bypass-draw + read in the same task,
// then store the picked colour as linear hue/sat/luma (the shader's space)
function pickColour(u, v) {
  const g = grade(); if (!g) return;
  const cv = el('colorCanvas');
  const wasBypass = state.gradeBypass;
  state.gradeBypass = true; engine.markGradeDirty(); engine.redraw();
  const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height;
  const x2 = c2.getContext('2d'); x2.drawImage(cv, 0, 0);
  const d = x2.getImageData(Math.min(cv.width - 1, Math.round(u * cv.width)), Math.min(cv.height - 1, Math.round(v * cv.height)), 1, 1).data;
  state.gradeBypass = wasBypass; engine.markGradeDirty(); engine.redraw();
  const lin = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  const R = lin(d[0]), G2 = lin(d[1]), B = lin(d[2]);
  const mx = Math.max(R, G2, B), mn = Math.min(R, G2, B), ch = mx - mn;
  let h = 0;
  if (ch > 1e-4) {
    if (mx === R) h = (G2 - B) / ch;
    else if (mx === G2) h = 2 + (B - R) / ch;
    else h = 4 + (R - G2) / ch;
    h = ((h / 6) % 1 + 1) % 1;
  }
  ensureMask(g);
  g.maskQ.on = 1; g.maskQ.h = h;
  g.maskQ.s = ch / Math.max(mx, 1e-4);
  g.maskQ.y = 0.2126 * R + 0.7152 * G2 + 0.0722 * B;
  pickArmed = false; el('mqPick').classList.remove('on');
  el('mqSwatch').style.background = `rgb(${d[0]},${d[1]},${d[2]})`;
  toast('Colour picked — grade now keys on it');
  commit();
}

function syncMask() {
  const g = grade();
  const q = g?.maskQ || { range: 0.25, soft: 0.12 };
  const w = g?.maskW || { shape: 'off', rx: 0.35, ry: 0.35, feather: 0.2, angle: 0 };
  const set = (id, v) => { const inp = el(id); if (inp) { inp.value = v; inp.nextElementSibling.textContent = (+v).toFixed(2); } };
  set('mqRange', q.range ?? 0.25); set('mqSoft', q.soft ?? 0.12);
  set('mwRx', w.rx ?? 0.35); set('mwRy', w.ry ?? 0.35);
  set('mwFeather', w.feather ?? 0.2); set('mwAngle', w.angle || 0);
  $$('#mwShape button').forEach((b) => b.classList.toggle('on', b.dataset.shape === (w.shape || 'off')));
  el('mInvert')?.classList.toggle('on', !!g?.maskInvert);
  el('mShow')?.classList.toggle('on', !!g?.maskShow);
  const sw = el('mqSwatch');
  if (sw) sw.style.background = g?.maskQ?.on ? `hsl(${Math.round((q.h || 0) * 360)}deg ${Math.round((q.s || 0) * 100)}% ${Math.round(30 + (q.y || 0) * 50)}%)` : '#26262a';
}

// ---- reflect selected clip's grade back into all controls ----
export function syncUI(force) {
  // During playback the selection auto-follows the playhead across cuts; a full
  // control resync (LUT-list + strip DOM rebuilds, slider fills, curve redraw)
  // is a long main-thread task that visibly hitches playback at every cut.
  // Do a light pass instead — the full sync runs on pause / tab enter.
  if (state.playing && !force) { updateSubDots(); updateStripSelection(); return; }
  const g = grade();
  const disabled = !g;
  el('colorEmpty').style.display = disabled ? '' : 'none';
  updateSubDots();
  // RAW develop panel exists only for RAW sources
  const rm = g ? selMedia() : null;
  const isRaw = !!(rm && isMcraw(rm.name));
  const rbtn = el('csRawBtn');
  if (rbtn) {
    rbtn.classList.toggle('hidden', !isRaw);
    if (!isRaw && rbtn.classList.contains('on')) document.querySelector('#colorSub button[data-cs="wheels"]')?.click();
  }
  if (el('rawInfo')) el('rawInfo').textContent = isRaw
    ? [rm.rawIso && ('ISO ' + rm.rawIso), rm.rawShutter && ('1/' + Math.round(1e9 / rm.rawShutter) + ' s')].filter(Boolean).join(' · ')
    : '';
  if (!g) return;
  el('inputTransform').value = g.inputTransform;
  const dflt = defaultGrade();
  for (const key of SLIDER_KEYS) {
    const v = g[key] ?? dflt[key];   // pre-FX grades lack the vignette/glow keys
    const inp = el('a_' + key); inp.value = v; inp.nextElementSibling.textContent = Number(v).toFixed(2);
  }
  ensureWheels(g);
  $$('.wheel-pad').forEach((pad) => {
    const w = g.wheels[pad.dataset.wheel]; const knob = pad.querySelector('.knob');
    knob.style.left = (w.x * 0.5 + 0.5) * 100 + '%'; knob.style.top = (w.y * 0.5 + 0.5) * 100 + '%';
  });
  $$('.master').forEach((m) => m.value = g.wheels[m.dataset.master].m);
  el('lutMix').value = g.lutMix;
  syncHsl();
  syncMask();
  // FX accordion: open + dot the effects this clip actually uses
  $$('#csFx .card[data-fx]').forEach((card) => {
    const on = Math.abs(g[card.dataset.fx] || 0) > 1e-4;
    card.classList.toggle('closed', !on);
    card.classList.toggle('hasval', on);
  });
  updateFills(document.getElementById('color'));
  drawCurve(); renderLutList(); renderStrip();
}

const fmtDur = (s) => s >= 60 ? fmtShort(s) : s.toFixed(1) + 's';

// mini clip strip at the bottom of the Color tab
export function renderStrip() {
  const strip = el('colorStrip'); if (!strip) return;
  strip.innerHTML = '';
  const segs = videoProgram();
  const area = el('cStripArea');
  if (area) area.classList.toggle('hidden', !segs.length || (!showThumbs && !showMini));
  segs.forEach((seg, i) => {
    const c = seg.clip;
    const m = state.media.find((x) => x.id === c.mediaId);
    const graded = isGraded(state.grades[c.id]);
    const name = c.type === 'title' ? (c.title?.text || 'Title') : (m?.name || 'Clip');
    if (i) { const sep = document.createElement('i'); sep.className = 'cs-sep'; strip.appendChild(sep); }
    const d = document.createElement('div');
    d.className = 'cstrip-item' + (c.id === state.selectedClipId ? ' on' : '') + (c.type === 'title' ? ' is-title' : '');
    d.dataset.start = seg.start; d.dataset.end = seg.end; d.dataset.id = c.id;
    if (m?.thumb) d.style.backgroundImage = `url(${m.thumb})`;
    d.title = `${i + 1} · ${name}${graded ? ' — graded' : ''}`;
    d.innerHTML = `<span class="csgi${graded ? ' graded' : ''}"></span>` +
      `<span class="cs-meta"><b class="csn">${i + 1}</b><span class="cs-name"></span><span class="cs-dur">${fmtDur(seg.end - seg.start)}</span></span>` +
      `<span class="csp"></span>`;
    d.querySelector('.cs-name').textContent = name.replace(/\.[a-z0-9]+$/i, '');
    d.onclick = () => { state.selectedClipId = c.id; bus.emit('clip:selected', c.id); engine.seek(seg.start + 0.01); syncUI(); };
    strip.appendChild(d);
  });
  renderMini(segs);
  updateStripProgress();
  // keep the selected thumb in view when playback advances the selection
  const on = strip.querySelector('.cstrip-item.on');
  const sc = strip.parentElement;
  if (on && sc && (on.offsetLeft < sc.scrollLeft || on.offsetLeft + on.offsetWidth > sc.scrollLeft + sc.clientWidth))
    sc.scrollLeft = on.offsetLeft - sc.clientWidth / 2 + on.offsetWidth / 2;
}

// compact program timeline: proportional-width blocks, gaps included, no thumbnails
function renderMini(segs = videoProgram()) {
  const mini = el('colorMini'); if (!mini) return;
  mini.innerHTML = '';
  const total = segs.length ? segs.at(-1).end : 0;
  if (!total) return;
  let cursor = 0;
  segs.forEach((seg, i) => {
    if (seg.start > cursor + 1e-3) {
      const gap = document.createElement('i');
      gap.className = 'cmini-gap';
      gap.style.width = ((seg.start - cursor) / total) * 100 + '%';
      mini.appendChild(gap);
    }
    cursor = seg.end;
    const c = seg.clip;
    const b = document.createElement('div');
    b.className = 'cmini-clip' + (c.id === state.selectedClipId ? ' on' : '') +
      (isGraded(state.grades[c.id]) ? ' graded' : '') + (c.type === 'title' ? ' is-title' : '');
    b.dataset.id = c.id;
    b.style.width = ((seg.end - seg.start) / total) * 100 + '%';
    b.textContent = i + 1;
    mini.appendChild(b);
  });
  const ph = document.createElement('i');
  ph.className = 'cmini-ph'; ph.id = 'cMiniPh';
  mini.appendChild(ph);
}

// thin accent bar showing where the playhead sits inside its clip + mini-timeline playhead
function updateStripProgress() {
  const strip = el('colorStrip'); if (!strip) return;
  for (const d of strip.children) {
    const bar = d.querySelector?.('.csp'); if (!bar) continue;
    const s = +d.dataset.start, e = +d.dataset.end;
    const inside = state.playhead >= s - 0.005 && state.playhead < e;
    bar.style.width = inside ? clamp((state.playhead - s) / Math.max(1e-6, e - s), 0, 1) * 100 + '%' : '0';
  }
  const ph = el('cMiniPh');
  if (ph) {
    const segs = videoProgram();
    const total = segs.length ? segs.at(-1).end : 0;
    ph.style.left = total ? clamp(state.playhead / total, 0, 1) * 100 + '%' : '0%';
  }
}
