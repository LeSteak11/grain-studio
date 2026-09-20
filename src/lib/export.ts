import { baseName, fsx, join } from './fs';
import { getLut } from './luts';
import { clearBusy, setBusy, store, toast } from './store';
import { DEFAULT_EDIT, isVideo } from './types';
import { renderVideo } from './videoexport';
import { segmentsOf } from './video';
import { buildTextLayer, layerSize } from './textlayer';
import { outputDims } from './geometry';

export interface ExportOpts {
  dir: string;
  format: 'jpeg' | 'png';
  quality: number;
  /** Long edge in px; 0 = original size. */
  size: number;
  openAfter: boolean;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/export.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data as { id: number; ok: boolean; buf?: ArrayBuffer; error?: string };
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok && m.buf) p.resolve(m.buf);
      else p.reject(new Error(m.error ?? 'export failed'));
    };
  }
  return worker;
}

let running = false;

/** Renders in a worker so the editor stays responsive; reads the next file while the current one renders. */
export async function exportPhotos(ids: string[], o: ExportOpts, names?: string[]) {
  if (running) {
    toast('An export is already running');
    return;
  }
  running = true;
  let done = 0;
  let failed = 0;
  setBusy('Exporting', 0, ids.length);
  const photoOf = (id: string) => store.get().photos.find((p) => p.id === id);
  const read = (id: string | undefined) => {
    const p = id ? photoOf(id) : undefined;
    return p ? fsx.readBytes(p.file) : null;
  };
  let next = read(ids[0]);
  for (let i = 0; i < ids.length; i++) {
    const photo = photoOf(ids[i]);
    const cur = next;
    next = read(ids[i + 1]);

    // Videos go through the WebCodecs worker instead of the still-image path.
    if (photo && isVideo(photo)) {
      try {
        const edit = store.get().edits[photo.id] ?? DEFAULT_EDIT;
        const segs = segmentsOf(edit, photo.dur ?? 0).length;
        const bufs = await renderVideo(photo, edit, { maxEdge: o.size, quality: o.quality }, (p) =>
          setBusy(`Rendering ${photo.name}`, Math.round((done + p) * 10) / 10, ids.length),
        );
        const base = names?.[i] || baseName(photo.name);
        for (let n = 0; n < bufs.length; n++) {
          await fsx.writeBytes(join(o.dir, `${base}${segs > 1 ? `-${n + 1}` : ''}.mp4`), bufs[n], true);
        }
      } catch (err) {
        console.error('video export failed', photo.name, err);
        toast(`Couldn't render ${photo.name}: ${err instanceof Error ? err.message : err}`);
        failed++;
      }
      done++;
      setBusy('Exporting', done, ids.length);
      continue;
    }
    if (!photo || !cur) {
      failed++;
      done++;
      continue;
    }
    try {
      const bytes = await cur;
      const edit = store.get().edits[photo.id] ?? DEFAULT_EDIT;
      const lut = await getLut(edit.preset);
      const id = ++seq;
      const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
      const [ow, oh] = outputDims(edit, photo.w, photo.h);
      const scale = o.size ? Math.min(1, o.size / Math.max(ow, oh)) : 1;
      const [lw, lh] = layerSize(ow * scale, oh * scale, 4096);
      const text = await buildTextLayer(edit.text, lw, lh).catch(() => null);
      const out = await new Promise<ArrayBuffer>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const transfer: Transferable[] = [buf as ArrayBuffer];
        if (text) transfer.push(text);
        getWorker().postMessage(
          { id, bytes: buf, edit, lut, w: photo.w, h: photo.h, size: o.size, type: `image/${o.format}`, quality: o.quality, text },
          transfer,
        );
      });
      const ext = o.format === 'png' ? 'png' : 'jpg';
      const base = names?.[i] || baseName(photo.name);
      await fsx.writeBytes(join(o.dir, `${base}.${ext}`), new Uint8Array(out), true);
    } catch (err) {
      console.error('export failed', photo.name, err);
      failed++;
    }
    done++;
    setBusy('Exporting', done, ids.length);
  }
  running = false;
  clearBusy();
  const ok = done - failed;
  toast(failed ? `Exported ${ok}, ${failed} failed` : `Exported ${ok} photo${ok === 1 ? '' : 's'}`);
  if (o.openAfter && ok) await fsx.openPath(o.dir);
}
