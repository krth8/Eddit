// MotionCam RAW (.mcraw) support. All mcraw-specific logic lives here and in
// vendor/mcraw/ — the rest of the app only ever calls the gated entry points
// below. Decode + develop (debayer, levels, white balance, colour matrix)
// happen in a wasm worker built from motioncam-decoder (Apache-2.0); frames
// come back as display-ready RGBA and feed the SAME WebCodecs proxy/conform
// encoders every other format uses. The original .mcraw is never touched by
// ffmpeg (it has no demuxer for it) and proxies stay edit-only as always.
export const isMcraw = (name) => /\.mcraw$/i.test(name || '');

let _worker = null, _id = 0;
const _pending = new Map();

function worker() {
  if (_worker) return _worker;
  _worker = new Worker('vendor/mcraw/mcraw-worker.js');
  _worker.onmessage = (e) => {
    const p = _pending.get(e.data.id);
    if (!p) return;
    _pending.delete(e.data.id);
    if (e.data.err) p.reject(new Error(e.data.err)); else p.resolve(e.data);
  };
  _worker.onerror = (e) => {
    for (const p of _pending.values()) p.reject(new Error('mcraw worker error: ' + (e.message || 'crashed')));
    _pending.clear();
    try { _worker.terminate(); } catch {}
    _worker = null;
  };
  return _worker;
}

function rpc(msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++_id;
    _pending.set(id, { resolve, reject });
    worker().postMessage({ ...msg, id }, transfer || []);
  });
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Open a session: reads the frame index + metadata only (fast). frame(i)
// returns developed RGBA at half sensor resolution (2x2 superpixel debayer).
export async function openMcraw(file) {
  const r = await rpc({ op: 'open', file });
  const ts = r.ts;
  const rel = (i) => (ts[i] - ts[0]) / 1000;   // seconds from first frame
  let fps = 30;
  if (r.count > 1) {
    const dts = [];
    for (let i = 1; i < Math.min(r.count, 120); i++) dts.push(ts[i] - ts[i - 1]);
    dts.sort((a, b) => a - b);
    const med = dts[dts.length >> 1] || 33.3;
    fps = Math.min(120, Math.max(1, 1000 / med));
  }
  const duration = r.count > 1 ? rel(r.count - 1) + 1 / fps : 1 / fps;
  return {
    meta: r.meta, count: r.count, fps, duration, ts, rel,
    width: r.f0.width || 0, height: r.f0.height || 0,
    audioRate: r.audioRate || 0, audioCh: r.audioCh || 0,
    frame: (i) => rpc({ op: 'frame', h: r.h, i }),
    audio: () => rpc({ op: 'audio', h: r.h }),
    close: () => rpc({ op: 'close', h: r.h }).catch(() => {}),
  };
}

async function bitmapOf(f, w, h) {
  const img = new ImageData(new Uint8ClampedArray(f.buf), f.w, f.h);
  return createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
}

// AAC-encode interleaved int16 PCM into the muxer (proxy audio). The proxy is
// the ONLY playable form of an mcraw clip, so unlike other formats it carries
// its own audio track.
async function encodePcm(muxer, pcm, rate, ch) {
  let err = null;
  const enc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { err = e; } });
  enc.configure({ codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: ch, bitrate: 128000 });
  const frames = Math.floor(pcm.length / ch);
  const BLOCK = Math.round(rate / 5);
  for (let off = 0; off < frames; off += BLOCK) {
    const n = Math.min(BLOCK, frames - off);
    const planar = new Float32Array(ch * n);
    for (let c = 0; c < ch; c++)
      for (let i = 0; i < n; i++) planar[c * n + i] = pcm[(off + i) * ch + c] / 32768;
    const data = new AudioData({
      format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: ch,
      timestamp: Math.round((off / rate) * 1e6), data: planar,
    });
    enc.encode(data); data.close();
    if (err) throw err;
  }
  await enc.flush(); enc.close();
  if (err) throw err;
}

// Proxy tier for makeProxy(): all-intra H.264, real frame timestamps (VFR
// safe), AAC audio muxed in when the clip has any.
export async function proxyViaMcraw(Mux, file, targetH, onProgress, ctl) {
  const s = await openMcraw(file);
  try {
    const f0 = await s.frame(0);
    const ph = even(Math.min(targetH, f0.h)), pw = even(f0.w * (ph / f0.h));
    const framerate = Math.min(60, Math.max(1, Math.round(s.fps)));
    let audioOk = false;
    const ch = Math.min(2, s.audioCh);
    if (s.audioRate && ch && 'AudioEncoder' in window) {
      try { audioOk = (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: s.audioRate, numberOfChannels: ch, bitrate: 128000 })).supported; } catch {}
    }
    const muxer = new Mux.Muxer({
      target: new Mux.ArrayBufferTarget(),
      video: { codec: 'avc', width: pw, height: ph, frameRate: framerate },
      ...(audioOk ? { audio: { codec: 'aac', sampleRate: s.audioRate, numberOfChannels: ch } } : {}),
      fastStart: 'in-memory',
    });
    const state = { err: null };
    const encoder = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { state.err = e; } });
    encoder.configure({ codec: 'avc1.4d0028', width: pw, height: ph, bitrate: Math.round(pw * ph * framerate * 0.4), framerate, latencyMode: 'quality' });

    for (let i = 0; i < s.count; i++) {
      if (ctl?.cancelled) throw new Error('cancelled');
      if (state.err) break;
      const f = i === 0 ? f0 : await s.frame(i);
      const bmp = await bitmapOf(f, pw, ph);
      const vf = new VideoFrame(bmp, { timestamp: Math.round(s.rel(i) * 1e6), duration: Math.round(1e6 / framerate) });
      encoder.encode(vf, { keyFrame: true });
      vf.close(); bmp.close();
      if (onProgress && (i % 4 === 0 || i === s.count - 1)) onProgress(i / s.count);
      if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 20));
    }
    await encoder.flush();
    if (state.err) throw new Error('encode error: ' + (state.err.message || state.err));
    encoder.close();

    if (audioOk) {
      const a = await s.audio();
      if (a.samples) await encodePcm(muxer, new Int16Array(a.buf), s.audioRate, ch);
    }
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    return { url: URL.createObjectURL(blob), blob, width: pw, height: ph, size: blob.size, method: 'mcraw' };
  } finally { s.close(); }
}

// Export conform: develop just the timeline range at delivery resolution.
// Output timestamps are relative to ss so the export loop's srcTime - off
// mapping lands on the exact source frame.
export async function mcrawConformRange(file, { ss = 0, dur = 0, height = 1080 }, onProgress) {
  const Mux = window.Mp4Muxer;
  if (!Mux || !('VideoEncoder' in window)) throw new Error('WebCodecs encoder unavailable');
  const s = await openMcraw(file);
  try {
    const f0 = await s.frame(0);
    const ph = even(height), pw = even(f0.w * (ph / f0.h));
    const framerate = Math.min(60, Math.max(1, Math.round(s.fps)));
    const muxer = new Mux.Muxer({ target: new Mux.ArrayBufferTarget(), video: { codec: 'avc', width: pw, height: ph, frameRate: framerate }, fastStart: 'in-memory' });
    const state = { err: null };
    const encoder = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { state.err = e; } });
    const codec = ph > 1088 ? 'avc1.640033' : 'avc1.640028';
    encoder.configure({ codec, width: pw, height: ph, bitrate: Math.round(pw * ph * framerate * 0.3), framerate, latencyMode: 'quality' });

    const end = dur > 0 ? ss + dur : Infinity;
    const picks = [];
    for (let i = 0; i < s.count; i++) { const t = s.rel(i); if (t >= ss && t <= end) picks.push(i); }
    if (!picks.length) throw new Error('no frames in range');
    for (let k = 0; k < picks.length; k++) {
      if (state.err) break;
      const i = picks[k];
      const f = i === 0 ? f0 : await s.frame(i);
      const bmp = await bitmapOf(f, pw, ph);
      const vf = new VideoFrame(bmp, { timestamp: Math.round((s.rel(i) - ss) * 1e6), duration: Math.round(1e6 / framerate) });
      encoder.encode(vf, { keyFrame: k % 12 === 0 });
      vf.close(); bmp.close();
      if (onProgress && (k % 4 === 0 || k === picks.length - 1)) onProgress(k / picks.length);
      if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 20));
    }
    await encoder.flush();
    if (state.err) throw new Error('encode error: ' + (state.err.message || state.err));
    encoder.close();
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  } finally { s.close(); }
}
