// Playback engine with seamless cuts.
// Two <video> elements (A/B) double-buffer the program: while one plays the
// current segment, the other preloads the next clip seeked to its in-point, so
// the cut is a swap with no reload hiccup. Per-clip speed (time remap) drives
// playbackRate; grading runs through the WebGPU renderer each frame. Dedicated
// audio tracks are mixed by the Web Audio engine; video-clip audio plays from
// the active element (per-clip volume/mute).
import { state, getMedia, timelineDuration, videoProgram, programAt, srcTimeAt, clipTLDur, clipEnd, fadeGainAt, defaultTransform, effectiveTransform, layersAt, populatedVideoTracks, transitionAt, projectDims, bus } from '../state.js';
import { FrameServer } from '../media/frameserver.js';
import { AudioEngine } from './audio.js';
import { renderTitleCanvas } from './title.js';

function mkVideo() { const v = document.createElement('video'); v.playsInline = true; v.preload = 'auto'; v.muted = false; return v; }

export class Engine {
  constructor(renderer) {
    this.renderer = renderer;
    this.frameServer = new FrameServer();
    this.audio = new AudioEngine();
    this.A = mkVideo(); this.B = mkVideo();
    this.cur = { el: this.A, clipId: null, seg: null };
    this.pre = { el: this.B, clipId: null, seg: null };
    this.canvas = null;
    this.onTick = null;
    this._raf = null;
    this._scrubbing = false;

    for (const v of [this.A, this.B]) {
      v.addEventListener('ended', () => { if (state.playing && v === this.cur.el) this._advance(); });
    }
  }

  setCanvas(canvas) { this.canvas = canvas; this.renderer.setCanvas(canvas); this._sizeCanvas(); if (!state.playing) this._drawOnce(); }
  markGradeDirty() { this._gradeDirty = true; this.renderer.invalidateGradeCache?.(); if (!state.playing) this._drawOnce(); }
  // loop range {a,b} in timeline seconds (clip loop / in-out section), or null
  setLoop(range) { this.loop = range && range.b > range.a + 0.04 ? range : null; }

  _srcFor(m) { return m && m.proxyReady && m.proxyUrl ? m.proxyUrl : (m ? m.url : ''); }

  _loadInto(slot, seg, seekTo) {
    if (seg.clip.type === 'title') { slot.seg = seg; slot.clipId = seg.clip.id; try { slot.el.pause(); } catch {} return; }
    const m = getMedia(seg.clip.mediaId); if (!m) return;
    if (slot.clipId !== seg.clip.id || slot.el.src !== this._srcFor(m)) {
      slot.el.src = this._srcFor(m);
      slot.clipId = seg.clip.id;
    }
    slot.seg = seg;
    const set = () => { try { slot.el.currentTime = Math.max(0, seekTo); } catch {} };
    if (slot.el.readyState >= 1) set(); else slot.el.addEventListener('loadedmetadata', set, { once: true });
  }

  _preloadNext(afterSeg) {
    const prog = videoProgram();
    const idx = prog.findIndex((s) => s.clip === afterSeg.clip && Math.abs(s.start - afterSeg.start) < 1e-3);
    const next = prog[idx + 1];
    if (!next || next.clip.type === 'title') { this.pre.seg = null; return; }
    this._loadInto(this.pre, next, next.clip.in);
    this.pre.el.pause();
  }

  _swap() { const t = this.cur; this.cur = this.pre; this.pre = t; }

  // ---- transport ----
  seek(t) {
    const dur = timelineDuration();
    state.playhead = Math.max(0, Math.min(dur, t));
    this._gapNext = null;
    const seg = programAt(state.playhead);
    if (!seg) {
      // seeked into empty space — black frame; while playing, roll on to the
      // next clip in real time (the _loop gap mode picks this up)
      this.cur.seg = null; this.cur.clipId = null;
      try { this.cur.el.pause(); } catch {}
      if (state.playing) {
        const next = videoProgram().find((s) => s.end > state.playhead + 0.001);
        if (next) { this._gapNext = next; this._lastWall = performance.now(); }
      }
      this.audio.seek(state.playhead, state.playing);
      this._drawBlack(); this.onTick?.(state.playhead, dur); return;
    }
    const src = srcTimeAt(seg, state.playhead);
    this._sizeCanvas(seg.clip);
    this._loadInto(this.cur, seg, src);
    this._lastWall = null;
    if (seg.clip.type === 'title') { this._drawOnce(); }
    else {
      this.cur.el.playbackRate = seg.clip.speed || 1;
      if (state.playing) this.cur.el.play().catch(() => {});
      else { const draw = () => this._drawOnce(); if (this.cur.el.readyState >= 2) draw(); else this.cur.el.addEventListener('seeked', draw, { once: true }); }
    }
    this.audio.seek(state.playhead, state.playing);
    this.onTick?.(state.playhead, dur);
  }

  play() {
    if (!timelineDuration()) return;
    if (state.playhead >= timelineDuration() - 0.05) state.playhead = 0;
    // with a loop active, start inside it
    if (this.loop && (state.playhead < this.loop.a || state.playhead >= this.loop.b - 0.05)) state.playhead = this.loop.a + 0.001;
    state.playing = true;
    this._lastWall = null;
    this._gapNext = null;
    const seg = programAt(state.playhead);
    if (seg) {
      this._loadInto(this.cur, seg, srcTimeAt(seg, state.playhead));
      if (seg.clip.type !== 'title') { this._applyClipAV(seg.clip, this.cur.el); this.cur.el.play().catch(() => {}); }
      this._preloadNext(seg);
    } else {
      // pressing play inside a gap: roll black until the next clip
      const next = videoProgram().find((s) => s.end > state.playhead + 0.001);
      if (next) { this.cur.seg = null; this.cur.clipId = null; this._gapNext = next; this._lastWall = performance.now(); }
    }
    this.audio.play(state.playhead);
    bus.emit('play:changed', true);
    this._loop();
  }
  pause() {
    state.playing = false;
    this.A.pause(); this.B.pause();
    this._pauseLayerEls();
    this.audio.pause();
    cancelAnimationFrame(this._raf); this._raf = null;
    bus.emit('play:changed', false);
    this._drawOnce();
  }
  toggle() { state.playing ? this.pause() : this.play(); }

  _advance() {
    const cur = this.cur.seg;
    const prog = videoProgram();
    const idx = cur ? prog.findIndex((s) => s.clip === cur.clip && Math.abs(s.start - cur.start) < 1e-3) : -1;
    const next = idx >= 0 ? prog[idx + 1] : prog.find((s) => s.end > state.playhead + 0.001);
    if (!next) { state.playhead = timelineDuration(); this.pause(); return; }
    // EMPTY SPACE between clips is part of the edit: roll black in real time
    // (wall-clock playhead in _loop) instead of teleporting to the next clip
    if (next.start > state.playhead + 0.02) {
      this._gapNext = next;
      this.cur.seg = null; this.cur.clipId = null;
      try { this.cur.el.pause(); } catch {}
      this._lastWall = performance.now();
      return;
    }
    this._startSeg(next);
  }

  // begin playing a program segment (from a cut or the end of a gap)
  _startSeg(next) {
    // if the preloaded slot already holds `next`, swap for a seamless cut
    if (this.pre.seg && this.pre.seg.clip === next.clip && Math.abs(this.pre.seg.start - next.start) < 1e-3) {
      this.cur.el.pause();
      this._swap();
    } else {
      this._loadInto(this.cur, next, next.clip.in);
    }
    state.playhead = next.start + 0.001;
    this._lastWall = null;
    if (next.clip.type === 'title') { this._preloadNext(next); return; }
    this._sizeCanvas(next.clip);
    this._applyClipAV(next.clip, this.cur.el);
    this.cur.el.playbackRate = next.clip.speed || 1;
    this.cur.el.play().catch(() => {});
    this._preloadNext(next);
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    if (!state.playing) return;
    // loop wrap (clip loop / in-out section) — seek keeps playback rolling
    if (this.loop && state.playhead >= this.loop.b - 0.02) { this.seek(Math.max(0, this.loop.a) + 0.001); return; }
    // rolling through a gap: wall-clock playhead over black until the next clip
    if (this._gapNext) {
      const now = performance.now();
      const dt = this._lastWall ? Math.max(0, (now - this._lastWall) / 1000) : 0;
      this._lastWall = now;
      state.playhead += dt;
      if (state.playhead >= this._gapNext.start - 0.005) {
        const nx = this._gapNext; this._gapNext = null;
        this._startSeg(nx);
      } else {
        this._drawOnce();
      }
      this.audio.tick(state.playhead);
      this.onTick?.(state.playhead, timelineDuration());
      return;
    }
    const seg = this.cur.seg;
    if (!seg) { this._advance(); return; }
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    if (seg.clip.type === 'title') {
      // no video to clock against — advance the playhead by real elapsed time
      const dt = this._lastWall ? Math.max(0, (now - this._lastWall) / 1000) : 0;
      this._lastWall = now;
      state.playhead = state.playhead + dt;
      if (state.playhead >= clipEnd(seg.clip) - 0.02) { this._advance(); return; }
    } else {
      this._lastWall = now;
      const local = this.cur.el.currentTime;
      if (local >= seg.clip.out - 0.03) { this._advance(); return; }
      state.playhead = seg.start + (local - seg.clip.in) / (seg.clip.speed || 1);
    }
    this.audio.tick(state.playhead);
    this._drawOnce();
    this.onTick?.(state.playhead, timelineDuration());
  }

  // per-clip audio/video: volume, mute, speed (pitch follows unless preserved)
  _applyClipAV(clip, el) {
    el.volume = Math.max(0, Math.min(1, clip.volume ?? 1));
    el.muted = !!clip.mute;
    el.playbackRate = clip.speed || 1;
    try { el.preservesPitch = true; } catch {}
  }

  // the render target is the PROJECT frame (preview capped at 1080 high);
  // sources fill it via the renderer's per-layer cover crop
  _sizeCanvas() {
    if (!this.canvas) return;
    const [w, h] = projectDims(1080);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    // the player boxes size themselves to the project aspect via --pvAR
    const ar = (w / h).toFixed(4);
    if (this._pvAR !== ar) { this._pvAR = ar; document.documentElement.style.setProperty('--pvAR', ar); bus.emit('project:aspect'); }
  }

  _applyGrade(clip) {
    this.renderer.setTime?.(state.playhead);
    if (this._appliedClipId !== clip.id || this._gradeDirty) {
      const g = state.gradeBypass ? null : state.grades[clip.id];
      this.renderer.setLUT(g?.lut || null); this.renderer.setCurve(g?.curves || null); this.renderer.setGrade(g || null);
      this._appliedClipId = clip.id; this._gradeDirty = false;
    }
    // transform (keyframe-interpolated) + fade opacity — recomputed every frame
    const fade = fadeGainAt(clip, state.playhead);
    const tf = effectiveTransform(clip, state.playhead);
    const animated = clip.keyframes && clip.keyframes.length > 1;
    if (fade < 0.999 || animated) this.renderer.setTransform({ ...(tf || defaultTransform()), opacity: (tf?.opacity ?? 1) * fade });
    else this.renderer.setTransform(tf || null);
  }

  _setLayer(clip, opacityMul) {
    this.renderer.setTime?.(state.playhead);
    const g = state.gradeBypass ? null : state.grades[clip.id];
    this.renderer.setLUT(g?.lut || null); this.renderer.setCurve(g?.curves || null); this.renderer.setGrade(g || null);
    const fade = fadeGainAt(clip, state.playhead);
    const tf = effectiveTransform(clip, state.playhead);
    this.renderer.setTransform({ ...(tf || defaultTransform()), opacity: (tf?.opacity ?? 1) * fade * opacityMul });
  }
  // resolve a clip to a drawable source (video element or rendered title canvas)
  _ensureCanvasSize() { this._sizeCanvas(); }
  _sourceFor(clip) {
    if (clip.type === 'title') {
      const W = this.canvas?.width || 1920, H = this.canvas?.height || 1080;
      const cv = renderTitleCanvas(clip.title, W, H,
        { tl: Math.max(0, state.playhead - clip.start), dur: clipTLDur(clip) });
      return { source: cv, w: cv.width, h: cv.height };
    }
    const el = this._layerEl(clip);
    if (!el || !el.videoWidth) return null;
    return { source: el, w: el.videoWidth, h: el.videoHeight };
  }

  _drawTransition(tr) {
    this._ensureCanvasSize(tr.prev);
    this.renderer.beginComposite();
    const ps = this._sourceFor(tr.prev);   // outgoing: source continues past its out-point
    if (ps) { this._setLayer(tr.prev, 1); this.renderer.drawLayer(ps.source, ps.w, ps.h); }
    const cs = this._sourceFor(tr.cur);    // incoming: ramps in over the dissolve
    if (cs) { this._setLayer(tr.cur, tr.p); this.renderer.drawLayer(cs.source, cs.w, cs.h); }
    this._appliedClipId = null;
  }

  _drawOnce() {
    if (!this.canvas) return;
    this._drawFrame();
    // scopes & friends sample the canvas in the SAME task as the submit —
    // reading a WebGPU canvas after presentation is unreliable.
    bus.emit('frame:drawn');
  }
  redraw() { this._drawOnce(); }
  _drawFrame() {
    const tr = transitionAt(state.playhead);
    if (tr) { this._drawTransition(tr); return; }
    // multi-track projects composite — but only when ≥2 layers are actually
    // under the playhead. A title parked elsewhere on V2 used to force the
    // compositing path for the WHOLE timeline, which stutters on phones.
    if (populatedVideoTracks() >= 2) {
      const layers = layersAt(state.playhead);
      if (layers.length >= 2) { this._composite(layers); return; }
      this._pauseLayerEls();      // fall through to the fast A/B path
    }
    const seg = this.cur.seg || programAt(state.playhead);
    if (!seg) { this._drawBlack(); return; }
    if (seg.clip.type === 'title') {
      this._ensureCanvasSize(seg.clip); this._setLayer(seg.clip, 1);
      const s = this._sourceFor(seg.clip); if (s) this.renderer.drawSource(s.source, s.w, s.h);
      return;
    }
    this._applyGrade(seg.clip);
    const el = this.cur.el;
    if (el.videoWidth) this.renderer.drawSource(el, el.videoWidth, el.videoHeight);
  }
  _drawBlack() { if (this.canvas && this.renderer.clear) this.renderer.clear(); }

  // ---- N-layer compositing (video tracks blended bottom→top) ----
  _layerEl(clip) {
    if (!this._layerEls) this._layerEls = new Map();
    let el = this._layerEls.get(clip.id);
    if (!el) { el = mkVideo(); el.muted = true; this._layerEls.set(clip.id, el); }
    const m = getMedia(clip.mediaId); if (!m) return null;
    const src = this._srcFor(m); if (!src) return null;
    if (el.dataset.src !== src) { el.src = src; el.dataset.src = src; }
    const srcTime = clip.in + Math.max(0, state.playhead - clip.start) * (clip.speed || 1);
    if (state.playing) {
      // let the element PLAY and only resync on real drift — seeking a video
      // every frame decodes from the previous keyframe each time and janks
      // hard on phones (this is why video under a title played choppy)
      if (el.paused || Math.abs(el.currentTime - srcTime) > 0.25) {
        try { el.currentTime = srcTime; } catch {}
        el.playbackRate = clip.speed || 1;
        el.play().catch(() => {});
      }
    } else {
      if (!el.paused) el.pause();
      if (el.readyState >= 1 && Math.abs(el.currentTime - srcTime) > 0.033) { try { el.currentTime = srcTime; } catch {} }
    }
    return el;
  }
  _pauseLayerEls() {
    if (this._layerEls) for (const el of this._layerEls.values()) if (!el.paused) el.pause();
  }
  _composite(layers) {
    const t = state.playhead;
    if (!layers) layers = layersAt(t);
    if (!layers.length) { this._drawBlack(); return; }
    // layer elements that fell out of the active set must stop playing
    if (this._layerEls) {
      const activeIds = new Set(layers.map((l) => l.clip.id));
      for (const [id, el] of this._layerEls) if (!activeIds.has(id) && !el.paused) el.pause();
    }
    this._ensureCanvasSize(layers[0].clip);     // base (bottom) layer sets output size
    // release video elements for clips that fell off the timeline
    if (this._layerEls) {
      const liveIds = new Set(state.tracks.video.flatMap((tr) => tr.clips.map((c) => c.id)));
      for (const [id, el] of this._layerEls) if (!liveIds.has(id)) { try { el.removeAttribute('src'); el.load(); } catch {} this._layerEls.delete(id); }
    }
    this.renderer.beginComposite();
    for (const { clip } of layers) {
      const s = this._sourceFor(clip);
      if (!s) continue;
      this._setLayer(clip, 1);
      this.renderer.drawLayer(s.source, s.w, s.h);
    }
    this._appliedClipId = null;                 // grade cache invalidated by multi-set
  }

  // ---- scrubbing ----
  startScrub() { this._scrubbing = true; this.pause(); }
  _ensureVideoRaf() { if (this._scrubRaf) return; const loop = () => { if (!this._scrubbing) { this._scrubRaf = null; return; } this._scrubRaf = requestAnimationFrame(loop); this._drawOnce(); }; this._scrubRaf = requestAnimationFrame(loop); }
  _stopVideoRaf() { if (this._scrubRaf) { cancelAnimationFrame(this._scrubRaf); this._scrubRaf = null; } }
  scrub(t) {
    const dur = timelineDuration();
    state.playhead = Math.max(0, Math.min(dur, t));
    const seg = programAt(state.playhead);
    if (!seg) { this._drawBlack(); this.onTick?.(state.playhead, dur); return; }
    const src = srcTimeAt(seg, state.playhead);
    const media = getMedia(seg.clip.mediaId);
    if (this.frameServer.supported && media?.proxyReady && media?.proxyBlob) {
      this._stopVideoRaf(); this._reqFrame(media, src, seg.clip);
    } else {
      this._ensureVideoRaf(); this._sizeCanvas(seg.clip); this._loadInto(this.cur, seg, src);
    }
    this.onTick?.(state.playhead, dur);
  }
  _reqFrame(media, srcTime, clip) {
    this._latestReq = { media, srcTime, clip };
    if (this._frameBusy) return; this._frameBusy = true;
    (async () => {
      while (this._latestReq) {
        const { media, srcTime, clip } = this._latestReq; this._latestReq = null;
        try {
          const bmp = await this.frameServer.frameAt(media, srcTime);
          // the canvas STAYS at project resolution — resizing it to the proxy
          // buffer here made the player flip sizes between scrubbing and
          // playback (worst at title clips, which render at project size)
          if (bmp && this.canvas) { this._applyGrade(clip); this._sizeCanvas(); this.renderer.drawSource(bmp, bmp.width, bmp.height); bus.emit('frame:drawn'); }
          else if (!bmp) { this._ensureVideoRaf(); this._loadInto(this.cur, this.cur.seg || programAt(state.playhead), srcTime); }
        } catch { this._ensureVideoRaf(); }
      }
      this._frameBusy = false;
    })();
  }
  endScrub() { this._scrubbing = false; this._stopVideoRaf(); this._latestReq = null; this.seek(state.playhead); }
}
