// Drives the video render worker: one clip at a time, one job per segment.
import { fsx } from './fs';
import { getLut } from './luts';
import { segmentsOf } from './video';
import { dropDecoded, mixSegment, mixSequence, type SeqPart } from './sound';
import { buildTextLayer, layerSize } from './textlayer';
import { aspectPx, cropToAspect, orientedDims, outputDims } from './geometry';
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

/** One clip in a combined render, in the order it should play. */
export interface SeqItem {
  photo: Photo;
  edit: EditState;
}

/** Trimmed range of a clip. Splits are ignored here: combining is the opposite of splitting. */
const rangeOf = (it: SeqItem) => {
  const dur = it.photo.dur ?? 0;
  const start = Math.max(0, Math.min(it.edit.trimIn, dur));
  const end = it.edit.trimOut > 0.001 ? Math.min(it.edit.trimOut, dur) : dur;
  return end - start < 0.05 ? { start: 0, end: dur } : { start, end };
};

/** Seconds into the combined clip where each part after the first begins. */
export function sequenceJoins(items: SeqItem[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (let i = 0; i < items.length - 1; i++) {
    const r = rangeOf(items[i]);
    at += r.end - r.start;
    out.push(Math.round(at * 1000) / 1000);
  }
  return out;
}

export const sequenceDuration = (items: SeqItem[]) => items.reduce((a, it) => { const r = rangeOf(it); return a + (r.end - r.start); }, 0);

/**
 * Joins several clips into one MP4. Every clip is centre-cropped to `aspect` so they
 * share one output size; 'first' keeps whatever shape the opening clip already has.
 */
export async function renderSequence(items: SeqItem[], aspect: string, opts: VideoOpts, onProgress?: (p: number) => void): Promise<Uint8Array> {
  if (!videoSupported()) throw new Error('this build of Windows cannot encode video (WebCodecs missing)');
  if (items.length < 2) throw new Error('pick at least two clips to combine');

  const lead = items[0];
  const [lw0, lh0] = orientedDims(lead.edit.rotate, lead.photo.w, lead.photo.h);
  const leadOut = outputDims(lead.edit, lead.photo.w, lead.photo.h);
  const ratio = aspect === 'first' ? leadOut[0] / leadOut[1] : (aspectPx(aspect, lw0, lh0) ?? leadOut[0] / leadOut[1]);

  // Output size comes from the opening clip, cropped to the chosen shape.
  const leadCrop = cropToAspect(lead.edit.crop, ratio, lw0, lh0);
  const [bw, bh] = outputDims(lead.edit, lead.photo.w, lead.photo.h, leadCrop);
  const k = opts.maxEdge ? Math.min(1, opts.maxEdge / Math.max(bw, bh)) : 1;
  const W = Math.max(2, Math.round((bw * k) / 2) * 2);
  const H = Math.max(2, Math.round((bh * k) / 2) * 2);

  const parts: { bytes: ArrayBuffer; edit: EditState; lut: Awaited<ReturnType<typeof getLut>>; start: number; end: number; text: ImageBitmap | null }[] = [];
  const audioParts: SeqPart[] = [];
  const transfer: Transferable[] = [];
  const [tw, th] = layerSize(W, H, 4096);

  for (const it of items) {
    const raw = await fsx.readBytes(it.photo.file);
    const [ow, oh] = orientedDims(it.edit.rotate, it.photo.w, it.photo.h);
    const crop = cropToAspect(it.edit.crop, ratio, ow, oh);
    const edit: EditState = { ...it.edit, crop, splits: [] };
    const range = rangeOf(it);
    const text = await buildTextLayer(edit.text, tw, th).catch(() => null);
    const copy = raw.slice().buffer;
    parts.push({ bytes: copy, edit, lut: await getLut(edit.preset), start: range.start, end: range.end, text });
    audioParts.push({ key: `v:${it.photo.id}`, bytes: it.photo.audio ? raw : null, edit, start: range.start, end: range.end });
    transfer.push(copy);
    if (text) transfer.push(text);
  }

  const audio = await mixSequence(audioParts);
  if (audio) for (const c of audio.channels) transfer.push(c.buffer);
  for (const it of items) dropDecoded(`v:${it.photo.id}`);

  const id = ++seq;
  const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, kind: 'seq', parts, W, H, fps: 30, quality: opts.quality, audio }, transfer);
  });
  return new Uint8Array(buf);
}
