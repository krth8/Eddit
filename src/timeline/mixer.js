// Shared audio scheduling for both live playback (AudioEngine) and offline
// export mix. Handles volume/mute, speed (playbackRate), pitch (detune),
// and per-clip fade in/out as a piecewise-linear gain envelope — correct even
// when the playhead starts mid-clip or mid-fade.
import { state, clipEnd } from '../state.js';

// Every clip that can contribute audio: dedicated audio tracks + video-clip
// audio. `fade` says whether the clip's fadeIn/fadeOut belong to its SOUND —
// on a video clip they are a picture fade and must leave the audio alone.
export function audioClips() {
  const out = [];
  for (const tr of state.tracks.audio) for (const c of tr.clips) out.push({ clip: c, fade: true });
  for (const tr of state.tracks.video) for (const c of tr.clips) out.push({ clip: c, fade: false });
  return out;
}

// Schedule one clip's audio into `ctx`, connected to `dest`, relative to
// `playhead` (the timeline second aligned to ctx.currentTime). Returns the
// created nodes so callers can adjust them live, or null if nothing plays.
export function scheduleClipAudio(ctx, dest, buf, c, playhead, applyFade = true) {
  const ce = clipEnd(c);
  const clipStartTL = Math.max(playhead, c.start);
  if (ce <= playhead) return null;
  const vol = c.mute ? 0 : (c.volume ?? 1);
  const speed = c.speed || 1;
  const when = ctx.currentTime + Math.max(0, c.start - playhead);
  const offset = c.in + Math.max(0, playhead - c.start) * speed;
  const durTL = ce - clipStartTL;
  if (durTL <= 0) return null;

  const src = ctx.createBufferSource();
  src.buffer = buf; src.playbackRate.value = speed;
  try { src.detune.value = (c.pitch || 0) * 100; } catch {}
  const gain = ctx.createGain();

  const cs = c.start, ceLocal = ce - cs;
  const fi = applyFade ? Math.max(0, c.fadeIn || 0) : 0;
  const fo = applyFade ? Math.max(0, c.fadeOut || 0) : 0;
  const env = (localT) => {
    let e = 1;
    if (fi > 0) e = Math.min(e, localT / fi);
    if (fo > 0) e = Math.min(e, (ceLocal - localT) / fo);
    return Math.max(0, Math.min(1, e));
  };
  // breakpoints (timeline seconds) that bound each linear segment
  const bp = [clipStartTL, cs + fi, ce - fo, ce]
    .filter((t) => t >= clipStartTL - 1e-6 && t <= ce + 1e-6)
    .map((t) => +Math.max(clipStartTL, Math.min(ce, t)).toFixed(6));
  const uniq = [...new Set(bp)].sort((a, b) => a - b);
  const g = gain.gain;
  g.setValueAtTime(vol * env(uniq[0] - cs), when);
  for (let i = 1; i < uniq.length; i++) g.linearRampToValueAtTime(vol * env(uniq[i] - cs), when + (uniq[i] - clipStartTL));

  src.connect(gain).connect(dest);
  try { src.start(when, offset, durTL * speed); } catch {}
  return { src, gain, clip: c };
}

// Render the whole timeline's audio to a single AudioBuffer offline (for export).
// decodeFor(media) -> Promise<AudioBuffer|null>. Returns null if silent.
export async function mixTimelineAudio(dur, decodeFor, sampleRate = 48000) {
  const clips = audioClips();
  if (!clips.length || dur <= 0) return null;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return null;
  const length = Math.ceil(dur * sampleRate);
  const ctx = new OAC(2, length, sampleRate);
  const master = ctx.createGain();
  master.gain.value = state.masterVolume ?? 1;
  master.connect(ctx.destination);
  let scheduled = 0;
  for (const { clip: c, fade } of clips) {
    if (c.mute) continue;
    const media = state.media.find((m) => m.id === c.mediaId);
    let buf = null;
    try { buf = await decodeFor(media, ctx); } catch { buf = null; }
    if (!buf) continue;
    if (scheduleClipAudio(ctx, master, buf, c, 0, fade)) scheduled++;
  }
  if (!scheduled) return null;
  return ctx.startRendering();
}
