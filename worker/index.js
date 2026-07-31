// Static-site Worker for Eddit: serves the site out of the R2 bucket bound as
// BUCKET (see wrangler.toml).
//
// Why R2 + Worker rather than Pages / Workers-Assets: the two ffmpeg cores are
// ~31 MB each, over the 25 MiB per-file limit of both. R2 has no such limit.
// Same reason ARCAD is built this way.
//
// The other half of the reason is CROSS-ORIGIN ISOLATION. Eddit needs
// SharedArrayBuffer for the multi-threaded ffmpeg core, which requires COOP +
// COEP response headers. GitHub Pages can't set headers, which is why
// coi-serviceworker.js exists in the repo — it installs a service worker that
// re-serves everything with the right headers, at the cost of one extra reload
// on first visit. Here the headers come straight off the origin, so isolation
// holds on the very first response. coi-serviceworker stays in the page as a
// no-op fallback (it bails out when crossOriginIsolated is already true).

// COEP require-corp blocks any subresource that hasn't opted in. Everything
// Eddit loads is same-origin (verified: no CDN, no external fonts), and CORP
// same-origin is stamped on every response below so the policy is explicit
// rather than incidental.
const ISOLATION = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  cube: 'text/plain; charset=utf-8',
};

// App code revalidates on every load. index.html carries a ?v= cache-buster on
// src/main.js only — the modules main.js imports are plain relative specifiers
// with no version on them, so a hard cache would happily serve a new main.js
// against last release's modules. An ETag 304 is cheap; a half-updated module
// graph is not.
const REVALIDATE = 'no-cache';
// vendor/ is third-party (ffmpeg cores, mp4box, mcraw) and only moves on a
// deliberate dependency bump, so it may sit in the browser cache for a day.
// That also keeps the 31 MB wasm off the wire on every reload.
const VENDOR_TTL = 'public, max-age=86400';

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: ISOLATION });
    }

    const url = new URL(request.url);
    let key = decodeURIComponent(url.pathname.slice(1));   // drop the leading "/"
    if (key === '' || key.endsWith('/')) key += 'index.html';

    let object = await env.BUCKET.get(key);
    // Direct-load fallback: an extensionless path that isn't in the bucket is an
    // app route, not a file → hand back index.html. A missing FILE (has a dot)
    // still 404s, so a typo'd script src fails loudly instead of being answered
    // with HTML that then fails to parse.
    if (object === null && !key.split('/').pop().includes('.')) {
      key = 'index.html';
      object = await env.BUCKET.get(key);
    }
    if (object === null) return new Response('Not found', { status: 404, headers: ISOLATION });

    const headers = new Headers(ISOLATION);
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);

    const ext = key.split('.').pop().toLowerCase();
    if (CONTENT_TYPES[ext]) headers.set('content-type', CONTENT_TYPES[ext]);
    headers.set('cache-control', key.startsWith('vendor/') ? VENDOR_TTL : REVALIDATE);

    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
