// Toolbox tab (Edit left sidebar): generators that drop clips on the timeline,
// and the FX modules (src/fx) — dragged onto a clip, which then carries the
// effect in its FX stack (Edit inspector + Color → FX). A tap only hints:
// effects never land on a clip implicitly.
import { state, bus, addTitle, addSolid } from '../state.js';
import { el, toast } from '../util.js';
import { render as tlRender, selectClip, renderInspector } from '../timeline/timeline.js';
import { syncUI as colorSync } from './color.js';
import { FX, fxDef, addFx } from '../fx/index.js';

let engine;
const ph = () => Math.max(0, state.playhead || 0);

const GENERATORS = [
  { label: 'Text', icon: 'T', run: () => addTitle(ph()) },
  { label: 'Solid', icon: '■', run: () => addSolid('#0e0e12', ph()) },
];

export function initFx(eng) {
  engine = eng;
  const gWrap = el('fxGenerators'), fWrap = el('fxEffects');
  for (const gen of GENERATORS) {
    const b = document.createElement('button');
    b.className = 'fx-btn';
    b.innerHTML = `<span class="fx-ic">${gen.icon}</span>${gen.label}`;
    b.onclick = () => { const c = gen.run(); tlRender(); selectClip(c.id); renderInspector(); engine.seek(state.playhead); };
    gWrap.appendChild(b);
  }
  for (const d of FX) {
    const b = document.createElement('button');
    b.className = 'fx-btn fx-drag';
    b.innerHTML = `<span class="fx-ic">${d.icon}</span>${d.label}`;
    b.title = `Drag ${d.label} onto a clip`;
    b.addEventListener('pointerdown', (e) => fxDrag(d.id, e, b));
    fWrap.appendChild(b);
  }
  // Media / Toolbox sub-tab switch
  document.querySelectorAll('#editSideTabs button').forEach((btn) => btn.onclick = () => {
    document.querySelectorAll('#editSideTabs button').forEach((b) => b.classList.toggle('on', b === btn));
    document.querySelectorAll('#edit .side-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.st !== btn.dataset.st));
  });
}

// the picture clip under the pointer (audio lanes can't take an effect)
const clipAt = (x, y) => {
  const n = document.elementFromPoint(x, y);
  const c = n && n.closest ? n.closest('.tl-clip') : null;
  return c && !c.classList.contains('audio') && state.grades[c.dataset.id] ? c : null;
};

// pointer drag from the toolbox onto a timeline clip (mouse + touch, like the
// media pool's drag)
function fxDrag(id, e, btn) {
  if (e.button != null && e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let dragging = false, ghost = null, over = null;
  const hover = (c) => { if (over === c) return; over?.classList.remove('fx-drop'); over = c; over?.classList.add('fx-drop'); };
  const cleanup = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cleanup);
    btn.classList.remove('dragging'); ghost?.remove(); hover(null);
  };
  const move = (ev) => {
    if (!dragging) {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (Math.hypot(dx, dy) <= 6) return;
      // touch: a mostly-vertical first move scrolls the toolbox instead
      if (ev.pointerType === 'touch' && Math.abs(dy) > Math.abs(dx)) { cleanup(); return; }
      dragging = true; btn.classList.add('dragging');
      ghost = document.createElement('div'); ghost.className = 'drag-ghost'; ghost.textContent = fxDef(id).label;
      document.body.appendChild(ghost);
    }
    ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
    hover(clipAt(ev.clientX, ev.clientY));
  };
  const up = (ev) => {
    const target = dragging ? clipAt(ev.clientX, ev.clientY) : null;
    const wasDrag = dragging;
    cleanup();
    if (!wasDrag) { toast(`Drag ${fxDef(id).label} onto a clip on the timeline`); return; }
    if (target) applyTo(target.dataset.id, id);
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cleanup);
}

function applyTo(clipId, id) {
  const g = state.grades[clipId];
  const label = fxDef(id).label;
  if (!addFx(g, id)) { toast(`${label} is already on this clip`, true); selectClip(clipId); return; }
  engine.markGradeDirty();
  bus.emit('timeline:changed');
  selectClip(clipId);          // inspector opens on the clip, FX section included
  colorSync();
  toast('Added ' + label);
}
