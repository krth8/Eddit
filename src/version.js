// App version + release notes. Bump APP_VERSION on every public release and
// write a user-facing note — the projects overview surfaces "What's new" and
// auto-expands when the running build is newer than the one last seen in this
// browser. Newest entry first. 0.x = public beta, 1.0.0 = first stable.

export const APP_VERSION = '0.9.2';

export const RELEASE_NOTES = [
  {
    v: '0.9.2', date: '2026-07-31', title: 'Easier trimming on the timeline',
    items: [
      'Trimming and fading no longer fight for the same spot: the top of each clip end drags the fade, the rest of the height trims.',
      'On phones and tablets the selected clip gets a split handle at each end — fade on top, trim below — with far bigger touch targets.',
    ],
  },
  {
    v: '0.9.1', date: '2026-07-25', title: 'RAW, colour science and a smarter timeline',
    items: [
      'MotionCam RAW: import, grade and export .mcraw footage right in the browser — with 10-bit proxies and a RAW panel in the Color tab.',
      'Accurate Log colour science, project colour setting (sRGB/Rec.709), media multi-select, and overwrite editing on the timeline.',
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
