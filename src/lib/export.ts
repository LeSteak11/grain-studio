import { Renderer } from '../gl/renderer';
import { baseName, fsx, join } from './fs';
import { outputDims } from './geometry';
import { getLut } from './luts';
import { decodeFile } from './sources';
import { clearBusy, setBusy, store, toast } from './store';
import { DEFAULT_EDIT } from './types';

export interface ExportOpts {
  dir: string;
  format: 'jpeg' | 'png';
  quality: number;
  /** Long edge in px; 0 = original size. */
  size: number;
  openAfter: boolean;
}

let er: Renderer | null = null;

export async function exportPhotos(ids: string[], o: ExportOpts) {
  if (!er) er = new Renderer(new OffscreenCanvas(8, 8), true);
  const r = er;
  const maxDim = Math.min(r.maxTex, (r.gl.getParameter(r.gl.MAX_VIEWPORT_DIMS) as Int32Array)[0]);
  let done = 0;
  let failed = 0;
  let last = '';
  setBusy('Exporting', 0, ids.length);
  for (const id of ids) {
    const s = store.get();
    const photo = s.photos.find((p) => p.id === id);
    if (!photo) continue;
    try {
      const e = s.edits[id] ?? DEFAULT_EDIT;
      let bmp = await decodeFile(photo.file);
      if (Math.max(bmp.width, bmp.height) > r.maxTex) {
        const k = r.maxTex / Math.max(bmp.width, bmp.height);
        const scaled = await createImageBitmap(bmp, { resizeWidth: Math.floor(bmp.width * k), resizeHeight: Math.floor(bmp.height * k), resizeQuality: 'high' });
        bmp.close();
        bmp = scaled;
      }
      r.setImage(bmp);
      bmp.close();
      const [ow, oh] = outputDims(e, photo.w, photo.h);
      let k = o.size ? Math.min(1, o.size / Math.max(ow, oh)) : 1;
      k = Math.min(k, maxDim / Math.max(ow, oh));
      r.resize(ow * k, oh * k);
      r.render(e, await getLut(e.preset));
      const blob = await (r.canvas as OffscreenCanvas).convertToBlob({ type: `image/${o.format}`, quality: o.quality });
      const ext = o.format === 'png' ? 'png' : 'jpg';
      last = await fsx.writeBytes(join(o.dir, `${baseName(photo.name)}.${ext}`), new Uint8Array(await blob.arrayBuffer()), true);
    } catch (err) {
      console.error('export failed', photo.name, err);
      failed++;
    }
    done++;
    setBusy('Exporting', done, ids.length);
    await new Promise((res) => setTimeout(res, 0));
  }
  // Free the big textures but keep the context for next time.
  r.dispose();
  r.resize(8, 8);
  clearBusy();
  const ok = done - failed;
  toast(failed ? `Exported ${ok}, ${failed} failed` : `Exported ${ok} photo${ok === 1 ? '' : 's'} → ${last ? last.split('\\').slice(-2, -1)[0] : ''}`);
  if (o.openAfter && ok) await fsx.openPath(o.dir);
}
