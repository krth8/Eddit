// ffmpeg.wasm — tier-3 decode fallback for codecs neither WebCodecs nor the
// <video> element can handle (10-bit HEVC Canon C-Log without HEVC hardware,
// ProRes, etc.). Software decode, so it works regardless of the platform.
//
// VENDORED SAME-ORIGIN (vendor/ffmpeg/**). Loading @ffmpeg/ffmpeg from a CDN
// fails under our COEP/cross-origin isolation because the wrapper spawns its
// worker via `new Worker(new URL("./worker.js", import.meta.url))` — a
// cross-origin worker URL, which browsers block outright. Same-origin vendoring
// makes import.meta.url resolve locally, so the worker (and the ~32 MB core)
// load cleanly. Heavy + slow, so it only runs when native decode fails; the
// H.264 result is cached in OPFS like any proxy.
//
// onStatus(text, pct) reports load/convert phases for a visible progress UI.
const FF = new URL('../../vendor/ffmpeg/', import.meta.url);
const P = (p) => new URL(p, FF).href;

// Robust replacement for @ffmpeg/util's toBlobURL. Its downloadWithProgress
// throws when Content-Length != received bytes (always true when the server
// gzips the response, e.g. GitHub Pages compressing the 32 MB wasm) and then
// calls resp.arrayBuffer() on the ALREADY-READ body -> "body stream already
// read". Here we never compare to Content-Length, and on any reader failure we
// refetch cleanly instead of re-reading a consumed body.
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

async function fetchBlobURL(url, mime, onProgress) {
  try {
    const resp = await fetch(url);
    const total = parseInt(resp.headers.get('content-length') || '-1', 10);
    const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
    if (!reader) { const buf = await resp.arrayBuffer(); return URL.createObjectURL(new Blob([buf], { type: mime })); }
    const chunks = []; let received = 0;
    for (;;) {
      // stall watchdog: a hung download can't wedge the whole load forever
      const { done, value } = await withTimeout(reader.read(), 25000, 'download stalled');
      if (done) break;
      chunks.push(value); received += value.length;
      if (onProgress && total > 0) onProgress(Math.min(1, received / total));
    }
    const data = new Uint8Array(received); let pos = 0;
    for (const c of chunks) { data.set(c, pos); pos += c.length; }
    return URL.createObjectURL(new Blob([data], { type: mime }));
  } catch {
    const buf = await (await fetch(url)).arrayBuffer(); // fresh body
    return URL.createObjectURL(new Blob([buf], { type: mime }));
  }
}

let _ff = null, _loading = null, _mt = false;

export function ffmpegLoaded() { return !!_ff; }
export function ffmpegLoading() { return !!_loading && !_ff; }
export function ffmpegMultithread() { return _mt; }

async function loadCore(dir, mt, onStatus) {
  console.log(`[ffmpeg] core: ${mt ? 'multi-thread' : 'single-thread'} (crossOriginIsolated=${self.crossOriginIsolated}, cores=${navigator.hardwareConcurrency || '?'})`);
  onStatus?.('loading library…', null);
  const { FFmpeg } = await import(P('ffmpeg/index.js'));
  onStatus?.(`downloading core (${mt ? 'multi-thread' : 'single-thread'})…`, 0);
  const wasmURL = await fetchBlobURL(P(`${dir}/ffmpeg-core.wasm`), 'application/wasm',
    (pct) => onStatus?.('downloading core…', pct));
  onStatus?.('starting engine…', null);
  const ff = new FFmpeg();
  ff.on('log', ({ type, message }) => console.log('[ffmpeg]', type, message));
  // ff.load() can HANG (not throw) if the mt core's threads won't start on a
  // device — time it out so getFFmpeg can fall back to single-thread.
  await withTimeout(ff.load({ coreURL: P(`${dir}/ffmpeg-core.js`), wasmURL }), mt ? 15000 : 45000, `${mt ? 'multi-thread' : 'single-thread'} core init timed out`);
  console.log(`[ffmpeg] ${mt ? 'multi-thread' : 'single-thread'} core ready`);
  _mt = mt;
  return ff;
}

export async function getFFmpeg(onStatus) {
  if (_ff) return _ff;
  if (_loading) return _loading;
  _loading = (async () => {
    // multi-threaded core (much faster) needs SharedArrayBuffer → cross-origin
    // isolation. Try it when COI is available; fall back to single-thread.
    const wantMt = !!self.crossOriginIsolated;
    let ff;
    if (wantMt) {
      try { ff = await loadCore('core-mt', true, onStatus); }
      catch (e) { console.warn('[ffmpeg] multi-thread core failed, falling back to single-thread:', e?.message || e); ff = await loadCore('core', false, onStatus); }
    } else {
      ff = await loadCore('core', false, onStatus);
    }
    onStatus?.('ready', 1);
    _ff = ff;
    return ff;
  })();
  try { return await _loading; } catch (e) { _loading = null; throw e; }
}

// Transcode any file to a downscaled, all-intra H.264 MP4 (a proxy). 10-bit is
// converted to 8-bit yuv420p; the log signal is preserved so the Color tab's
// Log->Rec.709 transform/LUT still applies.
export async function transcodeToProxy(file, targetH, onProgress, onStatus) {
  const ff = await getFFmpeg(onStatus);
  const outName = 'proxy.mp4';
  const MDIR = '/in';

  const logs = [];
  const logCb = ({ message }) => { logs.push(message); if (logs.length > 80) logs.shift(); };
  const t0 = performance.now();
  const progCb = ({ progress }) => {
    const p = Math.max(0, Math.min(0.99, progress || 0));
    onProgress?.(p);
    let eta = '';
    if (p > 0.03) { const secs = ((performance.now() - t0) / 1000) / p * (1 - p); eta = secs > 90 ? ` · ~${Math.round(secs / 60)} min left` : ` · ~${Math.round(secs)}s left`; }
    onStatus?.('converting…' + eta, p);
  };
  ff.on('log', logCb);
  ff.on('progress', progCb);

  // Mount the File via WORKERFS so ffmpeg reads it on demand instead of copying
  // the whole (potentially multi-GB 4K) file into the wasm heap. Fall back to
  // writeFile for small files or if mount isn't available.
  let inPath = null, mounted = false, wroteName = null;
  const safe = file.name.replace(/[^\w.\-]/g, '_') || 'input.mov';
  try {
    await ff.createDir(MDIR).catch(() => {});
    await ff.mount('WORKERFS', { files: [file] }, MDIR);
    mounted = true; inPath = `${MDIR}/${file.name}`;
  } catch (e) {
    console.warn('[ffmpeg] WORKERFS mount failed, copying into memory:', e?.message || e);
    inPath = wroteName = 'input_' + safe;
    await ff.writeFile(inPath, new Uint8Array(await file.arrayBuffer()));
  }

  try {
    onStatus?.('converting…', 0);
    const threads = _mt ? Math.max(2, Math.min(16, navigator.hardwareConcurrency || 4)) : 1;
    const code = await ff.exec([
      '-threads', String(threads),
      // decoder shortcuts: skip the in-loop deblock filter and allow non-spec
      // speedups — invisible at proxy scale, and HEVC 10-bit software decode
      // is the dominant cost of this tier
      '-skip_loop_filter', 'all', '-flags2', '+fast',
      '-i', inPath,
      '-vf', `scale=-2:${Math.round(targetH / 2) * 2}:flags=fast_bilinear,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-g', '1', // all-intra, fast
      '-threads', String(threads),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', outName,
    ]);
    let data = null;
    try { data = await ff.readFile(outName); } catch {}
    ff.deleteFile(outName).catch(() => {});
    if (!data || !data.length) {
      const tail = logs.filter((l) => /error|invalid|not found|unable|could not|no such|memory|abort|fail|permission/i.test(l)).slice(-3).join(' — ')
        || logs.slice(-3).join(' — ') || `exit code ${code}`;
      throw new Error(tail);
    }
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    onStatus?.('done', 1);
    return blob;
  } finally {
    if (mounted) await ff.unmount(MDIR).catch(() => {});
    if (wroteName) ff.deleteFile(wroteName).catch(() => {});
    ff.off?.('log', logCb);
    ff.off?.('progress', progCb);
  }
}
