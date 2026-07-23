// Undo/redo via lightweight state snapshots. The edit surface (tracks + grades
// + selection + fps) is small and JSON-serialisable, so snapshotting is simpler
// and safer than a command pattern — and it captures every mutation uniformly,
// however it was made. LUT payloads are stripped (re-resolved from lutName).
import { state, bus } from './state.js';
import { findLut } from './luts.js';

const past = [];
const future = [];
const LIMIT = 100;
let suspended = false;
let baseline = null;

function snapshot() {
  const grades = {};
  for (const [k, g] of Object.entries(state.grades)) grades[k] = { ...g, lut: null };
  return JSON.stringify({
    tracks: state.tracks,
    grades,
    selectedClipId: state.selectedClipId,
    fps: state.fps,
    markers: state.markers || [],
    masterVolume: state.masterVolume ?? 1,
  });
}

function restore(json) {
  const s = JSON.parse(json);
  suspended = true;
  state.tracks = s.tracks;
  state.grades = s.grades || {};
  for (const g of Object.values(state.grades)) {
    if (g && g.lutName) { const l = findLut(g.lutName); if (l) { try { g.lut = l.get(); } catch {} } }
  }
  state.selectedClipId = s.selectedClipId || null;
  state.fps = s.fps || 30;
  state.markers = s.markers || [];
  state.masterVolume = s.masterVolume ?? 1;
  suspended = false;
  bus.emit('timeline:changed');
  bus.emit('media:changed');
  bus.emit('clip:selected', state.selectedClipId);
  bus.emit('history:changed');
}

// Call after mutations settle (debounced by the caller). Records one step per
// settled change; drags collapse into a single step because the debounce only
// fires once the burst ends.
export function commit() {
  if (suspended) return;
  const snap = snapshot();
  if (baseline === null) { baseline = snap; return; }
  if (snap === baseline) return;                 // nothing actually changed
  past.push(baseline);
  if (past.length > LIMIT) past.shift();
  future.length = 0;
  baseline = snap;
  bus.emit('history:changed');
}

export function undo() {
  if (!past.length) return false;
  future.push(baseline);
  const prev = past.pop();
  baseline = prev;
  restore(prev);
  return true;
}
export function redo() {
  if (!future.length) return false;
  past.push(baseline);
  const next = future.pop();
  baseline = next;
  restore(next);
  return true;
}
export function canUndo() { return past.length > 0; }
export function canRedo() { return future.length > 0; }
export function resetHistory() { past.length = 0; future.length = 0; baseline = snapshot(); bus.emit('history:changed'); }
