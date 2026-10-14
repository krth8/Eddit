// Proxy generation. Preferred path decodes with WebCodecs (fast). But WebCodecs
// HEVC/H.265 decode — especially 10-bit Main10 Canon Log from an EOS R6 — is
// often unsupported, so we FALL BACK to the <video> element (OS-backed decode:
// if the browser can play/thumbnail the file, it can decode it here too) and
// capture frames off it. Encoding is always H.264 via WebCodecs, which is
// broadly supported. Errors are surfaced, not swallowed.
import { demux, toChunk } from './demux.js';
import { transcodeToProxy, PROXY_GOP } from './ffmpeg.js';
import { probe } from './probe.js';
import { isMcraw, proxyViaMcraw } from './mcraw.js';

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

// H.264 Main at the lowest level that fits the proxy. A fixed level 4.0 broke
// on 50/60 fps and 1080p proxies: its 20 Mbps / 245760 MB/s ceilings sit below
// what those need, and platform encoders (Windows MF) reject the config — only
// noticed at flush, after a full decode pass. Bitrate is capped to the level.
function encoderConfig(pw, ph, framerate) {
  const mbps = Math.ceil(pw / 16) * Math.ceil(ph / 16) * framerate;
  const [lvl, maxBr] = mbps <= 245760 ? ['28', 20e6] : mbps <= 522240 ? ['2a', 50e6] : ['33', 135e6];
  // 0.2 bits/px/frame (~5.5 Mbps @720p30) with a keyframe every PROXY_GOP
  // frames. All-intra needed 0.4 and still made a 91 s screen recording a
  // 205 MB proxy of a 7.5 MB source; P-frames cost next to nothing on static
  // content, and VBR undershoots the budget there anyway
  const bitrate = Math.min(Math.round(pw * ph * framerate * 0.2), Math.round(maxBr * 0.9));
  return { codec: 'avc1.4d00' + lvl, width: pw, height: ph, bitrate, framerate, latencyMode: 'quality' };
}

async function checkEncoder(pw, ph, framerate) {
  const cfg = encoderConfig(pw, ph, framerate);
  let ok = false;
  try { ok = (await VideoEncoder.isConfigSupported(cfg)).supported; } catch {}
  if (!ok) throw new Error(`H.264 encoder rejects ${pw}x${ph}@${framerate} (${cfg.codec})`);
}

function mkEncoder(Mux, pw, ph, framerate, audio) {
  const muxer = new Mux.Muxer({
    target: new Mux.ArrayBufferTarget(),
    video: { codec: 'avc', width: pw, height: ph, frameRate: framerate },
    ...(audio ? { audio: { codec: 'aac', sampleRate: audio.sampleRate, numberOfChannels: audio.channels } } : {}),
    fastStart: 'in-memory',
    // the first frame isn't always at 0: B-frame sources with an edit list
    // (Screenity/Mediabunny, phones) decode to cts 0.033 since mp4box ignores
    // the elst, and <video> capture can miss frame 0. 'strict' rejected every
    // chunk — so each tier ran a full pass, then failed at finalize.
    firstTimestampBehavior: 'offset',
  });
  const state = { err: null };
  // a muxer throw inside the output callback is otherwise an uncaught page
  // error the decode loop never sees — record it so the pass stops right away
  const encoder = new VideoEncoder({
    output: (c, m) => { try { muxer.addVideoChunk(c, m); } catch (e) { state.err = state.err || e; } },
    error: (e) => { state.err = e; },
  });
  encoder.configure(encoderConfig(pw, ph, framerate));
  return { muxer, encoder, state };
}
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// ── Proxy audio ───────────────────────────────────────────────────────────────
// The proxy has to carry the source's audio: playback prefers it over the
// original (engine._srcFor), so a silent proxy means a silent timeline the
// moment the build lands. Export is unaffected — it decodes the original.
//
// decodeAudioData rather than WebCodecs AudioDecoder: it covers every container
// and codec the browser can play without parsing an esds by hand, and the proxy
// only needs something playable, not a bit-exact copy. Returns null when the
// file has no audio, which is the ordinary case for screen recordings and RAW.
async function sourceAudio(file) {
  if (!('AudioEncoder' in window)) return null;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return null;
  let buf = null;
  try {
    buf = await new OAC(1, 1, 48000).decodeAudioData(await file.arrayBuffer());
  } catch { return null; }
  if (!buf || !buf.length) return null;
  const channels = Math.min(2, buf.numberOfChannels);   // browsers won't play a camera's 4+ tracks anyway
  const sampleRate = buf.sampleRate;
  try {
    const s = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 128000 });
    if (!s.supported) return null;
  } catch { return null; }
  return { buf, sampleRate, channels };
}

// AAC-encode the decoded buffer into the muxer (the planar-float sibling of
// mcraw.js's encodePcm). Callers treat a throw as non-fatal: a proxy with
// picture and no sound still beats no proxy.
async function encodeProxyAudio(muxer, a) {
  let err = null;
  const enc = new AudioEncoder({ output: (c, m) => { try { muxer.addAudioChunk(c, m); } catch (e) { err = err || e; } }, error: (e) => { err = e; } });
  enc.configure({ codec: 'mp4a.40.2', sampleRate: a.sampleRate, numberOfChannels: a.channels, bitrate: 128000 });
  const chans = [...Array(a.channels)].map((_, i) => a.buf.getChannelData(Math.min(i, a.buf.numberOfChannels - 1)));
  const total = a.buf.length, BLOCK = Math.round(a.sampleRate / 5);
  for (let off = 0; off < total; off += BLOCK) {
    const n = Math.min(BLOCK, total - off);
    const planar = new Float32Array(a.channels * n);
    for (let c = 0; c < a.channels; c++) planar.set(chans[c].subarray(off, off + n), c * n);
    const data = new AudioData({
      format: 'f32-planar', sampleRate: a.sampleRate, numberOfFrames: n, numberOfChannels: a.channels,
      timestamp: Math.round((off / a.sampleRate) * 1e6), data: planar,
    });
    enc.encode(data); data.close();
    if (err) throw err;
  }
  await enc.flush(); enc.close();
  if (err) throw err;
}

// Background-safe analysis of a short-GOP H.264 proxy: demux + WebCodecs
// decode of N evenly spaced frames → filmstrip sprite, poster thumb, dims and
// duration. The <video>-based capture paths (probe/makeStrip) need a VISIBLE
// tab to present frames — in a hidden tab they yield black or time out. This
// path decodes off-screen, so thumbs land even when conversions finish while
// the user is on another tab.
const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });

export async function analyzeProxy(blob, { frames = 10, fw = 320, thumbW = 640 } = {}) {
  const dem = await demux(blob);
  const out = { width: dem.width || 0, height: dem.height || 0, duration: dem.duration || 0, thumb: null, strip: null };
  if (!dem.samples.length || !('VideoDecoder' in window) || !out.width) return out;
  const sup = await VideoDecoder.isConfigSupported({ codec: dem.codec, description: dem.description }).catch(() => ({ supported: false }));
  if (!sup.supported) return out;
  const N = Math.min(frames, dem.samples.length);
  // each pick snaps back to its GOP's keyframe so it decodes on its own (an
  // all-intra proxy from an older build maps every pick to itself)
  const keys = dem.samples.reduce((a, s, i) => (s.is_sync && a.push(i), a), []);
  const keyAtOrBefore = (i) => { let k = keys[0] ?? 0; for (const x of keys) { if (x > i) break; k = x; } return k; };
  const picks = [...Array(N)].map((_, i) => keyAtOrBefore(Math.min(dem.samples.length - 1, Math.floor((i + 0.5) / N * dem.samples.length))));
  const fh = Math.max(2, Math.round(fw * out.height / out.width));
  const stripCan = new OffscreenCanvas(fw * N, fh);
  const scx = stripCan.getContext('2d');
  const th = Math.max(2, Math.round(thumbW * out.height / out.width));
  const thumbCan = new OffscreenCanvas(thumbW, th);
  let slot = 0, err = null;
  const dec = new VideoDecoder({
    output: (f) => {
      try {
        scx.drawImage(f, slot * fw, 0, fw, fh);
        if (slot === Math.floor(N / 2)) thumbCan.getContext('2d').drawImage(f, 0, 0, thumbW, th);
      } catch (e) { err = e; }
      slot++;
      f.close();
    },
    error: (e) => { err = e; },
  });
  dec.configure({ codec: dem.codec, description: dem.description });
  // keyframe picks only, so the sparse decode is clean
  for (const i of picks) dec.decode(toChunk(dem.samples[i], dem.timescale));
  await dec.flush().catch((e) => { err = err || e; });
  try { dec.close(); } catch {}
  if (err || !slot) return out;
  out.strip = await blobToDataURL(await stripCan.convertToBlob({ type: 'image/jpeg', quality: 0.6 }));
  out.thumb = await blobToDataURL(await thumbCan.convertToBlob({ type: 'image/jpeg', quality: 0.7 }));
  return out;
}

// Whether this browser can H.264-encode the proxy. Checked up front: an
// unsupported config otherwise only errors at encoder.flush(), AFTER a full
// decode pass — and then the next tier does the same, so the progress bar ran
// to 100% two or three times before ffmpeg finally took over.
async function canEncodeH264(Mux) {
  if (!('VideoEncoder' in window) || !Mux) return false;
  try {
    const s = await VideoEncoder.isConfigSupported({ codec: 'avc1.4d0028', width: 1280, height: 720, bitrate: 1e7, framerate: 30, latencyMode: 'quality' });
    return !!s.supported;
  } catch { return false; }
}

export async function makeProxy(file, targetH, onProgress, onStatus, hintMP, ctl) {
  const Mux = window.Mp4Muxer;
  const canEncode = await canEncodeH264(Mux);
  const errs = [];
  const tierFailed = (tier, e) => { const msg = e?.message || String(e); errs.push(tier + ': ' + msg); console.warn(`[proxy] ${tier} failed for ${file.name} — ${msg}`); };

  // MotionCam RAW: decode + develop in the mcraw wasm worker — no other tier
  // can read it (ffmpeg has no mcraw demuxer), so this path is authoritative.
  if (isMcraw(file.name)) {
    if (!canEncode) throw new Error('RAW (.mcraw) needs a WebCodecs H.264 encoder in this browser');
    return await proxyViaMcraw(Mux, file, targetH, onProgress, ctl);
  }

  // Try WebCodecs decode when the container demuxes AND the codec is supported.
  // The support check runs on the moov alone, so an undecodable original (10-bit
  // 4:2:2 HEVC without hardware) isn't read end to end before ffmpeg gets it.
  let dem = null, decodeSupported = false;
  const supported = async ({ codec, description }) => ('VideoDecoder' in window) &&
    !!(await VideoDecoder.isConfigSupported({ codec, description }).catch(() => ({ supported: false }))).supported;
  try {
    dem = await demux(file, { accept: supported });
    decodeSupported = dem.samples.length > 0;
  } catch (e) { if (e?.header) dem = e.header; /* else demux failed (e.g. some MOV) — fall through */ }

  const fps = Math.min(60, Math.max(1, Math.round(dem?.fps || 30)));

  // tier 1: WebCodecs decode
  let decodeFailed = false;
  if (canEncode && dem && decodeSupported) {
    try { return await proxyViaWebCodecs(Mux, dem, targetH, onProgress, ctl, file); }
    catch (e) { tierFailed('webcodecs', e); decodeFailed = /decode error/.test(e?.message || ''); }
  }
  if (ctl?.cancelled) throw new Error('cancelled');
  // tier 2: <video> element (OS-backed decode). Skipped when WebCodecs claimed
  // the codec and then failed decoding it: <video> sits on the same platform
  // decoder, so it would just burn a real-time pass before failing too.
  if (canEncode && !decodeFailed) {
    onProgress?.(0);
    try { return await proxyViaVideo(Mux, file, targetH, fps, onProgress, ctl); }
    catch (e) { tierFailed('video', e); }
  }
  if (ctl?.cancelled) throw new Error('cancelled');
  // tier 3: ffmpeg.wasm software decode+encode — the universal last resort
  try {
    onProgress?.(0);
    onStatus?.('Converting with ffmpeg.wasm…');
    if (ctl) ctl.ffmpeg = true;   // deletion now needs an engine abort
    const blob = await transcodeToProxy(file, targetH, onProgress, onStatus,
      dem?.width ? dem.width * dem.height : (hintMP || 0), ctl);
    let w = 0, h = 0;
    try { const pm = await probe(blob); w = pm.width || 0; h = pm.height || 0; if (pm.url) URL.revokeObjectURL(pm.url); } catch {}
    return { url: URL.createObjectURL(blob), blob, width: w, height: h, size: blob.size, method: 'ffmpeg' };
  } catch (e) { tierFailed('ffmpeg', e); }

  throw new Error(errs.join(' | ') || 'no available decode path');
}

async function proxyViaWebCodecs(Mux, dem, targetH, onProgress, ctl, file) {
  const { codec, description, samples, timescale, width, height, fps } = dem;
  const framerate = Math.min(60, Math.max(1, Math.round(fps || 30)));
  // Bake the container's display rotation into the proxy — the decoder outputs
  // coded orientation, so 90/270 swaps the output aspect and all four
  // rotations go through a canvas transform.
  const rot = dem.rotation || 0;
  const dispW = (rot === 90 || rot === 270) ? height : width;
  const dispH = (rot === 90 || rot === 270) ? width : height;
  // never upscale: a 786-line screen capture gains nothing from a 1080 proxy
  const ph = even(Math.min(targetH, dispH)), pw = even(dispW * (ph / dispH));
  // decoded up front: the muxer needs the audio track declared at construction
  await checkEncoder(pw, ph, framerate);
  const audio = file ? await sourceAudio(file) : null;
  const { muxer, encoder, state } = mkEncoder(Mux, pw, ph, framerate, audio);

  const canvas = new OffscreenCanvas(pw, ph);
  const cx = canvas.getContext('2d');
  const total = samples.length; let done = 0, nEnc = 0;
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
        encoder.encode(vf, { keyFrame: nEnc++ % PROXY_GOP === 0 });
        vf.close();
      } catch (e) { decErr = e; }
      frame.close();
      if (onProgress && (++done % 8 === 0 || done === total)) onProgress(done / total);
    },
    error: (e) => { decErr = e; },
  });
  decoder.configure({ codec, description });
  // Feed with backpressure: queuing every sample at once let a decode/encode
  // error surface only after the whole clip was "done", and held thousands of
  // 4K chunks and frames in flight. 'dequeue' events aren't throttled in a
  // hidden tab the way timers are; the timeout is only a safety net.
  const drained = () => new Promise((r) => {
    const t = setTimeout(r, 50);
    const go = () => { clearTimeout(t); r(); };
    decoder.addEventListener('dequeue', go, { once: true });
    encoder.addEventListener('dequeue', go, { once: true });
  });
  for (const s of samples) {
    if (decErr || state.err) break;
    if (ctl?.cancelled) { decErr = new Error('cancelled'); break; }
    decoder.decode(toChunk(s, timescale));
    while (!decErr && !state.err && (decoder.decodeQueueSize > 6 || encoder.encodeQueueSize > 6)) await drained();
  }
  if (state.err) { try { decoder.close(); encoder.close(); } catch {} throw new Error('encode error: ' + (state.err.message || state.err)); }
  await decoder.flush().catch((e) => { decErr = decErr || e; });
  if (decErr) { try { decoder.close(); encoder.close(); } catch {} throw new Error('decode error: ' + (decErr.message || decErr)); }
  await encoder.flush();
  if (state.err) throw new Error('encode error: ' + (state.err.message || state.err));
  if (audio) {
    try { await encodeProxyAudio(muxer, audio); }
    catch (e) { console.warn('[proxy] audio encode failed — proxy stays silent:', e?.message || e); }
  }
  muxer.finalize(); decoder.close(); encoder.close();
  const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
  return { url: URL.createObjectURL(blob), blob, width: pw, height: ph, size: blob.size, method: 'webcodecs' };
}

// OS-backed decode via a <video> element -> capture frames -> H.264 encode.
async function proxyViaVideo(Mux, file, targetH, fps, onProgress, ctl) {
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
    const ph = even(Math.min(targetH, H0)), pw = even(W0 * (ph / H0));
    const fr = Math.min(60, Math.max(1, Math.round(fps)));
    await checkEncoder(pw, ph, fr);
    const audio = await sourceAudio(file);
    const { muxer, encoder, state } = mkEncoder(Mux, pw, ph, fr, audio);
    const canvas = new OffscreenCanvas(pw, ph);
    const cx = canvas.getContext('2d');

    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      v.playbackRate = 2;                 // capture faster than real time
      let last = -1, nEnc = 0;
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
          if (ctl?.cancelled) { done(reject, new Error('cancelled')); return; }
          if (state.err) { done(reject, new Error('encode error: ' + (state.err.message || state.err))); return; }
          try {
            cx.drawImage(v, 0, 0, pw, ph);
            const ts = Math.max(last + 1, Math.round((meta.mediaTime || v.currentTime) * 1e6)); last = ts;
            const vf = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / fr) });
            encoder.encode(vf, { keyFrame: nEnc++ % PROXY_GOP === 0 }); vf.close();
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
        if (ctl?.cancelled) throw new Error('cancelled');
        v.currentTime = Math.min(dur, f / fr);
        await withTO(once(v, 'seeked'), 8000, 'seek timed out');
        cx.drawImage(v, 0, 0, pw, ph);
        const vf = new VideoFrame(canvas, { timestamp: Math.round((f / fr) * 1e6), duration: Math.round(1e6 / fr) });
        encoder.encode(vf, { keyFrame: f % PROXY_GOP === 0 }); vf.close();
        if (onProgress && f % 4 === 0) onProgress(f / total);
      }
    }

    await encoder.flush();
    if (state.err) throw new Error('encode error: ' + (state.err.message || state.err));
    if (audio) {
      try { await encodeProxyAudio(muxer, audio); }
      catch (e) { console.warn('[proxy] audio encode failed — proxy stays silent:', e?.message || e); }
    }
    muxer.finalize(); encoder.close();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    return { url: URL.createObjectURL(blob), blob, width: pw, height: ph, size: blob.size, method: 'video' };
  } finally { try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch {} URL.revokeObjectURL(url); }
}

const withTO = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
