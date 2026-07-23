// Filmstrip for hover-scrub: N evenly spaced frames composed into one wide
// JPEG sprite (persisted with the project like the poster thumb). Fed from the
// all-intra proxy normally, so the seeks are effectively instant.
export function makeStrip(source, frames = 10, fw = 160) {
  return new Promise((resolve) => {
    const url = typeof source === 'string' ? source : URL.createObjectURL(source);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    let finished = false;
    const done = (strip) => {
      if (finished) return; finished = true;
      try { if (typeof source !== 'string') URL.revokeObjectURL(url); } catch {}
      resolve(strip);
    };
    const to = setTimeout(() => done(null), 25000);
    v.onerror = () => { clearTimeout(to); done(null); };
    v.onloadedmetadata = async () => {
      const dur = isFinite(v.duration) ? v.duration : 0;
      if (!dur || !v.videoWidth) { clearTimeout(to); done(null); return; }
      const fh = Math.max(2, Math.round(fw * v.videoHeight / v.videoWidth));
      const c = document.createElement('canvas'); c.width = fw * frames; c.height = fh;
      const cx = c.getContext('2d');
      for (let i = 0; i < frames; i++) {
        await new Promise((res) => {
          v.onseeked = () => {
            // wait for a presented frame (same HEVC quirk as the poster thumb)
            if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
              let fired = false;
              v.requestVideoFrameCallback(() => { fired = true; res(); });
              setTimeout(() => { if (!fired) res(); }, 500);
            } else setTimeout(res, 80);
          };
          try { v.currentTime = dur * (i + 0.5) / frames; } catch { res(); }
        });
        try { cx.drawImage(v, i * fw, 0, fw, fh); } catch {}
      }
      clearTimeout(to);
      done(c.toDataURL('image/jpeg', 0.6));
    };
  });
}

// Lightweight metadata + poster thumbnail using a <video> element (OS-backed
// decode: H.264 always; H.265/HEVC incl. 10-bit on supported hardware). Robust
// to files that never fire loadedmetadata — resolves (playable:false) instead
// of hanging the import.
export function probe(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.src = url;
    const meta = { url, width: 0, height: 0, duration: 0, playable: true };

    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(hardTO); resolve(meta); };
    const fail = () => { meta.playable = false; finish(); };

    // hard safety net: never let a weird file hang the import
    const hardTO = setTimeout(() => { if (!meta.width) meta.playable = false; finish(); }, 8000);

    // draw the current frame; returns null when the capture is (near-)black —
    // HEVC 10-bit hardware decode often fires `seeked` before a frame is
    // actually presented, and drawing at that point yields a black canvas.
    const capture = () => {
      try {
        const c = document.createElement('canvas');
        const scale = 320 / (v.videoWidth || 320);
        c.width = Math.max(2, Math.round(v.videoWidth * scale));
        c.height = Math.max(2, Math.round(v.videoHeight * scale));
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(v, 0, 0, c.width, c.height);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        let sum = 0, n = 0;
        for (let i = 0; i < d.length; i += 4 * 13) { sum += d[i] + d[i + 1] + d[i + 2]; n += 3; }
        if (sum / Math.max(1, n) < 4) return null;
        return c.toDataURL('image/jpeg', 0.7);
      } catch { return null; }
    };

    v.onerror = fail;
    v.onloadedmetadata = () => {
      meta.width = v.videoWidth;
      meta.height = v.videoHeight;
      meta.duration = isFinite(v.duration) ? v.duration : 0;
      const dur = meta.duration || 0;
      // several spots: a black capture retries later in the clip. If every try
      // is black we resolve WITHOUT a thumb, so the caller can grab one off the
      // H.264 proxy instead.
      const times = [Math.min(1, dur * 0.25), Math.min(2, dur * 0.5 || 0.5), Math.min(5, dur * 0.75 || 1)];
      let attempt = 0;
      const trySeek = () => {
        if (done) return;
        if (attempt >= times.length) { finish(); return; }
        const target = times[attempt++];
        v.onseeked = () => {
          // wait for a *presented* frame before drawing (rVFC), with a timeout
          // net for browsers/paths where it never fires on a paused seek
          const go = () => {
            if (done) return;
            const th = capture();
            if (th) { meta.thumb = th; finish(); } else trySeek();
          };
          if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
            let fired = false;
            v.requestVideoFrameCallback(() => { fired = true; go(); });
            setTimeout(() => { if (!fired) go(); }, 700);
          } else setTimeout(go, 120);
        };
        try { v.currentTime = target; } catch { finish(); }
      };
      trySeek();
      // if seeking never fires we still have dimensions — resolve without a thumb
      setTimeout(() => { if (!meta.thumb) finish(); }, 6000);
    };
  });
}
