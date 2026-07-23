// Web Audio mixer for dedicated audio tracks. Each audio clip is played by an
// AudioBufferSourceNode -> GainNode (volume/mute) -> destination, scheduled
// against the playhead. Per-clip speed = playbackRate, pitch = detune (cents).
// Everything is wrapped so a missing/undecodable source just stays silent.
import { state, getMedia, clipEnd } from '../state.js';
import { scheduleClipAudio } from './mixer.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();   // mediaId -> AudioBuffer | 'pending' | 'fail'
    this.active = [];           // {clip, src, gain}
    this.startedAt = 0;         // ctx time when playhead 0 anchored
  }

  _ensureCtx() {
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = state.masterVolume ?? 1;
        this.master.connect(this.ctx.destination);
      } catch { this.ctx = null; }
    }
    return this.ctx;
  }
  setMaster(v) { state.masterVolume = v; if (this.master) this.master.gain.value = v; }

  async _buffer(media) {
    if (!media || !media.file) return null;
    const cached = this.buffers.get(media.id);
    if (cached && cached !== 'pending') return cached === 'fail' ? null : cached;
    if (cached === 'pending') return null;
    this.buffers.set(media.id, 'pending');
    try {
      const ctx = this._ensureCtx(); if (!ctx) throw 0;
      const buf = await ctx.decodeAudioData(await media.file.arrayBuffer());
      this.buffers.set(media.id, buf);
      return buf;
    } catch { this.buffers.set(media.id, 'fail'); return null; }
  }

  _stopAll() { for (const a of this.active) { try { a.src.stop(); } catch {} } this.active = []; }

  async _schedule(playhead) {
    const ctx = this._ensureCtx(); if (!ctx) return;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    this.startedAt = ctx.currentTime - playhead;
    for (const track of state.tracks.audio) {
      for (const c of track.clips) {
        if (clipEnd(c) <= playhead) continue;
        const buf = await this._buffer(getMedia(c.mediaId));
        if (!buf) continue;
        const node = scheduleClipAudio(ctx, this.master || ctx.destination, buf, c, playhead);
        if (node) this.active.push(node);
      }
    }
  }

  play(playhead) { this._stopAll(); this._schedule(playhead); }
  pause() { this._stopAll(); }
  seek(playhead, playing) { this._stopAll(); if (playing) this._schedule(playhead); }
  tick() { /* sources are scheduled ahead; nothing per-frame */ }

  // live volume/mute change without a full reschedule
  setVolume(clip) { const a = this.active.find((x) => x.clip === clip); if (a) a.gain.gain.value = clip.mute ? 0 : (clip.volume ?? 1); }
  // pitch/speed change needs a reschedule
  refresh() { if (state.playing) this.seek(state.playhead, true); }
}
