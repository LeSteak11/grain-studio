// Fullscreen triangle. vUv: screen space with v=0 at top. vRaw: texture space for offscreen passes.
export const VERT = /* glsl */ `#version 300 es
out vec2 vUv;
out vec2 vRaw;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  vRaw = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAG_LUMA = /* glsl */ `#version 300 es
precision highp float;
in vec2 vRaw;
out vec4 o;
uniform sampler2D uSrc;
void main() {
  vec3 c = texture(uSrc, vRaw).rgb;
  o = vec4(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), 1.0);
}`;

export const FRAG_BLUR = /* glsl */ `#version 300 es
precision highp float;
in vec2 vRaw;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  float s = 0.0, ws = 0.0;
  for (int i = -12; i <= 12; i++) {
    float w = exp(-float(i * i) / 72.0);
    s += texture(uTex, vRaw + uDir * float(i)).r * w;
    ws += w;
  }
  o = vec4(vec3(s / ws), 1.0);
}`;

export const FRAG_MAIN = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform sampler3D uLut;
uniform float uLutSize, uLutAmt;
uniform vec2 uSrcSize;
uniform vec2 uOriSize;
uniform vec4 uCrop;
uniform vec4 uView;
uniform int uRot;
uniform float uFlip, uAngle, uScale, uCropAspect, uOriginal;
uniform float uExposure, uContrast, uHighlights, uShadows, uClarity, uSharpen, uSat;
uniform float uTemp, uTint, uSkin, uFade, uVignette, uGrain, uGrainSize;
uniform vec4 uSplit;
uniform vec3 uHsl[6];

const vec3 LW = vec3(0.2126, 0.7152, 0.0722);

vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

vec3 rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5, d = mx - mn, h = 0.0, s = 0.0;
  if (d > 1e-5) {
    s = d / (1.0 - abs(2.0 * l - 1.0) + 1e-6);
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, clamp(s, 0.0, 1.0), l);
}
vec3 hsl2rgb(vec3 hsl) {
  vec3 rgb = clamp(abs(mod(hsl.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  float C = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  return hsl.z + C * (rgb - 0.5);
}

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1, 0)), c = hash(i + vec2(0, 1)), d = hash(i + vec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Output (crop space) -> source texture uv. Inverse of: flip, rotate 90s, straighten+zoom, crop.
vec2 srcUvFrom(vec2 q) {
  vec2 p = uCrop.xy + q * uCrop.zw;
  vec2 c = (p - 0.5) * uOriSize / uScale;
  float cs = cos(uAngle), sn = sin(uAngle);
  c = vec2(cs * c.x + sn * c.y, -sn * c.x + cs * c.y);
  vec2 o = c / uOriSize + 0.5;
  for (int i = 0; i < 3; i++) { if (i < uRot) o = vec2(o.y, 1.0 - o.x); }
  if (uFlip > 0.5) o.x = 1.0 - o.x;
  return o;
}

const float CENTERS[7] = float[7](0.0, 0.0833, 0.1611, 0.3333, 0.6111, 0.7778, 1.0);

void main() {
  vec2 q = uView.xy + vUv * uView.zw;
  vec2 uvRaw = srcUvFrom(q);
  float inside = step(0.0, uvRaw.x) * step(0.0, uvRaw.y) * step(uvRaw.x, 1.0) * step(uvRaw.y, 1.0);
  vec2 uv = clamp(uvRaw, 0.0, 1.0);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 col = texture(uSrc, uv).rgb;

  if (uOriginal < 0.5) {
    if (uSharpen > 0.001) {
      float fp = max(max(length(dx * uSrcSize), length(dy * uSrcSize)), 1.0);
      vec2 o = fp / uSrcSize;
      vec3 n = texture(uSrc, uv + vec2(o.x, 0.0)).rgb + texture(uSrc, uv - vec2(o.x, 0.0)).rgb
             + texture(uSrc, uv + vec2(0.0, o.y)).rgb + texture(uSrc, uv - vec2(0.0, o.y)).rgb;
      col = clamp(col + (col - n * 0.25) * uSharpen * 2.2, 0.0, 1.0);
    }

    // White balance + exposure in linear light.
    vec3 lin = toLin(col);
    vec3 wb = vec3(1.0 + 0.30 * uTemp, 1.0 - 0.18 * uTint, 1.0 - 0.30 * uTemp);
    wb /= dot(wb, LW);
    lin *= wb * exp2(uExposure * 2.0);
    col = toSrgb(lin);

    // Tone: clarity (local contrast), highlights, shadows.
    float L = dot(col, LW);
    float B = texture(uBlur, uv).r;
    float mid = 1.0 - pow(abs(2.0 * clamp(L, 0.0, 1.0) - 1.0), 2.0);
    float dL = uClarity * 1.6 * (L - B) * mid;
    dL += uHighlights * 0.28 * smoothstep(0.4, 1.0, L) + uShadows * 0.30 * (1.0 - smoothstep(0.0, 0.55, L));
    float L2 = max(L + dL, 0.0);
    col = mix(col + dL, col * (L2 / max(L, 1e-4)), smoothstep(0.02, 0.1, L));
    col = clamp(col, 0.0, 1.0);

    // Contrast: S-curve up, flatten down.
    if (uContrast >= 0.0) col = mix(col, col * col * (3.0 - 2.0 * col), uContrast * 0.9);
    else col = mix(col, 0.5 + (col - 0.5) * 0.45, -uContrast);

    // Preset look (3D LUT).
    if (uLutAmt > 0.0) {
      vec3 lc = col * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
      col = mix(col, texture(uLut, lc).rgb, uLutAmt);
    }

    // Saturation.
    L = dot(col, LW);
    float satK = uSat >= 0.0 ? 1.0 + uSat * 0.9 : 1.0 + uSat;
    col = clamp(mix(vec3(L), col, satK), 0.0, 1.0);

    // HSL per band + skin tone.
    vec3 hsl = rgb2hsl(col);
    vec3 adj = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      float c0 = CENTERS[i], c1 = CENTERS[i + 1];
      if (hsl.x >= c0 && hsl.x < c1) {
        float t = smoothstep(0.0, 1.0, (hsl.x - c0) / (c1 - c0));
        adj = mix(uHsl[i], uHsl[(i + 1) % 6], t);
      }
    }
    float m = smoothstep(0.02, 0.2, hsl.y * (1.0 - abs(2.0 * hsl.z - 1.0)) * 2.0);
    hsl.x = fract(hsl.x + adj.x * (30.0 / 360.0) * m + 1.0);
    hsl.y = clamp(hsl.y * (1.0 + adj.y * m), 0.0, 1.0);
    hsl.z = clamp(hsl.z + adj.z * 0.2 * m * hsl.y, 0.0, 1.0);
    float dsk = abs(hsl.x - 0.078);
    float skw = (1.0 - smoothstep(0.0, 0.07, min(dsk, 1.0 - dsk))) * smoothstep(0.05, 0.3, hsl.y);
    hsl.x = fract(hsl.x + uSkin * skw * 0.02 + 1.0);
    hsl.y = clamp(hsl.y * (1.0 + uSkin * 0.12 * skw), 0.0, 1.0);
    col = hsl2rgb(hsl);

    // Split tone.
    L = dot(col, LW);
    vec3 sh = hsl2rgb(vec3(uSplit.x, 1.0, 0.5));
    vec3 hi = hsl2rgb(vec3(uSplit.z, 1.0, 0.5));
    col += (sh - 0.5) * uSplit.y * 0.22 * (1.0 - smoothstep(0.0, 0.65, L));
    col += (hi - 0.5) * uSplit.w * 0.22 * smoothstep(0.35, 1.0, L);

    // Fade: lift blacks.
    col = mix(col, 0.16 + col * 0.84, uFade);

    // Vignette follows the frame.
    vec2 vq = (q - 0.5) * 2.0;
    float vd = length(vq) / 1.4142;
    col *= 1.0 - uVignette * 0.8 * smoothstep(0.25, 1.05, vd);

    // Film grain anchored to source pixels, scaled to image size.
    if (uGrain > 0.0) {
      vec2 sp = uv * uSrcSize;
      float cell = max(uSrcSize.x, uSrcSize.y) / mix(2200.0, 450.0, uGrainSize);
      vec2 gp = sp / cell;
      float n = vnoise(gp) * 0.65 + vnoise(gp * 2.13 + 17.0) * 0.35 - 0.5;
      L = dot(col, LW);
      col += n * uGrain * 0.24 * (1.0 - 0.6 * abs(2.0 * L - 1.0));
    }

    col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  }

  col = mix(vec3(0.055), clamp(col, 0.0, 1.0), inside);
  outColor = vec4(col, 1.0);
}`;
