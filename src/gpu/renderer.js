// WebGPU color-grading renderer.
// Pipeline (all in linear light): input transform (LOG->linear / sRGB->linear)
// -> exposure -> temp/tint -> lift/gamma/gain/offset -> contrast(pivot) ->
// saturation -> curves (1D) -> 3D LUT (trilinear) -> linear->sRGB out.
import { identityCube } from './lut.js';
import { curveEval } from '../util.js';

const WGSL = /* wgsl */`
struct Grade {
  p0: vec4<f32>,   // exposure, contrast, saturation, pivot
  p1: vec4<f32>,   // temp, tint, lutMix, inputT
  p2: vec4<f32>,   // hasLut, hasCurve, lutSize, hasHsl
  lift: vec4<f32>,
  gamma: vec4<f32>,
  gain: vec4<f32>,
  offset: vec4<f32>,
  tf0: vec4<f32>,  // pos x, pos y, scale, rotation
  tf1: vec4<f32>,  // crop L, R, T, B (0..1 insets)
  tf2: vec4<f32>,  // opacity, _, _, _
  hsl0: vec4<f32>, // hue-vs-sat offsets, bands 0..3
  hsl1: vec4<f32>, // hue-vs-sat offsets, bands 4..7
  fx0: vec4<f32>,  // vignette amount, vignette size, vignette feather, glow amount
  fx1: vec4<f32>,  // glow threshold, glow radius, tone-map amount, _
  fx2: vec4<f32>,  // distort amount, distort scale, distort speed, time (playhead s)
  fx3: vec4<f32>,  // wiggle amount, wiggle freq, tone shadows, tone highlights
  hslH0: vec4<f32>, // hue-vs-hue offsets, bands 0..3
  hslH1: vec4<f32>, // hue-vs-hue offsets, bands 4..7
  hslL0: vec4<f32>, // hue-vs-lum offsets, bands 0..3
  hslL1: vec4<f32>, // hue-vs-lum offsets, bands 4..7
  mk0: vec4<f32>,  // qualifier on, target hue, target sat, target luma
  mk1: vec4<f32>,  // qualifier range, qualifier soften, mask invert, show mask
  mk2: vec4<f32>,  // window shape (0 off, 1 circle, 2 rect, 3 linear), cx, cy, feather
  mk3: vec4<f32>,  // window rx, ry, angle, _
};
@group(0) @binding(0) var<uniform> G: Grade;
@group(0) @binding(1) __SRC_DECL__
@group(0) @binding(2) var srcSamp: sampler;
@group(0) @binding(3) var lutTex: texture_3d<f32>;
@group(0) @binding(4) var lutSamp: sampler;
@group(0) @binding(5) var curveTex: texture_2d<f32>;
@group(0) @binding(6) var curveSamp: sampler;
__SRC_FN__

struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2<f32>,3>(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
  var o: VSOut;
  let xy = p[i];
  o.pos = vec4(xy, 0.0, 1.0);
  o.uv = vec2((xy.x+1.0)*0.5, 1.0-(xy.y+1.0)*0.5);
  return o;
}

fn srgbToLin(c: vec3<f32>) -> vec3<f32> {
  return select(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), c > vec3(0.04045));
}
fn linToSrgb(c: vec3<f32>) -> vec3<f32> {
  let cc = clamp(c, vec3(0.0), vec3(1.0));
  return select(cc*12.92, 1.055*pow(cc, vec3(1.0/2.4))-0.055, cc > vec3(0.0031308));
}
// --- LOG -> linear decodes (normalized 0..1 code value) ---
fn slog3(x: f32) -> f32 {
  if (x >= 0.1673609920) { return (pow(10.0, ((x*1023.0-420.0)/261.5))*(0.19)) - 0.01; }
  return (x*1023.0-95.0)*0.01125000/(171.2102946929-95.0);
}
fn logc(x: f32) -> f32 {
  if (x > 0.1496582) { return (pow(10.0, (x-0.385537)/0.247190)-0.052272)/5.555556; }
  return (x-0.092809)/5.367655;
}
// Canon C-Log3 / C-Log2 (approximate, normalized) — refine with official LUTs later.
fn clog3(x: f32) -> f32 {
  let v = x;
  if (v < 0.097465473) { return (v-0.12512248)/2.3069815; }
  return (pow(10.0,(v-0.12240537)/0.36726845)-1.0)/14.98325 * 0.9 + 0.0;
}
fn clog2(x: f32) -> f32 {
  if (x < 0.092864125) { return (x-0.12512248)/2.0 ; }
  return (pow(10.0,(x-0.092864125)/0.24136077)-1.0)/87.09937 ;
}
fn decodeInput(c: vec3<f32>, mode: f32) -> vec3<f32> {
  if (mode < 0.5) { return srgbToLin(c); }
  if (mode < 1.5) { return vec3(clog3(c.r), clog3(c.g), clog3(c.b)); }
  if (mode < 2.5) { return vec3(clog2(c.r), clog2(c.g), clog2(c.b)); }
  if (mode < 3.5) { return vec3(slog3(c.r), slog3(c.g), slog3(c.b)); }
  return vec3(logc(c.r), logc(c.g), logc(c.b));
}

// --- value noise + fbm for the distort/wiggle FX ---
fn hash2(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i); let b = hash2(i + vec2(1.0, 0.0));
  let c = hash2(i + vec2(0.0, 1.0)); let d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn fbm(p: vec2<f32>) -> f32 {
  var v = 0.0; var a = 0.5; var q = p;
  for (var i = 0; i < 3; i++) { v = v + a * vnoise(q); q = q * 2.03; a = a * 0.5; }
  return v;
}

// ACES filmic tone map (Narkowicz approximation) — compresses highlights with a
// smooth shoulder so boosted-contrast flat footage keeps its highlight detail
fn acesFilm(x: vec3<f32>) -> vec3<f32> {
  return clamp((x * (2.51 * x + vec3(0.03))) / (x * (2.43 * x + vec3(0.59)) + vec3(0.14)), vec3(0.0), vec3(1.0));
}

// standard HSV -> RGB (h wraps; s,v unbounded above 1 for linear-light values)
fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3<f32> {
  let p = abs(fract(vec3(h) + vec3(1.0, 2.0/3.0, 1.0/3.0)) * 6.0 - vec3(3.0));
  return v * mix(vec3(1.0), clamp(p - vec3(1.0), vec3(0.0), vec3(1.0)), s);
}

fn applyCurve(c: vec3<f32>) -> vec3<f32> {
  let r = textureSample(curveTex, curveSamp, vec2(clamp(c.r,0.0,1.0), 0.5)).r;
  let g = textureSample(curveTex, curveSamp, vec2(clamp(c.g,0.0,1.0), 0.5)).g;
  let b = textureSample(curveTex, curveSamp, vec2(clamp(c.b,0.0,1.0), 0.5)).b;
  return vec3(r, g, b);
}

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  // ---- clip transform: reframe/scale/rotate/crop (inverse-map the output uv) ----
  var uv = in.uv;
  var p = uv - vec2(0.5, 0.5);
  p = p - vec2(G.tf0.x, G.tf0.y);
  let cr = cos(-G.tf0.w); let sr = sin(-G.tf0.w);
  p = vec2(p.x * cr - p.y * sr, p.x * sr + p.y * cr);
  p = p / max(0.02, G.tf0.z);
  uv = p + vec2(0.5, 0.5);
  // fill-to-project: crop-sample the source so it covers the frame without
  // stretching (tf2.yz carry the per-axis cover factors, 1/1 = same aspect)
  uv = vec2(0.5, 0.5) + (uv - vec2(0.5, 0.5)) * vec2(G.tf2.y, G.tf2.z);
  // wiggle: rigid smooth-noise jitter of the whole layer (AE-style wiggle)
  if (G.fx3.x > 0.0005) {
    let wt = G.fx2.w * (0.5 + G.fx3.y * 6.0);
    let w = vec2(vnoise(vec2(wt, 3.7)), vnoise(vec2(wt, 9.1))) - vec2(0.5);
    uv = uv + w * G.fx3.x * 0.2;
  }
  // turbulence displace: an evolving fbm noise field warps the image per-pixel
  if (G.fx2.x > 0.0005) {
    let sc = 2.0 + G.fx2.y * 14.0;
    let tt = G.fx2.w * G.fx2.z * 2.0;
    let np = uv * sc + vec2(tt, tt * 0.63);
    let d = vec2(fbm(np) - 0.5, fbm(np + vec2(37.2, 17.9)) - 0.5);
    uv = uv + d * G.fx2.x * 0.25;
  }
  let inside = uv.x >= G.tf1.x && uv.x <= 1.0 - G.tf1.y && uv.y >= G.tf1.z && uv.y <= 1.0 - G.tf1.w;
  // sample unconditionally (clamped); the out-of-frame area is masked to black
  // at the end instead of early-return.
  let raw = srcAt(uv);
  // LUT sits at the INPUT: conversion LUTs map the raw camera Log signal to
  // Rec.709 before grading (mixable against the built-in math decode).
  var c: vec3<f32>;
  if (G.p2.x > 0.5) {
    let s = clamp(raw.rgb, vec3(0.0), vec3(1.0));
    let sz = G.p2.z;
    let uvw = s * (sz - 1.0) / sz + 0.5 / sz;
    let conv = srgbToLin(textureSample(lutTex, lutSamp, uvw).rgb);
    let base = decodeInput(raw.rgb, G.p1.w);
    c = mix(base, conv, G.p1.z);
  } else {
    c = decodeInput(raw.rgb, G.p1.w);
  }
  let c0 = c;   // normalized input — the mask mixes the grade against this

  // exposure (stops)
  c = c * pow(2.0, G.p0.x);
  // temp/tint (simple channel gains)
  let temp = G.p1.x; let tint = G.p1.y;
  c.r = c.r * (1.0 + temp*0.35);
  c.b = c.b * (1.0 - temp*0.35);
  c.g = c.g * (1.0 + tint*0.25);
  // lift / gamma / gain / offset (linear-space)
  c = c * (1.0 + G.gain.rgb) + G.offset.rgb;
  c = c + G.lift.rgb * (1.0 - c);
  let gm = clamp(vec3(1.0) - G.gamma.rgb, vec3(0.2), vec3(3.0));
  c = pow(max(c, vec3(0.0)), gm);
  // contrast around pivot
  let pv = G.p0.w;
  c = (c - pv) * (1.0 + G.p0.y) + pv;

  // tone: shadow/highlight ZONE gains + filmic tone map. The gains are
  // multiplicative with soft luma masks — black and the mids stay anchored,
  // so lifting shadow detail doesn't raise the black point into wash-out
  // (unlike lift), and pulling highlights down keeps their relative detail.
  if (G.fx1.z + abs(G.fx3.z) + abs(G.fx3.w) > 0.0005) {
    let Yt = dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722));
    let shM = pow(1.0 - smoothstep(0.0, 0.45, Yt), 2.0);
    let hiM = smoothstep(0.3, 1.1, Yt);
    c = c * max(1.0 + G.fx3.z * 1.6 * shM, 0.05);
    c = c * max(1.0 + G.fx3.w * 0.85 * hiM, 0.05);
    if (G.fx1.z > 0.0005) { c = mix(c, acesFilm(max(c, vec3(0.0))), G.fx1.z); }
  }
  // saturation
  let luma = dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, G.p0.z);
  c = max(c, vec3(0.0));

  // HSL curves: 8 hue bands driving hue shift / saturation / luminance.
  // Gated on p2.w — the CPU sets it only when some band is non-zero, so
  // untouched grades skip the whole hue analysis (uniform branch, no divergence).
  if (G.p2.w > 0.5) {
    let mx = max(max(c.r, c.g), c.b);
    let mn = min(min(c.r, c.g), c.b);
    let chroma = mx - mn;
    if (chroma > 0.0001 && mx > 0.0001) {
      var h = 0.0;
      if (mx == c.r) { h = (c.g - c.b) / chroma; }
      else if (mx == c.g) { h = 2.0 + (c.b - c.r) / chroma; }
      else { h = 4.0 + (c.r - c.g) / chroma; }
      h = fract(h / 6.0);
      let band = h * 8.0;
      let i0 = i32(floor(band)) % 8;
      let i1 = (i0 + 1) % 8;
      let t = fract(band);
      var oH = array<f32,8>(G.hslH0.x, G.hslH0.y, G.hslH0.z, G.hslH0.w, G.hslH1.x, G.hslH1.y, G.hslH1.z, G.hslH1.w);
      var oS = array<f32,8>(G.hsl0.x, G.hsl0.y, G.hsl0.z, G.hsl0.w, G.hsl1.x, G.hsl1.y, G.hsl1.z, G.hsl1.w);
      var oL = array<f32,8>(G.hslL0.x, G.hslL0.y, G.hslL0.z, G.hslL0.w, G.hslL1.x, G.hslL1.y, G.hslL1.z, G.hslL1.w);
      let dh = mix(oH[i0], oH[i1], t);
      let ds = mix(oS[i0], oS[i1], t);
      let dl = mix(oL[i0], oL[i1], t);
      // hue-vs-hue: rotate the hue (±45° at full throw) and rebuild from HSV
      if (abs(dh) > 0.0001) {
        c = hsv2rgb(fract(h + dh * 0.125 + 1.0), chroma / mx, mx);
      }
      // hue-vs-sat: luma-preserving saturation multiplier (identity at 0)
      let hl = dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722));
      c = max(mix(vec3(hl), c, 1.0 + ds), vec3(0.0));
      // hue-vs-lum: brightness gain on that hue range
      c = max(c * (1.0 + dl * 0.7), vec3(0.0));
    }
  }

  // curves operate on display-ish values -> encode, curve, decode
  if (G.p2.y > 0.5) {
    var s = linToSrgb(c);
    s = applyCurve(s);
    c = srgbToLin(s);
  }

  // ---- secondary mask: qualifier (picked colour) × window (shape) gates the
  // COLOUR grade — the final pixel mixes graded vs untouched input by the mask.
  // Geometric/light FX below (glow, vignette, distort) stay global.
  var m = 1.0;
  let mShape = G.mk2.x;
  if (G.mk0.x > 0.5 || mShape > 0.5) {
    if (G.mk0.x > 0.5) {
      // hue/sat/luma distance to the picked colour, measured on the INPUT
      let mx0 = max(max(c0.r, c0.g), c0.b);
      let mn0 = min(min(c0.r, c0.g), c0.b);
      let ch0 = mx0 - mn0;
      var hh = 0.0;
      if (ch0 > 0.0001) {
        if (mx0 == c0.r) { hh = (c0.g - c0.b) / ch0; }
        else if (mx0 == c0.g) { hh = 2.0 + (c0.b - c0.r) / ch0; }
        else { hh = 4.0 + (c0.r - c0.g) / ch0; }
        hh = fract(hh / 6.0);
      }
      let ss = ch0 / max(mx0, 0.0001);
      let yy = dot(max(c0, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722));
      var dh = abs(hh - G.mk0.y); dh = min(dh, 1.0 - dh);
      let D = sqrt(dh * dh * 9.0 + (ss - G.mk0.z) * (ss - G.mk0.z) * 1.44 + (yy - G.mk0.w) * (yy - G.mk0.w));
      m = m * (1.0 - smoothstep(G.mk1.x, G.mk1.x + max(G.mk1.y, 0.01), D));
    }
    if (mShape > 0.5) {
      let pw = in.uv - vec2(G.mk2.y, G.mk2.z);
      var dw = 0.0;
      if (mShape < 1.5) {          // ellipse: normalized radial distance
        dw = length(pw / max(vec2(G.mk3.x, G.mk3.y), vec2(0.001))) - 1.0;
      } else if (mShape < 2.5) {   // rectangle: chebyshev distance
        let q = abs(pw) / max(vec2(G.mk3.x, G.mk3.y), vec2(0.001));
        dw = max(q.x, q.y) - 1.0;
      } else {                     // linear: signed distance along the angle
        dw = dot(pw, vec2(cos(G.mk3.z), sin(G.mk3.z))) / max(G.mk3.x, 0.001);
      }
      m = m * (1.0 - smoothstep(0.0, max(G.mk2.w, 0.01), dw));
    }
    if (G.mk1.z > 0.5) { m = 1.0 - m; }
    c = mix(c0, c, m);
  }

  // exponential glow (bloom): highlights of the source bleed over their
  // neighbours. Single-pass approximation — three rings of taps whose weights
  // fall off exponentially with distance; taps get decode + exposure only.
  // (srcAt samples at explicit LOD 0, safe inside the uniform branch/loops.)
  if (G.fx0.w > 0.0005) {
    let dims = vec2<f32>(textureDimensions(srcTex));
    let aspect = dims.y / max(dims.x, 1.0);
    let radius = max(0.05, G.fx1.y) * 0.08;
    let thr = vec3(max(G.fx1.x, 0.0));
    var acc = vec3(0.0);
    var wsum = 0.0;
    for (var ring = 1; ring < 4; ring++) {
      let rr = radius * f32(ring) / 3.0;
      let w = exp(f32(1 - ring));
      for (var k = 0; k < 8; k++) {
        let ang = (f32(k) + f32(ring) * 0.5) * 0.78539816;
        let off = vec2(cos(ang) * aspect, sin(ang)) * rr;
        let tap = srcAt(uv + off).rgb;
        let lin = decodeInput(tap, G.p1.w) * pow(2.0, G.p0.x);
        acc = acc + max(lin - thr, vec3(0.0)) * w;
        wsum = wsum + w;
      }
    }
    c = c + acc / max(wsum, 0.0001) * G.fx0.w * 2.0;
  }

  // vignette: screen-space radial falloff toward the corners of the frame
  if (G.fx0.x > 0.0005) {
    let d = length(in.uv - vec2(0.5, 0.5)) * 1.4142136;
    let fall = smoothstep(clamp(G.fx0.y, 0.0, 1.5), clamp(G.fx0.y, 0.0, 1.5) + max(0.02, G.fx0.z), d);
    c = c * (1.0 - fall * clamp(G.fx0.x, 0.0, 1.0));
  }

  let vis = select(0.0, 1.0, inside);
  // premultiplied-alpha output so layers blend "over"; raw.a carries source
  // transparency (title text, PNG overlays) — video is opaque so a stays 1.
  let a = G.tf2.x * vis * raw.a;
  // show-mask: draw the matte itself as grayscale for tuning
  if (G.mk1.w > 0.5) { return vec4(vec3(m) * a, a); }
  return vec4(linToSrgb(c) * a, a);
}
`;

export class Renderer {
  constructor() {
    this.ok = false;
    this.device = null;
    this.ctx = null;
    this.canvas = null;
    this.format = 'bgra8unorm';
    this.srcTex = null;
    this.srcSize = [0, 0];
    this.lut = null;
    this.bindDirty = true;
  }

  async init() {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    this.device = await adapter.requestDevice();
    this.format = navigator.gpu.getPreferredCanvasFormat();

    this.uniformBuf = this.device.createBuffer({ size: 24 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.srcSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.lutSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
    this.curveSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    // Two pipeline variants over the same shader: texture_2d for ImageBitmap /
    // canvas / title sources, texture_external for <video>. The external path
    // (device.importExternalTexture) samples decoded video frames zero-copy —
    // copyExternalImageToTexture from a playing video forces a GPU readback
    // per frame that stutters badly on mobile SoCs and outright fails on some
    // Android hw-decoder configs (frozen picture while the clock advances).
    const mkPipeline = (ext) => {
      const code = WGSL
        .replace('__SRC_DECL__', ext ? 'var srcTex: texture_external;' : 'var srcTex: texture_2d<f32>;')
        .replace('__SRC_FN__', ext
          ? 'fn srcAt(uv: vec2<f32>) -> vec4<f32> { return textureSampleBaseClampToEdge(srcTex, srcSamp, clamp(uv, vec2(0.0), vec2(1.0))); }'
          : 'fn srcAt(uv: vec2<f32>) -> vec4<f32> { return textureSampleLevel(srcTex, srcSamp, clamp(uv, vec2(0.0), vec2(1.0)), 0.0); }');
      const mod = this.device.createShaderModule({ code });
      return this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{
          format: this.format,
          // premultiplied "over": out = src + dst*(1-src.a)
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }] },
        primitive: { topology: 'triangle-list' },
      });
    };
    this.pipeline = mkPipeline(false);
    this.extOK = typeof this.device.importExternalTexture === 'function';
    try { this.pipelineExt = this.extOK ? mkPipeline(true) : null; } catch { this.pipelineExt = null; this.extOK = false; }

    this.setLUT(null);
    this.setCurve(null);
    this.setGrade(null);
    this.ok = true;
    return true;
  }

  setCanvas(canvas) {
    if (!this.ok) return;
    this.canvas = canvas || null;
    if (!canvas) { this.ctx = null; return; }   // e.g. restoring a never-set canvas
    this.ctx = canvas.getContext('webgpu');
    this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
  }

  _ensureSrcTex(w, h) {
    if (this.srcTex && this.srcSize[0] === w && this.srcSize[1] === h) return;
    this.srcTex?.destroy?.();
    this.srcTex = this.device.createTexture({
      size: [w, h], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.srcSize = [w, h];
    this.bindDirty = true;
  }

  _buildLutTexture(lut) {
    const { size, data } = lut;
    const u8 = new Uint8Array(size * size * size * 4);
    for (let i = 0; i < u8.length; i++) u8[i] = Math.round(Math.max(0, Math.min(1, data[i])) * 255);
    const tex = this.device.createTexture({
      size: [size, size, size], dimension: '3d', format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture: tex }, u8,
      { bytesPerRow: size * 4, rowsPerImage: size }, [size, size, size]);
    return { tex, size };
  }

  // Memoized per LUT object: the compositor re-applies every layer's grade
  // each frame, and rebuilding a GPU texture per layer per frame was the
  // multi-track stutter. LUT objects are replaced (never mutated), so
  // reference identity is a safe cache key; null = shared identity cube.
  setLUT(lut) {
    const key = lut || null;
    if (key === this._lutKey && this.lutTex) return;
    this._lutKey = key;
    if (!this._lutCache) this._lutCache = new Map();
    let e = this._lutCache.get(key);
    if (!e) {
      e = this._buildLutTexture(key || identityCube(2));
      if (this._lutCache.size >= 8) {
        const [k0, e0] = this._lutCache.entries().next().value;
        if (k0 !== key) { e0.tex.destroy(); this._lutCache.delete(k0); }
      }
      this._lutCache.set(key, e);
    }
    this.lutTex = e.tex; this.lutSize = e.size; this.hasLut = e.size > 2;
    this.bindDirty = true;
    this._writeUniform();
  }

  _identityCurve() { const a = new Uint8Array(256 * 4); for (let i = 0; i < 256; i++) { a[i * 4] = a[i * 4 + 1] = a[i * 4 + 2] = i; a[i * 4 + 3] = 255; } return a; }

  _buildCurveTexture(u8) {
    const tex = this.device.createTexture({
      size: [256, 1], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture: tex }, u8, { bytesPerRow: 256 * 4 }, [256, 1]);
    return tex;
  }

  // curves: {rgb:[{x,y}],r,g,b} control points in 0..1 -> composed 256-table.
  // Memoized like setLUT — identity curves (every fresh grade) share one
  // texture with zero table builds; edited curves cache per object and are
  // invalidated via invalidateGradeCache() since they mutate in place.
  setCurve(curves) {
    const key = curves || null;
    if (key === this._curveKey && this.curveTex) return;
    this._curveKey = key;
    const has = key && ['rgb', 'r', 'g', 'b'].some((k) => key[k] && (key[k].length > 2 ||
      key[k].some((p) => Math.abs(p.y - p.x) > 0.001)));
    this.hasCurve = !!has;
    if (!has) {
      if (!this._identityCurveTex) this._identityCurveTex = this._buildCurveTexture(this._identityCurve());
      this.curveTex = this._identityCurveTex;
      this.bindDirty = true;
      this._writeUniform();
      return;
    }
    if (!this._curveCache) this._curveCache = new Map();
    let tex = this._curveCache.get(key);
    if (!tex) {
      const u8 = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const x = i / 255;
        const m = curveEval(key.rgb, x);
        const r = curveEval(key.r, m);
        const g = curveEval(key.g, m);
        const b = curveEval(key.b, m);
        u8[i * 4] = Math.round(Math.max(0, Math.min(1, r)) * 255);
        u8[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
        u8[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
        u8[i * 4 + 3] = 255;
      }
      tex = this._buildCurveTexture(u8);
      if (this._curveCache.size >= 8) {
        const [k0, t0] = this._curveCache.entries().next().value;
        if (k0 !== key) { t0.destroy(); this._curveCache.delete(k0); }
      }
      this._curveCache.set(key, tex);
    }
    this.curveTex = tex;
    this.bindDirty = true;
    this._writeUniform();
  }

  // grades mutate in place while sliders drag — drop the memo keys (and the
  // curve textures built from now-stale points) so the next set* rebuilds.
  invalidateGradeCache() {
    this._lutKey = undefined;
    this._curveKey = undefined;
    if (this._curveCache) { for (const t of this._curveCache.values()) t.destroy(); this._curveCache.clear(); }
  }

  setGrade(g) { this._grade = g; this._writeUniform(); }
  setTransform(tf) { this._tf = tf; this._writeUniform(); }
  // timeline time driving distort/wiggle evolution — playhead-based so export
  // renders the identical motion. Callers follow with setTransform each frame.
  setTime(t) { this._time = t || 0; }

  _writeUniform() {
    const g = this._grade;
    const inputMap = { none: 0, clog3: 1, clog2: 2, slog3: 3, logc: 4 };
    const f = new Float32Array(24 * 4);
    if (g) {
      const hsl = g.hsl || [], hslH = g.hslHue || [], hslL = g.hslLum || [];
      const hasHsl = [...hsl, ...hslH, ...hslL].some((v) => Math.abs(v || 0) > 1e-4);
      // RAW develop offsets compose into the same controls — exposure is a
      // linear-light gain, so the sum is mathematically the develop result
      f.set([g.exposure + (g.rawExposure || 0), g.contrast, g.saturation, g.pivot], 0);       // p0
      f.set([g.temp + (g.rawTemp || 0), g.tint + (g.rawTint || 0), g.lutMix, inputMap[g.inputTransform] || 0], 4); // p1
      f.set([this.hasLut ? 1 : 0, this.hasCurve ? 1 : 0, this.lutSize || 2, hasHsl ? 1 : 0], 8); // p2
      f.set([...g.lift, 0], 12);
      f.set([...g.gamma, 0], 16);
      f.set([...g.gain, 0], 20);
      f.set([...g.offset, 0], 24);
      f.set([hsl[0] || 0, hsl[1] || 0, hsl[2] || 0, hsl[3] || 0], 40);
      f.set([hsl[4] || 0, hsl[5] || 0, hsl[6] || 0, hsl[7] || 0], 44);
      f.set([hslH[0] || 0, hslH[1] || 0, hslH[2] || 0, hslH[3] || 0], 64);
      f.set([hslH[4] || 0, hslH[5] || 0, hslH[6] || 0, hslH[7] || 0], 68);
      f.set([hslL[0] || 0, hslL[1] || 0, hslL[2] || 0, hslL[3] || 0], 72);
      f.set([hslL[4] || 0, hslL[5] || 0, hslL[6] || 0, hslL[7] || 0], 76);
      const q = g.maskQ || {}, wn = g.maskW || {};
      const shapeMap = { off: 0, circle: 1, rect: 2, linear: 3 };
      f.set([q.on ? 1 : 0, q.h || 0, q.s || 0, q.y || 0], 80);
      f.set([q.range ?? 0.25, q.soft ?? 0.12, g.maskInvert ? 1 : 0, g.maskShow ? 1 : 0], 84);
      f.set([shapeMap[wn.shape] || 0, wn.cx ?? 0.5, wn.cy ?? 0.5, wn.feather ?? 0.2], 88);
      f.set([wn.rx ?? 0.35, wn.ry ?? 0.35, wn.angle || 0, 0], 92);
      // fx defaults via ?? so grades saved before vignette/glow existed still work
      f.set([g.vignette || 0, g.vignetteSize ?? 0.7, g.vignetteFeather ?? 0.5, g.glow || 0], 48);
      f.set([g.glowThreshold ?? 0.6, g.glowRadius ?? 0.5, g.toneMap || 0, 0], 52);
      f.set([g.distort || 0, g.distortScale ?? 0.5, g.distortSpeed ?? 0.5, this._time || 0], 56);
      f.set([g.wiggle || 0, g.wiggleFreq ?? 0.5, g.toneSh || 0, g.toneHi || 0], 60);
    } else {
      f.set([0, 0, 1, 0.435], 0);
      f.set([0, 0, 1, 0], 4);
      f.set([this.hasLut ? 1 : 0, this.hasCurve ? 1 : 0, this.lutSize || 2, 0], 8);
    }
    const t = this._tf;
    const ft = this._fit || [1, 1];   // cover factors set per-layer in drawLayer
    if (t) {
      f.set([t.x || 0, t.y || 0, t.scale ?? 1, t.rotation || 0], 28);
      f.set([t.cropL || 0, t.cropR || 0, t.cropT || 0, t.cropB || 0], 32);
      f.set([t.opacity ?? 1, ft[0], ft[1], 0], 36);
    } else {
      f.set([0, 0, 1, 0], 28); f.set([0, 0, 0, 0], 32); f.set([1, ft[0], ft[1], 0], 36);
    }
    this.device.queue.writeBuffer(this.uniformBuf, 0, f);
  }

  _bind() {
    if (!this.bindDirty && this._bindGroup) return this._bindGroup;
    this._bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.srcTex.createView() },
        { binding: 2, resource: this.srcSampler },
        { binding: 3, resource: this.lutTex.createView({ dimension: '3d' }) },
        { binding: 4, resource: this.lutSampler },
        { binding: 5, resource: this.curveTex.createView() },
        { binding: 6, resource: this.curveSampler },
      ],
    });
    this.bindDirty = false;
    return this._bindGroup;
  }

  // ---- compositing: beginComposite() clears the frame, then drawLayer() blends
  // each video layer "over" the previous one (bottom track first). drawSource()
  // is the single-layer shortcut used everywhere else. ----
  beginComposite() {
    if (!this.ok || !this.ctx) return;
    this._frameView = this.ctx.getCurrentTexture().createView();
    const enc = this.device.createCommandEncoder();
    enc.beginRenderPass({ colorAttachments: [{ view: this._frameView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] }).end();
    this.device.queue.submit([enc.finish()]);
  }

  // per-frame bind group for an imported external texture (they expire after
  // the task, so caching is impossible by design — creation is cheap)
  _bindExt(extTex) {
    return this.device.createBindGroup({
      layout: this.pipelineExt.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: extTex },
        { binding: 2, resource: this.srcSampler },
        { binding: 3, resource: this.lutTex.createView({ dimension: '3d' }) },
        { binding: 4, resource: this.lutSampler },
        { binding: 5, resource: this.curveTex.createView() },
        { binding: 6, resource: this.curveSampler },
      ],
    });
  }

  drawLayer(source, w, h) {
    if (!this.ok || !this.ctx || !this._frameView || !w || !h) return false;
    // default-fill: compute the cover crop for this source vs the canvas frame
    const ca = (this.canvas?.width || 1) / (this.canvas?.height || 1);
    const sa = w / h;
    const fit = sa > ca ? [ca / sa, 1] : [1, sa / ca];
    if (!this._fit || Math.abs(this._fit[0] - fit[0]) > 1e-4 || Math.abs(this._fit[1] - fit[1]) > 1e-4) {
      this._fit = fit; this._writeUniform();
    }
    const isVideo = typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement;
    if (isVideo && source.readyState < 2) return false;   // no decodable frame yet
    let pipeline = null, bind = null;
    if (isVideo && this.extOK && this.pipelineExt) {
      try {
        bind = this._bindExt(this.device.importExternalTexture({ source }));
        pipeline = this.pipelineExt;
        this.srcMode = 'external';
      } catch (e) {
        // readyState was guarded above, so a throw here means the path itself
        // is unsupported — stop retrying every frame
        this.extOK = false; bind = null;
      }
    }
    if (!bind) {
      this._ensureSrcTex(w, h);
      try {
        this.device.queue.copyExternalImageToTexture({ source, flipY: false }, { texture: this.srcTex }, [w, h]);
        this.srcMode = 'copy';
      } catch (e) {
        // last resort: rasterize through 2D canvas — slower but never freezes
        try {
          const c = this._fbCanvas || (this._fbCanvas = document.createElement('canvas'));
          if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
          c.getContext('2d').drawImage(source, 0, 0, w, h);
          this.device.queue.copyExternalImageToTexture({ source: c, flipY: false }, { texture: this.srcTex }, [w, h]);
          this.srcMode = 'canvas';
        } catch (e2) { this.uploadFails = (this.uploadFails || 0) + 1; return false; }
      }
      pipeline = this.pipeline; bind = this._bind();
    }
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this._frameView, loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    return true;
  }

  // source: HTMLVideoElement | ImageBitmap | HTMLImageElement | HTMLCanvasElement
  drawSource(source, w, h) {
    if (!this.ok || !this.ctx || !w || !h) return false;
    // a video with no decoded frame yet must not CLEAR the canvas and then
    // bail inside drawLayer — that black-flashes every seek during scrubbing.
    // Keep the previous picture until a drawable frame arrives.
    if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement && source.readyState < 2) return false;
    this.beginComposite();
    return this.drawLayer(source, w, h);
  }

  clear() {
    if (!this.ok || !this.ctx) return;
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
}
