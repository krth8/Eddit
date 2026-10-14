// One FX stack UI, shared by the Edit clip inspector and Color → FX: a card
// per effect on the clip (params, bypass, remove) built from the modules'
// param lists. `onChange(structural)` fires on every edit; structural = an
// effect was added or removed, so callers can refresh their own layout.
import { FX, fxDef, fxStack, addFx, removeFx, setFxOn } from './index.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function renderFxStack(box, g, onChange, { addMenu = false, emptyText = '' } = {}) {
  box.innerHTML = '';
  if (!g) return;
  const stack = fxStack(g);
  const redraw = () => { renderFxStack(box, g, onChange, { addMenu, emptyText }); onChange(true); };

  for (const entry of stack) {
    const d = fxDef(entry.id); if (!d) continue;
    const card = document.createElement('div');
    card.className = 'fx-mod' + (entry.on === false ? ' off' : '');
    card.dataset.fx = d.id;
    card.innerHTML = `<div class="fx-mod-hd"><span class="fx-ic">${d.icon}</span><b>${esc(d.label)}</b>
      <label class="fx-on" title="Enable / bypass"><input type="checkbox" ${entry.on === false ? '' : 'checked'}></label>
      <button class="fx-del" title="Remove effect" aria-label="Remove ${esc(d.label)}">✕</button></div>`;
    for (const p of d.params) {
      const v = g[p.key] ?? p.def;
      const row = document.createElement('div');
      row.className = 'slider-row';
      row.innerHTML = `<label>${esc(p.label)}</label><input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}" data-default="${p.add ?? p.def}"><span class="val">${Number(v).toFixed(2)}</span>`;
      const inp = row.querySelector('input');
      inp.oninput = () => { g[p.key] = parseFloat(inp.value); inp.nextElementSibling.textContent = g[p.key].toFixed(2); onChange(false); };
      card.appendChild(row);
    }
    card.querySelector('.fx-on input').onchange = (e) => { setFxOn(g, d.id, e.target.checked); card.classList.toggle('off', !e.target.checked); onChange(false); };
    card.querySelector('.fx-del').onclick = () => { removeFx(g, d.id); redraw(); };
    box.appendChild(card);
  }

  if (!stack.length && emptyText) {
    const p = document.createElement('p'); p.className = 'statline fx-empty'; p.textContent = emptyText; box.appendChild(p);
  }

  if (addMenu) {
    const free = FX.filter((d) => !stack.some((e) => e.id === d.id));
    if (!free.length) return;
    const wrap = document.createElement('div'); wrap.className = 'fx-add';
    const btn = document.createElement('button'); btn.className = 'ghost'; btn.textContent = '+ Add effect';
    const menu = document.createElement('div'); menu.className = 'fx-grid fx-add-menu hidden';
    for (const d of free) {
      const b = document.createElement('button'); b.className = 'fx-btn';
      b.innerHTML = `<span class="fx-ic">${d.icon}</span>${esc(d.label)}`;
      b.onclick = () => { addFx(g, d.id); redraw(); };
      menu.appendChild(b);
    }
    btn.onclick = () => menu.classList.toggle('hidden');
    wrap.append(btn, menu); box.appendChild(wrap);
  }
}
