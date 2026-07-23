// Timeline audio waveforms. Decodes a media's audio once, reduces it to a
// fixed number of peak buckets, and caches them per media id. Drawing a clip
// maps its in/out trim window onto the peak array. Cosmetic only — any failure
// (no audio, decode error, oversized original) just leaves the clip flat.
const BUCKETS = 1200;
const MAX_BYTES = 350 * 1024 * 1024; // don't pull multi-GB originals into memory for a cosmetic waveform
const cache = new Map();   // mediaId -> Float32Array(BUCKETS) | 'pending' | null
let actx = null;

function ctx() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { actx = null; } }
  return actx;
}

export async function getPeaks(media) {
  if (!media) return null;
  const hit = cache.get(media.id);
  if (hit !== undefined) return hit === 'pending' ? null : hit;
  cache.set(media.id, 'pending');
  // prefer the small proxy (may be video-only → falls back to the original)
  const sources = [media.proxyBlob, media.file].filter((b) => b && b.size <= MAX_BYTES);
  for (const src of sources) {
    try {
      const c = ctx(); if (!c) break;
      const buf = await c.decodeAudioData(await src.arrayBuffer());
      const peaks = reduce(buf);
      cache.set(media.id, peaks);
      return peaks;
    } catch { /* try next source */ }
  }
  cache.set(media.id, null);
  return null;
}

function reduce(buf) {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const n = ch0.length;
  const out = new Float32Array(BUCKETS);
  const step = n / BUCKETS;
  for (let i = 0; i < BUCKETS; i++) {
    const a = Math.floor(i * step), b = Math.min(n, Math.floor((i + 1) * step));
    let peak = 0;
    for (let j = a; j < b; j++) {
      const v = ch1 ? Math.max(Math.abs(ch0[j]), Math.abs(ch1[j])) : Math.abs(ch0[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  return out;
}

// Draw the in/out slice of a media's peaks into a clip canvas.
export function drawWave(canvas, peaks, media, clip, color) {
  if (!canvas || !peaks || !media?.duration) return;
  const w = canvas.width, h = canvas.height;
  const cx = canvas.getContext('2d');
  cx.clearRect(0, 0, w, h);
  const dur = media.duration;
  const p0 = Math.max(0, Math.min(1, (clip.in || 0) / dur));
  const p1 = Math.max(0, Math.min(1, (clip.out || dur) / dur));
  const span = Math.max(1e-6, p1 - p0);
  cx.fillStyle = color;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const idx = Math.floor((p0 + (x / w) * span) * (peaks.length - 1));
    const amp = peaks[idx] || 0;
    const bar = Math.max(0.5, amp * (h * 0.46));
    cx.fillRect(x, mid - bar, 1, bar * 2);
  }
}
