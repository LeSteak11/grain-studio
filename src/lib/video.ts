// Video support: thumbnails, playback sources, trim/split maths, audio extraction.
import { THUMB_EDGE } from './thumbs';
import type { EditState, Photo } from './types';

export const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm'];

export const isVideoName = (name: string) => VIDEO_EXTS.includes((name.split('.').pop() ?? '').toLowerCase());

const AUDIO_BOXES = ['mp4a', 'Opus', 'ac-3', 'ec-3', 'alac', 'fLaC'];

/** Cheap check for an audio track: look for its sample-entry box name. */
function hasAudioTrack(b: Uint8Array): boolean {
  const limit = Math.min(b.length, 40_000_000);
  for (const name of AUDIO_BOXES) {
    const c0 = name.charCodeAt(0);
    const c1 = name.charCodeAt(1);
    const c2 = name.charCodeAt(2);
    const c3 = name.charCodeAt(3);
    for (let i = 0; i < limit - 3; i++) {
      if (b[i] === c0 && b[i + 1] === c1 && b[i + 2] === c2 && b[i + 3] === c3) return true;
    }
  }
  return false;
}

export interface VideoMeta {
  w: number;
  h: number;
  dur: number;
  audio: boolean;
  /** JPEG thumbnail bytes. */
  buf: ArrayBuffer;
}

function videoFromBlob(blob: Blob): { el: HTMLVideoElement; url: string; free: () => void } {
  const url = URL.createObjectURL(blob);
  const el = document.createElement('video');
  el.src = url;
  el.muted = true;
  el.preload = 'auto';
  el.playsInline = true;
  return { el, url, free: () => URL.revokeObjectURL(url) };
}

async function seekTo(el: HTMLVideoElement, t: number) {
  await new Promise<void>((res, rej) => {
    const ok = () => {
      el.removeEventListener('seeked', ok);
      el.removeEventListener('error', bad);
      res();
    };
    const bad = () => {
      el.removeEventListener('seeked', ok);
      el.removeEventListener('error', bad);
      rej(new Error('seek failed'));
    };
    el.addEventListener('seeked', ok);
    el.addEventListener('error', bad);
    el.currentTime = t;
  });
}

/** Grabs a frame for the library thumbnail and reads the basic metadata. */
export async function makeVideoThumb(bytes: Uint8Array, time?: number): Promise<VideoMeta> {
  const { el, free } = videoFromBlob(new Blob([bytes as BlobPart], { type: 'video/mp4' }));
  try {
    await new Promise<void>((res, rej) => {
      el.addEventListener('loadedmetadata', () => res(), { once: true });
      el.addEventListener('error', () => rej(new Error('this video format can not be played')), { once: true });
    });
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    await seekTo(el, time ?? Math.min(Math.max(dur * 0.1, 0.05), Math.max(dur - 0.05, 0)));
    const w = el.videoWidth;
    const h = el.videoHeight;
    const k = Math.min(1, THUMB_EDGE / Math.max(w, h));
    const c = new OffscreenCanvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
    c.getContext('2d')!.drawImage(el, 0, 0, c.width, c.height);
    const buf = await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 })).arrayBuffer();
    return { w, h, dur, audio: hasAudioTrack(bytes), buf };
  } finally {
    el.removeAttribute('src');
    el.load();
    free();
  }
}

/** Clip segments after trim and splits, in seconds. */
export function segmentsOf(edit: EditState, dur: number): { start: number; end: number }[] {
  const start = Math.max(0, Math.min(edit.trimIn, dur));
  const end = edit.trimOut > 0.001 ? Math.min(edit.trimOut, dur) : dur;
  if (end - start < 0.05) return [{ start: 0, end: dur }];
  const cuts = edit.splits.filter((t) => t > start + 0.05 && t < end - 0.05).sort((a, b) => a - b);
  const out: { start: number; end: number }[] = [];
  let from = start;
  for (const c of cuts) {
    out.push({ start: from, end: c });
    from = c;
  }
  out.push({ start: from, end });
  return out;
}

export const durationOf = (p: Photo, e: EditState) => {
  const segs = segmentsOf(e, p.dur ?? 0);
  return segs.reduce((a, s) => a + (s.end - s.start), 0);
};

/** Decodes the audio track and returns the trimmed range as planar PCM (null when there's no audio). */
export async function audioSlice(bytes: Uint8Array, start: number, end: number, volume: number): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    const copy = bytes.slice().buffer;
    const buf = await ctx.decodeAudioData(copy);
    const rate = buf.sampleRate;
    const from = Math.max(0, Math.floor(start * rate));
    const to = Math.min(buf.length, Math.ceil(end * rate));
    if (to <= from) return null;
    const channels: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const slice = buf.getChannelData(c).slice(from, to);
      if (volume !== 1) for (let i = 0; i < slice.length; i++) slice[i] *= volume;
      channels.push(slice);
    }
    return { channels, sampleRate: rate };
  } catch {
    return null;
  } finally {
    void ctx?.close();
  }
}
