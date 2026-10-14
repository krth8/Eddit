// WebCodecs random-access frame server. Given a short-GOP proxy (a keyframe
// every PROXY_GOP frames, no B-frames — or all-intra from older builds), it
// can decode ANY single frame on demand — the basis for frame-accurate
// scrubbing without the <video> element's seek latency. A random frame costs
// at most one GOP of decodes; a forward step continues where the decoder
// stands (one decode), and the GOP lead-in frames are cached too, so stepping
// back inside a GOP is free. Decodes are serialised per media and results
// cached as ImageBitmaps.
import { demux, toChunk } from './demux.js';

const TIMEOUT = Symbol('timeout');
const race = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(TIMEOUT), ms))]);
const CACHE = 32;   // bitmaps per media — ~120 MB at 720p

export class FrameServer {
  constructor() {
    this.map = new Map();               // mediaId -> entry
    this.supported = 'VideoDecoder' in window;
  }

  async _entry(media) {
    if (!media.proxyBlob) return null;
    if (this.map.has(media.id)) return this.map.get(media.id);
    let dem;
    try { dem = await demux(media.proxyBlob); } catch { return null; }
    if (!dem.samples.length) return null;
    // presentation order == decode order: proxies carry no B-frames
    const samples = dem.samples.slice().sort((a, b) => a.cts - b.cts);
    const times = samples.map((s) => s.cts / dem.timescale);
    let k = 0;
    const keyOf = samples.map((s, i) => (s.is_sync ? (k = i) : k));   // each frame's GOP keyframe
    const entry = {
      codec: dem.codec, description: dem.description, timescale: dem.timescale,
      samples, times, keyOf, decoder: null, out: null, lock: Promise.resolve(),
      cache: new Map(), order: [],
      next: null,      // sample index the decoder can take next without a keyframe
    };
    this.map.set(media.id, entry);
    return entry;
  }

  _index(times, t) {
    let lo = 0, hi = times.length - 1, ans = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }

  // returns an ImageBitmap for the frame at source-time t (or null -> caller falls back)
  async frameAt(media, t) {
    const e = await this._entry(media);
    if (!e) return null;
    const idx = this._index(e.times, t);
    if (e.cache.has(idx)) return e.cache.get(idx);
    // re-checked under the lock: a queued decode's GOP walk may have cached it
    const run = e.lock.then(() => e.cache.get(idx) || this._decode(e, idx));
    e.lock = run.catch(() => {});
    const bmp = await run;
    return bmp ? this._put(e, idx, bmp) : null;
  }

  // cache a bitmap; returns the one that is cached for i (an earlier copy wins)
  _put(e, i, bmp) {
    const have = e.cache.get(i);
    if (have) { if (have !== bmp) bmp.close?.(); return have; }
    e.cache.set(i, bmp); e.order.push(i);
    while (e.order.length > CACHE) { const old = e.order.shift(); e.cache.get(old)?.close?.(); e.cache.delete(old); }
    return bmp;
  }

  async _decode(e, idx) {
    if (!e.decoder || e.decoder.state === 'closed') {
      e.decoder = new VideoDecoder({
        output: (f) => {
          const i = this._index(e.times, f.timestamp / 1e6 + 2e-6);   // chunk timestamps are truncated µs
          if (i === e.want && e.pending) { const r = e.pending; e.pending = null; r(f); return; }
          // a GOP walk's lead-in frame: keep it — scrubbing back wants it next
          if (e.cache.has(i)) { f.close(); return; }
          createImageBitmap(f).then((b) => { this._put(e, i, b); }, () => {}).finally(() => f.close());
        },
        error: () => { e.next = null; const r = e.pending; e.pending = null; r?.(null); },
      });
      e.next = null;
      // optimizeForLatency: emit each keyframe as soon as it decodes. Without it
      // the only way to get the picture out is flush(), which drains and resets
      // the pipeline at EVERY scrub position — measured at 6.4ms p50 against
      // 0.3ms here, on the same 720p all-intra proxy.
      e.decoder.configure({ codec: e.codec, description: e.description, optimizeForLatency: true });
    }
    // continue from where the decoder stands when idx lies ahead in the same
    // GOP; otherwise restart at the GOP's keyframe
    const key = e.keyOf[idx];
    const from = (e.next != null && e.next > key && e.next <= idx) ? e.next : key;
    const got = new Promise((res) => { e.pending = res; e.want = idx; });
    try { for (let i = from; i <= idx; i++) e.decoder.decode(toChunk(e.samples[i], e.timescale)); }
    catch { e.pending = null; e.next = null; return null; }
    e.next = idx + 1;
    const wait = 25 + 4 * (idx - from);   // the walk's extra decodes
    // …but it is only a HINT. A decoder that ignores it holds the frame until a
    // flush, so fall back to exactly the old behaviour rather than hanging —
    // and remember that, so such a decoder pays the wait once instead of on
    // every frame, which would leave it slower than before this change.
    let vf;
    if (e.needsFlush) {
      try { await e.decoder.flush(); } catch {}
      e.next = null;   // after a flush the decoder needs a keyframe
      vf = await race(got, 250);
    } else {
      vf = await race(got, wait);
      if (vf === TIMEOUT) {
        // The FIRST decode is slow from decoder warm-up even where the hint is
        // honoured — latching on that one sample put every later frame back on
        // the flush path and undid the whole gain. Only conclude the decoder
        // buffers once it has held the frame several times running.
        if ((e.lateCount = (e.lateCount || 0) + 1) >= 3) e.needsFlush = true;
        try { await e.decoder.flush(); } catch {}
        e.next = null;
        vf = await race(got, 250);
      } else e.lateCount = 0;
    }
    if (!vf || vf === TIMEOUT) { e.pending = null; return null; }
    let bmp = null;
    try { bmp = await createImageBitmap(vf); } catch {}
    vf.close();
    return bmp;
  }

  clear(mediaId) {
    const e = this.map.get(mediaId);
    if (!e) return;
    try { e.decoder?.close?.(); } catch {}
    e.cache.forEach((b) => b?.close?.());
    this.map.delete(mediaId);
  }
}
