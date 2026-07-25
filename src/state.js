// Central app state + change bus. Multi-track timeline model.
import { makeBus, uid } from './util.js';
import { defaultTitle } from './timeline/title.js';

export const bus = makeBus();

export function defaultGrade() {
  return {
    inputTransform: 'none',
    exposure: 0, contrast: 0, saturation: 1, temp: 0, tint: 0, pivot: 0.435,
    // RAW develop offsets (RAW sources only) — composed into exposure/temp/
    // tint ahead of the creative grade, and never carried by presets/copy
    rawExposure: 0, rawTemp: 0, rawTint: 0,
    lift: [0, 0, 0], gamma: [0, 0, 0], gain: [0, 0, 0], offset: [0, 0, 0],
    lut: null, lutName: null, lutMix: 1,
    curves: {
      rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      r: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      g: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      b: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    },
    // HSL curves: 8 hue bands each. hsl = sat multiplier offset (-1..1 → 0..2x),
    // hslHue = hue rotation (-1..1 → ±45°), hslLum = brightness gain.
    hsl: [0, 0, 0, 0, 0, 0, 0, 0],
    hslHue: [0, 0, 0, 0, 0, 0, 0, 0],
    hslLum: [0, 0, 0, 0, 0, 0, 0, 0],
    // Tone: zone gains (shadows/highlights, black point stays anchored) and
    // ACES filmic tone-map blend — for flat footage pushed hard on contrast.
    toneMap: 0, toneSh: 0, toneHi: 0,
    // FX: screen-space vignette + exponential glow (bloom). Amounts of 0 = off;
    // the shape params only matter once the amount is raised.
    vignette: 0, vignetteSize: 0.7, vignetteFeather: 0.5,
    glow: 0, glowThreshold: 0.6, glowRadius: 0.5,
    // distort = turbulence displace; wiggle = smooth position jitter
    distort: 0, distortScale: 0.5, distortSpeed: 0.5,
    wiggle: 0, wiggleFreq: 0.5,
    // secondary mask: qualifier (picked colour ± range) × window shape.
    // The grade applies only inside the mask; maskShow previews the matte.
    maskQ: { on: 0, h: 0, s: 0, y: 0, range: 0.25, soft: 0.12 },
    maskW: { shape: 'off', cx: 0.5, cy: 0.5, rx: 0.35, ry: 0.35, feather: 0.2, angle: 0 },
    maskInvert: false, maskShow: false,
  };
}

// does a grade deviate from defaults? (drives "graded" indicators in the UI)
export function isGraded(g) {
  if (!g) return false;
  const d = defaultGrade();
  if (g.lut || g.inputTransform !== 'none') return true;
  for (const k of ['exposure', 'contrast', 'saturation', 'temp', 'tint', 'pivot']) if (Math.abs(g[k] - d[k]) > 1e-4) return true;
  for (const k of ['toneMap', 'toneSh', 'toneHi']) if (Math.abs((g[k] || 0) - d[k]) > 1e-4) return true;
  for (const k of ['lift', 'gamma', 'gain', 'offset']) if ((g[k] || []).some((v) => Math.abs(v) > 1e-4)) return true;
  if ([...(g.hsl || []), ...(g.hslHue || []), ...(g.hslLum || [])].some((v) => Math.abs(v) > 1e-4)) return true;
  if ((g.vignette || 0) > 1e-4 || (g.glow || 0) > 1e-4) return true;
  if (g.maskQ?.on || (g.maskW?.shape && g.maskW.shape !== 'off')) return true;
  if ((g.distort || 0) > 1e-4 || (g.wiggle || 0) > 1e-4) return true;
  for (const ch of ['rgb', 'r', 'g', 'b']) {
    const c = g.curves?.[ch];
    if (c && (c.length !== 2 || c[0].x !== 0 || c[0].y !== 0 || c[1].x !== 1 || c[1].y !== 1)) return true;
  }
  return false;
}

export const PROJECT_ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '21:9': 21 / 9 };
export function projectDims(maxH = Infinity) {
  const p = state.project || {};
  const ar = PROJECT_ASPECTS[p.format] || 16 / 9;
  const h = Math.round(Math.min(maxH, p.height || 1080) / 2) * 2;
  return [Math.round(h * ar / 2) * 2, h];
}

// Tracks: video[0] = V1 (bottom) … higher index composites on top.
export const state = {
  media: [],
  tracks: { video: [{ id: uid('v'), clips: [] }], audio: [{ id: uid('a'), clips: [] }] },
  grades: {},
  selectedMediaId: null,
  selectedClipId: null,
  playhead: 0,
  playing: false,
  activeTab: 'media',
  tool: 'select',
  snap: true,
  fps: 30,
  // project frame: aspect + master resolution (preview caps at 1080 high;
  // export renders the full height). Clips default to FILL (cover + crop).
  project: { format: '16:9', height: 1080 },
  markers: [],
  masterVolume: 1,
  gradeBypass: false,   // preview-only before/after toggle — never affects export
  inPoint: null,        // I/O section markers (timeline seconds, session-only)
  outPoint: null,
};

// ---- markers (timeline bookmarks) ----
export function toggleMarker(t) {
  if (!state.markers) state.markers = [];
  const near = state.markers.find((m) => Math.abs(m.t - t) < 0.15);
  if (near) state.markers = state.markers.filter((m) => m !== near);
  else state.markers.push({ t, id: uid('mk') });
  state.markers.sort((a, b) => a.t - b.t);
  bus.emit('timeline:changed');
}

// ---- ripple delete: remove a clip and close the gap on its track ----
export function rippleDelete(id) {
  const ref = allClips().find((x) => x.clip.id === id); if (!ref) return;
  const c = ref.clip; const dur = clipTLDur(c); const start = c.start;
  const list = ref.track.clips;
  const idx = list.indexOf(c); if (idx >= 0) list.splice(idx, 1);
  delete state.grades[id];
  for (const other of list) if (other.start >= start - 1e-4) other.start = Math.max(0, other.start - dur);
  if (state.selectedClipId === id) state.selectedClipId = null;
  bus.emit('timeline:changed');
}

export function addMedia(m) { m.id = m.id || uid('m'); state.media.push(m); bus.emit('media:changed'); return m; }
export function getMedia(id) { return state.media.find((m) => m.id === id); }

// ---- clips ----
export function defaultTransform() {
  return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, cropL: 0, cropR: 0, cropT: 0, cropB: 0 };
}
// Clip: {id, mediaId, in, out, start, speed, volume, mute, pitch, kind, transform}
export function makeClip(mediaId, opts = {}) {
  const m = getMedia(mediaId);
  const out = opts.out != null ? opts.out : (m?.duration || 5);
  return {
    id: uid('c'), mediaId, kind: opts.kind || 'video',
    type: opts.type || 'video', title: opts.title || null,
    in: opts.in || 0, out, start: opts.start || 0,
    speed: opts.speed || 1, volume: opts.volume != null ? opts.volume : 1,
    mute: !!opts.mute, pitch: opts.pitch || 0,
    fadeIn: opts.fadeIn || 0, fadeOut: opts.fadeOut || 0,
    transIn: opts.transIn || 0,   // cross-dissolve from the previous same-track clip
    transform: defaultTransform(),
  };
}
export const srcDur = (c) => Math.max(0.02, c.out - c.in);
export const clipTLDur = (c) => srcDur(c) / (c.speed || 1);   // duration on the timeline
export const clipEnd = (c) => c.start + clipTLDur(c);

// transform at timeline time t — interpolated across keyframes, else static.
// clip.keyframes = [{ t: secondsFromClipStart, tf: {x,y,scale,rotation,opacity,crop…} }]
export function effectiveTransform(clip, t) {
  const ks = clip.keyframes;
  if (!ks || !ks.length) return clip.transform || null;
  const ct = t - clip.start;
  const s = ks.length > 1 ? [...ks].sort((a, b) => a.t - b.t) : ks;
  if (ct <= s[0].t) return s[0].tf;
  if (ct >= s[s.length - 1].t) return s[s.length - 1].tf;
  for (let i = 1; i < s.length; i++) {
    if (ct <= s[i].t) {
      const a = s[i - 1], b = s[i], u = (ct - a.t) / Math.max(1e-6, b.t - a.t);
      const L = (k, d = 0) => (a.tf[k] ?? d) + ((b.tf[k] ?? d) - (a.tf[k] ?? d)) * u;
      return { x: L('x'), y: L('y'), scale: L('scale', 1), rotation: L('rotation'), opacity: L('opacity', 1),
        cropL: L('cropL'), cropR: L('cropR'), cropT: L('cropT'), cropB: L('cropB') };
    }
  }
  return s[s.length - 1].tf;
}

// fade envelope 0..1 at timeline time t (drives both audio gain and video opacity)
export function fadeGainAt(c, t) {
  const s = c.start, e = clipEnd(c);
  const fi = Math.max(0, c.fadeIn || 0), fo = Math.max(0, c.fadeOut || 0);
  let g = 1;
  if (fi > 0) g = Math.min(g, (t - s) / fi);
  if (fo > 0) g = Math.min(g, (e - t) / fo);
  return Math.max(0, Math.min(1, g));
}

export function ensureVideoTracks(n) { while (state.tracks.video.length < n) state.tracks.video.push({ id: uid('v'), clips: [] }); }
export function ensureAudioTracks(n) { while (state.tracks.audio.length < n) state.tracks.audio.push({ id: uid('a'), clips: [] }); }

export function trackListFor(kind) { return kind === 'audio' ? state.tracks.audio : state.tracks.video; }

// Overwrite semantics: a placed clip owns its span. Same-track neighbours are
// trimmed out of the way, split when it lands mid-clip, deleted when fully
// covered — two clips never overlap on a track.
export function resolveOverwrite(track, placed) {
  if (!track || !placed) return;
  const ps = placed.start, pe = clipEnd(placed);
  for (const c of [...track.clips]) {
    if (c.id === placed.id) continue;
    const cs = c.start, ce = clipEnd(c);
    if (ce <= ps + 1e-4 || cs >= pe - 1e-4) continue;
    const sp = c.speed || 1;
    if (cs >= ps - 1e-4 && ce <= pe + 1e-4) {
      // fully covered — the clip is gone
      const i = track.clips.indexOf(c); if (i >= 0) track.clips.splice(i, 1);
      delete state.grades[c.id];
      if (state.selectedClipId === c.id) state.selectedClipId = null;
    } else if (cs < ps - 1e-4 && ce > pe + 1e-4) {
      // dropped in the middle — split into head + tail remnants
      const tail = structuredClone(c);
      tail.id = uid('c');
      tail.in = c.in + (pe - cs) * sp;
      tail.start = pe;
      tail.fadeIn = 0; tail.transIn = 0;
      c.out = c.in + (ps - cs) * sp;
      c.fadeOut = 0;
      track.clips.push(tail);
      state.grades[tail.id] = structuredClone(state.grades[c.id] || defaultGrade());
    } else if (cs < ps) {
      c.out = c.in + (ps - cs) * sp;    // tail covered
    } else {
      c.in = c.in + (pe - cs) * sp;     // head covered
      c.start = pe;
    }
  }
}

// add a clip to a specific track index; returns the clip
export function addClipAt(mediaId, { kind = 'video', trackIndex = 0, start = 0, inS = 0, outS = null } = {}) {
  const m = getMedia(mediaId); if (!m) return null;
  const list = trackListFor(kind);
  if (kind === 'video') ensureVideoTracks(trackIndex + 1); else ensureAudioTracks(trackIndex + 1);
  const c = makeClip(mediaId, { kind, start, in: inS, out: outS == null ? (m.duration || 5) : outS });
  list[trackIndex].clips.push(c);
  resolveOverwrite(list[trackIndex], c);
  const g = defaultGrade();
  if (m.inputTransform) g.inputTransform = m.inputTransform;   // media-level default (mixed-camera projects)
  state.grades[c.id] = g;
  bus.emit('timeline:changed');
  return c;
}

// overlay clips (titles/solids) live ABOVE the footage: reuse the TOPMOST
// track when its span is free — a new track only grows when the top one is
// occupied there (adding a title used to spawn a fresh track every time)
function overlayTrackIndex(start, dur) {
  const top = state.tracks.video.length - 1;
  const free = (tr) => !tr.clips.some((c) => start < clipEnd(c) && start + dur > c.start);
  if (top >= 1 && free(state.tracks.video[top])) return top;
  ensureVideoTracks(state.tracks.video.length + 1);
  return state.tracks.video.length - 1;
}

// add a text/title clip on the topmost free overlay track
export function addTitle(start = 0, dur = 5) {
  const ti = overlayTrackIndex(start, dur);
  const c = makeClip(null, { kind: 'video', type: 'title', title: defaultTitle(), start, in: 0, out: dur });
  state.tracks.video[ti].clips.push(c);
  state.grades[c.id] = defaultGrade();
  bus.emit('timeline:changed');
  return c;
}

// solid-colour generator (a title clip that's all backdrop, no text)
export function addSolid(color = '#0e0e12', start = 0, dur = 5) {
  const ti = overlayTrackIndex(start, dur);
  const title = { ...defaultTitle(), text: '', bg: color, bgOpacity: 1 };
  const c = makeClip(null, { kind: 'video', type: 'title', title, start, in: 0, out: dur });
  state.tracks.video[ti].clips.push(c);
  state.grades[c.id] = defaultGrade();
  bus.emit('timeline:changed');
  return c;
}

// append to end of V1 (used by double-click / "add to timeline")
export function appendClip(mediaId) {
  const v = state.tracks.video[0];
  const start = v.clips.reduce((a, c) => Math.max(a, clipEnd(c)), 0);
  return addClipAt(mediaId, { kind: 'video', trackIndex: 0, start });
}

export function allClips() {
  const out = [];
  state.tracks.video.forEach((t, ti) => t.clips.forEach((c) => out.push({ clip: c, kind: 'video', trackIndex: ti, track: t })));
  state.tracks.audio.forEach((t, ti) => t.clips.forEach((c) => out.push({ clip: c, kind: 'audio', trackIndex: ti, track: t })));
  return out;
}
export function getClip(id) { const f = allClips().find((x) => x.clip.id === id); return f ? f.clip : null; }
export function findClipRef(id) { return allClips().find((x) => x.clip.id === id) || null; }

export function removeClip(id) {
  for (const t of [...state.tracks.video, ...state.tracks.audio]) {
    const i = t.clips.findIndex((c) => c.id === id);
    if (i >= 0) { t.clips.splice(i, 1); delete state.grades[id]; if (state.selectedClipId === id) state.selectedClipId = null; bus.emit('timeline:changed'); return true; }
  }
  return false;
}

export function timelineDuration() {
  return allClips().reduce((a, x) => Math.max(a, clipEnd(x.clip)), 0);
}

// Resolved top-most video program: array of {start,end,clip} (gaps omitted).
export function videoProgram() {
  const vids = [];
  state.tracks.video.forEach((t, ti) => t.clips.forEach((c) => vids.push({ c, ti })));
  if (!vids.length) return [];
  const bounds = new Set([0]);
  for (const { c } of vids) { bounds.add(c.start); bounds.add(clipEnd(c)); }
  const B = [...bounds].sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < B.length - 1; i++) {
    const a = B[i], b = B[i + 1]; if (b - a < 1e-4) continue;
    const mid = (a + b) / 2;
    let top = null;
    for (const { c, ti } of vids) if (mid >= c.start && mid < clipEnd(c) && (!top || ti >= top.ti)) top = { c, ti };
    if (top) {
      const last = segs[segs.length - 1];
      if (last && last.clip === top.c && Math.abs(last.end - a) < 1e-4) last.end = b;
      else segs.push({ start: a, end: b, clip: top.c });
    }
  }
  return segs;
}
export function programAt(t) {
  for (const s of videoProgram()) if (t >= s.start && t < s.end) return s;
  return null;
}
// ALL video-track clips active at time t, bottom track first (for compositing)
export function layersAt(t) {
  const out = [];
  state.tracks.video.forEach((tr, ti) => {
    for (const c of tr.clips) if (t >= c.start && t < clipEnd(c)) out.push({ clip: c, ti });
  });
  return out.sort((a, b) => a.ti - b.ti);
}
// how many video tracks actually hold clips (compositing only kicks in at >= 2)
export function populatedVideoTracks() {
  return state.tracks.video.reduce((n, tr) => n + (tr.clips.length ? 1 : 0), 0);
}
// active cross-dissolve at time t: {prev, cur, p} where p ramps 0→1, else null
export function transitionAt(t) {
  for (const tr of state.tracks.video) {
    const clips = [...tr.clips].sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++) {
      const cur = clips[i], prev = clips[i - 1];
      const d = Math.max(0, cur.transIn || 0);
      if (d > 0 && t >= cur.start && t < cur.start + d && Math.abs(clipEnd(prev) - cur.start) < 0.06) {
        return { prev, cur, p: (t - cur.start) / d };
      }
    }
  }
  return null;
}
// source-time inside a program segment for timeline time t
export function srcTimeAt(seg, t) { return seg.clip.in + (t - seg.start) * (seg.clip.speed || 1); }

// audio clips active at time t (dedicated audio tracks)
export function audioAt(t) {
  const out = [];
  for (const t2 of state.tracks.audio) for (const c of t2.clips) if (t >= c.start && t < clipEnd(c)) out.push(c);
  return out;
}
