// Drives the video render worker: one clip at a time, one job per segment.
import { fsx } from './fs';
import { getLut } from './luts';
import { audioSlice, segmentsOf } from './video';
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
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const audio = photo.audio && !edit.mute ? await audioSlice(bytes, seg.start, seg.end, edit.volume) : null;
    const id = ++seq;
    const copy = bytes.slice().buffer; // the worker takes ownership of its copy
    const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress: (p) => onProgress?.((i + p) / segs.length) });
      const transfer: Transferable[] = [copy];
      if (audio) for (const c of audio.channels) transfer.push(c.buffer);
      getWorker().postMessage({ id, bytes: copy, edit, lut, start: seg.start, end: seg.end, maxEdge: opts.maxEdge, quality: opts.quality, audio }, transfer);
    });
    out.push(new Uint8Array(buf));
  }
  return out;
}
