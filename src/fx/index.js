// FX registry. Each effect is a module (one file in this folder) describing
// its params; a clip only carries the effects that were dropped on it, as an
// ordered stack on its grade: g.fx = [{ id, on }]. The renderer reads the
// param values off the grade and gates each effect's amount on the stack, so
// an effect that isn't on the clip can never render — nothing is "placed
// from before". New effects: add a module here and its uniforms/shader code.
import vignette from './vignette.js';
import glow from './glow.js';
import distort from './distort.js';
import wiggle from './wiggle.js';

export const FX = [vignette, glow, distort, wiggle];
export const fxDef = (id) => FX.find((f) => f.id === id) || null;

// Grades saved before the stack existed have no g.fx — their effects were on
// whenever the amount was raised. Read-only, so the renderer can call it.
export function fxOn(g, id) {
  if (!g) return false;
  if (Array.isArray(g.fx)) return g.fx.some((e) => e.id === id && e.on !== false);
  const d = fxDef(id);
  return !!d && (g[d.amount] || 0) > 1e-4;
}

// the clip's effect stack, migrating a pre-stack grade in place
export function fxStack(g) {
  if (!g) return [];
  if (!Array.isArray(g.fx)) g.fx = FX.filter((d) => (g[d.amount] || 0) > 1e-4).map((d) => ({ id: d.id, on: true }));
  return g.fx;
}

// add an effect at its starting values; false when the clip already has it
// (the shader runs one instance of each)
export function addFx(g, id) {
  const d = fxDef(id); if (!g || !d) return false;
  const st = fxStack(g);
  if (st.some((e) => e.id === id)) return false;
  for (const p of d.params) g[p.key] = p.add ?? p.def;
  st.push({ id, on: true });
  return true;
}

export function removeFx(g, id) {
  const d = fxDef(id); if (!g || !d) return;
  g.fx = fxStack(g).filter((e) => e.id !== id);
  for (const p of d.params) g[p.key] = p.def;
}

export function setFxOn(g, id, on) {
  const e = fxStack(g).find((x) => x.id === id);
  if (e) e.on = !!on;
}
