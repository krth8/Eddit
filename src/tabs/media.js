// Media tab: import, media-pool grid, inspector, proxy queue.
import { state, addMedia, getMedia, appendClip, bus } from '../state.js';
import { el, $$, fmtShort, fmtTC, toast, uid, clamp } from '../util.js';
import { probe, makeStrip } from '../media/probe.js';
import { makeProxy, codecSupport } from '../media/proxy.js';
import { demux } from '../media/demux.js';
import { pickMedia, pickFolder, isMediaFile, handleMap, pathMap } from '../media/pick.js';
import { proxyKey, loadProxy, saveProxy, proxyBytes, clearProxies } from '../store.js';
import { findLut } from '../luts.js';
import { ffmpegLoaded, ffmpegMultithread } from '../media/ffmpeg.js';

let engine = null;
let caps = { decode: false, encode: false, hevc: false };
const proxyQueue = [];
let proxyBusy = false;
const cards = new Map();       // mediaId -> grid card element (incremental updates)
const freshSeen = new Set();   // media whose "proxy ready" pop has already played
let binFilter = null;          // active folder-bin filter (null = all)
const dirOf = (m) => (m.path || '').split('/').slice(0, -1).join('/');

export async function initMedia(eng) {
  engine = eng;
  caps = await codecSupport();
  // codec capability line lives in the diagnostics overlay (header pills are gone)
  const codecLine = caps.hevc10 ? 'H.264 · H.265 10-bit' : caps.hevc ? 'H.264 · H.265 8-bit' : caps.decode ? 'H.264 · H.265 via <video>' : 'no WebCodecs';
  if (window.__eddit) window.__eddit.codecLine = codecLine; else window.__eddit = { codecLine };
  ffUI();  // set initial ffmpeg pill state

  const doPick = async () => { const files = await pickMedia(); if (files.length) importFiles(files); };
  el('importBtn').onclick = doPick;
  el('emptyImport').onclick = doPick;
  el('importFolderBtn').onclick = async () => { const files = await pickFolder(); if (files.length) importFiles(files); };
  el('fileInput').onchange = (e) => importFiles([...e.target.files]); // legacy fallback

  // drag & drop anywhere on the Media tab
  const drop = el('media');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.outline = '2px dashed var(--accent)'; drop.style.outlineOffset = '-6px'; });
  drop.addEventListener('dragleave', () => { drop.style.outline = ''; });
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.style.outline = '';
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) importFiles(files);
  });

  el('tsize').oninput = (e) => el('grid').style.setProperty('--tw', e.target.value + 'px');
  el('search').oninput = renderGrid;

  // OPFS proxy-cache size + clear (proxyBytes existed but was never surfaced)
  updateCacheStat();
  const pc = el('proxyClear');
  if (pc) pc.onclick = async () => {
    if (!confirm('Clear the proxy cache? Loaded proxies keep working; missing ones rebuild on demand.')) return;
    const ok = await clearProxies();
    toast(ok ? 'Proxy cache cleared' : 'Could not clear cache', !ok);
    updateCacheStat();
  };

  el('addToTl').onclick = () => { if (state.selectedMediaId) { appendClip(state.selectedMediaId); toast('Added to timeline'); } };
  el('rebuildProxy').onclick = () => { const m = getMedia(state.selectedMediaId); if (m) { m.proxyReady = false; queueProxy(m, true); } };
  el('removeMediaBtn').onclick = () => { if (state.selectedMediaId) removeMedia(state.selectedMediaId); };

  bus.on('media:changed', renderGrid);
  renderGrid();
}

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|3gp|hevc)$/i;

async function importFiles(files) {
  // Folder imports sweep in sidecars (wav/cube/bmp/Thumbs.db…) — keep only
  // real video files.
  files = [...files];
  const vids = files.filter((f) => f.type.startsWith('video') || VIDEO_EXT.test(f.name));
  const skipped = files.length - vids.length;
  if (!vids.length) return toast(skipped ? 'No video files in the selection' : 'No files selected', true);
  if (skipped) toast(`${skipped} non-video file${skipped === 1 ? '' : 's'} skipped`);

  // PHASE 1 — index: every clip gets its pool card up front. Probing and proxy
  // building follow in the background, so one slow/exotic file can never block
  // the rest of the import (importing a folder of 6K ProRes used to stall).
  const work = [];
  for (const file of vids) {
    console.log('[import]', file.name, '· type:', file.type || '(none)', '· size:', file.size);
    // re-link: a restored-but-unlinked slot matching this file keeps its clips
    const existing = state.media.find((x) => !x.file && x.name === file.name && x.size === file.size);
    if (existing) {
      existing.file = file; existing.handle = handleMap.get(file) || null;
      work.push({ m: existing, file, relink: true });
      continue;
    }
    const m = addMedia({
      size: file.size, path: pathMap.get(file) || file.webkitRelativePath || '',
      name: file.name, file, handle: handleMap.get(file) || null, url: null,
      width: 0, height: 0, duration: 0, thumb: null, playable: false,
      proxyReady: false, proxyUrl: null, proxyStatus: el('autoProxy').checked ? 'queued' : '',
    });
    work.push({ m, file, relink: false });
  }
  renderGrid();
  toast(`Indexed ${work.length} clip${work.length === 1 ? '' : 's'}`);

  // PHASE 2 — probe metadata per clip, then hand it to the proxy queue (whose
  // ffmpeg tier also converts clips nothing native can decode)
  for (const { m, file, relink } of work) {
    if (m.removed) continue;
    try {
      const meta = await probe(file);
      m.url = meta.url; m.playable = meta.playable;
      if (meta.width) { m.width = meta.width; m.height = meta.height; }
      if (meta.duration && !m.duration) m.duration = meta.duration;
      if (meta.thumb) m.thumb = meta.thumb;   // fresh thumb also on re-link
      if (!m.width || !m.height) {
        // real dimensions from the container demuxer — WebCodecs often decodes
        // what <video> won't, so 0×0 here is not "undecodable". Only for
        // modest files: the demuxer reads the WHOLE file into memory, and for
        // big camera originals the proxy supplies the dimensions anyway.
        if (file.size < 3e8) {
          try {
            const d = await demux(file);
            let W = d.width, H = d.height;
            if (d.rotation === 90 || d.rotation === 270) { const t = W; W = H; H = t; }
            if (W && H) { m.width = W; m.height = H; }
            if (!m.duration && d.duration) m.duration = d.duration;
          } catch (e) { console.log('[import] demux failed', file.name, e?.message || e); }
        }
      }
    } catch (e) { console.warn('[import] probe failed', file.name, e); }
    updateCard(m);
    bus.emit('media:changed');
    if (relink) toast('Re-linked ' + file.name);
    if (el('autoProxy').checked) { if (!m.proxyReady) queueProxy(m, false); }
    else ensureStrip(m);   // no proxy coming — build the hover strip off the original
  }
}

// visible ffmpeg.wasm status: header pill + a prominent progress banner
function ffUI(text, pct) {
  const box = el('ffStatus'), pill = el('ffPill');
  const active = text && text !== 'done';
  if (pill) {
    pill.textContent = active ? 'ffmpeg ⏳' : (ffmpegLoaded() ? ('ffmpeg ✓ ' + (ffmpegMultithread() ? 'MT' : 'ST')) : 'ffmpeg —');
    pill.classList.toggle('busy', !!active);
    pill.classList.toggle('on', !active && ffmpegLoaded());
  }
  if (!box) return;
  box.classList.remove('err');
  if (!text || text === 'done') { box.classList.remove('show'); return; }
  box.classList.add('show');
  box.innerHTML = `<span class="ff-spin"></span> ffmpeg.wasm — ${text}${pct != null ? ` · ${Math.round(pct * 100)}%` : ''}`;
}
// persistent error (click to dismiss)
function ffError(name, msg) {
  const box = el('ffStatus'); const pill = el('ffPill');
  if (pill) { pill.textContent = 'ffmpeg ✗'; pill.classList.remove('busy', 'on'); }
  if (!box) return;
  box.classList.add('show', 'err');
  box.innerHTML = `<b>ffmpeg failed</b> — ${name}: ${msg} &nbsp; <span style="opacity:.6">(click to dismiss)</span>`;
  box.onclick = () => { box.classList.remove('show', 'err'); box.onclick = null; };
}

function queueProxy(m, force) {
  if (m.proxyReady && !force) return;
  // ffmpeg.wasm tier-3 works even without a WebCodecs encoder, so always queue
  m.proxyReady = false; m.proxyStatus = 'queued';
  proxyQueue.push(m);
  renderGrid();
  runQueue();
}

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label || 'timed out')), ms))]);

async function updateCacheStat() {
  const s = el('proxyCache'); if (!s) return;
  try {
    const b = await withTimeout(proxyBytes(), 4000, 'opfs');
    s.textContent = b ? `cache: ${(b / 1e6).toFixed(0)} MB` : 'cache: empty';
  } catch { s.textContent = 'cache: ?'; }
}

async function runQueue() {
  if (proxyBusy) return;
  proxyBusy = true;
  const prog = el('proxyProg');
  try {
    const targetH = parseInt(el('proxyH').value, 10) || 720;
    while (proxyQueue.length) {
      const m = proxyQueue.shift();
      if (!m || !m.file || m.removed) { if (m) m.proxyStatus = m.file ? m.proxyStatus : 'unlinked'; continue; }
      const key = proxyKey(m.file, targetH);
      // status FIRST so the UI reflects progress even if the OPFS lookup is slow
      m.proxyStatus = 'building'; el('proxyStat').textContent = 'building ' + m.name;
      prog.classList.remove('hidden'); prog.firstElementChild.style.width = '0%'; updateCard(m);
      try {
        // reuse a cached proxy from OPFS (timeout-guarded so a hung FS can't freeze the queue)
        const cached = await withTimeout(loadProxy(key), 4000, 'opfs').catch(() => null);
        if (cached) {
          m.proxyBlob = cached; m.proxyUrl = URL.createObjectURL(cached); m.proxyKey = key;
          m.proxyReady = true; m.proxyStatus = 'ready'; updateCard(m);
          bus.emit('media:changed');   // autosave — the project must persist proxyKey
          ensureStrip(m);
          continue;
        }
        m.proxyProgress = 0;
        const res = await makeProxy(m.file, targetH,
          (p) => {
            prog.firstElementChild.style.width = (p * 100).toFixed(0) + '%';
            m.proxyProgress = p;
            const c = cards.get(m.id); const bar = c && c.querySelector('.card-prog i');
            if (bar) bar.style.width = Math.round(p * 100) + '%';
          },
          (text, pct) => ffUI(text, pct));
        if (m.removed) continue;
        m.proxyUrl = res.url; m.proxyBlob = res.blob; m.proxyW = res.width; m.proxyH = res.height;
        m.proxyKey = key; m.proxyReady = true; m.proxyStatus = 'ready'; m.proxyMethod = res.method; m.proxyError = null;
        // originals <video> can't decode have no poster/dims/duration — adopt
        // them off the H.264 proxy (ffmpeg-tier clips arrive here with 0×0)
        if ((!m.thumb || !m.width || !m.duration) && res.blob) {
          try {
            const pm = await probe(res.blob);
            if (!m.thumb && pm.thumb) m.thumb = pm.thumb;
            if (!m.width && pm.width) { m.width = pm.width; m.height = pm.height; }
            if (!m.duration && pm.duration) m.duration = pm.duration;
            if (pm.url) URL.revokeObjectURL(pm.url);
          } catch {}
        }
        withTimeout(saveProxy(key, res.blob), 8000, 'opfs-save').catch(() => {}); // fire-and-forget
        // autosave NOW so proxyKey survives a hard stop — without this the key
        // only reached IndexedDB when something else happened to trigger a save,
        // and killing the PWA left finished proxies "relink" on next launch
        bus.emit('media:changed');
        ensureStrip(m);
        if (res.method === 'video') toast(`Proxy built for ${m.name} via <video> fallback`, false, 3500);
      } catch (e) {
        m.proxyStatus = 'failed'; m.proxyError = e.message || String(e);
        console.warn('proxy failed', m.name, e);
        toast(`Proxy failed — ${m.name}: ${m.proxyError}`, true, 6500);
      }
      updateCard(m);
    }
  } finally {
    proxyBusy = false;
    prog.classList.add('hidden');
    el('proxyStat').textContent = 'idle';
    ffUI();
    updateCacheStat();
  }
}

function makeCard(m) {
  const d = document.createElement('div');
  d.dataset.id = m.id;
  d.innerHTML = `<div class="thumbbox"><span class="proxy-badge"></span><span class="dur-badge"></span><span class="card-spin"></span><div class="card-prog"><i></i></div></div>
    <div class="meta"><div class="cap"></div><div class="sub"></div></div>
    <span class="clip-del" title="Remove from project">✕</span>`;
  d.querySelector('.clip-del').onclick = (e) => { e.stopPropagation(); removeMedia(m.id); };
  d.onclick = () => selectMedia(m.id);
  wireHoverScrub(m, d.querySelector('.thumbbox'));
  return d;
}

// ---- hover scrub (desktop): sweep the mouse across a card's thumb to preview
// the clip. One shared <video> hops between cards; the all-intra H.264 proxy
// makes currentTime seeks effectively instant. Mouse-only (hover+fine pointer).
const canHoverScrub = matchMedia('(hover:hover) and (pointer:fine)').matches;
export const STRIP_FRAMES = 10;
let scrubV = null;

// build (once) the persisted 10-frame filmstrip for a clip — proxy preferred,
// original as fallback. media:changed persists it via autosave.
export async function ensureStrip(m) {
  if (m.strip || m._stripBusy) return;
  const src = m.proxyBlob || ((m.playable && m.file) ? m.file : null);
  if (!src || !m.duration) return;
  m._stripBusy = true;
  try {
    const s = await makeStrip(src, STRIP_FRAMES);
    if (s) { m.strip = s; bus.emit('media:changed'); }
  } finally { m._stripBusy = false; }
}

export function wireHoverScrub(m, tb) {
  if (!canHoverScrub) return;
  tb.addEventListener('pointerenter', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    // filmstrip first: works with no file/proxy loaded at all. Live <video>
    // is the fallback while a clip has no strip yet.
    if (m.strip) {
      const ov = document.createElement('div');
      ov.className = 'scrub-strip';
      ov.style.backgroundImage = `url(${m.strip})`;
      ov.style.backgroundSize = (STRIP_FRAMES * 100) + '% 100%';
      tb.insertBefore(ov, tb.firstChild);   // badges (z-index 2) stay on top
    } else {
      const src = (m.proxyReady && m.proxyUrl) || (m.playable && m.url) || null;
      if (!src || !m.duration) return;
      if (!scrubV) {
        scrubV = document.createElement('video');
        scrubV.muted = true; scrubV.playsInline = true; scrubV.preload = 'auto';
        scrubV.className = 'scrub-vid';
      }
      if (scrubV.dataset.src !== src) { scrubV.src = src; scrubV.dataset.src = src; }
      tb.insertBefore(scrubV, tb.firstChild);
    }
    let line = tb.querySelector('.scrub-line');
    if (!line) { line = document.createElement('i'); line.className = 'scrub-line'; tb.appendChild(line); }
    tb.classList.add('scrubbing');
  });
  tb.addEventListener('pointermove', (e) => {
    const strip = tb.querySelector('.scrub-strip');
    if (!strip && !(scrubV && scrubV.parentElement === tb)) return;
    const r = tb.getBoundingClientRect();
    const f = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 0.999);
    const line = tb.querySelector('.scrub-line');
    if (line) line.style.left = (f * 100).toFixed(1) + '%';
    if (strip) {
      const idx = Math.min(STRIP_FRAMES - 1, Math.floor(f * STRIP_FRAMES));
      strip.style.backgroundPosition = (idx / (STRIP_FRAMES - 1) * 100) + '% 50%';
    } else {
      const t = f * (m.duration || scrubV.duration || 0);
      if (Math.abs((scrubV.currentTime || 0) - t) > 0.04) { try { scrubV.currentTime = t; } catch {} }
    }
  });
  tb.addEventListener('pointerleave', () => {
    tb.querySelector('.scrub-strip')?.remove();
    if (scrubV && scrubV.parentElement === tb) scrubV.remove();
    tb.querySelector('.scrub-line')?.remove();
    tb.classList.remove('scrubbing');
  });
}

// Update ONE card in place — so a clip lights up with its thumbnail the moment
// its proxy finishes (grayscale→colour + a one-shot glow), without a full
// re-render resetting every animation. Sortcut's ingest pattern.
export function updateCard(m, card) {
  card = card || cards.get(m.id); if (!card) return;
  const st = m.proxyStatus;
  const pend = st === 'queued' || st === 'building';   // unlinked = idle, no spinner
  card.className = 'clip'
    + (m.id === state.selectedMediaId ? ' active' : '')
    + (pend ? ' proxy-pending' : '')
    + (st === 'building' ? ' proxy-building' : '')
    + (st === 'unlinked' ? ' proxy-unlinked' : '')
    + (st === 'failed' ? ' proxy-failed' : '');
  if (m.proxyReady && !freshSeen.has(m.id)) {
    freshSeen.add(m.id); card.classList.add('fresh');
    setTimeout(() => card.classList.remove('fresh'), 1500);
  }
  const tb = card.querySelector('.thumbbox');
  tb.classList.toggle('nothumb', !m.thumb);
  tb.style.backgroundImage = m.thumb ? `url(${m.thumb})` : '';
  // per-clip proxy progress bar (replaces the spinner while building)
  const pbar = card.querySelector('.card-prog');
  if (pbar) {
    const building = st === 'building';
    pbar.style.display = building ? 'block' : 'none';
    pbar.firstElementChild.style.width = Math.round((m.proxyProgress || 0) * 100) + '%';
  }
  const badge = card.querySelector('.proxy-badge');
  const bt = st === 'ready' ? 'proxy' : st === 'building' ? 'proxy…' : st === 'queued' ? 'queued'
    : st === 'failed' ? 'proxy ✗' : st === 'unlinked' ? 'relink' : '';
  badge.textContent = bt;
  badge.className = 'proxy-badge ' + (st === 'ready' ? 'ready' : st === 'failed' ? 'failed' : 'pending');
  badge.style.display = bt ? '' : 'none';
  card.querySelector('.dur-badge').textContent = fmtShort(m.duration);
  card.querySelector('.cap').textContent = m.name;
  card.querySelector('.sub').textContent = `${m.width || '?'}×${m.height || '?'}` +
    (st === 'failed' ? ' · failed' : m.proxyMethod === 'ffmpeg' ? ' · sw' : m.proxyMethod === 'video' ? ' · sw' : '');
  card.title = st === 'failed' ? 'Proxy failed: ' + (m.proxyError || 'unknown')
    : (st === 'unlinked' && m.handle) ? 'Click to restore file access' : '';
}

function renderGrid() {
  const grid = el('grid'), empty = el('gridEmpty');
  const q = (el('search')?.value || '').toLowerCase();
  let items = state.media.filter((m) => m.name.toLowerCase().includes(q));
  if (binFilter != null) items = items.filter((m) => { const d = dirOf(m); return d === binFilter || d.startsWith(binFilter + '/'); });
  empty.style.display = state.media.length ? 'none' : '';
  grid.style.display = state.media.length ? '' : 'none';
  const seen = new Set();
  let prev = null;
  for (const m of items) {
    let card = cards.get(m.id);
    if (!card) { card = makeCard(m); cards.set(m.id, card); }
    updateCard(m, card);
    const want = prev ? prev.nextSibling : grid.firstChild;
    if (card !== want) grid.insertBefore(card, want);
    prev = card; seen.add(m.id);
  }
  for (const [id, card] of cards) if (!seen.has(id)) { card.remove(); cards.delete(id); }
  el('mediaCount').textContent = `${state.media.length} clip${state.media.length === 1 ? '' : 's'}`;
  renderBins();
  bus.emit('export:refresh');
}

// folder-bin tree built from each clip's relative path
function renderBins() {
  const box = el('binList'); if (!box) return;
  const tree = { kids: new Map(), count: 0 };
  for (const m of state.media) {
    tree.count++;
    let node = tree, acc = '';
    for (const part of dirOf(m).split('/').filter(Boolean)) {
      acc = acc ? acc + '/' + part : part;
      if (!node.kids.has(part)) node.kids.set(part, { name: part, path: acc, kids: new Map(), count: 0 });
      node = node.kids.get(part); node.count++;
    }
  }
  box.innerHTML = '';
  box.appendChild(binRow('All media', null, tree.count, binFilter === null, 0));
  (function walk(node, depth) {
    for (const kid of node.kids.values()) { box.appendChild(binRow(kid.name, kid.path, kid.count, binFilter === kid.path, depth)); walk(kid, depth + 1); }
  })(tree, 1);
}
function binRow(name, path, count, on, depth) {
  const r = document.createElement('div');
  r.className = 'binrow' + (on ? ' on' : '');
  r.style.paddingLeft = (8 + depth * 13) + 'px';
  r.innerHTML = `<svg class="ic" style="opacity:.65;width:13px;height:13px;flex:none"><use href="#i-folder"/></svg>
    <span class="bname" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</span><span class="bn">${count}</span>`;
  r.onclick = () => { binFilter = path; renderGrid(); };
  return r;
}

// restore a saved project: rebuild media (proxies from OPFS), timeline, grades
// Tear down the current project's in-memory state + object URLs before loading
// another. Leaves the OPFS proxy cache intact (it's shared across projects).
export function resetForNewProject() {
  for (const m of state.media) { try { if (m.url) URL.revokeObjectURL(m.url); if (m.proxyUrl) URL.revokeObjectURL(m.proxyUrl); } catch {} }
  proxyQueue.length = 0;
  state.media = [];
  state.tracks = { video: [{ id: uid('v'), clips: [] }], audio: [{ id: uid('a'), clips: [] }] };
  state.grades = {};
  state.markers = [];
  state.selectedMediaId = null;
  state.selectedClipId = null;
  state.playhead = 0;
  cards.clear();
  el('mediaInspector').style.display = 'none';
  renderGrid();
}

export async function restore(proj) {
  if (!proj || !proj.media) return;
  state.fps = proj.fps || 30;
  for (const pm of proj.media) {
    const m = {
      id: pm.id, name: pm.name, size: pm.size, path: pm.path || '', file: null, url: null,
      width: pm.width, height: pm.height, duration: pm.duration, thumb: pm.thumb,
      strip: pm.strip || null, handle: pm.handle || null,
      proxyKey: pm.proxyKey || null, proxyW: pm.proxyW, proxyH: pm.proxyH,
      proxyReady: false, proxyStatus: 'unlinked',
    };
    let key = pm.proxyKey || null;
    let blob = key ? await loadProxy(key) : null;
    if (!blob) {
      // the saved project may predate the proxy finishing (hard stop before
      // autosave) — but the OPFS key is deterministic (name__size__height), so
      // probe the likely candidates and reclaim the cached proxy anyway
      const targetH = parseInt(el('proxyH')?.value, 10) || 720;
      const heights = [...new Set([pm.proxyH, targetH, 720, 540, 1080].filter(Boolean))];
      for (const h of heights) {
        const k = proxyKey({ name: pm.name, size: pm.size }, h);
        if (k === pm.proxyKey) continue;   // already tried
        blob = await loadProxy(k);
        if (blob) { key = k; break; }
      }
    }
    if (blob) { m.proxyKey = key; m.proxyBlob = blob; m.proxyUrl = URL.createObjectURL(blob); m.proxyReady = true; m.proxyStatus = 'ready'; }
    state.media.push(m);
  }
  if (proj.tracks && proj.tracks.video) state.tracks = proj.tracks;
  else if (proj.timeline) { // migrate v1 single-track projects
    let t = 0; const clips = proj.timeline.map((c) => { const start = t; t += Math.max(0.02, (c.out - c.in)); return { ...c, start, speed: 1, volume: 1, mute: false, pitch: 0, kind: 'video' }; });
    state.tracks = { video: [{ id: 'v0', clips }], audio: [{ id: 'a0', clips: [] }] };
  }
  // re-acquire originals from persisted handles — silent path only (permission
  // already granted, e.g. installed-PWA persistent permissions). 'prompt' needs
  // a user gesture; clicking the relink card handles that (relinkFromHandle).
  for (const m of state.media) {
    if (m.file || !m.handle) continue;
    try {
      if ((await m.handle.queryPermission({ mode: 'read' })) !== 'granted') continue;
      await adoptHandleFile(m);
    } catch {}
  }
  state.project = proj.project || { format: '16:9', height: 1080 };
  bus.emit('project:restored');
  state.markers = proj.markers || [];
  state.masterVolume = proj.masterVolume ?? 1;
  const mv = el('tlMasterVol'); if (mv) mv.value = state.masterVolume;
  state.grades = proj.grades || {};
  // re-resolve bundled LUTs from their saved name (data wasn't persisted)
  for (const g of Object.values(state.grades)) {
    if (g && g.lutName) { const l = findLut(g.lutName); if (l) { try { g.lut = l.get(); } catch {} } }
  }
  bus.emit('media:changed'); bus.emit('timeline:changed');
  renderGrid();
  // self-heal black/missing thumbs from the proxy in the background — projects
  // saved before the probe fix carry solid-black poster data-URLs
  (async () => {
    let healed = 0;
    for (const m of state.media) {
      if (!m.proxyBlob) continue;
      if (!m.thumb || (await thumbIsBlack(m.thumb))) {
        try {
          const pm = await probe(m.proxyBlob);
          if (pm.thumb) { m.thumb = pm.thumb; updateCard(m); healed++; }
          if (pm.url) URL.revokeObjectURL(pm.url);
        } catch {}
      }
      await ensureStrip(m);   // backfill hover filmstrips for older projects
    }
    if (healed) bus.emit('media:changed');   // persist the regenerated thumbs
  })();
  const unlinked = state.media.filter((m) => !m.proxyReady).length;
  if (state.media.length) toast(`Restored project — ${state.media.length} clips${unlinked ? `, ${unlinked} need re-import` : ''}`, false, 3500);
}

function removeMedia(id) {
  const m = getMedia(id); if (!m) return;
  m.removed = true;
  // drop the clip(s) that reference it (and their grades)
  for (const tr of [...state.tracks.video, ...state.tracks.audio]) {
    for (let i = tr.clips.length - 1; i >= 0; i--) {
      if (tr.clips[i].mediaId === id) { delete state.grades[tr.clips[i].id]; tr.clips.splice(i, 1); }
    }
  }
  const qi = proxyQueue.indexOf(m); if (qi >= 0) proxyQueue.splice(qi, 1);
  try { if (m.url) URL.revokeObjectURL(m.url); if (m.proxyUrl) URL.revokeObjectURL(m.proxyUrl); } catch {}
  const idx = state.media.indexOf(m); if (idx >= 0) state.media.splice(idx, 1);
  if (state.selectedMediaId === id) { state.selectedMediaId = null; el('mediaInspector').style.display = 'none'; }
  bus.emit('media:changed'); bus.emit('timeline:changed');
  toast('Removed ' + m.name);
}

// is a stored thumb (near-)black? Thumbs captured before the black-frame probe
// fix were saved as solid black data-URLs and must be regenerated.
function thumbIsBlack(dataUrl) {
  return new Promise((res) => {
    if (!dataUrl) return res(true);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        let s = 0, n = 0;
        for (let i = 0; i < d.length; i += 4 * 13) { s += d[i] + d[i + 1] + d[i + 2]; n += 3; }
        res(s / Math.max(1, n) < 4);
      } catch { res(false); }
    };
    img.onerror = () => res(false);
    img.src = dataUrl;
  });
}

// take the File back from a stored handle; resume the proxy build if needed
async function adoptHandleFile(m) {
  const f = await m.handle.getFile();
  m.file = f; m.url = URL.createObjectURL(f); m.playable = true;
  if (m.proxyReady) return;
  m.proxyStatus = null;
  if (el('autoProxy')?.checked) queueProxy(m, false); else updateCard(m);
}

// gesture path: 'prompt' permission needs a user click — used by the card click
async function relinkFromHandle(m) {
  if (!m || m.file || !m.handle) return false;
  try {
    let perm = await m.handle.queryPermission({ mode: 'read' });
    if (perm === 'prompt') perm = await m.handle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') return false;
    await adoptHandleFile(m);
    bus.emit('media:changed');
    return true;
  } catch { return false; }
}

function selectMedia(id) {
  state.selectedMediaId = id;
  const m = getMedia(id);
  if (m && !m.file && m.handle) {
    relinkFromHandle(m).then((ok) => { if (ok) { toast('Re-linked ' + m.name); selectMedia(id); } });
  }
  el('mediaInspector').style.display = m ? '' : 'none';
  if (!m) return;
  const v = el('mediaPreview');
  const src = (m.proxyReady && m.proxyUrl) ? m.proxyUrl : m.url;
  if (src) v.src = src; else v.removeAttribute('src');
  el('mediaMeta').innerHTML = [
    `<b>${m.name}</b>`,
    `${m.width}×${m.height} · ${fmtTC(m.duration)}`,
    `proxy: ${m.proxyStatus || 'none'}${m.proxyMethod ? ` (${m.proxyMethod})` : ''}`,
    m.proxyError ? `<span style="color:var(--danger)">${m.proxyError}</span>` : '',
  ].filter(Boolean).join('<br>');
  renderGrid();
}
