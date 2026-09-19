import { Renderer } from '../gl/renderer';
import { fsx, paths } from './fs';
import { getLut } from './luts';
import { outputDims } from './geometry';
import { store } from './store';
import { isEdited } from './types';

export const THUMB_EDGE = 720;

let tr: Renderer | null = null;
let trKey = '';
let lock: Promise<unknown> = Promise.resolve();

type SetSrc = (key: string, bmp: ImageBitmap) => void;

/** Exclusive access to the shared small offscreen renderer (preset previews + edited thumbnails). */
export function withThumbRenderer<T>(fn: (r: Renderer, setSrc: SetSrc) => T | Promise<T>): Promise<T> {
  const run = lock.then(() => {
    if (!tr) tr = new Renderer(new OffscreenCanvas(8, 8), true);
    const r = tr;
    return fn(r, (key, bmp) => {
      if (trKey !== key) {
        r.setImage(bmp);
        trKey = key;
      }
    });
  });
  lock = run.catch(() => undefined);
  return run;
}

const bmpCache = new Map<string, Promise<ImageBitmap>>();

/** Decoded small (≤720px) version of the original, cached. */
export function getThumbBitmap(id: string): Promise<ImageBitmap> {
  let p = bmpCache.get(id);
  if (p) {
    bmpCache.delete(id);
    bmpCache.set(id, p);
    return p;
  }
  p = fsx.readBytes(paths.thumb(id)).then((b) => createImageBitmap(new Blob([b as BlobPart])));
  p.catch(() => bmpCache.delete(id));
  bmpCache.set(id, p);
  if (bmpCache.size > 60) bmpCache.delete(bmpCache.keys().next().value!);
  return p;
}

export function dropThumbBitmap(id: string) {
  bmpCache.delete(id);
}

const timers = new Map<string, number>();

export function scheduleEditedThumb(id: string) {
  clearTimeout(timers.get(id));
  timers.set(
    id,
    window.setTimeout(() => {
      timers.delete(id);
      renderEditedThumb(id).catch((e) => console.warn('thumb render failed', e));
    }, 600),
  );
}

function setRev(id: string, rev: number) {
  store.set((s) => ({ photos: s.photos.map((p) => (p.id === id ? { ...p, rev } : p)) }));
}

async function renderEditedThumb(id: string) {
  const s = store.get();
  const photo = s.photos.find((p) => p.id === id);
  if (!photo) return;
  const edit = s.edits[id];
  if (!isEdited(edit)) {
    if (photo.rev) {
      setRev(id, 0);
      await fsx.remove([paths.editedThumb(id)]);
    }
    return;
  }
  const bmp = await getThumbBitmap(id);
  const lut = await getLut(edit.preset);
  const blob = await withThumbRenderer(async (r, setSrc) => {
    setSrc(`t:${id}`, bmp);
    const [ow, oh] = outputDims(edit, photo.w, photo.h);
    const k = Math.min(1, THUMB_EDGE / Math.max(ow, oh));
    r.resize(ow * k, oh * k);
    r.render(edit, lut);
    return (r.canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  });
  await fsx.writeBytes(paths.editedThumb(id), new Uint8Array(await blob.arrayBuffer()));
  if (store.get().edits[id] === edit) setRev(id, Date.now());
}
