// Export tab: render the graded timeline frame-by-frame through the WebGPU
// pipeline, encode with WebCodecs VideoEncoder, mux to MP4 (mp4-muxer).
import { state, timelineDuration, programAt, srcTimeAt, videoProgram, getMedia, fadeGainAt, defaultTransform, effectiveTransform, layersAt, populatedVideoTracks, transitionAt, clipTLDur, PROJECT_ASPECTS, bus } from '../state.js';
import { el, fmtTC, toast } from '../util.js';
import { renderTitleCanvas } from '../timeline/title.js';
import { mixTimelineAudio, audioClips } from '../timeline/mixer.js';

let engine = null, renderer = null;

export function initExport(eng, rend) {
  engine = eng; renderer = rend;
  el('exRender').onclick = render;
  // project settings: aspect + master resolution live in state.project
  // (persisted with the project; the preview canvas resizes immediately)
  const syncProject = () => {
    const a = el('exAspect'), r = el('exRes');
    if (a) a.value = state.project?.format || '16:9';
    if (r) r.value = String(state.project?.height || 1080);
  };
  syncProject();
  const applyProject = () => {
    state.project = { format: el('exAspect')?.value || '16:9', height: parseInt(el('exRes')?.value, 10) || 1080 };
    engine.markGradeDirty();
    bus.emit('media:changed');   // autosave
  };
  if (el('exAspect')) el('exAspect').onchange = applyProject;
  el('exRes').onchange = applyProject;
  bus.on('project:restored', syncProject);
  refresh();
}

export function refresh() {
  const prog = videoProgram();
  const n = prog.length;
  el('exClipCount').textContent = n;
  el('exState').textContent = n ? `Ready — ${fmtTC(timelineDuration())}` : 'Nothing to export yet';
  el('exSummary').textContent = n
    ? prog.map((s, i) => `${i + 1}. ${getMedia(s.clip.mediaId)?.name || '?'} [${s.start.toFixed(1)}–${s.end.toFixed(1)}s]`).join('\n')
    : 'Add clips in the Edit tab.';
}

function awaitEvent(target, ev, timeout = 4000) {
  return new Promise((res) => { const t = setTimeout(res, timeout); target.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true }); });
}

// Encode a rendered AudioBuffer to AAC and feed it into the muxer.
async function encodeAudio(muxer, buf, sr, ch, status) {
  let err = null;
  const enc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { err = e; } });
  enc.configure({ codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, bitrate: 192000 });
  const frames = buf.length;
  const BLOCK = 9600; // 0.2s @ 48k
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(c < buf.numberOfChannels ? buf.getChannelData(c) : buf.getChannelData(0));
  for (let off = 0; off < frames; off += BLOCK) {
    const n = Math.min(BLOCK, frames - off);
    const planar = new Float32Array(ch * n);
    for (let c = 0; c < ch; c++) planar.set(chans[c].subarray(off, off + n), c * n);
    const data = new AudioData({
      format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch,
      timestamp: Math.round((off / sr) * 1e6), data: planar,
    });
    enc.encode(data); data.close();
    if (err) throw err;
  }
  await enc.flush(); enc.close();
  if (err) throw err;
  if (status) status.textContent = 'Audio mixed — rendering video…';
}

async function render() {
  const prog0 = videoProgram();
  if (!prog0.length) return toast('Timeline is empty', true);
  if (!('VideoEncoder' in window)) return toast('WebCodecs encode unavailable', true);
  const Mux = window.Mp4Muxer;
  const fps = parseInt(el('exFps').value, 10);
  const resH = parseInt(el('exRes').value, 10);
  const bitrate = parseFloat(el('exBitrate').value) * 1e6;

  const aspect = PROJECT_ASPECTS[state.project?.format] || 16 / 9;
  const H = Math.round(resH / 2) * 2;
  const W = Math.round((H * aspect) / 2) * 2;

  const btn = el('exRender'); btn.disabled = true;
  const prog = el('exProg'); prog.classList.remove('hidden');
  const bar = prog.firstElementChild;
  const status = el('exStatus');
  el('exResult').classList.add('hidden');

  // dedicated offscreen render target + video decoder element
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const prevCanvas = renderer.canvas;
  renderer.setCanvas(canvas);

  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';

  const dur = timelineDuration();

  // ---- mix the timeline audio offline (dedicated tracks + video-clip audio) ----
  let audioBuf = null;
  let audioOk = false;
  if ('AudioEncoder' in window && audioClips().some((c) => !c.mute)) {
    try { audioOk = (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 })).supported; } catch { audioOk = false; }
  }
  if (audioOk) {
    status.textContent = 'Mixing audio…';
    await new Promise((r) => setTimeout(r));
    const audioCache = new Map();
    const decodeFor = async (media, actx) => {
      if (!media) return null;
      if (audioCache.has(media.id)) return audioCache.get(media.id);
      const src = media.file || media.proxyBlob || null;
      let buf = null;
      if (src) { try { buf = await actx.decodeAudioData(await src.arrayBuffer()); } catch { buf = null; } }
      audioCache.set(media.id, buf); return buf;
    };
    try { audioBuf = await mixTimelineAudio(dur, decodeFor, 48000); } catch (e) { audioBuf = null; }
  }
  const AUDIO_SR = 48000, AUDIO_CH = 2;

  const muxer = new Mux.Muxer({
    target: new Mux.ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    ...(audioBuf ? { audio: { codec: 'aac', numberOfChannels: AUDIO_CH, sampleRate: AUDIO_SR } } : {}),
    fastStart: 'in-memory',
  });
  let encErr = null;
  const encoder = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { encErr = e; } });
  encoder.configure({ codec: 'avc1.640028', width: W, height: H, bitrate, framerate: fps, latencyMode: 'quality' });

  // encode the mixed audio track up front (fast; muxer sorts by timestamp)
  if (audioBuf) {
    try { await encodeAudio(muxer, audioBuf, AUDIO_SR, AUDIO_CH, status); }
    catch (e) { console.warn('audio encode failed', e); }
  }

  const total = Math.max(1, Math.round(dur * fps));
  let curMedia = null, lastClipId = null;
  const multi = populatedVideoTracks() >= 2;      // composite all video tracks
  const layerVids = new Map();                    // clipId -> pooled <video>
  const applyGrade = (clip, t, opMul = 1) => {
    renderer.setTime?.(t);
    const g = state.grades[clip.id];
    renderer.setLUT(g?.lut || null); renderer.setCurve(g?.curves || null); renderer.setGrade(g || null);
    const fade = fadeGainAt(clip, t); const tf = effectiveTransform(clip, t);
    const op = (tf?.opacity ?? 1) * fade * opMul;
    renderer.setTransform(op < 0.999 ? { ...(tf || defaultTransform()), opacity: op } : (tf || null));
  };
  const layerFrame = async (clip, t) => {
    let v = layerVids.get(clip.id);
    if (!v) { v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; layerVids.set(clip.id, v); }
    const m = getMedia(clip.mediaId); if (!m) return null;
    const src = m.proxyReady && m.proxyUrl ? m.proxyUrl : m.url;
    if (v.dataset.src !== src) { v.dataset.src = src; v.src = src; await awaitEvent(v, 'loadeddata'); }
    const srcTime = clip.in + Math.max(0, t - clip.start) * (clip.speed || 1);
    if (Math.abs(v.currentTime - srcTime) > 0.001) { v.currentTime = srcTime; await awaitEvent(v, 'seeked'); }
    return v;
  };
  // drawable source for a clip: rendered title canvas or a seeked video frame
  const sourceFrame = async (clip, t) => {
    if (clip.type === 'title') { const cv = renderTitleCanvas(clip.title, W, H, { tl: Math.max(0, t - clip.start), dur: clipTLDur(clip) }); return { source: cv, w: cv.width, h: cv.height }; }
    const v = await layerFrame(clip, t); if (!v || !v.videoWidth) return null;
    return { source: v, w: v.videoWidth, h: v.videoHeight };
  };

  try {
    for (let f = 0; f < total; f++) {
      const t = Math.min(dur - 1e-3, f / fps);
      const trn = transitionAt(t);
      if (trn) {
        renderer.beginComposite();
        const pv = await sourceFrame(trn.prev, t);
        if (pv) { applyGrade(trn.prev, t, 1); renderer.drawLayer(pv.source, pv.w, pv.h); }
        const cv = await sourceFrame(trn.cur, t);
        if (cv) { applyGrade(trn.cur, t, trn.p); renderer.drawLayer(cv.source, cv.w, cv.h); }
        const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 }); frame.close();
        if (f % 4 === 0 || f === total - 1) { bar.style.width = ((f / total) * 100).toFixed(1) + '%'; status.textContent = `Rendering ${f + 1}/${total} frames…`; await new Promise((r) => setTimeout(r)); }
        if (encErr) throw encErr;
        continue;
      }
      if (multi) {
        const layers = layersAt(t);
        if (!layers.length) { renderer.clear(); }
        else {
          renderer.beginComposite();
          for (const { clip } of layers) {
            const s = await sourceFrame(clip, t);
            if (!s) continue;
            applyGrade(clip, t);
            renderer.drawLayer(s.source, s.w, s.h);
          }
        }
        const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
        frame.close();
        if (f % 4 === 0 || f === total - 1) { bar.style.width = ((f / total) * 100).toFixed(1) + '%'; status.textContent = `Rendering ${f + 1}/${total} frames…`; await new Promise((r) => setTimeout(r)); }
        if (encErr) throw encErr;
        continue;
      }
      const seg = programAt(t);
      if (seg && seg.clip.type === 'title') {
        renderer.beginComposite(); applyGrade(seg.clip, t);
        const cv = renderTitleCanvas(seg.clip.title, W, H, { tl: Math.max(0, t - seg.clip.start), dur: clipTLDur(seg.clip) }); renderer.drawLayer(cv, cv.width, cv.height);
        const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 }); frame.close();
        if (f % 4 === 0 || f === total - 1) { bar.style.width = ((f / total) * 100).toFixed(1) + '%'; status.textContent = `Rendering ${f + 1}/${total} frames…`; await new Promise((r) => setTimeout(r)); }
        if (encErr) throw encErr;
        continue;
      }
      if (!seg) { renderer.clear(); const bf = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) }); encoder.encode(bf, { keyFrame: f % (fps * 2) === 0 }); bf.close(); continue; }
      const media = getMedia(seg.clip.mediaId);
      const srcTime = srcTimeAt(seg, t);

      if (media !== curMedia) {
        curMedia = media;
        video.src = media.proxyReady && media.proxyUrl ? media.proxyUrl : media.url;
        await awaitEvent(video, 'loadeddata');
      }
      if (Math.abs(video.currentTime - srcTime) > 0.001) { video.currentTime = srcTime; await awaitEvent(video, 'seeked'); }

      if (seg.clip.id !== lastClipId) {
        const g = state.grades[seg.clip.id];
        renderer.setLUT(g?.lut || null); renderer.setCurve(g?.curves || null); renderer.setGrade(g || null);
        lastClipId = seg.clip.id;
      }
      // clip transform (keyframe-interpolated, like the multi-track path) + fade
      const fade = fadeGainAt(seg.clip, t);
      const tf = effectiveTransform(seg.clip, t);
      const animated = seg.clip.keyframes && seg.clip.keyframes.length > 1;
      renderer.setTransform((fade < 0.999 || animated) ? { ...(tf || defaultTransform()), opacity: (tf?.opacity ?? 1) * fade } : (tf || null));
      renderer.drawSource(video, video.videoWidth, video.videoHeight);

      const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();

      if (f % 4 === 0 || f === total - 1) {
        bar.style.width = ((f / total) * 100).toFixed(1) + '%';
        status.textContent = `Rendering ${f + 1}/${total} frames…`;
        await new Promise((r) => setTimeout(r)); // keep UI responsive
      }
      if (encErr) throw encErr;
    }
    await encoder.flush();
    if (encErr) throw encErr;
    muxer.finalize();
    encoder.close();

    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    el('exDownload').href = url;
    el('exResult').classList.remove('hidden');
    bar.style.width = '100%';
    status.textContent = `Done — ${(blob.size / 1e6).toFixed(1)} MB`;
    toast('Render complete');
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    toast('Render failed: ' + e.message, true);
  } finally {
    renderer.setCanvas(prevCanvas);
    // the renderer now holds the LAST exported clip's LUT/curve/grade but the
    // engine's applied-clip cache still matches — force a re-apply + redraw
    engine.markGradeDirty();
    for (const v of layerVids.values()) { try { v.removeAttribute('src'); v.load(); } catch {} }
    layerVids.clear();
    btn.disabled = false;
  }
}
