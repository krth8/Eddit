// Projects browser: create / open / rename / duplicate / delete multiple
// editorial sessions. Each project is its own timeline+grades; proxies in OPFS
// are a shared cache so duplicating/opening never re-transcodes.
import { el, toast } from './util.js';
import { state, bus } from './state.js';
import { listProjects, getActiveId, setActiveId, createProject, openProject, renameProject, duplicateProject, deleteProject, saveProject } from './store.js';
import { resetForNewProject, restore as restoreMedia } from './tabs/media.js';
import { APP_VERSION, RELEASE_NOTES, semverGt } from './version.js';

let onSwitch = null; // callback(proj) to re-seed engine/history after a load
// the project actually LOADED into the editor this session. Boot shows the
// browser with nothing loaded — activeId (last session's project) must not be
// treated as open, and autosave must never clobber a project we never loaded.
let loadedId = null;

// "What's new" dropdown on the projects overview — full release history,
// newest first. Auto-expands when this build is newer than the version last
// seen in this browser (then records it); a green NEW badge marks versions
// you haven't seen yet.
function buildWhatsNew() {
  const slot = el('projNews');
  if (!slot || !RELEASE_NOTES.length) return;
  let seen = null;
  try { seen = localStorage.getItem('eddit.version'); } catch {}
  const isUpdate = semverGt(APP_VERSION, seen);
  try { localStorage.setItem('eddit.version', APP_VERSION); } catch {}
  const isFresh = (v) => (seen ? semverGt(v, seen) : false);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const notes = RELEASE_NOTES.map((n) => `
    <div class="splash-note">
      <div class="splash-note-h"><b>v${n.v}</b>${n.date ? `<span class="splash-note-date">${n.date}</span>` : ''}${n.title ? `<span>· ${esc(n.title)}</span>` : ''}${isFresh(n.v) ? '<span class="pdrop-badge">new</span>' : ''}</div>
      <ul class="splash-note-list">${n.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>
    </div>`).join('');
  const root = document.createElement('div');
  root.className = 'pdrop splash-news' + (isUpdate ? ' open' : '');
  root.innerHTML = `
    <div class="pdrop-head${isUpdate ? ' open' : ''}">
      <svg class="ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <span>What's new</span>
    </div>
    <div class="pdrop-bodywrap"><div class="pdrop-body">${notes}</div></div>`;
  const head = root.querySelector('.pdrop-head');
  head.onclick = () => { const o = !root.classList.contains('open'); root.classList.toggle('open', o); head.classList.toggle('open', o); };
  slot.replaceChildren(root);
}

export function initProjects(afterLoad) {
  onSwitch = afterLoad;
  buildWhatsNew();
  el('projBtn').onclick = openBrowser;
  el('projClose').onclick = closeBrowser;
  el('projOverlay').addEventListener('click', (e) => { if (e.target === el('projOverlay')) closeBrowser(); });
  el('projNew').onclick = async () => {
    const name = (prompt('New project name', 'Untitled') || '').trim();
    if (name === null) return;
    await commitCurrent();
    const id = await createProject(name || 'Untitled');
    await switchTo(id);
    closeBrowser();
    toast('Created “' + (name || 'Untitled') + '”');
  };
}

function fmtWhen(t) {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function commitCurrent() { if (loadedId == null) return; try { await saveProject(state); } catch {} }

async function switchTo(id) {
  const proj = await openProject(id);
  resetForNewProject();
  if (proj) await restoreMedia(proj);
  loadedId = id;
  onSwitch?.(proj);
  bus.emit('projects:switched', id);
}

export async function openBrowser() {
  await render();
  el('projOverlay').classList.remove('hidden');
}
// landing screen: the browser opens over an EMPTY editor — nothing preloads
export async function bootBrowser() { return openBrowser(); }
function closeBrowser() {
  el('projOverlay').classList.add('hidden');
  // dismissed without choosing → fresh unsaved session: detach the stored
  // active project so the first edit autosaves into a NEW project
  if (loadedId == null) setActiveId(null).catch(() => {});
}

async function render() {
  const grid = el('projGrid'); grid.innerHTML = '';
  const projects = await listProjects();
  if (!projects.length) { grid.innerHTML = '<div class="proj-empty statline">No projects yet — create your first one.</div>'; return; }
  for (const p of projects) {
    const card = document.createElement('div');
    card.className = 'proj-card' + (p.id === loadedId ? ' active' : '');
    const thumb = p.thumb ? `background-image:url(${p.thumb})` : '';
    card.innerHTML = `
      <div class="proj-thumb" style="${thumb}">${p.thumb ? '' : '🎬'}${p.id === loadedId ? '<span class="proj-badge">open</span>' : ''}</div>
      <div class="proj-body">
        <div class="proj-name" title="${p.name}">${p.name}</div>
        <div class="proj-meta">${p.clips || 0} clip${p.clips === 1 ? '' : 's'} · ${fmtWhen(p.modified)}</div>
      </div>
      <div class="proj-actions">
        <button data-a="open" title="Open">Open</button>
        <button data-a="rename" title="Rename">✎</button>
        <button data-a="dup" title="Duplicate">⧉</button>
        <button data-a="del" title="Delete">🗑</button>
      </div>`;
    card.querySelector('[data-a="open"]').onclick = async () => {
      if (p.id === loadedId) { closeBrowser(); return; }
      await commitCurrent(); await switchTo(p.id); closeBrowser();
      toast('Opened “' + p.name + '”');
    };
    card.querySelector('[data-a="rename"]').onclick = async () => {
      const name = prompt('Rename project', p.name); if (name === null) return;
      await renameProject(p.id, name.trim() || p.name); render();
    };
    card.querySelector('[data-a="dup"]').onclick = async () => {
      if (p.id === loadedId) await commitCurrent();
      await duplicateProject(p.id); render(); toast('Duplicated');
    };
    card.querySelector('[data-a="del"]').onclick = async () => {
      if (!confirm('Delete “' + p.name + '”? This cannot be undone.')) return;
      const wasLoaded = p.id === loadedId;
      await deleteProject(p.id);
      if (wasLoaded) {
        loadedId = null;
        const next = await getActiveId();
        if (next) await switchTo(next); else { resetForNewProject(); onSwitch?.(null); }
      }
      render(); toast('Deleted');
    };
    grid.appendChild(card);
  }
}
