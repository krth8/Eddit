// Persistence: editorial state in IndexedDB, proxy blobs in OPFS.
// Survives reload and works on Android (no File System Access needed) — the
// project reopens fully playable/gradeable/exportable from cached proxies;
// originals are only needed to re-link for full-res export.

const DB_NAME = 'eddit';
const STORE = 'kv';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readonly'); const r = tx.objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

// ---- projects (multiple editorial states) ----
// Layout: 'projects' = metadata index [{id,name,created,modified,clips,thumb}];
// 'project:<id>' = full payload; 'activeId' = currently-open project id.
function uidP() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function serialize(state) {
  const media = state.media.map((m) => ({
    id: m.id, name: m.name, size: m.file?.size || m.size || 0, path: m.path || '',
    width: m.width, height: m.height, duration: m.duration, thumb: m.thumb,
    strip: m.strip || null,
    rawIso: m.rawIso || 0, rawShutter: m.rawShutter || 0,
    proxyKey: m.proxyKey || null, proxyW: m.proxyW, proxyH: m.proxyH,
    // FileSystemFileHandle is structured-clonable → survives in IndexedDB, so
    // restarts can re-acquire the original and resume proxy builds
    handle: m.handle || null,
  }));
  const grades = {};
  for (const [k, g] of Object.entries(state.grades)) grades[k] = { ...g, lut: null };
  return { v: 2, media, tracks: state.tracks, grades, fps: state.fps, markers: state.markers || [], masterVolume: state.masterVolume ?? 1, project: state.project || { format: '16:9', height: 1080 }, saved: true };
}

function clipCount(state) {
  let n = 0; for (const tr of [...(state.tracks?.video || []), ...(state.tracks?.audio || [])]) n += tr.clips.length;
  return n;
}

export async function listProjects() {
  await migrateLegacy();
  const idx = (await idbGet('projects')) || [];
  return idx.slice().sort((a, b) => (b.modified || 0) - (a.modified || 0));
}
export async function getActiveId() { await migrateLegacy(); return idbGet('activeId'); }
export async function setActiveId(id) { return idbSet('activeId', id); }

// migrate the old single-'project' key into the multi-project registry once
let _migrated = false;
async function migrateLegacy() {
  if (_migrated) return; _migrated = true;
  const idx = await idbGet('projects');
  if (idx) return; // already on the new layout
  const old = await idbGet('project');
  const id = uidP();
  if (old && old.media) {
    await idbSet('project:' + id, old);
    await idbSet('projects', [{ id, name: 'My project', created: Date.now(), modified: Date.now(), clips: (old.tracks?.video || []).reduce((n, t) => n + t.clips.length, 0), thumb: old.media[0]?.thumb || null }]);
    await idbSet('activeId', id);
  } else {
    await idbSet('projects', []);
  }
}

export async function createProject(name = 'Untitled') {
  await migrateLegacy();
  const id = uidP();
  const empty = { v: 2, media: [], tracks: { video: [{ id: 'v' + id, clips: [] }], audio: [{ id: 'a' + id, clips: [] }] }, grades: {}, fps: 30, saved: true };
  await idbSet('project:' + id, empty);
  const idx = (await idbGet('projects')) || [];
  idx.push({ id, name, created: Date.now(), modified: Date.now(), clips: 0, thumb: null });
  await idbSet('projects', idx);
  await idbSet('activeId', id);
  return id;
}

export async function saveProject(state) {
  await migrateLegacy();
  let id = await idbGet('activeId');
  const idx = (await idbGet('projects')) || [];
  if (!id || !idx.find((p) => p.id === id)) { id = await createProject('My project'); }
  const payload = serialize(state);
  try { await idbSet('project:' + id, payload); }
  catch (e) {
    // a browser that can't clone handles must still save the project
    for (const m of payload.media) m.handle = null;
    await idbSet('project:' + id, payload);
  }
  const list = (await idbGet('projects')) || [];
  const meta = list.find((p) => p.id === id);
  if (meta) { meta.modified = Date.now(); meta.clips = clipCount(state); meta.thumb = state.media[0]?.thumb || null; await idbSet('projects', list); }
}

// load the active project's payload (kept as loadProject for boot compatibility)
export async function loadProject() {
  await migrateLegacy();
  const id = await idbGet('activeId');
  if (!id) return null;
  return idbGet('project:' + id);
}
export async function loadProjectById(id) { return idbGet('project:' + id); }

export async function openProject(id) { await setActiveId(id); return loadProjectById(id); }

export async function renameProject(id, name) {
  const idx = (await idbGet('projects')) || [];
  const meta = idx.find((p) => p.id === id); if (meta) { meta.name = name; meta.modified = Date.now(); await idbSet('projects', idx); }
}
export async function duplicateProject(id) {
  const payload = await idbGet('project:' + id); if (!payload) return null;
  const idx = (await idbGet('projects')) || [];
  const src = idx.find((p) => p.id === id);
  const nid = uidP();
  await idbSet('project:' + nid, payload);
  idx.push({ id: nid, name: ((src?.name || 'Project') + ' copy'), created: Date.now(), modified: Date.now(), clips: src?.clips || 0, thumb: src?.thumb || null });
  await idbSet('projects', idx);
  return nid;
}
export async function deleteProject(id) {
  const idx = (await idbGet('projects')) || [];
  const next = idx.filter((p) => p.id !== id);
  await idbSet('projects', next);
  await idbSet('project:' + id, null);
  const active = await idbGet('activeId');
  if (active === id) await idbSet('activeId', next[0]?.id || null);
}
export async function clearProject() { const id = await idbGet('activeId'); if (id) return idbSet('project:' + id, null); }

// generic kv access for app-level persistence (user LUTs, grade presets, …)
export const kvGet = (k) => idbGet(k);
export const kvSet = (k, v) => idbSet(k, v);

// ---- OPFS proxy cache ----
export function proxyKey(file, proxyH) { return `${(file?.name || 'clip').replace(/[^\w.-]/g, '_')}__${file?.size || 0}__${proxyH}.mp4`; }

async function opfsDir() {
  if (!navigator.storage?.getDirectory) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('proxies', { create: true });
}
export async function saveProxy(key, blob) {
  try {
    const dir = await opfsDir(); if (!dir) return false;
    const fh = await dir.getFileHandle(key, { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close();
    return true;
  } catch { return false; }
}
export async function loadProxy(key) {
  try {
    const dir = await opfsDir(); if (!dir) return null;
    const fh = await dir.getFileHandle(key, { create: false });
    return await fh.getFile();
  } catch { return null; }
}
export async function proxyBytes() {
  try {
    const dir = await opfsDir(); if (!dir) return 0;
    let n = 0; for await (const [, h] of dir.entries()) { const f = await h.getFile(); n += f.size; }
    return n;
  } catch { return 0; }
}
// wipe the OPFS proxy cache (loaded proxies keep working this session;
// anything else re-transcodes on demand)
export async function clearProxies() {
  try {
    if (!navigator.storage?.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('proxies', { recursive: true });
    return true;
  } catch { return false; }
}
