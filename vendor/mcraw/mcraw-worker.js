/*! Eddit mcraw worker — MotionCam .mcraw decode via motioncam-decoder
 *  (https://github.com/mirsadm/motioncam-decoder, Apache-2.0 — see LICENSE)
 *  compiled to WebAssembly. RPC: open / frame / audio / close. */
importScripts('mcraw.js');

let _mod = null;
function mod() { if (!_mod) _mod = createMcrawModule(); return _mod; }
const mounts = new Map(); // handle -> mount dir

self.onmessage = async (e) => {
  const d = e.data, id = d.id;
  const reply = (msg, tr) => self.postMessage({ id, ...msg }, tr || []);
  try {
    const M = await mod();
    if (d.op === 'open') {
      const dir = '/mc' + id + '_' + (self.performance.now() | 0);
      M.FS.mkdir(dir);
      M.FS.mount(M.FS.filesystems.WORKERFS, { files: [d.file] }, dir);
      const h = M.ccall('mc_open', 'number', ['string'], [dir + '/' + d.file.name]);
      if (!h) {
        try { M.FS.unmount(dir); M.FS.rmdir(dir); } catch {}
        throw new Error(M.ccall('mc_last_error', 'string', [], []) || 'mcraw open failed');
      }
      mounts.set(h, dir);
      const count = M._mc_frame_count(h);
      const ts = new Float64Array(count);
      for (let i = 0; i < count; i++) ts[i] = M._mc_frame_ts_ms(h, i);
      let meta = {}, f0 = {};
      try { meta = JSON.parse(M.ccall('mc_meta', 'string', ['number'], [h]) || '{}'); } catch {}
      try { f0 = JSON.parse(M.ccall('mc_frame_meta', 'string', ['number', 'number'], [h, 0]) || '{}'); } catch {}
      reply({ h, count, meta, f0, ts, audioRate: M._mc_audio_rate(h), audioCh: M._mc_audio_channels(h) }, [ts.buffer]);
    } else if (d.op === 'frame') {
      // full: 1 = full-res MHC demosaic; fmt: 0 = RGBA8, 1 = I010 10-bit;
      // outW/outH: scale (0 = native)
      if (!M._mc_develop2(d.h, d.i, d.full | 0, d.fmt | 0, d.outW | 0, d.outH | 0))
        throw new Error(M.ccall('mc_last_error', 'string', [], []) || 'develop failed');
      const w = M._mc_rgba_w(d.h), hh = M._mc_rgba_h(d.h);
      let buf;
      if ((d.fmt | 0) === 1) {
        const n = w * hh + 2 * ((w / 2) * (hh / 2));
        const p = M._mc_i010_ptr(d.h) >> 1;
        buf = M.HEAP16.slice(p, p + n).buffer;
      } else {
        const p = M._mc_rgba_ptr(d.h);
        buf = M.HEAPU8.slice(p, p + w * hh * 4).buffer;
      }
      reply({ w, h: hh, buf }, [buf]);
    } else if (d.op === 'audio') {
      const n = M._mc_audio_load(d.h);
      const p = M._mc_audio_ptr(d.h) >> 1;
      const buf = n ? M.HEAP16.slice(p, p + n).buffer : new ArrayBuffer(0);
      reply({ samples: n, buf }, [buf]);
    } else if (d.op === 'close') {
      M._mc_close(d.h);
      const dir = mounts.get(d.h);
      if (dir) { try { M.FS.unmount(dir); M.FS.rmdir(dir); } catch {} mounts.delete(d.h); }
      reply({});
    } else {
      throw new Error('unknown op ' + d.op);
    }
  } catch (err) {
    reply({ err: (err && err.message) || String(err) });
  }
};
