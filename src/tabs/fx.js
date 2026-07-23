// Toolbox tab (Edit left sidebar): generators that drop clips on the timeline,
// and one-tap grade presets ("effects") for the selected clip. A foundation to
// grow blur / masks / transition-library / audio-FX into.
import { state, bus, addTitle, addSolid, defaultGrade } from '../state.js';
import { el, toast } from '../util.js';
import { render as tlRender, selectClip, renderInspector } from '../timeline/timeline.js';
import { syncUI as colorSync } from './color.js';

let engine;
const ph = () => Math.max(0, state.playhead || 0);

const GENERATORS = [
  { label: 'Text', icon: 'T', run: () => addTitle(ph()) },
  { label: 'Solid', icon: '■', run: () => addSolid('#0e0e12', ph()) },
];

const EFFECTS = [
  { label: 'B&W', apply: (g) => { g.saturation = 0; } },
  { label: 'Warm', apply: (g) => { g.temp = 0.28; } },
  { label: 'Cool', apply: (g) => { g.temp = -0.28; } },
  { label: 'Punch', apply: (g) => { g.contrast = 0.28; g.saturation = 1.25; } },
  { label: 'Cinematic', apply: (g) => { g.contrast = 0.16; g.saturation = 0.92; g.temp = 0.08; g.lift = [0.02, 0.02, 0.05]; } },
  { label: 'Fade', apply: (g) => { g.contrast = -0.18; g.saturation = 0.85; g.lift = [0.06, 0.06, 0.07]; } },
  // vignette / glow are shader FX — fine-tune them under Color → FX
  { label: 'Vignette', apply: (g) => { g.vignette = 0.55; g.vignetteSize = 0.7; g.vignetteFeather = 0.5; } },
  { label: 'Glow', apply: (g) => { g.glow = 0.5; g.glowThreshold = 0.6; g.glowRadius = 0.5; } },
  { label: 'Dream', apply: (g) => { g.glow = 0.7; g.glowThreshold = 0.45; g.glowRadius = 0.7; g.contrast = -0.08; g.saturation = 1.08; } },
  { label: 'Noir', apply: (g) => { g.saturation = 0; g.contrast = 0.3; g.vignette = 0.7; g.vignetteSize = 0.55; } },
  { label: 'Distort', apply: (g) => { g.distort = 0.4; g.distortScale = 0.5; g.distortSpeed = 0.5; } },
  { label: 'Wiggle', apply: (g) => { g.wiggle = 0.3; g.wiggleFreq = 0.5; } },
  { label: 'Reset', apply: (g) => { Object.assign(g, defaultGrade()); } },
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
  for (const fx of EFFECTS) {
    const b = document.createElement('button');
    b.className = 'fx-btn';
    b.textContent = fx.label;
    b.onclick = () => applyFx(fx);
    fWrap.appendChild(b);
  }
  // Media / Toolbox sub-tab switch
  document.querySelectorAll('#editSideTabs button').forEach((btn) => btn.onclick = () => {
    document.querySelectorAll('#editSideTabs button').forEach((b) => b.classList.toggle('on', b === btn));
    document.querySelectorAll('#edit .side-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.st !== btn.dataset.st));
  });
}

function applyFx(fx) {
  const id = state.selectedClipId;
  if (!id || !state.grades[id]) { toast('Select a clip first', true); return; }
  fx.apply(state.grades[id]);
  engine.markGradeDirty(); bus.emit('timeline:changed'); colorSync();
  toast('Applied ' + fx.label);
}
