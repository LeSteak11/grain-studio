// Drives the video render worker: one clip at a time, one job per segment.
import { fsx } from './fs';
import { getLut } from './luts';
import { segmentsOf } from './video';
import { dropDecoded, mixSegment } from './sound';
import { buildTextLayer, layerSize } from './textlayer';
import { outputDims } from './geometry';
import type { EditState, Photo } from './types';

export interface VideoOpts {
  /** Cap on the long edge; 0 = source size. */
  maxEdge: number;
  /** 0..1 */
  quality: number;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void; onProgress?: (p: number) => void }>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/video.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data as { id: number; ok?: boolean; buf?: ArrayBuffer; error?: string; progress?: number };
      const job = pending.get(m.id);
      if (!job) return;
      if (m.progress !== undefined) {
        job.onProgress?.(m.progress);
        return;
      }
      pending.delete(m.id);
      if (m.ok && m.buf) job.resolve(m.buf);
      else job.reject(new Error(m.error ?? 'render failed'));
    };
  }
  return worker;
}

export function videoSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
}

/** Renders every segment of a clip. Returns one MP4 per segment. */
export async function renderVideo(photo: Photo, edit: EditState, opts: VideoOpts, onProgress?: (p: number) => void): Promise<Uint8Array[]> {
  if (!videoSupported()) throw new Error('this build of Windows cannot encode video (WebCodecs missing)');
  const bytes = await fsx.readBytes(photo.file);
  const segs = segmentsOf(edit, photo.dur ?? 0);
  const lut = await getLut(edit.preset);
  const out: Uint8Array[] = [];
  // Soundtrack fades and looping span the whole export, so each segment needs to know
  // how much finished video comes before it and how long the finished video runs.
  const total = segs.reduce((a, sg) => a + (sg.end - sg.start), 0);
  let elapsed = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const audio = await mixSegment(`v:${photo.id}`, photo.audio ? bytes : null, edit, seg, elapsed, total);
    elapsed += seg.end - seg.start;
    const id = ++seq;
    const [ow, oh] = outputDims(edit, photo.w, photo.h);
    const scale = opts.maxEdge ? Math.min(1, opts.maxEdge / Math.max(ow, oh)) : 1;
    const [lw, lh] = layerSize(ow * scale, oh * scale, 4096);
    const text = await buildTextLayer(edit.text, lw, lh).catch(() => null);
    const copy = bytes.slice().buffer; // the worker takes ownership of its copy
    const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress: (p) => onProgress?.((i + p) / segs.length) });
      const transfer: Transferable[] = [copy];
      if (audio) for (const c of audio.channels) transfer.push(c.buffer);
      if (text) transfer.push(text);
      getWorker().postMessage({ id, bytes: copy, edit, lut, start: seg.start, end: seg.end, maxEdge: opts.maxEdge, quality: opts.quality, audio, text }, transfer);
    });
    out.push(new Uint8Array(buf));
  }
  dropDecoded(`v:${photo.id}`);
  return out;
}
