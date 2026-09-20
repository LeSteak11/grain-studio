// Text overlay: drawn to a canvas, uploaded as a texture and composited by the same shader,
// so the preview, the export and a dragged-out file all match.
import type { TextStyle } from './types';

/** Fonts that ship with Windows or are already installed here; all look right for IG/TikTok captions. */
export const FONTS = [
  { name: 'Montserrat', label: 'Montserrat — geometric, very IG' },
  { name: 'Lato', label: 'Lato — clean (like Open Sans)' },
  { name: 'Bahnschrift', label: 'Bahnschrift — condensed' },
  { name: 'Segoe UI', label: 'Segoe UI — neutral' },
  { name: 'Arial Black', label: 'Arial Black — heavy' },
  { name: 'Impact', label: 'Impact — meme classic' },
  { name: 'Franklin Gothic Medium', label: 'Franklin Gothic' },
  { name: 'Trebuchet MS', label: 'Trebuchet' },
  { name: 'Georgia', label: 'Georgia — serif' },
  { name: 'Rockwell', label: 'Rockwell — slab serif' },
  { name: 'Courier New', label: 'Courier — typewriter' },
  { name: 'Comic Sans MS', label: 'Comic Sans' },
  { name: 'Ink Free', label: 'Ink Free — handwritten' },
];

export const WEIGHTS = [
  { v: 400, label: 'Regular' },
  { v: 700, label: 'Bold' },
  { v: 900, label: 'Black' },
];

export function fontAvailable(name: string): boolean {
  try {
    return document.fonts.check(`16px "${name}"`);
  } catch {
    return true;
  }
}

export const hasText = (t: TextStyle | undefined) => !!t && t.body.trim().length > 0;

/**
 * Draws the overlay at the given output size. Returns null when there's nothing to draw.
 * Alpha is left unpremultiplied so the shader can blend it exactly.
 */
export async function buildTextLayer(t: TextStyle, W: number, H: number): Promise<ImageBitmap | null> {
  if (!hasText(t) || W < 2 || H < 2) return null;
  const c = new OffscreenCanvas(Math.round(W), Math.round(H));
  const ctx = c.getContext('2d')!;
  const px = Math.max(4, t.size * H);
  ctx.font = `${t.weight} ${px}px "${t.font}", "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = t.align;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.globalAlpha = Math.max(0, Math.min(1, t.opacity));

  const lines = (t.caps ? t.body.toUpperCase() : t.body).split('\n');
  const lh = px * t.lineHeight;
  const cx = t.x * c.width;
  const cy = t.y * c.height;
  const top = cy - (lh * lines.length) / 2;

  if (t.shadow > 0) {
    ctx.shadowColor = `rgba(0,0,0,${0.65 * t.shadow})`;
    ctx.shadowBlur = px * 0.3 * t.shadow;
    ctx.shadowOffsetY = px * 0.05 * t.shadow;
  }
  lines.forEach((line, i) => {
    const y = top + lh * (i + 0.5);
    if (t.strokeW > 0) {
      ctx.strokeStyle = t.stroke;
      ctx.lineWidth = px * t.strokeW;
      ctx.strokeText(line, cx, y);
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line, cx, y);
  });
  return createImageBitmap(c, { premultiplyAlpha: 'none' });
}

/** Overlay sized for a given output, capped so huge exports don't waste memory. */
export function layerSize(outW: number, outH: number, cap = 2560): [number, number] {
  const k = Math.min(1, cap / Math.max(outW, outH));
  return [Math.max(2, Math.round(outW * k)), Math.max(2, Math.round(outH * k))];
}
