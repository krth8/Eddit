// mp4box.js demuxing -> everything WebCodecs needs to decode the video track.
// Returns { codec, description, samples[], track, width, height, timescale, fps }.
const MP4Box = window.MP4Box;
// mp4box's classic build exposes DataStream as its OWN global, not MP4Box.DataStream.
// (Getting this wrong silently kills WebCodecs decode → everything falls to ffmpeg.)
const DataStream = window.DataStream || (MP4Box && MP4Box.DataStream);

export function demux(file) {
  return new Promise((resolve, reject) => {
    if (!MP4Box) return reject(new Error('mp4box not loaded'));
    const mp4 = MP4Box.createFile();
    const samples = [];
    let track = null;

    mp4.onError = (e) => reject(new Error('demux: ' + e));
    mp4.onReady = (info) => {
      try {
        track = (info?.videoTracks || [])[0];
        if (!track) return reject(new Error('No video track'));
        mp4.setExtractionOptions(track.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
        mp4.start();
      } catch (e) { reject(e); }
    };
    mp4.onSamples = (id, user, s) => { for (const x of s) samples.push(x); };

    const reader = new FileReader();
    // EVERYTHING inside onload must be caught: mp4box parses synchronously in
    // appendBuffer and THROWS on containers it mishandles (e.g. Kinefinity
    // ProRes MOVs). An uncaught throw here leaves the promise pending forever
    // and kills the whole import instead of falling through to ffmpeg.wasm.
    reader.onload = () => {
      try {
        const buf = reader.result;
        buf.fileStart = 0;
        mp4.appendBuffer(buf);
        mp4.flush();
        if (!track) return reject(new Error('No video track'));
        const description = getDescription(mp4, track);
        const durSec = track.samples_duration && track.timescale ? (track.samples_duration / track.timescale)
          : (track.duration && track.timescale ? track.duration / track.timescale : 0);
        const fps = track.nb_samples && durSec ? (track.nb_samples / durSec) : 30;
        resolve({
          codec: track.codec,
          description,
          samples,
          track,
          width: track.track_width || track.video?.width,
          height: track.track_height || track.video?.height,
          duration: durSec,
          timescale: track.timescale,
          fps: Math.round(fps),
          rotation: getRotation(mp4, track),
        });
      } catch (e) { reject(e); }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
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
