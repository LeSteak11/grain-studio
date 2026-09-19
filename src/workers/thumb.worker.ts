// Decodes an original off the main thread and returns a JPEG thumbnail plus the true dimensions.
interface Req {
  id: number;
  buf: ArrayBuffer;
  edge: number;
  /** Also emit a mid-size preview JPEG when the original is bigger than this (0 = never). */
  previewEdge: number;
}

async function encode(src: ImageBitmap, w: number, h: number, edge: number, quality: number): Promise<ArrayBuffer> {
  const k = Math.min(1, edge / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * k));
  const th = Math.max(1, Math.round(h * k));
  const small = await createImageBitmap(src, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
  const c = new OffscreenCanvas(tw, th);
  c.getContext('2d')!.drawImage(small, 0, 0);
  small.close();
  return (await c.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer();
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

ctx.onmessage = async (e) => {
  const { id, buf, edge, previewEdge } = e.data;
  try {
    const bmp = await createImageBitmap(new Blob([buf]));
    const w = bmp.width;
    const h = bmp.height;
    const out = await encode(bmp, w, h, edge, 0.88);
    const pbuf = previewEdge && Math.max(w, h) > previewEdge * 1.15 ? await encode(bmp, w, h, previewEdge, 0.93) : null;
    bmp.close();
    ctx.postMessage({ id, ok: true, w, h, buf: out, pbuf }, pbuf ? [out, pbuf] : [out]);
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String(err) });
  }
};
