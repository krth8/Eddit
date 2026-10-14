// mp4box.js demuxing -> everything WebCodecs needs to decode the video track.
// Returns { codec, description, samples[], track, width, height, timescale, fps }.
const MP4Box = window.MP4Box;
// mp4box's classic build exposes DataStream as its OWN global, not MP4Box.DataStream.
// (Getting this wrong silently kills WebCodecs decode → everything falls to ffmpeg.)
const DataStream = window.DataStream || (MP4Box && MP4Box.DataStream);

// Reads in chunks, so a multi-GB camera file never needs one giant buffer.
// `accept(header)` runs once the moov is parsed: return false to stop before
// the sample data is read (the rejection carries `.header`) — the proxy
// builder uses it to bail out of a codec WebCodecs can't decode without first
// pulling the whole file through mp4box just to hand it to ffmpeg.wasm.
const CHUNK = 32 * 1024 * 1024;

export async function demux(file, { accept } = {}) {
  if (!MP4Box) throw new Error('mp4box not loaded');
  const mp4 = MP4Box.createFile();
  const samples = [];
  let track = null, err = null, gate = null, header = null;

  mp4.onError = (e) => { err = new Error('demux: ' + e); };
  mp4.onReady = (info) => {
    track = (info?.videoTracks || [])[0];
    if (!track) { err = new Error('No video track'); return; }
    if (accept) { header = headerOf(mp4, track); gate = Promise.resolve(accept(header)); }
    mp4.setExtractionOptions(track.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
    mp4.start();
  };
  mp4.onSamples = (id, user, s) => { for (const x of s) samples.push(x); };

  // mp4box parses synchronously in appendBuffer and THROWS on containers it
  // mishandles (e.g. Kinefinity ProRes MOVs) — the caller must see a rejection
  // so the import falls through to ffmpeg.wasm instead of hanging.
  // While an `accept` gate is pending, follow appendBuffer's next-position hint:
  // for a moov-at-end file (camera originals often write it last) it jumps
  // straight past the mdat, so the gate decides before the media data is read.
  // An accepted file whose mdat was skipped is then re-read sequentially.
  let skipped = false;
  for (let off = 0; off < file.size;) {
    const buf = await file.slice(off, off + CHUNK).arrayBuffer();
    buf.fileStart = off;
    const next = mp4.appendBuffer(buf);
    if (err) throw err;
    if (accept && !track && Number.isFinite(next) && next > off + buf.byteLength) { off = next; skipped = true; }
    else off += buf.byteLength;
    if (gate) {
      const ok = await gate; gate = null;
      if (!ok) { const e = new Error('demux stopped after header'); e.header = header; throw e; }
      if (skipped) return demux(file);
    }
  }
  mp4.flush();
  if (err) throw err;
  if (!track) throw new Error('No video track');
  return { ...headerOf(mp4, track), samples };
}

// Container metadata only (codec, dims, duration…) — stops reading as soon as
// the moov is parsed, so it is cheap even on multi-GB originals (unless the
// moov sits at the end of the file).
export async function demuxHeader(file) {
  try { await demux(file, { accept: () => false }); }
  catch (e) { if (e.header) return e.header; throw e; }
  throw new Error('no header');
}

function headerOf(mp4, track) {
  const durSec = track.samples_duration && track.timescale ? (track.samples_duration / track.timescale)
    : (track.duration && track.timescale ? track.duration / track.timescale : 0);
  const fps = track.nb_samples && durSec ? (track.nb_samples / durSec) : 30;
  return {
    codec: track.codec,
    description: getDescription(mp4, track),
    track,
    width: track.track_width || track.video?.width,
    height: track.track_height || track.video?.height,
    duration: durSec,
    timescale: track.timescale,
    fps: Math.round(fps),
    rotation: getRotation(mp4, track),
  };
}

// Display rotation from the tkhd matrix (16.16 fixed point). WebCodecs decodes
// the CODED orientation and ignores this — so the proxy builder must bake the
// rotation in, or phone/gimbal footage with a rotation flag plays flipped.
function getRotation(mp4, track) {
  try {
    const m = mp4.getTrackById(track.id).tkhd.matrix;
    const a = m[0] / 65536, b = m[1] / 65536;
    const deg = ((Math.round(Math.atan2(b, a) * 180 / Math.PI) % 360) + 360) % 360;
    return (deg === 90 || deg === 180 || deg === 270) ? deg : 0;
  } catch { return 0; }
}

function getDescription(mp4, track) {
  const trak = mp4.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header
    }
  }
  return undefined;
}

export function toChunk(sample, timescale) {
  return new EncodedVideoChunk({
    type: sample.is_sync ? 'key' : 'delta',
    timestamp: (sample.cts * 1e6) / timescale,
    duration: (sample.duration * 1e6) / timescale,
    data: sample.data,
  });
}
