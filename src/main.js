// Bootstrap: WebGPU renderer + playback engine + tab wiring + transport + keys.
import { state, bus, timelineDuration, videoProgram, addTitle, toggleMarker, rippleDelete } from './state.js';
import { el, $$, fmtTC, toast } from './util.js';
import { Renderer } from './gpu/renderer.js';
import { Engine } from './timeline/engine.js';
import { initMedia } from './tabs/media.js';
import { saveProject } from './store.js';
import { commit as histCommit, undo, redo, resetHistory, canUndo, canRedo } from './history.js';
import { initLayout, openSheet, closeSheet } from './layout.js';
import { initProjects, bootBrowser } from './projects.js';
import { initSliders } from './slider.js';
import { initColor, syncUI as colorSync, renderStrip } from './tabs/color.js';
import { initExport, refresh as exportRefresh } from './tabs/export.js';
import { initFx } from './tabs/fx.js';
import { initTimeline, render as tlRender, renderPlayhead, renderPool, renderInspector, selectClip, deleteSelected } from './timeline/timeline.js';

const BUILD = "v0.9.0";

// ---- PWA install: surfaced as a button on the Projects landing screen — the
// omnibox hint is easy to miss. beforeinstallprompt can fire before boot()
// finishes, so capture at module scope; it never fires when already installed.
let installEv = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEv = e;
  const b = document.getElementById('pwaInstall');
  if (b && !matchMedia('(display-mode: standalone)').matches) b.hidden = false;
});
window.addEventListener('appinstalled', () => {
  const b = document.getElementById('pwaInstall');
  if (b) b.hidden = true;
  toast('Eddit installed — find it with your apps');
});
const renderer = new Renderer();
let engine;

// ---- on-screen diagnostics (devices without DevTools, e.g. locked Chromebooks) ----
const DIAG = [];
function pushDiag(level, args) {
  const line = `[${level}] ` + args.map((a) => { try { return typeof a === 'string' ? a : (a && a.message) || JSON.stringify(a); } catch { return String(a); } }).join(' ');
  DIAG.push(line); if (DIAG.length > 600) DIAG.shift();
  const ov = document.getElementById('diagOverlay');
  if (ov && !ov.classList.contains('hidden')) renderDiag();
}
for (const lv of ['log', 'warn', 'error']) {
  const orig = console[lv].bind(console);
  console[lv] = (...a) => { try { pushDiag(lv, a); } catch {} orig(...a); };
}
window.addEventListener('error', (e) => pushDiag('error', [`${e.message} @ ${e.filename || ''}:${e.lineno || ''}`]));
window.addEventListener('unhandledrejection', (e) => pushDiag('error', ['unhandledrejection: ' + (e.reason?.message || e.reason)]));
function renderDiag() {
  const pre = document.getElementById('diagLog'); if (!pre) return;
  pre.textContent = DIAG.slice(-400).join('\n') || '(no logs yet — import a clip to capture ffmpeg output)';
  pre.scrollTop = pre.scrollHeight;
}
function openDiag() {
  const b = document.getElementById('diagBuild'); if (b) b.textContent = BUILD;
  const caps = document.getElementById('diagCaps');
  if (caps) caps.textContent = `WebGPU ${renderer.ok ? '✓' : '✗'} · ${window.__eddit?.codecLine || ''} · COI ${self.crossOriginIsolated} · ${navigator.userAgent}`;
  renderDiag();
  document.getElementById('diagOverlay').classList.remove('hidden');
}

async function boot() {
  console.log('%cEddit ' + BUILD, 'color:#5fd598;font-weight:700');
  const bt = el('buildTag'); if (bt) bt.textContent = BUILD;
  const supported = await renderer.init();
  if (!supported) toast('WebGPU not available — use Chrome/Edge 113+ with GPU enabled', true, 6000);

  engine = new Engine(renderer);
  engine.onTick = (ph, dur) => {
    // the timeline lives in the Edit panel — moving its playhead (plus the
    // touch-layout scrollLeft write) is wasted layout work from other tabs;
    // entering Edit re-renders via tlRender() so nothing goes stale
    if (state.activeTab === 'edit') renderPlayhead();
    const tc = `${fmtTC(ph)} / ${fmtTC(dur)}`;
    if (el('eTc')) el('eTc').textContent = tc;
    if (el('cTc')) el('cTc').textContent = state.selectedClipId ? `Clip · ${fmtTC(ph)}` : tc;
  };

  await initMedia(engine);
  initTimeline(engine);
  initColor(engine);
  initExport(engine, renderer);
  initFx(engine);

  setupTabs();
  setupTransport();
  setupTools();
  setupKeys();
  initLayout();
  initSliders();
  // projects browser — reload engine/history/UI after switching projects
  initProjects((proj) => {
    resetHistory();
    if (engine) engine.seek(0);
    renderPool(); tlRender(); renderInspector(); colorSync(); exportRefresh();
  });

  // aspect-true player boxes: size each canvas to the largest project-shaped
  // rect that fits its stage (JS-fit — cq units glitched during playback)
  const fitPlayerBoxes = () => {
    const ar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pvAR')) || 16 / 9;
    $$('canvas.pv-canvas').forEach((cv) => {
      const st = cv.closest('.pv-stage'); if (!st) return;
      const cs = getComputedStyle(st);
      const w = st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (w <= 0 || h <= 0) return;
      const bw = Math.min(w, h * ar);
      cv.style.width = bw.toFixed(1) + 'px';
      cv.style.height = (bw / ar).toFixed(1) + 'px';
    });
  };
  const stageRO = new ResizeObserver(fitPlayerBoxes);
  $$('.pv-stage').forEach((st) => stageRO.observe(st));
  bus.on('project:aspect', fitPlayerBoxes);
  fitPlayerBoxes();

  // (renderPool listens on media:changed — re-rendering it per timeline edit
  // was pure waste and made drags janky)
  bus.on('timeline:changed', exportRefresh);
  bus.on('export:refresh', exportRefresh);

  // "No preview yet" hint only while the timeline is actually empty
  const syncEmptyOverlay = () => {
    const ee = el('editEmpty');
    if (ee) ee.style.display = videoProgram().length ? 'none' : '';
  };
  bus.on('timeline:changed', syncEmptyOverlay);
  bus.on('media:changed', syncEmptyOverlay);

  // landing screen: the Projects overview opens over an EMPTY editor — nothing
  // preloads; a project only loads when the user picks (or creates) one
  resetHistory();
  syncEmptyOverlay();
  bootBrowser().catch(() => {});
  const ib = el('pwaInstall');
  if (ib) ib.onclick = async () => {
    if (!installEv) return;
    installEv.prompt();
    try { await installEv.userChoice; } catch {}
    installEv = null; ib.hidden = true;
  };
  let saveT, histT;
  const autosave = () => { clearTimeout(saveT); saveT = setTimeout(() => saveProject(state).catch(() => {}), 900); };
  bus.on('timeline:changed', autosave);
  bus.on('media:changed', autosave);
  // flush the debounced save the moment the app is backgrounded/killed — a
  // hard-stopped PWA otherwise loses the last ~900ms of state (e.g. proxyKeys)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveT) { clearTimeout(saveT); saveT = null; saveProject(state).catch(() => {}); }
  });
  // undo/redo: snapshot once a burst of edits settles
  bus.on('timeline:changed', () => { clearTimeout(histT); histT = setTimeout(histCommit, 450); });
  bus.on('history:changed', updateUndoButtons);
  // (no auto-opening inspector sheet on clip select — it's behind the toolbar
  // settings icon on narrow layouts instead)
  // (colour-tab sync on clip:selected is registered inside initColor — a second
  // registration here doubled the full-UI resync at every playback cut)
  bus.on('play:changed', (playing) => {
    $$('.btn-tp.play').forEach((b) => b.classList.toggle('playing', playing));
  });

  bus.on('frame:drawn', onFrameDrawn);
  window.__eddit = { ...window.__eddit, renderer, engine, state, bus };

  // diagnostics overlay (tap the ffmpeg pill or the build tag)
  if (el('brandLogo')) el('brandLogo').onclick = openDiag;   // quiet diagnostics entry
  el('diagClose').onclick = () => el('diagOverlay').classList.add('hidden');
  el('diagClear').onclick = () => { DIAG.length = 0; renderDiag(); };
  el('diagCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(DIAG.join('\n')); toast('Diagnostics copied'); }
    catch { const pre = el('diagLog'); const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Selected — long-press → Copy'); }
  };
  console.log('Eddit', BUILD, '· UA', navigator.userAgent, '· COI', self.crossOriginIsolated);
}

function activeCanvas() {
  if (state.activeTab === 'color') return el('colorCanvas');
  if (state.activeTab === 'edit') return el('editCanvas');
  return null;
}

function setupTabs() {
  const tabs = el('tabs'), ind = el('tabInd');
  const move = () => { const b = tabs.querySelector('.main-tab.active'); ind.style.left = b.offsetLeft + 'px'; ind.style.width = b.offsetWidth + 'px'; };
  document.documentElement.setAttribute('data-tab', state.activeTab || 'media');
  $$('.main-tab', tabs).forEach((b) => b.onclick = () => {
    $$('.main-tab', tabs).forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); move();
    $$('.tab-panel').forEach((p) => p.classList.remove('active'));
    el(b.dataset.tab).classList.add('active');
    state.activeTab = b.dataset.tab;
    document.documentElement.setAttribute('data-tab', b.dataset.tab);
    const c = activeCanvas();
    if (c && engine) engine.setCanvas(c);
    if (b.dataset.tab === 'edit') { renderPool(); tlRender(); renderInspector(); }
    if (b.dataset.tab === 'color') { bus.emit('color:enter'); renderStrip(); if (engine) engine.seek(state.playhead); }
    if (b.dataset.tab === 'export') exportRefresh();
  });
  requestAnimationFrame(move);
  window.addEventListener('resize', move);
}

// ---- loop state: clip loop (Color tab) and In/Out section loop (Edit tab) ----
// mutually exclusive; the engine holds a single {a,b} range
let clipLoop = false, ioLoop = false;
function applyLoop() {
  let range = null;
  if (clipLoop) {
    const seg = videoProgram().find((s) => s.clip.id === state.selectedClipId);
    if (seg) range = { a: seg.start, b: seg.end }; else clipLoop = false;
  }
  if (!range && ioLoop) {
    if (state.inPoint != null && state.outPoint != null && state.outPoint > state.inPoint + 0.05) range = { a: state.inPoint, b: state.outPoint };
    else ioLoop = false;
  }
  engine.setLoop(range);
  el('cLoop')?.classList.toggle('on', clipLoop);
  el('eLoop')?.classList.toggle('on', ioLoop);
}
// loop toggle shared by the player button, the timeline tool and the L key.
// With no section marked it loops the WHOLE timeline — the In/Out flags appear
// on the ruler and can be dragged to narrow it.
function toggleIOLoop() {
  if (!ioLoop && (state.inPoint == null || state.outPoint == null)) {
    const dur = timelineDuration();
    if (dur < 0.1) return toast('Timeline is empty', true);
    state.inPoint = 0; state.outPoint = dur;
  }
  ioLoop = !ioLoop;
  if (ioLoop) clipLoop = false;
  applyLoop(); tlRender();
  if (ioLoop && engine.loop && !state.playing) engine.seek(engine.loop.a + 0.001);
}
function setInPoint(clear) {
  state.inPoint = clear ? null : state.playhead;
  if (state.inPoint != null && state.outPoint != null && state.outPoint <= state.inPoint) state.outPoint = null;
  applyLoop(); tlRender();
}
function setOutPoint(clear) {
  state.outPoint = clear ? null : state.playhead;
  if (state.inPoint != null && state.outPoint != null && state.outPoint <= state.inPoint) state.inPoint = null;
  applyLoop(); tlRender();
}

function setupTransport() {
  const play = () => engine.toggle();
  el('ePlay').onclick = play; el('cPlay').onclick = play;
  // fps read at call time — the project's fps may be restored after boot
  const step = (d) => { engine.pause(); engine.seek(state.playhead + d / state.fps); };
  el('eNextF').onclick = () => step(1); el('ePrevF').onclick = () => step(-1);
  if (el('cNextF')) el('cNextF').onclick = () => step(1);
  if (el('cPrevF')) el('cPrevF').onclick = () => step(-1);
  // Color tab: loop the selected clip's timeline segment
  const cl = el('cLoop');
  if (cl) cl.onclick = () => {
    if (!clipLoop && !state.selectedClipId) return toast('Select a clip first', true);
    clipLoop = !clipLoop;
    if (clipLoop) ioLoop = false;
    applyLoop();
    if (clipLoop && engine.loop && !state.playing) engine.seek(engine.loop.a + 0.001);
  };
  bus.on('clip:selected', () => { if (clipLoop) applyLoop(); });
  const clip = (dir) => {
    const segs = videoProgram();
    if (!segs.length) return;
    const i = segs.findIndex((s) => state.playhead >= s.start && state.playhead < s.end);
    const ni = Math.max(0, Math.min(segs.length - 1, (i < 0 ? 0 : i) + dir));
    engine.pause(); engine.seek(segs[ni].start + 0.001); selectClip(segs[ni].clip.id);
  };
  el('eNextC').onclick = () => clip(1); el('ePrevC').onclick = () => clip(-1);
  el('cNextC').onclick = () => clip(1); el('cPrevC').onclick = () => clip(-1);
  const mv = el('tlMasterVol');
  if (mv) { mv.value = state.masterVolume ?? 1; mv.oninput = (e) => { engine.audio.setMaster(parseFloat(e.target.value)); bus.emit('timeline:changed'); }; }
  // narrow portrait collapses the volume slider behind the speaker icon —
  // tapping it pops the slider up (the class is inert on other layouts)
  const vr = el('tlVolRow'), vb = el('tlVolBtn');
  if (vr && vb) {
    vb.onclick = () => vr.classList.toggle('open');
    document.addEventListener('pointerdown', (e) => {
      if (vr.classList.contains('open') && !vr.contains(e.target)) vr.classList.remove('open');
    });
  }
  // project settings popover (⚙ on the timeline): aspect / resolution / fps.
  // Writes state.project + state.fps and mirrors the Export tab's selects.
  const pw = el('tlProjWrap');
  if (pw) {
    const syncFromState = () => {
      el('pAspect').value = state.project?.format || '16:9';
      el('pRes').value = String(state.project?.height || 1080);
      el('pFps').value = String(state.fps || 30);
    };
    el('tlProjBtn').onclick = () => { syncFromState(); pw.classList.toggle('open'); };
    document.addEventListener('pointerdown', (e) => {
      if (pw.classList.contains('open') && !pw.contains(e.target)) pw.classList.remove('open');
    });
    const applyProj = () => {
      state.project = { format: el('pAspect').value, height: parseInt(el('pRes').value, 10) || 1080 };
      state.fps = parseInt(el('pFps').value, 10) || 30;
      if (el('exAspect')) el('exAspect').value = state.project.format;
      if (el('exRes')) el('exRes').value = String(state.project.height);
      if (el('exFps')) el('exFps').value = String(state.fps);
      engine.seek(state.playhead);          // re-size the canvas/player box
      bus.emit('timeline:changed');         // autosave + export refresh
    };
    el('pAspect').onchange = applyProj; el('pRes').onchange = applyProj; el('pFps').onchange = applyProj;
    // the export tab's fps select drives the editor fps too (it used to be
    // export-only, leaving frame-stepping at 30)
    if (el('exFps')) el('exFps').addEventListener('change', () => { state.fps = parseInt(el('exFps').value, 10) || 30; bus.emit('timeline:changed'); });
  }

  // bypass on the Edit page — same state as the Color tab's button
  const eb = el('eBypass');
  if (eb) eb.onclick = () => {
    state.gradeBypass = !state.gradeBypass;
    eb.classList.toggle('on', state.gradeBypass);
    el('cBypass')?.classList.toggle('on', state.gradeBypass);
    engine.markGradeDirty();
  };
  const st = el('scopeToggle');
  if (st) {
    const sc = el('scopes');
    // visibility is driven by .show on EVERY layout (wide used to hard-show,
    // making this button a no-op on desktop). Default: on for wide, off narrow.
    const saved = localStorage.getItem('eddit.scopes');
    const on = saved != null ? saved === '1' : document.documentElement.getAttribute('data-layout') !== 'narrow';
    sc.classList.toggle('show', on); st.classList.toggle('on', on);
    st.onclick = () => {
      const v = sc.classList.toggle('show');
      st.classList.toggle('on', v);
      localStorage.setItem('eddit.scopes', v ? '1' : '0');
    };
    // per-scope collapse: click a scope's label to fold just that one away
    const hidden = new Set(JSON.parse(localStorage.getItem('eddit.scopeHide') || '[]'));
    sc.querySelectorAll('.scope-box').forEach((box) => {
      const id = box.querySelector('canvas').id;
      box.classList.toggle('collapsed', hidden.has(id));
      const lbl = box.querySelector('.scope-lbl');
      lbl.title = 'Show/hide this scope';
      lbl.onclick = () => {
        const c = box.classList.toggle('collapsed');
        if (c) hidden.add(id); else hidden.delete(id);
        localStorage.setItem('eddit.scopeHide', JSON.stringify([...hidden]));
      };
    });
  }
}

function setupTools() {
  const setTool = (tool) => {
    state.tool = tool;
    el('toolSelect').classList.toggle('on', tool === 'select');
    el('toolRazor').classList.toggle('on', tool === 'razor');
    tlRender();
  };
  el('toolSelect').onclick = () => setTool('select');
  el('toolRazor').onclick = () => setTool('razor');
  el('toolSnap').onclick = () => { state.snap = !state.snap; el('toolSnap').classList.toggle('on', state.snap); };
  el('toolDelete').onclick = deleteSelected;
  el('toolUndo').onclick = doUndo;
  el('toolRedo').onclick = doRedo;
  el('toolTitle').onclick = () => {
    const c = addTitle(Math.max(0, state.playhead || 0));
    tlRender(); selectClip(c.id); renderInspector();
    if (engine) engine.seek(state.playhead);
  };
  // clip settings drawer (narrow layouts) — toggles the inspector sheet
  if (el('toolInspect')) el('toolInspect').onclick = () => {
    const sb = document.querySelector('#editSide');
    if (sb?.classList.contains('sheet-open')) closeSheet(); else openSheet(sb);
  };
  // In/Out section + loop (shift-click a flag button to clear that point)
  if (el('toolIn')) el('toolIn').onclick = (e) => setInPoint(e.shiftKey);
  if (el('toolOut')) el('toolOut').onclick = (e) => setOutPoint(e.shiftKey);
  if (el('eLoop')) el('eLoop').onclick = toggleIOLoop;
  // the ruler's In/Out flags are draggable — keep the engine loop range in sync
  bus.on('io:changed', () => applyLoop());
}

function updateUndoButtons() {
  const u = el('toolUndo'), r = el('toolRedo');
  if (u) u.disabled = !canUndo();
  if (r) r.disabled = !canRedo();
  // master volume is part of undo snapshots — keep slider + gain in sync
  const mv = el('tlMasterVol');
  if (mv && Math.abs(parseFloat(mv.value) - (state.masterVolume ?? 1)) > 1e-3) {
    mv.value = state.masterVolume ?? 1;
    if (engine) engine.audio.setMaster(state.masterVolume ?? 1);
  }
}
function doUndo() { if (undo()) { renderInspector(); engine.seek(state.playhead); } }
function doRedo() { if (redo()) { renderInspector(); engine.seek(state.playhead); } }

function setupKeys() {
  window.addEventListener('keydown', (e) => {
    // undo/redo work everywhere except while typing in a field (native undo there)
    const inField = /input|textarea|select/i.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !inField) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y') && !inField) { e.preventDefault(); doRedo(); return; }
    if (inField) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;  // don't hijack browser combos (Ctrl+B etc.)
    switch (e.key) {
      case ' ': e.preventDefault(); engine.toggle(); break;
      case 'b': case 'B': el('toolRazor').click(); break;
      case 'v': case 'V': el('toolSelect').click(); break;
      case 's': case 'S': el('toolSnap').click(); break;
      case 'ArrowRight': e.preventDefault(); engine.pause(); engine.seek(state.playhead + 1 / state.fps); break;
      case 'ArrowLeft': e.preventDefault(); engine.pause(); engine.seek(state.playhead - 1 / state.fps); break;
      case 'Delete': case 'Backspace':
        if (e.shiftKey && state.selectedClipId) { rippleDelete(state.selectedClipId); tlRender(); renderInspector(); engine.seek(state.playhead); }
        else deleteSelected();
        break;
      case 'm': case 'M': toggleMarker(state.playhead); tlRender(); break;
      case 'i': case 'I': setInPoint(e.shiftKey); break;
      case 'o': case 'O': setOutPoint(e.shiftKey); break;
      case 'l': case 'L': el('eLoop')?.click(); break;
    }
  });
}

// lightweight scopes (waveform + histogram) sampled from the graded canvas.
// Event-driven: the engine emits frame:drawn in the same task as the WebGPU
// submit, which is the only moment readback from the canvas is reliable —
// polling on rAF read stale/blank frames (scopes froze until a grade change).
let scopeT = 0;
function onFrameDrawn() {
  if (state.activeTab !== 'color') return;
  const now = performance.now();
  // GPU→CPU readback is the expensive part — throttle harder while playing
  if (now - scopeT < (state.playing ? 250 : 90)) return; scopeT = now;
  if (!el('scopes').classList.contains('show')) return;   // hidden → skip the work
  const src = renderer.canvas; if (!src || !src.width) return;
  try { drawScopes(src); } catch {}
}

const tmp = document.createElement('canvas');
// size a canvas only when it actually changed — reassigning width every pass
// reallocates the backing store and stalls the raster pipeline
const sizeC = (c, w, h) => { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } };
function drawScopes(src) {
  const sw = 200, sh = 112;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  sizeC(tmp, sw, sh);
  const cx = tmp.getContext('2d', { willReadFrequently: true });
  cx.drawImage(src, 0, 0, sw, sh);
  const data = cx.getImageData(0, 0, sw, sh).data;

  // waveform (luma per column) — offsetParent null = collapsed, skip the work.
  // Plotted by accumulating into an ImageData and blitting once: the previous
  // one-fillRect-per-sample version was ~11k canvas calls per pass (the parade
  // 3×that) and dominated the playback profile on the Color tab.
  const wf = el('scopeWave');
  if (wf.offsetParent) {
    const W2 = 180, H2 = 70;
    sizeC(wf, W2, H2);
    const wc = wf.getContext('2d');
    const img = wc.createImageData(W2, H2), d8 = img.data;
    for (let p = 0; p < d8.length; p += 4) { d8[p] = 10; d8[p + 1] = 10; d8[p + 2] = 12; d8[p + 3] = 255; }
    for (let x = 0; x < sw; x++) {
      const px = ((x / sw) * W2) | 0;
      for (let y = 0; y < sh; y += 2) {
        const i = (y * sw + x) * 4;
        const l = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
        const p = ((((1 - l) * (H2 - 1)) | 0) * W2 + px) * 4;
        d8[p] = Math.min(255, d8[p] + 60); d8[p + 1] = Math.min(255, d8[p + 1] + 115); d8[p + 2] = Math.min(255, d8[p + 2] + 85);
      }
    }
    wc.putImageData(img, 0, 0);
  }
  // RGB parade — R, G, B waveforms side by side (same accumulate-once scheme)
  const pd = el('scopeParade');
  if (pd && pd.offsetParent) {
    const W2 = 180, H2 = 70, seg = W2 / 3;
    sizeC(pd, W2, H2);
    const pc = pd.getContext('2d');
    const img = pc.createImageData(W2, H2), d8 = img.data;
    for (let p = 0; p < d8.length; p += 4) { d8[p] = 10; d8[p + 1] = 10; d8[p + 2] = 12; d8[p + 3] = 255; }
    const add = [[128, 40, 40], [45, 115, 60], [55, 75, 128]];
    for (let ch = 0; ch < 3; ch++) {
      const a = add[ch], x0 = ch * seg;
      for (let x = 0; x < sw; x++) {
        const px = (x0 + (x / sw) * seg) | 0;
        for (let y = 0; y < sh; y += 2) {
          const i = (y * sw + x) * 4;
          const p = ((((1 - data[i + ch] / 255) * (H2 - 1)) | 0) * W2 + px) * 4;
          d8[p] = Math.min(255, d8[p] + a[0]); d8[p + 1] = Math.min(255, d8[p + 1] + a[1]); d8[p + 2] = Math.min(255, d8[p + 2] + a[2]);
        }
      }
    }
    pc.putImageData(img, 0, 0);
  }

  // Vectorscope — chroma on the U/V plane (colour balance + saturation)
  const vs = el('scopeVector');
  if (vs && vs.offsetParent) {
    const S = Math.round(80 * dpr); sizeC(vs, S, S);
    const vc = vs.getContext('2d'); vc.fillStyle = '#0a0a0c'; vc.fillRect(0, 0, S, S);
    vc.strokeStyle = 'rgba(255,255,255,.08)'; vc.beginPath(); vc.arc(S / 2, S / 2, S / 2 - 2, 0, 7); vc.stroke();
    vc.beginPath(); vc.moveTo(S / 2, 4); vc.lineTo(S / 2, S - 4); vc.moveTo(4, S / 2); vc.lineTo(S - 4, S / 2); vc.stroke();
    const img = vc.getImageData(0, 0, S, S); const px = img.data;
    for (let i = 0; i < data.length; i += 8) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const u = -0.169 * r - 0.331 * g + 0.5 * b;
      const v = 0.5 * r - 0.419 * g - 0.081 * b;
      const x = Math.round(S / 2 + u * (S - 6)), y = Math.round(S / 2 - v * (S - 6));
      if (x < 0 || y < 0 || x >= S || y >= S) continue;
      const p = (y * S + x) * 4;
      px[p] = Math.min(255, px[p] + 60); px[p + 1] = Math.min(255, px[p + 1] + 200); px[p + 2] = Math.min(255, px[p + 2] + 90); px[p + 3] = 255;
    }
    vc.putImageData(img, 0, 0);
  }

  // histogram
  const hg = el('scopeHist');
  if (hg.offsetParent) {
    sizeC(hg, 180 * dpr, 70 * dpr);
    const hc = hg.getContext('2d'); hc.setTransform(1, 0, 0, 1, 0, 0); hc.scale(dpr, dpr);
    hc.fillStyle = '#0a0a0c'; hc.fillRect(0, 0, 180, 70);
    const bins = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
    for (let i = 0; i < data.length; i += 4) { bins[0][data[i] >> 2]++; bins[1][data[i + 1] >> 2]++; bins[2][data[i + 2] >> 2]++; }
    const max = Math.max(...bins.flatMap((b) => [...b])) || 1;
    const cols = ['rgba(255,90,90,.6)', 'rgba(120,230,120,.6)', 'rgba(120,150,255,.6)'];
    hc.globalCompositeOperation = 'lighter';
    bins.forEach((b, ci) => { hc.fillStyle = cols[ci]; for (let i = 0; i < 64; i++) { const h = (b[i] / max) * 70; hc.fillRect((i / 64) * 180, 70 - h, 180 / 64, h); } });
    hc.globalCompositeOperation = 'source-over';
  }
}

boot();
