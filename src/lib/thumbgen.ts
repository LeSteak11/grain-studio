import { THUMB_EDGE } from './thumbs';

export const PREVIEW_EDGE = 2560;

interface Result {
  w: number;
  h: number;
  buf: ArrayBuffer;
  /** Mid-size preview, when the original is large enough to need one. */
  pbuf: ArrayBuffer | null;
}

type Pending = { resolve: (r: Result) => void; reject: (e: Error) => void };

const POOL = Math.max(2, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 3)));
const workers: Worker[] = [];
const pending = new Map<number, Pending>();
let seq = 0;
let rr = 0;

function worker(): Worker {
  if (workers.length < POOL) {
    const w = new Worker(new URL('../workers/thumb.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data as { id: number; ok: boolean; w: number; h: number; buf: ArrayBuffer; pbuf: ArrayBuffer | null; error?: string };
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve({ w: m.w, h: m.h, buf: m.buf, pbuf: m.pbuf });
      else p.reject(new Error(m.error));
    };
    workers.push(w);
    return w;
  }
  return workers[rr++ % workers.length];
}

/** Decode + downscale in a worker. Transfers the input buffer. */
export function makeThumb(bytes: Uint8Array): Promise<Result> {
  const id = ++seq;
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker().postMessage({ id, buf, edge: THUMB_EDGE, previewEdge: PREVIEW_EDGE }, [buf as ArrayBuffer]);
  });
}

export const THUMB_CONCURRENCY = POOL;
