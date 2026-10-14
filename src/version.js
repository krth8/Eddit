// App version + release notes. Bump APP_VERSION on every public release and
// write a user-facing note — the projects overview surfaces "What's new" and
// auto-expands when the running build is newer than the one last seen in this
// browser. Newest entry first. 0.x = public beta, 1.0.0 = first stable.

export const APP_VERSION = '0.9.7';

export const RELEASE_NOTES = [
  {
    v: '0.9.7', date: '2026-10-14', title: 'Smaller proxies, screen recordings fixed',
    items: [
      'Screen recordings (like Screenity) and other clips whose first frame isn’t at zero no longer restart their proxy three times and end up in the slow converter — they build in one quick pass.',
      'Proxies are 3–7× smaller on disk and still scrub smoothly, and clips smaller than the proxy size are no longer upscaled.',
      'New default: only formats your browser can’t play get a proxy on import — H.264 clips are ready immediately. You can switch back to “All clips” in the Proxy panel.',
      'The batch progress bar no longer starts over for each clip while a folder is importing.',
      'Video clips can no longer be dropped onto audio tracks.',
    ],
  },
  {
    v: '0.9.6', date: '2026-10-14', title: 'Proxies that build in one go',
    items: [
      'Proxy building no longer restarts over and over on 50/60 fps and 1080p clips — it picks an encoder setting your device accepts, and switches method right away if one can’t work.',
      'The proxy bar in the sidebar now shows progress for the whole batch, with a clip counter.',
    ],
  },
  {
    v: '0.9.5', date: '2026-10-14', title: 'Faster conversion of camera footage',
    items: [
      'Clips your browser can’t play natively (like 10-bit H.265 C-Log) convert up to about twice as fast, and big camera files no longer need to be loaded fully into memory first.',
      'Choose which clips get proxies on import: all clips, only formats your browser can’t play, or none.',
    ],
  },
  {
    v: '0.9.4', date: '2026-08-01', title: 'Smooth looping and a roomier timeline toolbar',
    items: [
      'Looping is smooth — playback no longer drops a frame each time it comes round.',
      'The timeline toolbar fills the width on phones and tablets, with bigger buttons.',
    ],
  },
  {
    v: '0.9.3', date: '2026-07-31', title: 'Audio import, sound in playback, and much faster scrubbing',
    items: [
      'Import music and audio files straight onto the audio tracks — and clips play with sound again, since proxies now carry the audio.',
      'Scrubbing is dramatically faster, stacked video tracks included, and the Color tab’s loop button now loops the whole selected clip.',
    ],
  },
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
