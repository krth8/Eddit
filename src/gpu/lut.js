// Adobe .cube LUT parser -> {size, data:Float32Array(rgba per entry)} for a 3D texture.
// Supports LUT_3D_SIZE (and 1D promoted to 3D by replication is skipped; we handle 3D only).
export function parseCube(text) {
  let size = 0;
  const rgb = [];
  let domainMin = [0, 0, 0], domainMax = [1, 1, 1];
  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('LUT_1D_SIZE')) { throw new Error('1D .cube LUTs not supported yet'); }
    if (up.startsWith('DOMAIN_MIN')) { domainMin = line.split(/\s+/).slice(1).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { domainMax = line.split(/\s+/).slice(1).map(Number); continue; }
    if (up.startsWith('TITLE') || up.startsWith('LUT_')) continue;
    const p = line.split(/\s+/).map(Number);
    if (p.length >= 3 && p.every((n) => !isNaN(n))) rgb.push(p[0], p[1], p[2]);
  }
  if (!size || rgb.length !== size * size * size * 3) {
    throw new Error(`Malformed .cube (size=${size}, entries=${rgb.length / 3})`);
  }
  // .cube fastest-changing is red; WebGPU 3D texture wants data laid out with
  // x (r) fastest, then y (g), then z (b) — which matches, so copy straight to rgba.
  const n = size * size * size;
  const data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = rgb[i * 3];
    data[i * 4 + 1] = rgb[i * 3 + 1];
    data[i * 4 + 2] = rgb[i * 3 + 2];
    data[i * 4 + 3] = 1;
  }
  return { size, data, domainMin, domainMax };
}

// Build an identity 3D LUT (no-op) so the pipeline always has a bound texture.
export function identityCube(size = 2) {
  const n = size * size * size;
  const data = new Float32Array(n * 4);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        data[i++] = r / (size - 1);
        data[i++] = g / (size - 1);
        data[i++] = b / (size - 1);
        data[i++] = 1;
      }
  return { size, data };
}
