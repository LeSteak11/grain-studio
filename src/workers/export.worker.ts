// Full-resolution export off the main thread: decode → GPU render → encode.
import { Renderer } from '../gl/renderer';
import { outputDims } from '../lib/geometry';
import type { Lut } from '../lib/luts';
import type { EditState } from '../lib/types';

interface Job {
  id: number;
  bytes: ArrayBuffer;
  edit: EditState;
  lut: Lut | null;
  w: number;
  h: number;
  size: number;
  type: string;
  quality: number;
  text: ImageBitmap | null;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

let r: Renderer | null = null;

ctx.onmessage = async (e) => {
  const j = e.data;
  try {
    if (!r) r = new Renderer(new OffscreenCanvas(8, 8), true);
    const maxDim = Math.min(r.maxTex, (r.gl.getParameter(r.gl.MAX_VIEWPORT_DIMS) as Int32Array)[0]);
    let bmp = await createImageBitmap(new Blob([j.bytes]));
    if (Math.max(bmp.width, bmp.height) > r.maxTex) {
      const k = r.maxTex / Math.max(bmp.width, bmp.height);
      const scaled = await createImageBitmap(bmp, { resizeWidth: Math.floor(bmp.width * k), resizeHeight: Math.floor(bmp.height * k), resizeQuality: 'high' });
      bmp.close();
      bmp = scaled;
    }
    r.setImage(bmp);
    bmp.close();
    const [ow, oh] = outputDims(j.edit, j.w, j.h);
    let k = j.size ? Math.min(1, j.size / Math.max(ow, oh)) : 1;
    k = Math.min(k, maxDim / Math.max(ow, oh));
    r.resize(ow * k, oh * k);
    r.setTextLayer(j.text ?? null);
    r.render(j.edit, j.lut);
    const blob = await (r.canvas as OffscreenCanvas).convertToBlob({ type: j.type, quality: j.quality });
    const buf = await blob.arrayBuffer();
    r.dispose();
    r.resize(8, 8);
    ctx.postMessage({ id: j.id, ok: true, buf }, [buf]);
  } catch (err) {
    ctx.postMessage({ id: j.id, ok: false, error: String(err) });
  }
};
