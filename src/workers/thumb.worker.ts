// Decodes an original off the main thread and returns a JPEG thumbnail plus the true dimensions.
interface Req {
  id: number;
  buf: ArrayBuffer;
  edge: number;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

ctx.onmessage = async (e) => {
  const { id, buf, edge } = e.data;
  try {
    const bmp = await createImageBitmap(new Blob([buf]));
    const w = bmp.width;
    const h = bmp.height;
    const k = Math.min(1, edge / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * k));
    const th = Math.max(1, Math.round(h * k));
    const small = await createImageBitmap(bmp, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
    bmp.close();
    const c = new OffscreenCanvas(tw, th);
    c.getContext('2d')!.drawImage(small, 0, 0);
    small.close();
    const out = await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 })).arrayBuffer();
    ctx.postMessage({ id, ok: true, w, h, buf: out }, [out]);
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String(err) });
  }
};
