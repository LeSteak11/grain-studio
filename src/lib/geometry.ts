import type { Crop, EditState } from './types';

export function orientedDims(rotate: number, w: number, h: number): [number, number] {
  return rotate % 2 ? [h, w] : [w, h];
}

/** Zoom needed so a straightened image still covers its own frame (no empty corners). */
export function autoScale(deg: number, W: number, H: number): number {
  const a = Math.abs((deg * Math.PI) / 180);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return Math.max((W * c + H * s) / W, (W * s + H * c) / H);
}

export function outputDims(e: EditState, w: number, h: number, crop: Crop = e.crop): [number, number] {
  const [W, H] = orientedDims(e.rotate, w, h);
  return [Math.max(1, Math.round(crop.w * W)), Math.max(1, Math.round(crop.h * H))];
}

export const ASPECTS: { id: string; label: string }[] = [
  { id: 'free', label: 'Free' },
  { id: 'original', label: 'Original' },
  { id: '1:1', label: '1:1' },
  { id: '4:5', label: '4:5' },
  { id: '5:4', label: '5:4' },
  { id: '3:4', label: '3:4' },
  { id: '4:3', label: '4:3' },
  { id: '2:3', label: '2:3' },
  { id: '3:2', label: '3:2' },
  { id: '9:16', label: '9:16' },
  { id: '16:9', label: '16:9' },
];

/** Aspect in pixels (w/h), or null for free. W/H are oriented image dims. */
export function aspectPx(id: string, W: number, H: number): number | null {
  if (id === 'free') return null;
  if (id === 'original') return W / H;
  const [a, b] = id.split(':').map(Number);
  return a > 0 && b > 0 ? a / b : null;
}

/** Largest centered crop of the given pixel aspect. */
export function fitCrop(ratioPx: number, W: number, H: number): Crop {
  const rn = ratioPx / (W / H);
  return rn >= 1 ? { x: 0, y: (1 - 1 / rn) / 2, w: 1, h: 1 / rn } : { x: (1 - rn) / 2, y: 0, w: rn, h: 1 };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
