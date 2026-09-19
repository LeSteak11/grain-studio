// Live preset thumbnails: the current photo rendered through every preset, drawn into small tile canvases.
import { getLut } from './luts';
import { outputDims } from './geometry';
import { store } from './store';
import { getThumbBitmap, withThumbRenderer } from './thumbs';
import { DEFAULT_EDIT } from './types';

const tiles = new Map<string, HTMLCanvasElement>();
let photoId: string | null = null;
let timer = 0;
let gen = 0;
const PREVIEW_EDGE = 220;

function schedule(delay: number) {
  clearTimeout(timer);
  timer = window.setTimeout(() => void run(), delay);
}

export function registerTile(presetId: string, canvas: HTMLCanvasElement) {
  tiles.set(presetId, canvas);
  schedule(30);
}

export function unregisterTile(presetId: string, canvas: HTMLCanvasElement) {
  if (tiles.get(presetId) === canvas) tiles.delete(presetId);
}

export function setPreviewPhoto(id: string | null) {
  photoId = id;
  schedule(0);
}

export function refreshPreviews(delay = 450) {
  schedule(delay);
}

async function run() {
  const my = ++gen;
  const id = photoId;
  if (!id) return;
  const photo = store.get().photos.find((p) => p.id === id);
  if (!photo) return;
  let bmp: ImageBitmap;
  try {
    bmp = await getThumbBitmap(id);
  } catch {
    return;
  }
  const base = store.get().edits[id] ?? DEFAULT_EDIT;
  let n = 0;
  for (const [pid, canvas] of [...tiles]) {
    if (my !== gen) return;
    const lut = pid === 'none' ? null : await getLut(pid);
    if (my !== gen) return;
    await withThumbRenderer((r, setSrc) => {
      setSrc(`t:${id}`, bmp);
      const e = { ...base, preset: pid === 'none' ? null : pid, strength: 1 };
      const [ow, oh] = outputDims(e, photo.w, photo.h);
      const k = PREVIEW_EDGE / Math.max(ow, oh);
      r.resize(ow * k, oh * k);
      r.render(e, lut);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const cw = canvas.width;
      const ch = canvas.height;
      const sw = r.canvas.width;
      const sh = r.canvas.height;
      const s = Math.max(cw / sw, ch / sh);
      const w = cw / s;
      const h = ch / s;
      ctx.drawImage(r.canvas, (sw - w) / 2, (sh - h) / 2, w, h, 0, 0, cw, ch);
    });
    if (++n % 6 === 0) await new Promise((res) => requestAnimationFrame(res));
  }
}
