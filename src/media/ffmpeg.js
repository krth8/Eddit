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

let _ff = null, _loading = null, _mt = false, _forceST = false;

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
    const wantMt = !!self.crossOriginIsolated && !_forceST;
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
let _jobs = 0;   // conversions since the current core was loaded
function _recycle() { try { _ff?.terminate?.(); } catch {} _ff = null; _loading = null; _jobs = 0; }
// abort the in-flight conversion (e.g. its media was deleted): terminating the
// core makes exec reject; the next job simply reloads a fresh core
export function abortTranscode() { _recycle(); }

export async function transcodeToProxy(file, targetH, onProgress, onStatus, hintMP, ctl, opts) {
  // The wasm heap only ever GROWS — a long proxy queue (dozens of 6K clips)
  // slowly fragments it until a conversion aborts mid-queue. Recycling the
  // engine every few jobs resets the heap for ~2s of reload time.
  if (_jobs >= 4) _recycle();
  try {
    const out = await runTranscode(file, targetH, onProgress, onStatus, false, hintMP, opts);
    _jobs++;
    return out;
  } catch (e) {
    if (ctl?.cancelled) throw new Error('cancelled');   // deleted mid-convert — no retry
    // A wasm OOM (e.g. 6K ProRes: 85MB frames × decoder buffers × x264
    // threads) ABORTS the worker, leaving the core unusable — reload a
    // single-threaded core and retry once with minimal memory. Threads are the
    // memory multiplier, so 1 thread fits where 16 blow the heap.
    const msg = e?.message || String(e);
    // a watchdog TERMINATE means the core deadlocked (age-related) — a fresh
    // multi-thread core almost always completes, so keep the fast path for
    // that case and reserve single-thread low-memory mode for real OOMs
    const stalled = /terminat/i.test(msg);
    console.warn('[ffmpeg] transcode failed (' + (stalled ? 'stall' : 'error') + '), retrying on a fresh core:', msg);
    onStatus?.(stalled ? 'engine stalled — restarting…' : 'retrying with low-memory engine…', null);
    _recycle(); _forceST = !stalled;
    try { const out = await runTranscode(file, targetH, onProgress, onStatus, !stalled, hintMP, opts); _jobs++; return out; }
    finally { _forceST = false; }
  }
}

// EXPORT CONFORM: transcode only the USED range of an undecodable original at
// delivery resolution/quality — export must never re-encode editing proxies.
export function transcodeRange(file, { ss = 0, dur = 0, height, crf = 15, gop = 12 }, onProgress, onStatus, hintMP) {
  return transcodeToProxy(file, height, onProgress, onStatus, hintMP, null, { ss, dur, crf, gop });
}

async function runTranscode(file, targetH, onProgress, onStatus, lowMem, hintMP, opts = {}) {
  const ff = await getFFmpeg(onStatus);
  const outName = 'proxy.mp4';
  const MDIR = '/in';

  const logs = [];
  let beat = performance.now();   // liveness: any log/progress resets it
  const logCb = ({ message }) => { beat = performance.now(); logs.push(message); if (logs.length > 80) logs.shift(); };
  const t0 = performance.now();
  const progCb = ({ progress }) => {
    beat = performance.now();
    const p = Math.max(0, Math.min(0.99, progress || 0));
    onProgress?.(p);
    let eta = '';
    if (p > 0.03) { const secs = ((performance.now() - t0) / 1000) / p * (1 - p); eta = secs > 90 ? ` · ~${Math.round(secs / 60)} min left` : ` · ~${Math.round(secs)}s left`; }
    onStatus?.('converting…' + eta, p);
  };
  ff.on('log', logCb);
  ff.on('progress', progCb);
  // DEADLOCK WATCHDOG: the multi-thread core sometimes never returns from
  // exec() even after encoding every frame (stuck at "99%" — pthreads fail to
  // join at exit, more likely the longer the core has lived). No output for
  // 90s = dead: terminate the worker so exec rejects and the caller retries
  // on a fresh core instead of wedging the whole proxy queue.
  const wd = setInterval(() => {
    if (performance.now() - beat > 90000) {
      clearInterval(wd);
      console.warn('[ffmpeg] no output for 90s — terminating the stalled engine');
      if (_ff === ff) { _ff = null; _loading = null; _jobs = 0; }
      try { ff.terminate?.(); } catch {}
    }
  }, 5000);

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
    // Frame size decides how many threads the wasm heap can afford: every
    // thread holds full decoded frames (6K yuv422p10 ≈ 85MB each), so big
    // frames must run narrow or the worker aborts with OOM. Dimensions come
    // from the caller when known (hintMP); otherwise the file size is the
    // proxy — anything reaching this tier is an exotic camera codec, and big
    // files mean big frames. (A separate ffmpeg header-probe exec was tried
    // and removed: every exec EXIT is a deadlock opportunity in the MT core.)
    const mp = (hintMP || 0) / 1e6;
    // Software HEVC decode is ~95% of the run (encode + scale of a 720p
    // all-intra proxy is nearly free), so threads go to the DECODER. Measured
    // on 4K 4:2:2 10-bit: decoder 4 / encoder 1 runs ~1.8x faster than 2/2.
    // The pthread pool is 32 workers and the old spawn deadlock came from
    // "auto" thread counts (decoder + x264 + filtergraph each sized to the
    // core count) exhausting it — so every count here is explicit, and the
    // total stays well under the pool. The heap is a fixed 1 GB on the MT
    // core: 4K-class frames (~33 MB at 4:2:2 10-bit) fit 8 frame threads,
    // 6K/8K frames still run narrow.
    const cores = navigator.hardwareConcurrency || 4;
    const bigFrame = mp > 9 || (!mp && file.size > 150e6);   // > DCI 4K, or unknown + big file
    let decThreads = _mt ? Math.max(2, Math.min(8, cores)) : 1;
    if (lowMem) decThreads = 1;
    else if (bigFrame) decThreads = Math.min(decThreads, 2);
    // x264 only matters at delivery sizes (export conform); a 720p proxy
    // encodes faster than one thread can decode its source
    const encThreads = (_mt && !lowMem && targetH > 1080) ? 2 : 1;
    console.log(`[ffmpeg] threads: decode ${decThreads}, encode ${encThreads} (${mp ? mp.toFixed(1) + ' MP' : 'dims unknown'})`);
    const code = await ff.exec([
      '-threads', String(decThreads),
      // decoder shortcuts: skip the in-loop deblock filter and allow non-spec
      // speedups — invisible at proxy scale, and HEVC 10-bit software decode
      // is the dominant cost of this tier
      '-skip_loop_filter', 'all', '-flags2', '+fast',
      ...(opts.ss ? ['-ss', String(opts.ss)] : []),
      '-i', inPath,
      ...(opts.dur ? ['-t', String(opts.dur)] : []),
      '-filter_threads', '1',
      '-vf', `scale=-2:${Math.round(targetH / 2) * 2}:flags=${opts.crf ? 'bicubic' : 'fast_bilinear'},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(opts.crf ?? 23), '-g', String(opts.gop ?? 1),
      // all-intra needs no lookahead — dropping it saves per-thread buffers
      '-x264-params', 'rc-lookahead=0:sync-lookahead=0',
      '-threads', String(encThreads),
      // The proxy carries the audio: playback prefers the proxy over the source
      // (engine._srcFor), so stripping it here made every clip go silent the
      // moment its proxy landed. AAC 128k stereo is cheap next to the video.
      // `-ac 2` because some camera files carry more channels than the browser
      // will play back, and a missing audio stream must not fail the run.
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outName,
    ]);
    let data = null;
    try { data = await withTimeout(ff.readFile(outName), 20000, 'read timed out'); } catch {}
    ff.deleteFile(outName).catch(() => {});
    if (!data || !data.length) {
      const tail = logs.filter((l) => /error|invalid|not found|unable|could not|no such|memory|abort|fail|permission/i.test(l)).slice(-3).join(' — ')
        || logs.slice(-3).join(' — ') || `exit code ${code}`;
      throw new Error(/abort|oom|memory/i.test(tail) ? 'out of memory decoding this resolution' : tail);
    }
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    onStatus?.('done', 1);
    return blob;
  } finally {
    clearInterval(wd);
    // a dead (OOM-aborted) worker never answers — timeout-guard the cleanup so
    // the retry path isn't wedged behind an unmount that will never resolve
    if (mounted) await withTimeout(ff.unmount(MDIR), 3000, 'unmount timed out').catch(() => {});
    if (wroteName) ff.deleteFile(wroteName).catch(() => {});
    ff.off?.('log', logCb);
    ff.off?.('progress', progCb);
  }
}
