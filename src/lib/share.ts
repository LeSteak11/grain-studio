// Edited image straight out of the app: copy to clipboard, or drag onto Discord/Instagram/Explorer.
import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { Renderer } from '../gl/renderer';
import { baseName, fsx, join, paths } from './fs';
import { orientedDims, outputDims } from './geometry';
import { getLut } from './luts';
import { loadFull, loadPreview } from './sources';
import { store, toast } from './store';
import type { Photo } from './types';
import { PREVIEW_EDGE } from './thumbgen';
import { DEFAULT_EDIT, isEdited, isVideo, type EditState } from './types';
import { renderVideo } from './videoexport';
import { segmentsOf } from './video';
import { clearBusy, setBusy } from './store';

/** Long edge of shared images: plenty for social apps, fast to render and upload. */
export const SHARE_EDGE = 3072;

let sr: Renderer | null = null;
let srKey = '';
let lock: Promise<unknown> = Promise.resolve();

function exclusive<T>(fn: (r: Renderer) => Promise<T>): Promise<T> {
  const run = lock.then(() => {
    if (!sr) sr = new Renderer(new OffscreenCanvas(8, 8), true);
    return fn(sr);
  });
  lock = run.catch(() => undefined);
  return run;
}

export async function renderShareBlob(id: string, type: 'image/jpeg' | 'image/png' = 'image/jpeg'): Promise<Blob> {
  const photo = store.get().photos.find((p) => p.id === id);
  if (!photo) throw new Error('photo not found');
  const e: EditState = store.get().edits[id] ?? DEFAULT_EDIT;
  const [ow, oh] = outputDims(e, photo.w, photo.h);
  const k = Math.min(1, SHARE_EDGE / Math.max(ow, oh));
  // Heavy crops need more source pixels than the preview holds.
  const [W, H] = orientedDims(e.rotate, photo.w, photo.h);
  const srcNeeded = Math.max((ow * k) / e.crop.w / W, (oh * k) / e.crop.h / H) * Math.max(photo.w, photo.h);
  const useFull = srcNeeded > PREVIEW_EDGE * 1.05;
  const lut = await getLut(e.preset);
  return exclusive(async (r) => {
    const key = `${id}:${useFull ? 'f' : 'p'}`;
    if (srKey !== key) {
      // Fetched inside the lock so a cache eviction can't close it before upload.
      let bmp = await (useFull ? loadFull(id) : loadPreview(id));
      if (!bmp.width) bmp = await createImageBitmap(new Blob([(await fsx.readBytes(photo.file)) as BlobPart]));
      r.setImage(bmp);
      srKey = key;
    }
    r.resize(ow * k, oh * k);
    r.render(e, lut);
    return (r.canvas as OffscreenCanvas).convertToBlob({ type, quality: 0.93 });
  });
}

export async function copyImage(id: string) {
  try {
    // Promise-valued ClipboardItem keeps the keyboard gesture valid while we render.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderShareBlob(id, 'image/png') })]);
    toast('Edited image copied. Paste it anywhere');
  } catch (e) {
    toast(`Copy failed: ${e}`);
  }
}

const iconPath = (id: string) => join(paths.dragDir(), id, '_drag-icon.png');

const shareFiles = new Map<string, { edit: EditState | undefined; path: Promise<string> }>();

/** Renders (or reuses) a temp file of the edited item for dragging out. */
export function renderShareFile(id: string): Promise<string> {
  const edit = store.get().edits[id];
  const hit = shareFiles.get(id);
  if (hit && hit.edit === edit) return hit.path;
  const photo = store.get().photos.find((p) => p.id === id);
  if (photo && isVideo(photo)) {
    // Untouched clips drag out as the original file, instantly.
    if (!isEdited(edit)) return Promise.resolve(photo.file);
    const path = renderVideoShare(photo, edit ?? DEFAULT_EDIT);
    path.catch(() => shareFiles.delete(id));
    shareFiles.set(id, { edit, path });
    return path;
  }
  const path = (async () => {
    const blob = await renderShareBlob(id, 'image/jpeg');
    const file = join(paths.dragDir(), id, `${baseName(photo?.name ?? id)}.jpg`);
    await fsx.writeBytes(file, new Uint8Array(await blob.arrayBuffer()));
    // Small drag ghost (the OS shows the icon at its native size).
    const src = await createImageBitmap(blob);
    const k = 140 / Math.max(src.width, src.height);
    const c = new OffscreenCanvas(Math.round(src.width * k), Math.round(src.height * k));
    c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
    src.close();
    const icon = await c.convertToBlob({ type: 'image/png' });
    await fsx.writeBytes(iconPath(id), new Uint8Array(await icon.arrayBuffer()));
    return file;
  })();
  path.catch(() => shareFiles.delete(id));
  shareFiles.set(id, { edit, path });
  return path;
}

async function renderVideoShare(photo: Photo, edit: EditState): Promise<string> {
  setBusy(`Rendering ${photo.name}`, 0, 1);
  try {
    const bufs = await renderVideo(photo, edit, { maxEdge: 1920, quality: 0.75 }, (p) => setBusy(`Rendering ${photo.name}`, Math.round(p * 100) / 100, 1));
    const file = join(paths.dragDir(), photo.id, `${baseName(photo.name)}.mp4`);
    await fsx.writeBytes(file, bufs[0]);
    // Extra segments sit next to it so a split clip can be dragged out piece by piece.
    for (let i = 1; i < bufs.length; i++) await fsx.writeBytes(join(paths.dragDir(), photo.id, `${baseName(photo.name)}-${i + 1}.mp4`), bufs[i]);
    return file;
  } finally {
    clearBusy();
  }
}

/** Has this clip already been rendered for its current edit? */
export function shareReady(id: string): boolean {
  const s = store.get();
  const photo = s.photos.find((p) => p.id === id);
  if (!photo) return false;
  if (!isVideo(photo)) return true;
  if (!isEdited(s.edits[id])) return true;
  const hit = shareFiles.get(id);
  return !!hit && hit.edit === s.edits[id] && settled.has(hit.path);
}

const settled = new Set<Promise<string> | string>();

/** True while an outgoing drag is in progress, so our own drop handler ignores it. */
export let draggingOut = false;

export async function dragOut(ids: string[]) {
  if (!ids.length || draggingOut) return;
  draggingOut = true;
  try {
    const dragged = ids.slice(0, 40);
    const files = await Promise.all(dragged.map(renderShareFile));
    for (const f of files) settled.add(f);
    await startDrag({ item: files, icon: iconPath(ids[0]) }, (payload) => {
      // Dropped somewhere: offer to mark these as posted.
      if (payload.result === 'Dropped') store.set({ postPrompt: { ids: dragged, at: Date.now() } });
    });
  } catch (e) {
    toast(`Drag failed: ${e}`);
  } finally {
    setTimeout(() => (draggingOut = false), 400);
  }
}

/** Start a drag once the pointer moves a few px with the button held. Pre-renders on press. */
export function dragOutGesture(ev: React.PointerEvent, ids: () => string[]) {
  if (ev.button !== 0) return;
  const sx = ev.clientX;
  const sy = ev.clientY;
  const list = ids();
  const s = store.get();
  // A video that still needs rendering can't be dragged instantly; render it, then say so.
  const needRender = list.filter((id) => {
    const p = s.photos.find((x) => x.id === id);
    return p && isVideo(p) && isEdited(s.edits[id]) && !shareReady(id);
  });
  if (needRender.length) {
    toast(`Rendering ${needRender.length === 1 ? 'the clip' : `${needRender.length} clips`}… drag again when it's done`);
    void Promise.all(needRender.map((id) => renderShareFile(id).then((f) => settled.add(f))))
      .then(() => toast('Ready — drag it out now'))
      .catch((e) => toast(`Render failed: ${e instanceof Error ? e.message : e}`));
    return;
  }
  list.slice(0, 40).forEach((id) => void renderShareFile(id).then((f) => settled.add(f)).catch(() => undefined));
  const move = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - sx, e.clientY - sy) < 7) return;
    cleanup();
    void dragOut(list);
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', cleanup);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', cleanup);
}
