// App version + release notes. Bump APP_VERSION on every public release and
// write a user-facing note — the projects overview surfaces "What's new" and
// auto-expands when the running build is newer than the one last seen in this
// browser. Newest entry first. 0.x = public beta, 1.0.0 = first stable.

export const APP_VERSION = '0.9.1';

export const RELEASE_NOTES = [
  {
    v: '0.9.1', date: '2026-07-25', title: 'RAW, colour science and a smarter timeline',
    items: [
      'MotionCam RAW (.mcraw): import, edit and export phone RAW — decoded and developed entirely in the browser, with a RAW panel in the Color tab (exposure, temp, tint).',
      '10-bit proxies for RAW footage where the browser supports it — grading latitude without banding.',
      'Colour science: proper camera gamut matrices for every Log conversion (Sony, ARRI, Canon, Panasonic, Fujifilm), exact Canon C-Log2/3 decodes, and new V-Log / F-Log input transforms.',
      'Project colour setting: sRGB (web) or Rec.709 (broadcast) — the preview follows it and exports carry the right colour tags.',
      'Media pool multi-select (ctrl/shift-click, long-press on touch): batch delete and per-camera input transforms for mixed-footage projects.',
      'Timeline: a clip-length ghost previews drops from the pool, and drops/moves use overwrite semantics — clips trim, split or replace what they land on, and never overlap.',
      'Your own LUT library (.cube) and reusable grade presets.',
    ],
  },
  {
    v: '0.9.0', date: '2026-07-23', title: 'Eddit public beta',
    items: [
      'First public beta of Eddit — a video editor that runs entirely in your browser: WebGPU colour grading, WebCodecs playback and export, and proxies for anything your device can’t play natively.',
      'It’s early and a lot more is coming — feedback is very welcome.',
    ],
  },
];

/** True if version `a` is strictly newer than `b` (semver x.y.z). Null/undefined `b`
 *  (no prior version seen) returns false — first-time visitors aren't shown "updates". */
export function semverGt(a, b) {
  if (!b) return false;
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}
