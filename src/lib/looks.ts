// Built-in looks, baked procedurally into 3D LUTs at runtime (nothing copied from VSCO).
import type { Lut } from './luts';

import type { Pt } from './types';
type V3 = [number, number, number];

interface LookDef {
  code: string;
  name: string;
  curve?: Pt[];
  r?: Pt[];
  g?: Pt[];
  b?: Pt[];
  sat?: number;
  warm?: number;
  sh?: V3;
  hi?: V3;
  split?: number;
  fade?: number;
  mono?: boolean;
  tone?: V3;
}

const S_SOFT: Pt[] = [[0, 0], [0.25, 0.22], [0.75, 0.79], [1, 1]];
const S_MED: Pt[] = [[0, 0], [0.25, 0.19], [0.75, 0.82], [1, 1]];
const S_STRONG: Pt[] = [[0, 0], [0.25, 0.15], [0.75, 0.86], [1, 1]];

export const LOOK_DEFS: LookDef[] = [
  { code: 'N1', name: 'Natural', curve: [[0, 0.02], [0.25, 0.23], [0.75, 0.78], [1, 0.98]], sat: 1.05, warm: 0.3 },
  { code: 'W1', name: 'Sunkissed', curve: S_SOFT, r: [[0, 0.03], [1, 1]], b: [[0, 0.02], [1, 0.9]], sat: 1.05, fade: 0.3 },
  { code: 'W2', name: 'Golden', curve: S_MED, warm: 1, sat: 1.1 },
  { code: 'F1', name: 'Film Fade', curve: [[0, 0.08], [0.3, 0.28], [0.7, 0.74], [1, 0.95]], sat: 0.85, fade: 0.5 },
  { code: 'F2', name: 'Portrait', curve: [[0, 0.03], [0.5, 0.52], [1, 0.97]], g: [[0, 0.02], [1, 0.98]], warm: 0.4, sat: 0.9, sh: [0.45, 0.5, 0.56], split: 0.3 },
  { code: 'C1', name: 'Coastal', b: [[0, 0.08], [0.5, 0.52], [1, 0.97]], r: [[0, 0], [1, 0.96]], sat: 0.9, fade: 0.4 },
  { code: 'C2', name: 'Nordic', curve: [[0, 0.06], [0.5, 0.56], [1, 1]], warm: -0.6, sat: 0.7 },
  { code: 'T1', name: 'Teal Orange', curve: S_MED, sat: 1.05, sh: [0.2, 0.55, 0.62], hi: [0.92, 0.62, 0.36], split: 0.4 },
  { code: 'P1', name: 'Pastel', curve: [[0, 0.12], [0.5, 0.6], [1, 0.97]], sat: 0.75 },
  { code: 'V1', name: 'Vivid', curve: S_STRONG, sat: 1.3 },
  { code: 'G1', name: 'Evergreen', curve: S_SOFT, r: [[0, 0], [0.5, 0.48], [1, 1]], g: [[0, 0.03], [0.5, 0.52], [1, 1]], b: [[0, 0.05], [1, 0.95]], sat: 0.95 },
  { code: 'R1', name: 'Retro', r: [[0, 0.05], [1, 1]], g: [[0, 0.03], [1, 0.97]], b: [[0, 0.1], [0.5, 0.42], [1, 0.8]], sat: 0.9, fade: 0.4 },
  { code: 'M1', name: 'Moody', curve: [[0, 0.03], [0.3, 0.22], [0.7, 0.68], [1, 0.92]], sat: 0.75, sh: [0.3, 0.45, 0.52], split: 0.25 },
  { code: 'K1', name: 'Chroma', curve: S_MED, r: [[0, 0], [0.5, 0.53], [1, 1]], b: [[0, 0], [0.7, 0.66], [1, 0.94]], sat: 1.2 },
  { code: 'X1', name: 'Cross', r: S_STRONG, g: S_MED, b: [[0, 0.15], [1, 0.85]], sat: 1.1 },
  { code: 'B1', name: 'Mono', curve: S_SOFT, mono: true },
  { code: 'B2', name: 'Mono Punch', curve: S_STRONG, mono: true },
  { code: 'B3', name: 'Mono Fade', curve: S_SOFT, mono: true, fade: 0.6, tone: [1.03, 1, 0.95] },
];

/** Monotone cubic (Fritsch–Carlson) through control points. */
export function spline(pts: Pt[]): (x: number) => number {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  const m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

const ident = (x: number) => x;
const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function build(d: LookDef): (r: number, g: number, b: number) => V3 {
  const m = d.curve ? spline(d.curve) : ident;
  const cr = d.r ? spline(d.r) : ident;
  const cg = d.g ? spline(d.g) : ident;
  const cb = d.b ? spline(d.b) : ident;
  return (r, g, b) => {
    r = cr(m(r));
    g = cg(m(g));
    b = cb(m(b));
    if (d.warm) {
      r *= 1 + 0.06 * d.warm;
      b *= 1 - 0.06 * d.warm;
    }
    let L = lum(r, g, b);
    if (d.mono) {
      r = g = b = L;
      if (d.tone) {
        r *= d.tone[0];
        g *= d.tone[1];
        b *= d.tone[2];
      }
    } else if (d.sat !== undefined) {
      r = L + (r - L) * d.sat;
      g = L + (g - L) * d.sat;
      b = L + (b - L) * d.sat;
    }
    if (d.split) {
      L = lum(r, g, b);
      const ws = (1 - L) ** 2 * d.split;
      const wh = L * L * d.split;
      if (d.sh) {
        r += (d.sh[0] - 0.5) * ws;
        g += (d.sh[1] - 0.5) * ws;
        b += (d.sh[2] - 0.5) * ws;
      }
      if (d.hi) {
        r += (d.hi[0] - 0.5) * wh;
        g += (d.hi[1] - 0.5) * wh;
        b += (d.hi[2] - 0.5) * wh;
      }
    }
    if (d.fade) {
      const f = d.fade * 0.15;
      r = f + r * (1 - f);
      g = f + g * (1 - f);
      b = f + b * (1 - f);
    }
    return [r, g, b];
  };
}

export function bakeLut(fn: (r: number, g: number, b: number) => V3, n = 33): Lut {
  const data = new Uint8Array(n * n * n * 3);
  let i = 0;
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const o = fn(r / (n - 1), g / (n - 1), b / (n - 1));
        data[i++] = q(o[0]);
        data[i++] = q(o[1]);
        data[i++] = q(o[2]);
      }
  return { size: n, data };
}

export function bakeLook(code: string): Lut | null {
  const d = LOOK_DEFS.find((l) => l.code === code);
  return d ? bakeLut(build(d)) : null;
}
