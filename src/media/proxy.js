// Proxy generation. Preferred path decodes with WebCodecs (fast). But WebCodecs
// HEVC/H.265 decode — especially 10-bit Main10 Canon Log from an EOS R6 — is
// often unsupported, so we FALL BACK to the <video> element (OS-backed decode:
// if the browser can play/thumbnail the file, it can decode it here too) and
// capture frames off it. Encoding is always H.264 via WebCodecs, which is
// broadly supported. Errors are surfaced, not swallowed.
import { demux, toChunk } from './demux.js';
import { transcodeToProxy } from './ffmpeg.js';
import { probe } from './probe.js';

const once = (el, ev) => new Promise((res, rej) => {
  el.addEventListener(ev, res, { once: true });
  el.addEventListener('error', () => rej(new Error(`<video> ${ev} failed`)), { once: true });
});

export async function codecSupport() {
  const out = { decode: false, encode: false, hevc: false, hevc10: false };
  if (!('VideoDecoder' in window) || !('VideoEncoder' in window)) return out;
  const ok = async (cfg, enc) => { try { return (await (enc ? VideoEncoder : VideoDecoder).isConfigSupported(cfg)).supported; } catch { return false; } };
  out.encode = await ok({ codec: 'avc1.42001f', width: 640, height: 360, bitrate: 1e6 }, true);
  out.decode = await ok({ codec: 'avc1.42001f' });
  out.hevc = await ok({ codec: 'hvc1.1.6.L93.B0' });                 // Main (8-bit)
  out.hevc10 = await ok({ codec: 'hvc1.2.4.L150.B0' });              // Main10 (10-bit)
  return out;
}

function mkEncoder(Mux, pw, ph, framerate) {
  const muxer = new Mux.Muxer({ target: new Mux.ArrayBufferTarget(), video: { codec: 'avc', width: pw, height: ph, frameRate: framerate }, fastStart: 'in-memory' });
  const state = { err: null };
  const encoder = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { state.err = e; } });
  // 0.4 bits/px/frame (~11 Mbps @720p30) — all-intra needs roughly double the
  // long-GOP budget to look clean; the cost is disk only, playback is easy
  encoder.configure({ codec: 'avc1.4d0028', width: pw, height: ph, bitrate: Math.round(pw * ph * framerate * 0.4), framerate, latencyMode: 'quality' });
  return { muxer, encoder, state };
}
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export async function makeProxy(file, targetH, onProgress, onStatus) {
  const Mux = window.Mp4Muxer;
  const canEncode = ('VideoEncoder' in window) && !!Mux;
  const errs = [];

  // Try WebCodecs decode when the container demuxes AND the codec is supported.
  let dem = null, decodeSupported = false;
  try {
    dem = await demux(file);
    if (dem.samples.length) {
      const s = await VideoDecoder.isConfigSupported({ codec: dem.codec, description: dem.description }).catch(() => ({ supported: false }));
      decodeSupported = !!s.supported;
    }
  } catch { /* demux failed (e.g. some MOV) — fall through */ }

  const fps = Math.min(60, Math.max(1, Math.round(dem?.fps || 30)));

  // tier 1: WebCodecs decode
  if (canEncode && dem && decodeSupported) {
    try { return await proxyViaWebCodecs(Mux, dem, targetH, onProgress); }
    catch (e) { errs.push('webcodecs: ' + (e?.message || e)); }
  }
  // tier 2: <video> element (OS-backed decode)
  if (canEncode) {
    try { return await proxyViaVideo(Mux, file, targetH, fps, onProgress); }
    catch (e) { errs.push('video: ' + (e?.message || e)); }
  }
  // tier 3: ffmpeg.wasm software decode+encode — the universal last resort
  try {
    onStatus?.('Converting with ffmpeg.wasm…');
    const blob = await transcodeToProxy(file, targetH, onProgress, onStatus);
    let w = 0, h = 0;
    try { const pm = await probe(blob); w = pm.width || 0; h = pm.height || 0; if (pm.url) URL.revokeObjectURL(pm.url); } catch {}
    return { url: URL.createObjectURL(blob), blob, width: w, height: h, size: blob.size, method: 'ffmpeg' };
  } catch (e) { errs.push('ffmpeg: ' + (e?.message || e)); }

  throw new Error(errs.join(' | ') || 'no available decode path');
}

async function proxyViaWebCodecs(Mux, dem, targetH, onProgress) {
  const { codec, description, samples, timescale, width, height, fps } = dem;
  const framerate = Math.min(60, Math.max(1, Math.round(fps || 30)));
  // Bake the container's display rotation into the proxy — the decoder outputs
  // coded orientation, so 90/270 swaps the output aspect and all four
  // rotations go through a canvas transform.
  const rot = dem.rotation || 0;
  const dispW = (rot === 90 || rot === 270) ? height : width;
  const dispH = (rot === 90 || rot === 270) ? width : height;
  const ph = even(targetH), pw = even(dispW * (ph / dispH));
  const { muxer, encoder, state } = mkEncoder(Mux, pw, ph, framerate);

  const canvas = new OffscreenCanvas(pw, ph);
  const cx = canvas.getContext('2d');
  const total = samples.length; let done = 0;
  let decErr = null;

  const drawRotated = (frame) => {
    if (!rot) { cx.drawImage(frame, 0, 0, pw, ph); return; }
    cx.save();
    cx.translate(pw / 2, ph / 2);
    cx.rotate(rot * Math.PI / 180);
    if (rot === 90 || rot === 270) cx.drawImage(frame, -ph / 2, -pw / 2, ph, pw);
    else cx.drawImage(frame, -pw / 2, -ph / 2, pw, ph);
    cx.restore();
  };

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        drawRotated(frame);
        const vf = new VideoFrame(canvas, { timestamp: frame.timestamp });
        encoder.encode(vf, { keyFrame: true });
        vf.close();
      } catch (e) { decErr = e; }
      frame.close();
      if (onProgress && (++done % 8 === 0 || done === total)) onProgress(done / total);
    },
    error: (e) => { decErr = e; },
  });
  decoder.configure({ codec, description });
  for (const s of samples) { if (decErr) break; decoder.decode(toChunk(s, timescale)); }
  await decoder.flush().catch((e) => { decErr = decErr || e; });
  if (decErr) { try { decoder.close(); encoder.close(); } catch {} throw new Error('decode error: ' + (decErr.message || decErr)); }
  await encoder.flush();
  if (state.err) throw new Error('encode error: ' + (state.err.message || state.err));
  muxer.finalize(); decoder.close(); encoder.close();
  const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
  return { url: URL.createObjectURL(blob), blob, width: pw, height: ph, size: blob.size, method: 'webcodecs' };
}

// OS-backed decode via a <video> element -> capture frames -> H.264 encode.
async function proxyViaVideo(Mux, file, targetH, fps, onProgress) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  // attach off-screen so requestVideoFrameCallback reliably fires
  v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  v.src = url;
  try {
    await withTO(once(v, 'loadedmetadata'), 15000, 'metadata load timed out');
    const W0 = v.videoWidth, H0 = v.videoHeight, dur = v.duration || 0;
    if (!W0 || !H0) throw new Error('the browser could not decode this file (unsupported codec/container)');
    const ph = even(targetH), pw = even(W0 * (ph / H0));
    const fr = Math.min(60, Math.max(1, Math.round(fps)));
    const { muxer, encoder, state } = mkEncoder(Mux, pw, ph, fr);
    const canvas = new OffscreenCanvas(pw, ph);
    const cx = canvas.getContext('2d');

    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      v.playbackRate = 2;                 // capture faster than real time
      let last = -1;
      await new Promise((resolve, reject) => {
        let lastT = -1, lastAdvance = performance.now();
        const wd = setInterval(() => {
          if (v.currentTime > lastT + 1e-3) { lastT = v.currentTime; lastAdvance = performance.now(); }
          else if (performance.now() - lastAdvance > 12000) { clearInterval(wd); reject(new Error('capture stalled — no frames decoded')); }
        }, 1000);
        const done = (fn, arg) => { clearInterval(wd); fn(arg); };
        v.onerror = () => done(reject, new Error('video decode error during capture'));
        v.onended = () => done(resolve);
        const step = (now, meta) => {
          try {
            cx.drawImage(v, 0, 0, pw, ph);
            const ts = Math.max(last + 1, Math.round((meta.mediaTime || v.currentTime) * 1e6)); last = ts;
            const vf = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / fr) });
            encoder.encode(vf, { keyFrame: true }); vf.close();
          } catch { /* skip a bad frame */ }
          if (onProgress && dur) onProgress(Math.min(0.99, (meta.mediaTime || v.currentTime) / dur));
          if (v.ended || (dur && v.currentTime >= dur - 0.05)) { done(resolve); return; }
          v.requestVideoFrameCallback(step);
        };
        v.requestVideoFrameCallback(step);
        v.play().catch((e) => done(reject, e));
      });
    } else {
      const total = Math.max(1, Math.round(dur * fr));
      for (let f = 0; f < total; f++) {
        v.currentTime = Math.min(dur, f / fr);
        await withTO(once(v, 'seeked'), 8000, 'seek timed out');
        cx.drawImage(v, 0, 0, pw, ph);
        const vf = new VideoFrame(canvas, { timestamp: Math.round((f / fr) * 1e6), duration: Math.round(1e6 / fr) });
        encoder.encode(vf, { keyFrame: true }); vf.close();
        if (onProgress && f % 4 === 0) onProgress(f / total);
      }
    }

    await encoder.flush();
    if (state.err) throw new Error('encode error: ' + (state.err.message || state.err));
    muxer.finalize(); encoder.close();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    return { url: URL.createObjectURL(blob), blob, width: pw, height: ph, size: blob.size, method: 'video' };
  } finally { try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch {} URL.revokeObjectURL(url); }
}

const withTO = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
