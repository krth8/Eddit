// Multi-track timeline: render V/A lanes, drag clips (move / trim), razor split,
// drag & drop from the pool, per-clip inspector (speed / volume / pitch / mute).
import {
  state, allClips, getMedia, getClip, findClipRef, removeClip, addClipAt,
  clipTLDur, clipEnd, srcDur, timelineDuration, videoProgram, programAt,
  ensureVideoTracks, ensureAudioTracks, defaultTransform, isGraded, bus,
  resolveOverwrite,
} from '../state.js';
import { el, $$, fmtShort, fmtTC, clamp, toast } from '../util.js';
import { getPeaks, drawWave } from './waveform.js';
import { toggleSheet, openSheet, isNarrow } from '../layout.js';
import { wireHoverScrub, applyThumbStyle } from '../tabs/media.js';
import { TITLE_FONTS, TITLE_ANIMS } from './title.js';

let engine = null;
let pxPerSec = 40;
let touchPanning = false;   // finger-pan scrub in progress (centered playhead)

const isTouchUI = () => document.documentElement.hasAttribute('data-touch');
// on touch layouts the lanes are shifted right by half a viewport so time 0 can
// sit under the CENTERED playhead; scrollLeft maps 1:1 to playhead time
const tlPad = () => { const sc = el('tlScroll'); return isTouchUI() && sc ? Math.round(sc.clientWidth / 2) : 0; };

export function initTimeline(eng) {
  engine = eng;
  const scroll = el('tlScroll');

  el('tlZoom').addEventListener('input', (e) => {
    // anchor the zoom on the playhead (or the view centre when the playhead is
    // off-screen) so zooming in/out keeps your bearings instead of drifting
    const r = scroll.getBoundingClientRect();
    const phX = state.playhead * pxPerSec + tlPad() - scroll.scrollLeft;
    const onScreen = phX >= 0 && phX <= r.width;
    const anchorT = onScreen ? state.playhead : (scroll.scrollLeft + r.width / 2 - tlPad()) / pxPerSec;
    const anchorX = onScreen ? phX : r.width / 2;
    pxPerSec = 20 * parseFloat(e.target.value);
    render();
    scroll.scrollLeft = Math.max(0, anchorT * pxPerSec + tlPad() - anchorX);
  });

  // live scrub on ruler + playhead
  const timeAt = (e) => Math.max(0, (e.clientX - el('tlInner').getBoundingClientRect().left) / pxPerSec);
  const beginScrub = (e) => {
    engine.startScrub(); engine.scrub(timeAt(e)); renderPlayhead();
    const mv = (ev) => { engine.scrub(timeAt(ev)); renderPlayhead(); };
    const up = () => { engine.endScrub(); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  el('tlRuler').addEventListener('pointerdown', beginScrub);
  el('tlPlayhead').addEventListener('pointerdown', (e) => { e.stopPropagation(); beginScrub(e); });
  // click/drag on EMPTY lane space also scrubs (mouse/pen) — so only clicking a
  // clip moves a clip; touch keeps the pan-scrub gesture handled elsewhere
  el('tlLanes').addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && isTouchUI()) return;
    if (e.target.closest('.tl-clip') || e.target.closest('.tl-addrow')) return;   // +/− rows are buttons, not scrub area
    beginScrub(e);
  });

  // ── vertical zoom: CONTINUOUS track height via --tlVH/--tlAH (28..88px).
  // Toolbar button cycles presets, Alt+scroll nudges, and on touch the strip
  // along the timeline's right edge drags it smoothly. Persisted.
  const VMIN = 28, VMAX = 88, VPRESETS = [32, 50, 78];
  let laneV = parseInt(localStorage.getItem('eddit.laneHpx'), 10)
    || ({ s: 32, m: 50, l: 78 }[localStorage.getItem('eddit.laneH')] || 50);
  const laneVars = () => {
    laneV = clamp(Math.round(laneV), VMIN, VMAX);
    document.documentElement.style.setProperty('--tlVH', laneV + 'px');
    document.documentElement.style.setProperty('--tlAH', Math.round(laneV * 0.68) + 'px');
    const strip = el('tlVZoom'), kn = strip?.querySelector('i');
    if (kn && strip.clientHeight > 40) {
      kn.style.top = (2 + (1 - (laneV - VMIN) / (VMAX - VMIN)) * (strip.clientHeight - 34)) + 'px';
    }
    const b = el('toolLaneH');
    if (b) b.title = `Track height ${laneV}px — click to cycle, Alt+scroll to adjust`;
  };
  const laneApply = () => { laneVars(); localStorage.setItem('eddit.laneHpx', String(laneV)); render(); };
  if (el('toolLaneH')) el('toolLaneH').onclick = () => {
    laneV = VPRESETS.find((v) => v > laneV + 2) ?? VPRESETS[0];
    laneApply();
  };
  scroll.addEventListener('wheel', (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    laneV += e.deltaY < 0 ? 8 : -8;
    laneApply();
  }, { passive: false });
  const vz = el('tlVZoom');
  if (vz) vz.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    // RELATIVE drag (b33 slider philosophy): no snap-to-finger on touch —
    // wherever you grab, dragging up grows the tracks and down shrinks them
    const r = vz.getBoundingClientRect();
    const y0 = e.clientY, v0 = laneV;
    const drag = (ev) => {
      laneV = v0 - ((ev.clientY - y0) / Math.max(1, r.height - 34)) * (VMAX - VMIN);
      laneVars();                    // cheap while dragging: CSS vars + knob only
    };
    const up = () => {
      window.removeEventListener('pointermove', drag); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      localStorage.setItem('eddit.laneHpx', String(laneV));
      render();                      // waveforms re-fit to the final height
    };
    window.addEventListener('pointermove', drag); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });
  laneVars();
  requestAnimationFrame(laneVars);   // knob position once the strip has layout

  // ── FINGER pan-scrub (phones/tablets): drag the timeline left/right and the
  // content moves under a playhead that stays centered — mobile-editor style.
  // Pen/stylus and mouse keep the classic behaviour (drag the playhead/ruler),
  // and a finger on a CLIP still moves the clip. Capture phase so the ruler's
  // classic scrub never sees finger input.
  let pinch = null;
  scroll.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (e.target.closest('.tl-clip') || e.target.closest('.tl-marker') || e.target.closest('.tl-ioflag') || e.target.closest('.tl-addrow')) return;  // clip/marker/IO-flag/track-button gestures win
    e.stopPropagation();
    touchPanning = true;
    const startX = e.clientX, startScroll = scroll.scrollLeft;
    const startY = e.clientY, startTop = scroll.scrollTop;
    engine.startScrub();
    const mv = (ev) => {
      if (pinch) { up(); return; }                     // second finger → pinch owns the gesture
      scroll.scrollLeft = startScroll - (ev.clientX - startX);
      scroll.scrollTop = startTop - (ev.clientY - startY);   // free pan: vertical scrolls the tracks
      const t = Math.max(0, Math.min(timelineDuration(), scroll.scrollLeft / pxPerSec));
      engine.scrub(t); renderPlayhead();
    };
    const up = () => {
      touchPanning = false;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      engine.endScrub();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }, true);

  // two-finger pinch zoom on the timeline (touch) — keeps the time under the
  // pinch centre stationary; the zoom slider stays in sync
  let pinchRaf = 0;
  const tDist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  scroll.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    engine.endScrub?.();
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    // time under the pinch centre — inner's rect already includes the touch pad
    pinch = { d: tDist(e), pps: pxPerSec, tMid: (midX - el('tlInner').getBoundingClientRect().left) / pxPerSec };
  }, { passive: true });
  scroll.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const next = clamp(pinch.pps * (tDist(e) / pinch.d), 10, 240);
    if (Math.abs(next - pxPerSec) < 0.5 || pinchRaf) return;
    pinchRaf = requestAnimationFrame(() => {
      pinchRaf = 0;
      pxPerSec = next;
      const z = el('tlZoom'); if (z) z.value = clamp(next / 20, parseFloat(z.min), parseFloat(z.max));
      render();
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      scroll.scrollLeft = Math.max(0, pinch.tMid * pxPerSec + tlPad() - (midX - scroll.getBoundingClientRect().left));
    });
  }, { passive: false });
  const pinchEnd = (e) => { if (e.touches.length < 2) pinch = null; };
  scroll.addEventListener('touchend', pinchEnd);
  scroll.addEventListener('touchcancel', pinchEnd);

  // "+" add-clip picker (replaces double-click-to-add — too many accidents)
  // "+" opens the Media / Toolbox drawer (pick clips or tools). On wide layouts
  // that panel is the persistent left sidebar, so just flag it; on narrow it's a
  // sheet/drawer we toggle.
  el('toolAddClip').onclick = (e) => {
    e.stopPropagation();
    const side = document.querySelector('#edit .side');
    if (getComputedStyle(side).position === 'static') { side.classList.add('flash'); setTimeout(() => side.classList.remove('flash'), 600); }
    else toggleSheet();
  };

  // pool view toggle
  $$('#poolViewToggle button').forEach((b) => b.onclick = () => {
    $$('#poolViewToggle button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); el('editPool').classList.toggle('list', b.dataset.v === 'list'); renderPool();
  });
  el('poolSearch').addEventListener('input', renderPool);
  // thumbnail-size slider (persisted, like the Media tab's)
  const ps = el('poolSize');
  if (ps) {
    const applyW = (v) => el('editPool').style.setProperty('--pw', v + 'px');
    ps.value = parseInt(localStorage.getItem('eddit.poolW'), 10) || 110;
    applyW(ps.value);
    ps.oninput = () => { applyW(ps.value); localStorage.setItem('eddit.poolW', ps.value); };
  }

  bus.on('timeline:changed', render);
  bus.on('media:changed', renderPool);
  bus.on('thumbs:baked', renderPool);   // thumbnail-look bakes are display-only
  render(); renderPool();
}

const snapTargets = () => { const t = [0, state.playhead]; for (const x of allClips()) t.push(x.clip.start, clipEnd(x.clip)); return t; };
function snap(t, exceptId) {
  if (!state.snap) return t;
  const tol = 7 / pxPerSec; let best = t, bd = tol;
  for (const tg of snapTargets()) { if (Math.abs(tg - t) < bd) { bd = Math.abs(tg - t); best = tg; } }
  return best;
}

export function selectClip(id) { state.selectedClipId = id; bus.emit('clip:selected', id); renderInspector(); render(); }

// drag an In/Out ruler flag — live-reposition cheaply, full render on release
function ioDrag(which) {
  return (e) => {
    e.stopPropagation(); e.preventDefault();
    const mv = (ev) => {
      const dur = timelineDuration();
      let t = clamp((ev.clientX - el('tlInner').getBoundingClientRect().left) / pxPerSec, 0, dur);
      t = snap(t);
      if (which === 'in') state.inPoint = Math.min(t, (state.outPoint ?? dur) - 0.05);
      else state.outPoint = Math.max(t, (state.inPoint ?? 0) + 0.05);
      updateIOVisuals();
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      bus.emit('io:changed'); render();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
}
function updateIOVisuals() {
  const rl = el('tlRuler');
  const fi = rl.querySelector('.tl-ioflag.in'), fo = rl.querySelector('.tl-ioflag.out');
  if (fi && state.inPoint != null) fi.style.left = state.inPoint * pxPerSec + 'px';
  if (fo && state.outPoint != null) fo.style.left = state.outPoint * pxPerSec + 'px';
  const band = el('tlInner').querySelector('.tl-io');
  if (band && state.inPoint != null && state.outPoint != null) {
    band.style.left = state.inPoint * pxPerSec + 'px';
    band.style.width = Math.max(0, (state.outPoint - state.inPoint) * pxPerSec) + 'px';
  }
}

function splitClip(id, tlTime) {
  const c = getClip(id); if (!c) return;
  const ref = findClipRef(id); if (!ref) return;
  const off = tlTime - c.start;
  if (off <= 0.05 || off >= clipTLDur(c) - 0.05) return;
  const splitSrc = c.in + off * (c.speed || 1);
  const right = { ...structuredClone(c), id: 'c_' + Math.random().toString(36).slice(2), in: splitSrc, start: tlTime };
  c.out = splitSrc;
  // fades stay with the end they belong to; the dissolve stays on the left edge
  right.fadeIn = 0; right.transIn = 0; c.fadeOut = 0;
  // keyframe times are clip-relative — split them between the halves and
  // re-base the right half's to its new start
  if (Array.isArray(c.keyframes) && c.keyframes.length) {
    right.keyframes = c.keyframes.filter((k) => k.t >= off - 1e-3).map((k) => ({ t: Math.max(0, k.t - off), tf: structuredClone(k.tf) }));
    c.keyframes = c.keyframes.filter((k) => k.t <= off + 1e-3);
    if (!right.keyframes.length) delete right.keyframes;
    if (!c.keyframes.length) delete c.keyframes;
  }
  state.grades[right.id] = structuredClone(state.grades[c.id]);
  ref.track.clips.push(right);
  bus.emit('timeline:changed');
}

function laneUnder(clientY, kind) {
  const lanes = [...document.querySelectorAll(`.tl-track[data-kind="${kind}"]`)];
  for (const lane of lanes) { const r = lane.getBoundingClientRect(); if (clientY >= r.top && clientY <= r.bottom) return lane; }
  return null;
}

// During drags only the moved element's style is touched; the full re-render
// (plus autosave/history via timeline:changed) happens once on pointerup —
// rebuilding every lane per mousemove made dragging janky, badly so on mobile.
function moveClip(id, e) {
  const ref = findClipRef(id); if (!ref) return;
  const c = ref.clip;
  const startX = e.clientX, start0 = c.start;
  let clipEl = document.querySelector(`.tl-clip[data-id="${id}"]`);
  clipEl?.classList.add('moving');
  const mv = (ev) => {
    const dt = (ev.clientX - startX) / pxPerSec;
    c.start = Math.max(0, snap(start0 + dt, id));
    // cross-track move within the same kind
    const lane = laneUnder(ev.clientY, ref.kind);
    let laneChanged = false;
    if (lane) {
      const ti = +lane.dataset.index;
      const list = ref.kind === 'audio' ? state.tracks.audio : state.tracks.video;
      if (list[ti] && list[ti] !== ref.track) {
        const i = ref.track.clips.indexOf(c); if (i >= 0) ref.track.clips.splice(i, 1);
        list[ti].clips.push(c); ref.track = list[ti]; ref.trackIndex = ti;
        laneChanged = true;
      }
    }
    if (laneChanged) {
      render();  // the element must move to another lane — rebuild once
      clipEl = document.querySelector(`.tl-clip[data-id="${id}"]`);
      clipEl?.classList.add('moving');
    } else if (clipEl) {
      clipEl.style.left = c.start * pxPerSec + 'px';
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
    resolveOverwrite(ref.track, c);   // landing on other clips trims/splits/deletes them
    bus.emit('timeline:changed');
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}

// Landscape phones dock no inspector — a plain tap on a clip (pointer released
// without dragging) pops the clip settings up as the right-hand drawer instead.
function tapOpensInspector(e) {
  if (!isNarrow() || document.documentElement.getAttribute('data-orient') !== 'landscape') return;
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;
  const mv = (ev) => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) moved = true; };
  const up = () => {
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
    if (!moved) openSheet(document.getElementById('editSide'));
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}

function edgeTrim(id, side, e) {
  const c = getClip(id); if (!c) return;
  const media = getMedia(c.mediaId);
  const sp = c.speed || 1;
  const startX = e.clientX, in0 = c.in, out0 = c.out, start0 = c.start;
  const clipEl = document.querySelector(`.tl-clip[data-id="${id}"]`);
  // trims stop at the neighbours — extending an edge never buries another clip
  const ref = findClipRef(id);
  let prevEnd = 0, nextStart = Infinity;
  if (ref) for (const o of ref.track.clips) {
    if (o.id === id) continue;
    const oe = o.start + clipTLDur(o);
    if (oe <= start0 + 1e-4) prevEnd = Math.max(prevEnd, oe);
    if (o.start >= start0 + clipTLDur(c) - 1e-4) nextStart = Math.min(nextStart, o.start);
  }
  const mv = (ev) => {
    const dTL = (ev.clientX - startX) / pxPerSec;      // timeline seconds moved
    if (side === 'l') {
      const maxTL = clipTLDur(c) - 0.05;
      const dt = clamp(dTL, Math.max(-in0 / sp, prevEnd - start0), maxTL);
      c.in = Math.max(0, in0 + dt * sp); c.start = start0 + dt;
    } else {
      const srcMax = (media?.duration || out0);
      const outCap = nextStart === Infinity ? srcMax : Math.min(srcMax, c.in + (nextStart - c.start) * sp);
      c.out = clamp(out0 + dTL * sp, c.in + 0.05, outCap);
    }
    if (clipEl) {
      clipEl.style.left = c.start * pxPerSec + 'px';
      clipEl.style.width = Math.max(6, clipTLDur(c) * pxPerSec - 2) + 'px';
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
    bus.emit('timeline:changed');
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}

export function render() {
  const lanes = el('tlLanes'); const ruler = el('tlRuler'); const inner = el('tlInner');
  const dur = timelineDuration();
  const pad = tlPad();
  inner.style.width = Math.max(inner.parentElement.clientWidth, dur * pxPerSec + 60 + pad) + 'px';
  // touch: shift the lanes right by half a viewport so the centered playhead
  // can reach time 0; all child coordinates stay untouched
  inner.style.transform = pad ? `translateX(${pad}px)` : '';

  // ruler
  ruler.innerHTML = '';
  const step = pxPerSec > 80 ? 1 : pxPerSec > 30 ? 5 : 10;
  for (let t = 0; t <= dur + step; t += step) {
    const tick = document.createElement('div'); tick.className = 'tick major'; tick.style.left = t * pxPerSec + 'px'; ruler.appendChild(tick);
    const lab = document.createElement('div'); lab.className = 'tlabel'; lab.style.left = t * pxPerSec + 'px'; lab.textContent = fmtShort(t); ruler.appendChild(lab);
  }
  // markers — click to seek, drawn over the ruler
  for (const mk of (state.markers || [])) {
    const el2 = document.createElement('div'); el2.className = 'tl-marker'; el2.style.left = mk.t * pxPerSec + 'px';
    el2.title = 'Marker @ ' + fmtShort(mk.t) + ' — click to seek';
    el2.addEventListener('pointerdown', (e) => { e.stopPropagation(); engine.seek(mk.t); });
    ruler.appendChild(el2);
  }

  // in/out section: DRAGGABLE flags on the ruler + a translucent band across
  // the lanes — grab a flag to slide the section boundary (snapping applies)
  inner.querySelectorAll('.tl-io').forEach((n) => n.remove());
  const ip = state.inPoint, op = state.outPoint;
  if (ip != null) { const f = document.createElement('div'); f.className = 'tl-ioflag in'; f.style.left = ip * pxPerSec + 'px'; f.title = 'In ' + fmtShort(ip) + ' — drag to move'; f.addEventListener('pointerdown', ioDrag('in')); ruler.appendChild(f); }
  if (op != null) { const f = document.createElement('div'); f.className = 'tl-ioflag out'; f.style.left = op * pxPerSec + 'px'; f.title = 'Out ' + fmtShort(op) + ' — drag to move'; f.addEventListener('pointerdown', ioDrag('out')); ruler.appendChild(f); }
  if (ip != null && op != null && op > ip) {
    const band = document.createElement('div'); band.className = 'tl-io';
    band.style.left = ip * pxPerSec + 'px'; band.style.width = (op - ip) * pxPerSec + 'px';
    inner.appendChild(band);
  }

  // lanes: video tracks top-down (highest index on top), then audio.
  // +/− track rows sit sticky-left above the video group and below the audio
  // group; a dark divider band separates the two groups.
  lanes.innerHTML = '';
  lanes.appendChild(trackAddRow('video'));
  for (let i = state.tracks.video.length - 1; i >= 0; i--) lanes.appendChild(buildLane('video', i));
  const gdiv = document.createElement('div'); gdiv.className = 'tl-groupdiv';
  lanes.appendChild(gdiv);
  for (let i = 0; i < state.tracks.audio.length; i++) lanes.appendChild(buildLane('audio', i));
  lanes.appendChild(trackAddRow('audio'));

  el('tCur').textContent = fmtShort(state.playhead);
  el('tTot').textContent = fmtShort(dur);
  const n = allClips().length;
  el('tlInfo').textContent = `${n} clip${n === 1 ? '' : 's'} · ${fmtTC(dur)}`;
  renderPlayhead();
  bus.emit('export:refresh');
}

// sticky-left +/− buttons for a track group. "−" removes the outermost track
// when it's empty (top video track / bottom audio track).
function trackAddRow(kind) {
  const list = kind === 'audio' ? state.tracks.audio : state.tracks.video;
  const row = document.createElement('div');
  row.className = 'tl-addrow';
  const wrap = document.createElement('div');
  wrap.className = 'tl-addwrap';
  const add = document.createElement('button');
  add.className = 'tl-add'; add.textContent = '+';
  add.title = kind === 'video' ? 'Add video track' : 'Add audio track';
  add.onclick = () => {
    (kind === 'video' ? ensureVideoTracks : ensureAudioTracks)(list.length + 1);
    bus.emit('timeline:changed');
  };
  const rm = document.createElement('button');
  rm.className = 'tl-add'; rm.textContent = '−';
  const outer = list[list.length - 1];
  rm.disabled = list.length <= 1 || outer.clips.length > 0;
  rm.title = rm.disabled ? 'Outermost track must be empty to remove' : (kind === 'video' ? 'Remove empty top video track' : 'Remove empty bottom audio track');
  rm.onclick = () => { if (!rm.disabled) { list.pop(); bus.emit('timeline:changed'); } };
  const lbl = document.createElement('span');
  lbl.className = 'tl-addlbl';
  lbl.textContent = kind === 'video' ? 'video' : 'audio';
  wrap.append(add, rm, lbl);
  row.appendChild(wrap);
  return row;
}

function buildLane(kind, index) {
  const lane = document.createElement('div');
  lane.className = 'tl-lane' + (kind === 'audio' ? ' audio' : '');
  // inner <i> gets the chip styling — the label itself stays width:0 so it
  // doesn't shift clip x-coordinates relative to the ruler
  const label = document.createElement('span'); label.className = 'tl-lanelabel'; label.innerHTML = `<i>${(kind === 'video' ? 'V' : 'A') + (index + 1)}</i>`;
  const track = document.createElement('div'); track.className = 'tl-track' + (kind === 'audio' ? ' audio-track' : ''); track.dataset.kind = kind; track.dataset.index = index;
  const list = kind === 'audio' ? state.tracks.audio : state.tracks.video;
  for (const c of list[index].clips) track.appendChild(buildClip(c, kind));

  // interactions
  track.addEventListener('pointerdown', (e) => {
    const clipEl = e.target.closest('.tl-clip'); if (!clipEl) return;
    if (e.target.classList.contains('tl-edge')) return;
    const id = clipEl.dataset.id;
    const tlTime = (e.clientX - el('tlInner').getBoundingClientRect().left) / pxPerSec;
    if (state.tool === 'razor') { splitClip(id, tlTime); return; }
    selectClip(id); moveClip(id, e); tapOpensInspector(e);
  });
  // (drag from the pool is handled by pointer events in poolPointerDrag)
  lane.appendChild(label); lane.appendChild(track);
  return lane;
}

function buildClip(c, kind) {
  const m = getMedia(c.mediaId);
  const isTitle = c.type === 'title';
  const d = document.createElement('div');
  d.className = 'tl-clip' + (kind === 'audio' ? ' audio' : '') + (isTitle ? ' title' : '') + (c.id === state.selectedClipId ? ' cur' : '') + ((c.speed || 1) !== 1 ? ' speed' : '')
    + (kind === 'video' && isGraded(state.grades[c.id]) ? ' graded' : '');
  d.dataset.id = c.id;
  d.style.left = c.start * pxPerSec + 'px';
  d.style.width = Math.max(6, clipTLDur(c) * pxPerSec - 2) + 'px';
  if (kind === 'video' && !isTitle && m?.thumb) d.style.backgroundImage = `url(${m.thumb})`;
  if ((c.speed || 1) !== 1) d.dataset.speed = (c.speed).toFixed(2) + '×';
  const w = Math.max(6, clipTLDur(c) * pxPerSec - 2);
  const fi = Math.max(0, c.fadeIn || 0) * pxPerSec, fo = Math.max(0, c.fadeOut || 0) * pxPerSec;
  const label = isTitle ? ('T ' + (c.title?.text || 'Title').split('\n')[0]) : (m?.name || 'clip');
  d.innerHTML = `<span class="tl-name">${label}${c.mute ? ' 🔇' : ''}</span>`
    + `<span class="fade-tri in" style="width:${fi}px"></span><span class="fade-tri out" style="width:${fo}px"></span>`
    + `<span class="fade-h in" style="left:${fi}px"></span><span class="fade-h out" style="left:${w - fo}px"></span>`
    + (c.transIn > 0 ? `<span class="trans-mark" style="width:${c.transIn * pxPerSec}px"></span>` : '')
    + ((c.keyframes && c.keyframes.length) ? c.keyframes.map((k) => `<span class="kf-mark" style="left:${k.t * pxPerSec}px"></span>`).join('') : '')
    + `<span class="tl-edge l"></span><span class="tl-edge r"></span>`;
  if (!c.mute && !isTitle) attachWave(d, c, m, kind);
  d.querySelector('.tl-edge.l').addEventListener('pointerdown', (e) => { e.stopPropagation(); selectClip(c.id); edgeTrim(c.id, 'l', e); });
  d.querySelector('.tl-edge.r').addEventListener('pointerdown', (e) => { e.stopPropagation(); selectClip(c.id); edgeTrim(c.id, 'r', e); });
  d.querySelector('.fade-h.in').addEventListener('pointerdown', (e) => { e.stopPropagation(); selectClip(c.id); fadeDrag(c, 'in', e); });
  d.querySelector('.fade-h.out').addEventListener('pointerdown', (e) => { e.stopPropagation(); selectClip(c.id); fadeDrag(c, 'out', e); });
  return d;
}

// drag a fade handle horizontally → set fadeIn / fadeOut (seconds on the timeline)
function fadeDrag(c, side, e) {
  e.preventDefault();
  const dur = clipTLDur(c);
  const startX = e.clientX;
  const startVal = side === 'in' ? (c.fadeIn || 0) : (c.fadeOut || 0);
  const clipEl = document.querySelector(`.tl-clip[data-id="${c.id}"]`);
  const move = (ev) => {
    const dx = (ev.clientX - startX) / pxPerSec;
    let v = side === 'in' ? startVal + dx : startVal - dx;   // out grows leftward
    v = Math.max(0, Math.min(dur, v));
    if (side === 'in') c.fadeIn = v; else c.fadeOut = v;
    // keep in+out from overlapping past the clip
    if ((c.fadeIn || 0) + (c.fadeOut || 0) > dur) { if (side === 'in') c.fadeIn = dur - (c.fadeOut || 0); else c.fadeOut = dur - (c.fadeIn || 0); }
    // update just this clip's fade visuals — full render happens on release
    if (clipEl) {
      const wpx = Math.max(6, dur * pxPerSec - 2);
      const fi = Math.max(0, c.fadeIn || 0) * pxPerSec, fo = Math.max(0, c.fadeOut || 0) * pxPerSec;
      const set = (sel, prop, val) => { const n = clipEl.querySelector(sel); if (n) n.style[prop] = val; };
      set('.fade-tri.in', 'width', fi + 'px'); set('.fade-tri.out', 'width', fo + 'px');
      set('.fade-h.in', 'left', fi + 'px'); set('.fade-h.out', 'left', (wpx - fo) + 'px');
    }
    engine.markGradeDirty();
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); bus.emit('timeline:changed'); engine.audio.refresh(); renderInspector(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

// Lazily fetch + paint an audio waveform behind a clip once its width is known.
function attachWave(clipEl, c, m, kind) {
  const w = Math.max(6, Math.round(clipTLDur(c) * pxPerSec - 2));
  const cv = document.createElement('canvas');
  const ah = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tlAH')) || 34;
  cv.className = 'tl-wave'; cv.width = w; cv.height = kind === 'audio' ? Math.max(16, ah - 6) : 22;
  clipEl.insertBefore(cv, clipEl.firstChild);
  getPeaks(m).then((peaks) => {
    if (!peaks || !clipEl.isConnected) return;
    const color = kind === 'audio' ? 'rgba(13,35,24,.55)' : 'rgba(0,0,0,.35)';
    drawWave(cv, peaks, m, c, color);
  }).catch(() => {});
}

let dropline = null;
function showDroplineAt(t) {
  if (!dropline) { dropline = document.createElement('div'); dropline.className = 'tl-dropline'; el('tlInner').appendChild(dropline); }
  dropline.style.left = t * pxPerSec + 'px';
}
function hideDropline() { dropline?.remove(); dropline = null; }

export function renderPlayhead() {
  el('tlPlayhead').style.left = state.playhead * pxPerSec + 'px';
  el('tCur').textContent = fmtShort(state.playhead);
  // touch layouts: keep the playhead centered during playback and finger-pans
  // (a stylus dragging the playhead must NOT recentre the view under the pen)
  if (isTouchUI() && (state.playing || touchPanning)) {
    const sc = el('tlScroll');
    if (sc) sc.scrollLeft = state.playhead * pxPerSec;   // pad == half viewport → 1:1
  }
}

// ---- edit-tab media pool (grid/list, draggable) ----
export function renderPool() {
  const pool = el('editPool'); if (!pool) return;
  const q = (el('poolSearch')?.value || '').toLowerCase();
  pool.innerHTML = '';
  const items = state.media.filter((m) => m.name.toLowerCase().includes(q));
  if (!items.length) { pool.innerHTML = '<div class="statline" style="grid-column:1/-1">No media. Import in the Media tab.</div>'; return; }
  for (const m of items) {
    const d = document.createElement('div');
    d.className = 'pool-thumb';
    d.title = m.name;
    d.innerHTML = `<div class="pt-img">`
      + `<span class="pt-dur">${fmtShort(m.duration)}</span>${m.proxyReady ? '<span class="pt-proxy" title="proxy ready"></span>' : ''}</div>`
      + `<div class="pt-meta"><div class="pt-name"></div><div class="pt-sub">${m.width || '?'}×${m.height || '?'} · ${fmtShort(m.duration)}</div></div>`;
    d.querySelector('.pt-name').textContent = m.name.replace(/\.[a-z0-9]+$/i, '');
    applyThumbStyle(d.querySelector('.pt-img'), m);   // mid-strip frame default
    // hover-scrub like the Media grid (works mid-proxy-build via the original)
    wireHoverScrub(m, d.querySelector('.pt-img'));
    // pointer-based drag so it works with touch (Chrome OS / tablets) too —
    // native HTML5 draggable doesn't fire for touch input
    d.addEventListener('pointerdown', (e) => poolPointerDrag(m, e, d));
    pool.appendChild(d);
  }
}

function appendToTimeline(mediaId) {
  // place at the playhead; if a clip already covers that spot on V1, snap to
  // just after it so nothing overlaps
  let start = Math.max(0, state.playhead || 0);
  for (const cc of [...state.tracks.video[0].clips].sort((a, b) => a.start - b.start)) {
    if (start >= cc.start - 1e-4 && start < clipEnd(cc) - 1e-4) start = clipEnd(cc);
  }
  const c = addClipAt(mediaId, { kind: 'video', trackIndex: 0, start });
  if (c) selectClip(c.id);
}

// tap-to-add clip picker (mobile/tablet); stylus/desktop can still drag the pool
function closeClipPicker() { document.getElementById('clipPicker')?.remove(); document.removeEventListener('pointerdown', pickerOutside, true); }
function pickerOutside(e) { if (!e.target.closest('#clipPicker') && e.target.id !== 'toolAddClip' && !e.target.closest('#toolAddClip')) closeClipPicker(); }
function openClipPicker(anchor) {
  if (document.getElementById('clipPicker')) { closeClipPicker(); return; }
  const pop = document.createElement('div'); pop.className = 'clip-picker'; pop.id = 'clipPicker';
  if (!state.media.length) {
    pop.innerHTML = '<div class="statline" style="padding:14px">No media yet — import in the Media tab.</div>';
  } else {
    const head = document.createElement('div'); head.className = 'cp-head'; head.textContent = 'Add clip to timeline';
    pop.appendChild(head);
    for (const m of state.media) {
      const row = document.createElement('button'); row.className = 'cp-item';
      row.innerHTML = `<span class="cp-thumb" ${m.thumb ? `style="background-image:url(${m.thumb})"` : ''}></span>`
        + `<span class="cp-name">${m.name}</span><span class="cp-dur">${fmtShort(m.duration)}</span>`;
      row.onclick = () => { appendToTimeline(m.id); closeClipPicker(); toast('Added ' + m.name); };
      pop.appendChild(row);
    }
  }
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 10)) + 'px';
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 10) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', pickerOutside, true), 0);
}

// touch/mouse drag from the pool onto a timeline track
function poolPointerDrag(m, e, thumb) {
  if (e.button != null && e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let dragging = false, ghost = null;
  const trackAt = (x, y) => { const el2 = document.elementFromPoint(x, y); return el2 && el2.closest ? el2.closest('.tl-track') : null; };
  let laneGhost = null;   // clip-length preview rect inside the timeline
  const start = (ev) => {
    dragging = true;
    thumb.classList.add('dragging');
    ghost = document.createElement('div'); ghost.className = 'drag-ghost'; ghost.textContent = m.name;
    document.body.appendChild(ghost);
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
    thumb.classList.remove('dragging'); ghost?.remove(); laneGhost?.remove(); laneGhost = null;
    document.querySelectorAll('.tl-lane.drop').forEach((l) => l.classList.remove('drop'));
    hideDropline();
  };
  const cancel = () => cleanup();
  const move = (ev) => {
    if (!dragging) {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (Math.hypot(dx, dy) <= 6) return;
      // touch: a mostly-vertical first move means the user is scrolling the
      // pool — hand the gesture back to the browser (thumbs are pan-y now)
      if (ev.pointerType === 'touch' && Math.abs(dy) > Math.abs(dx)) { cleanup(); return; }
      start(ev);
    }
    ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
    const track = trackAt(ev.clientX, ev.clientY);
    document.querySelectorAll('.tl-lane.drop').forEach((l) => l.classList.remove('drop'));
    if (track) {
      track.parentElement.classList.add('drop');
      const innerR = el('tlInner').getBoundingClientRect();
      const t = Math.max(0, snap((ev.clientX - innerR.left) / pxPerSec));
      showDroplineAt(t);
      // ghost rect previews the clip's real footprint before the drop
      if (!laneGhost) { laneGhost = document.createElement('div'); laneGhost.className = 'tl-ghostclip'; el('tlInner').appendChild(laneGhost); }
      const tr = track.getBoundingClientRect();
      laneGhost.style.left = t * pxPerSec + 'px';
      laneGhost.style.width = Math.max(8, (m.duration || 5) * pxPerSec) + 'px';
      laneGhost.style.top = (tr.top - innerR.top) + 'px';
      laneGhost.style.height = tr.height + 'px';
      laneGhost.style.display = '';
    } else { hideDropline(); if (laneGhost) laneGhost.style.display = 'none'; }
  };
  const up = (ev) => {
    cleanup();
    if (!dragging) { appendToTimeline(m.id); toast('Added ' + m.name); return; } // tap = add to the end
    const track = trackAt(ev.clientX, ev.clientY);
    if (track) {
      const start2 = Math.max(0, snap((ev.clientX - el('tlInner').getBoundingClientRect().left) / pxPerSec));
      const clip = addClipAt(m.id, { kind: track.dataset.kind, trackIndex: +track.dataset.index, start: start2 });
      if (clip) selectClip(clip.id);
    }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
}

// capture the clip's current transform as a keyframe at the playhead (clip-time)
function upsertKeyframe(clip, tlTime) {
  if (!clip.keyframes) clip.keyframes = [];
  const ct = Math.max(0, tlTime - clip.start);
  const tf = { ...(clip.transform || defaultTransform()) };
  const ex = clip.keyframes.find((k) => Math.abs(k.t - ct) < 0.05);
  if (ex) ex.tf = tf; else clip.keyframes.push({ t: ct, tf });
  clip.keyframes.sort((a, b) => a.t - b.t);
}

// ---- per-clip inspector ----
export function renderInspector() {
  const box = el('clipInspector'); const body = el('clipInsBody');
  const empty = el('clipInsEmpty');
  const c = state.selectedClipId ? getClip(state.selectedClipId) : null;
  if (!c) { box.style.display = 'none'; if (empty) empty.style.display = ''; return; }
  if (empty) empty.style.display = 'none';
  if (!c.transform) c.transform = defaultTransform();
  const t = c.transform;
  const m = getMedia(c.mediaId);
  const isAudio = findClipRef(c.id)?.kind === 'audio';
  const isTitle = c.type === 'title';
  box.style.display = '';
  const deg = Math.round((t.rotation || 0) * 180 / Math.PI);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sr = (label, id, min, max, step, val, disp, def = 0) =>
    `<div class="slider-row"><label>${label}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" data-default="${def}"><span class="val">${disp}</span></div>`;
  const ti = c.title || {};
  body.innerHTML = `
    <div class="ins-title">${isTitle ? 'Text · ' + esc((ti.text || 'Title').split('\n')[0]) : (m?.name || 'clip')}</div>
    ${isTitle ? `<details class="ins-grp" open><summary>Text</summary>
      <textarea id="ti_text" class="ti-text" rows="2" placeholder="Title text">${esc(ti.text)}</textarea>
      ${sr('Size', 'ti_size', 0.03, 0.25, 0.005, ti.size ?? 0.09, Math.round((ti.size ?? 0.09) * 100), 0.09)}
      ${sr('Y position', 'ti_y', 0.1, 0.9, 0.01, ti.y ?? 0.5, (ti.y ?? 0.5).toFixed(2), 0.5)}
      <div class="row" style="gap:10px;margin-top:8px">
        <label class="ti-lbl">Font <select id="ti_font" style="max-width:120px">
          ${TITLE_FONTS.map((f) => `<option value="${esc(f.css)}" ${(ti.font || TITLE_FONTS[0].css) === f.css ? 'selected' : ''} style="font-family:${esc(f.css)}">${f.label}</option>`).join('')}
        </select></label>
        <label class="ti-lbl">Weight <select id="ti_weight">
          <option value="400" ${(ti.weight || 700) === 400 ? 'selected' : ''}>Regular</option>
          <option value="700" ${(ti.weight || 700) === 700 ? 'selected' : ''}>Bold</option>
          <option value="900" ${(ti.weight || 700) === 900 ? 'selected' : ''}>Black</option></select></label>
      </div>
      <div class="row" style="gap:10px;margin-top:8px">
        <label class="ti-lbl">Colour <input type="color" id="ti_color" value="${ti.color || '#ffffff'}"></label>
        <label class="ti-lbl">Align <select id="ti_align">
          <option value="left" ${ti.align === 'left' ? 'selected' : ''}>Left</option>
          <option value="center" ${(ti.align || 'center') === 'center' ? 'selected' : ''}>Center</option>
          <option value="right" ${ti.align === 'right' ? 'selected' : ''}>Right</option></select></label>
      </div>
      ${sr('Backdrop', 'ti_bg', 0, 1, 0.05, ti.bgOpacity ?? 0, Math.round((ti.bgOpacity ?? 0) * 100), 0)}
      ${sr('Shadow', 'ti_shadow', 0, 1, 0.05, (typeof ti.shadowAmt === 'number' ? ti.shadowAmt : (ti.shadow !== false ? 0.65 : 0)), Math.round((typeof ti.shadowAmt === 'number' ? ti.shadowAmt : 0.65) * 100), 0.65)}
      ${sr('Outline', 'ti_outline', 0, 0.15, 0.005, ti.outline ?? 0, Math.round((ti.outline ?? 0) * 200), 0)}
      <div class="row" style="gap:10px;margin-top:4px">
        <label class="ti-lbl">Outline colour <input type="color" id="ti_outlinecolor" value="${ti.outlineColor || '#000000'}"></label>
      </div>
      <div class="row" style="gap:10px;margin-top:8px">
        <label class="ti-lbl">Animation <select id="ti_anim">
          ${TITLE_ANIMS.map((a) => `<option value="${a.id}" ${(ti.anim || 'none') === a.id ? 'selected' : ''}>${a.label}</option>`).join('')}
        </select></label>
      </div>
      <div class="ar-wrap" id="ti_ar">
        <div class="ar-cap"><span id="ti_arin"></span><span class="ar-mid">in · hold · out</span><span id="ti_arout"></span></div>
        <div class="ar-track"><div class="ar-fill"></div><i class="ar-knob" data-k="in"></i><i class="ar-knob" data-k="out"></i></div>
      </div>
    </details>` : ''}
    ${isAudio ? '' : `<details class="ins-grp" open><summary>Transform</summary>
      ${sr('Position X', 'tf_x', -1, 1, 0.005, t.x, t.x.toFixed(2), 0)}
      ${sr('Position Y', 'tf_y', -1, 1, 0.005, t.y, t.y.toFixed(2), 0)}
      ${sr('Scale / zoom', 'tf_scale', 0.1, 4, 0.01, t.scale, t.scale.toFixed(2) + '×', 1)}
      ${sr('Rotation', 'tf_rot', -180, 180, 1, deg, deg + '°', 0)}
      ${sr('Opacity', 'tf_op', 0, 1, 0.01, t.opacity, Math.round(t.opacity * 100) + '%', 1)}
      ${sr('Crop L', 'tf_cl', 0, 0.5, 0.005, t.cropL, Math.round(t.cropL * 100) + '%', 0)}
      ${sr('Crop R', 'tf_cr', 0, 0.5, 0.005, t.cropR, Math.round(t.cropR * 100) + '%', 0)}
      ${sr('Crop T', 'tf_ct', 0, 0.5, 0.005, t.cropT, Math.round(t.cropT * 100) + '%', 0)}
      ${sr('Crop B', 'tf_cb', 0, 0.5, 0.005, t.cropB, Math.round(t.cropB * 100) + '%', 0)}
      <div class="row" style="gap:6px;margin-top:8px">
        <button class="ghost" id="tf_key" style="flex:1">◆ Keyframe</button>
        <button class="ghost" id="tf_keyclr" ${c.keyframes && c.keyframes.length ? '' : 'disabled'}>Clear</button>
      </div>
      <div class="statline" id="tf_keyinfo" style="margin-top:4px">${c.keyframes && c.keyframes.length ? c.keyframes.length + ' keyframes — animating' : 'Static — add keyframes at the playhead to animate'}</div>
      <button class="ghost" id="tf_reset" style="width:100%;margin-top:6px">Reset transform</button>
    </details>`}
    ${isAudio ? '' : `<details class="ins-grp"><summary>Transition</summary>
      ${sr('Dissolve in', 'ins_transIn', 0, 2, 0.05, c.transIn || 0, (c.transIn || 0).toFixed(2) + ' s', 0)}
      <p class="statline" style="margin:6px 0 0">Cross-dissolves from the previous clip on this track.</p>
    </details>`}
    ${isTitle ? `<details class="ins-grp" open><summary>Fade</summary>
      ${sr('Fade in', 'ins_fadeIn', 0, 5, 0.05, c.fadeIn || 0, (c.fadeIn || 0).toFixed(2) + ' s', 0)}
      ${sr('Fade out', 'ins_fadeOut', 0, 5, 0.05, c.fadeOut || 0, (c.fadeOut || 0).toFixed(2) + ' s', 0)}
    </details>` : `<details class="ins-grp" open><summary>Speed &amp; audio</summary>
      ${sr('Speed', 'ins_speed', 0.25, 4, 0.05, c.speed || 1, (c.speed || 1).toFixed(2) + '×', 1)}
      ${sr('Volume', 'ins_volume', 0, 1, 0.01, c.volume ?? 1, Math.round((c.volume ?? 1) * 100) + '%', 1)}
      ${sr('Pitch', 'ins_pitch', -12, 12, 1, c.pitch || 0, (c.pitch || 0) + ' st', 0)}
      ${sr('Fade in', 'ins_fadeIn', 0, 5, 0.05, c.fadeIn || 0, (c.fadeIn || 0).toFixed(2) + ' s', 0)}
      ${sr('Fade out', 'ins_fadeOut', 0, 5, 0.05, c.fadeOut || 0, (c.fadeOut || 0).toFixed(2) + ' s', 0)}
      <label class="row" style="gap:7px;margin-top:8px;color:var(--text-secondary)"><input type="checkbox" id="ins_mute" ${c.mute ? 'checked' : ''}>Mute</label>
    </details>`}
    <div class="ins-actions"><button class="ghost" id="ins_del">Delete clip</button></div>`;

  if (isTitle) {
    const upT = () => { engine.markGradeDirty(); bus.emit('timeline:changed'); render(); };
    el('ti_text').oninput = (e) => { c.title.text = e.target.value; engine.markGradeDirty(); bus.emit('timeline:changed'); };
    el('ti_size').oninput = (e) => { c.title.size = parseFloat(e.target.value); e.target.nextElementSibling.textContent = Math.round(c.title.size * 100); engine.markGradeDirty(); bus.emit('timeline:changed'); };
    el('ti_y').oninput = (e) => { c.title.y = parseFloat(e.target.value); e.target.nextElementSibling.textContent = c.title.y.toFixed(2); engine.markGradeDirty(); bus.emit('timeline:changed'); };
    el('ti_color').oninput = (e) => { c.title.color = e.target.value; engine.markGradeDirty(); bus.emit('timeline:changed'); };
    el('ti_align').onchange = (e) => { c.title.align = e.target.value; upT(); };
    el('ti_font').onchange = (e) => { c.title.font = e.target.value; upT(); };
    el('ti_weight').onchange = (e) => { c.title.weight = parseInt(e.target.value, 10); upT(); };
    el('ti_shadow').oninput = (e) => { c.title.shadowAmt = parseFloat(e.target.value); e.target.nextElementSibling.textContent = Math.round(c.title.shadowAmt * 100); engine.markGradeDirty(); bus.emit('timeline:changed'); };
    el('ti_outline').oninput = (e) => { c.title.outline = parseFloat(e.target.value); e.target.nextElementSibling.textContent = Math.round(c.title.outline * 200); engine.markGradeDirty(); bus.emit('timeline:changed'); };
    el('ti_outlinecolor').oninput = (e) => { c.title.outlineColor = e.target.value; engine.markGradeDirty(); bus.emit('timeline:changed'); };
    el('ti_anim').onchange = (e) => { c.title.anim = e.target.value; engine.seek(state.playhead); upT(); };
    // dual-handle animation range: [0..in-knob] = intro, middle = hold,
    // [out-knob..end] = outro — mapped over the clip's timeline duration
    {
      const ar = el('ti_ar');
      const track = ar.querySelector('.ar-track'), fillEl = ar.querySelector('.ar-fill');
      const kin = ar.querySelector('.ar-knob[data-k="in"]'), kout = ar.querySelector('.ar-knob[data-k="out"]');
      const dur = () => Math.max(0.1, clipTLDur(c));
      const sync = () => {
        const d = dur();
        const a = clamp(c.title.animIn ?? c.title.animDur ?? 0.8, 0, d);
        const b = clamp(c.title.animOut ?? c.title.animDur ?? 0.8, 0, d);
        const fa = clamp(a / d, 0, 0.98), fb = clamp(1 - b / d, fa + 0.02, 1);
        kin.style.left = (fa * 100) + '%'; kout.style.left = (fb * 100) + '%';
        fillEl.style.left = (fa * 100) + '%'; fillEl.style.width = ((fb - fa) * 100) + '%';
        el('ti_arin').textContent = 'in ' + a.toFixed(2) + 's';
        el('ti_arout').textContent = 'out ' + b.toFixed(2) + 's';
      };
      const dragKnob = (knob, isIn) => knob.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const mv = (ev) => {
          const r = track.getBoundingClientRect();
          const f = clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
          const d = dur();
          if (isIn) c.title.animIn = clamp(f * d, 0, d - (c.title.animOut ?? 0.8) - 0.05);
          else c.title.animOut = clamp((1 - f) * d, 0, d - (c.title.animIn ?? 0.8) - 0.05);
          sync(); engine.markGradeDirty();
        };
        const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); bus.emit('timeline:changed'); };
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      });
      dragKnob(kin, true); dragKnob(kout, false);
      sync();
    }
    el('ti_bg').oninput = (e) => { c.title.bgOpacity = parseFloat(e.target.value); e.target.nextElementSibling.textContent = Math.round(c.title.bgOpacity * 100); engine.markGradeDirty(); bus.emit('timeline:changed'); };
  }

  const upd = (recalc) => { bus.emit('timeline:changed'); if (recalc) engine.audio.refresh(); };
  // auto-key: once a clip has keyframes, editing a transform re-keys at the playhead
  const afterTf = () => { if (c.keyframes && c.keyframes.length) { upsertKeyframe(c, state.playhead); const info = el('tf_keyinfo'); if (info) info.textContent = c.keyframes.length + ' keyframes — animating'; render(); } engine.markGradeDirty(); bus.emit('timeline:changed'); };
  if (!isAudio) {
    const bindTf = (id, key, disp, map = (v) => v) => el(id).oninput = (e) => { t[key] = map(parseFloat(e.target.value)); e.target.nextElementSibling.textContent = disp(t[key], parseFloat(e.target.value)); afterTf(); };
    bindTf('tf_x', 'x', (v) => v.toFixed(2));
    bindTf('tf_y', 'y', (v) => v.toFixed(2));
    bindTf('tf_scale', 'scale', (v) => v.toFixed(2) + '×');
    el('tf_rot').oninput = (e) => { t.rotation = parseFloat(e.target.value) * Math.PI / 180; e.target.nextElementSibling.textContent = Math.round(parseFloat(e.target.value)) + '°'; afterTf(); };
    bindTf('tf_op', 'opacity', (v) => Math.round(v * 100) + '%');
    bindTf('tf_cl', 'cropL', (v) => Math.round(v * 100) + '%');
    bindTf('tf_cr', 'cropR', (v) => Math.round(v * 100) + '%');
    bindTf('tf_ct', 'cropT', (v) => Math.round(v * 100) + '%');
    bindTf('tf_cb', 'cropB', (v) => Math.round(v * 100) + '%');
    el('tf_reset').onclick = () => { c.transform = defaultTransform(); c.keyframes = []; engine.markGradeDirty(); bus.emit('timeline:changed'); renderInspector(); };
    el('tf_key').onclick = () => { upsertKeyframe(c, state.playhead); render(); engine.markGradeDirty(); bus.emit('timeline:changed'); renderInspector(); };
    if (el('tf_keyclr')) el('tf_keyclr').onclick = () => { c.keyframes = []; render(); engine.markGradeDirty(); bus.emit('timeline:changed'); renderInspector(); };
  }
  if (el('ins_speed')) el('ins_speed').oninput = (e) => { c.speed = parseFloat(e.target.value); e.target.nextElementSibling.textContent = c.speed.toFixed(2) + '×'; upd(true); };
  if (el('ins_volume')) el('ins_volume').oninput = (e) => { c.volume = parseFloat(e.target.value); e.target.nextElementSibling.textContent = Math.round(c.volume * 100) + '%'; engine.audio.setVolume(c); if (engine.cur?.el && engine.cur.clipId === c.id) engine.cur.el.volume = c.volume; bus.emit('timeline:changed'); };
  if (el('ins_pitch')) el('ins_pitch').oninput = (e) => { c.pitch = parseInt(e.target.value, 10); e.target.nextElementSibling.textContent = c.pitch + ' st'; upd(true); };
  if (el('ins_transIn')) el('ins_transIn').oninput = (e) => { c.transIn = parseFloat(e.target.value); e.target.nextElementSibling.textContent = c.transIn.toFixed(2) + ' s'; render(); engine.markGradeDirty(); bus.emit('timeline:changed'); };
  el('ins_fadeIn').oninput = (e) => { c.fadeIn = parseFloat(e.target.value); e.target.nextElementSibling.textContent = c.fadeIn.toFixed(2) + ' s'; upd(true); };
  el('ins_fadeOut').oninput = (e) => { c.fadeOut = parseFloat(e.target.value); e.target.nextElementSibling.textContent = c.fadeOut.toFixed(2) + ' s'; upd(true); };
  if (el('ins_mute')) el('ins_mute').onchange = (e) => { c.mute = e.target.checked; engine.audio.setVolume(c); if (engine.cur?.el && engine.cur.clipId === c.id) engine.cur.el.muted = c.mute; upd(false); };
  el('ins_del').onclick = () => { removeClip(c.id); engine.seek(state.playhead); renderInspector(); };
}

export function deleteSelected() { if (state.selectedClipId) { removeClip(state.selectedClipId); engine.seek(state.playhead); renderInspector(); } }
export function getPxPerSec() { return pxPerSec; }
