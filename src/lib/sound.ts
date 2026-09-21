// The sound library: audio files you can lay over a clip, and the mixing that
// bakes them into a render. Files live in <root>/audio, the index in sounds.json.
import { open } from '@tauri-apps/plugin-dialog';
import { fsx, paths } from './fs';
import { clearBusy, setBusy, store, toast } from './store';
import { VIDEO_EXTS } from './video';
import { AUDIO_EXTS, isAudioName, isVideo, type EditState, type Photo, type Track } from './types';

/** Everything is mixed and encoded at this rate, whatever the sources use. */
const RATE = 48000;
const PEAKS = 320;

let ctx: AudioContext | null = null;
function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext({ sampleRate: RATE });
  return ctx;
}

// Decoded audio is reused across the segments of one render.
const decoded = new Map<string, AudioBuffer>();
const MAX_CACHE = 6;

async function decode(key: string, bytes: Uint8Array): Promise<AudioBuffer> {
  const hit = decoded.get(key);
  if (hit) return hit;
  const buf = await audioCtx().decodeAudioData(bytes.slice().buffer);
  if (decoded.size >= MAX_CACHE) decoded.delete(decoded.keys().next().value!);
  decoded.set(key, buf);
  return buf;
}

export function dropDecoded(key?: string) {
  if (key) decoded.delete(key);
  else decoded.clear();
}

export const trackById = (id: string | null): Track | null => (id ? (store.get().tracks.find((t) => t.id === id) ?? null) : null);

/** Max absolute level per bucket, for the waveform strip. */
function peaksOf(buf: AudioBuffer): number[] {
  const ch = buf.getChannelData(0);
  const per = Math.max(1, Math.floor(ch.length / PEAKS));
  const out: number[] = [];
  for (let i = 0; i < PEAKS; i++) {
    let max = 0;
    const from = i * per;
    const to = Math.min(ch.length, from + per);
    for (let j = from; j < to; j++) {
      const v = Math.abs(ch[j]);
      if (v > max) max = v;
    }
    out.push(Math.round(max * 100) / 100);
  }
  return out;
}

let idSeq = 0;
const newId = () => `s${Date.now().toString(16)}${(idSeq++ % 0xfff).toString(16).padStart(3, '0')}`;

export interface TrackMeta {
  name: string;
  artist?: string;
  tags?: string[];
  from?: string;
  license?: string;
  url?: string;
}

const extOf = (name: string) => (name.split('.').pop() ?? 'mp3').toLowerCase();
const stripExt = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, '');

/** Writes bytes into the sound library and indexes them. Null if they will not decode. */
export async function addTrack(bytes: Uint8Array, ext: string, meta: TrackMeta): Promise<Track | null> {
  const id = newId();
  let buf: AudioBuffer;
  try {
    buf = await decode(`t:${id}`, bytes);
  } catch {
    return null;
  }
  const file = paths.audioFile(id, ext.toLowerCase());
  await fsx.writeBytes(file, bytes);
  const track: Track = {
    id,
    file,
    name: meta.name.slice(0, 120) || 'Untitled',
    artist: meta.artist,
    size: bytes.byteLength,
    dur: buf.duration,
    added: Date.now(),
    tags: meta.tags?.length ? meta.tags.slice(0, 8) : undefined,
    from: meta.from ?? 'local',
    license: meta.license,
    url: meta.url,
    peaks: peaksOf(buf),
  };
  store.set((s) => ({ tracks: [track, ...s.tracks] }));
  return track;
}

/** File picker to the sound library. */
export async function pickAndImportAudio() {
  const sel = await open({ multiple: true, directory: false, filters: [{ name: 'Audio', extensions: AUDIO_EXTS }] });
  if (!sel) return;
  await importAudioPaths(Array.isArray(sel) ? sel : [sel]);
}

export async function importAudioPaths(list: string[]) {
  const files = list.filter((p) => isAudioName(p));
  if (!files.length) return;
  setBusy('Adding sounds', 0, files.length);
  let ok = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const path = files[i];
      const name = path.split(/[\\/]/).pop() ?? 'Sound';
      try {
        const bytes = await fsx.readBytes(path);
        if (await addTrack(bytes, extOf(name), { name: stripExt(name) })) ok++;
      } catch (e) {
        console.warn('audio import failed', name, e);
      }
      setBusy('Adding sounds', i + 1, files.length);
    }
  } finally {
    clearBusy();
  }
  toast(ok ? `Added ${ok} sound${ok === 1 ? '' : 's'}` : 'Could not read those audio files');
}

/** Decoded audio as a 16-bit PCM WAV, so an extracted track is a plain file anything can read. */
function encodeWav(buf: AudioBuffer): Uint8Array {
  const chans = Math.min(2, buf.numberOfChannels);
  const frames = buf.length;
  const bytes = new Uint8Array(44 + frames * chans * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + frames * chans * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, chans, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * chans * 2, true);
  view.setUint16(32, chans * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, frames * chans * 2, true);
  const src: Float32Array[] = [];
  for (let c = 0; c < chans; c++) src.push(buf.getChannelData(c));
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < chans; c++) {
      const v = Math.max(-1, Math.min(1, src[c][i]));
      view.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      at += 2;
    }
  }
  return bytes;
}

/** Audio lifted off a video, held in memory so you can hear it before it joins the library. */
export interface PendingSound {
  name: string;
  /** 16-bit PCM WAV. */
  bytes: Uint8Array;
  dur: number;
  peaks: number[];
  /** Object URL for the preview player; revoked when the sound is kept or dropped. */
  url: string;
}

async function pendingFrom(name: string, videoBytes: Uint8Array): Promise<PendingSound> {
  // decodeAudioData reads the audio track straight out of an MP4/MOV/WebM container.
  const buf = await audioCtx().decodeAudioData(videoBytes.slice().buffer);
  const bytes = encodeWav(buf);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' }));
  return { name: `${stripExt(name)} (audio)`, bytes, dur: buf.duration, peaks: peaksOf(buf), url };
}

/** File picker to a sound you can listen to before keeping. Null if it has no usable audio. */
export async function pickVideoForAudio(): Promise<PendingSound | null> {
  const sel = await open({ multiple: false, directory: false, filters: [{ name: 'Video', extensions: VIDEO_EXTS }] });
  if (!sel || Array.isArray(sel)) return null;
  const name = sel.split(/[\/]/).pop() ?? 'Clip';
  setBusy('Reading the audio', 0, 0);
  try {
    return await pendingFrom(name, await fsx.readBytes(sel));
  } catch (e) {
    console.warn('extract failed', e);
    toast('No audio track in that video, or the format is one Windows cannot decode');
    return null;
  } finally {
    clearBusy();
  }
}

/** Same thing for a clip already in the library. */
export async function audioFromPhoto(photo: Photo): Promise<PendingSound | null> {
  if (!isVideo(photo) || !photo.audio) {
    toast('That clip has no audio track');
    return null;
  }
  setBusy('Reading the audio', 0, 0);
  try {
    return await pendingFrom(photo.name, await fsx.readBytes(photo.file));
  } catch (e) {
    console.warn('extract failed', e);
    toast('Could not read the audio on that clip');
    return null;
  } finally {
    clearBusy();
  }
}

export function discardPending(p: PendingSound | null) {
  if (p) URL.revokeObjectURL(p.url);
}

/** Keeps a previewed sound: writes the WAV into the library and indexes it. */
export async function keepPending(p: PendingSound, name?: string): Promise<Track | null> {
  const track = await addTrack(p.bytes, 'wav', { name: name?.trim() || p.name, from: 'clip' });
  URL.revokeObjectURL(p.url);
  if (!track) toast('Could not save that sound');
  return track;
}

export async function removeTrack(id: string) {
  const t = trackById(id);
  if (!t) return;
  store.set((s) => ({ tracks: s.tracks.filter((x) => x.id !== id) }));
  dropDecoded(`t:${id}`);
  await fsx.remove([t.file]).catch(() => undefined);
  toast(`Removed ${t.name}`);
}

export function toggleTrackFav(id: string) {
  store.set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, fav: !t.fav } : t)) }));
}

export function renameTrack(id: string, name: string) {
  const n = name.trim();
  if (!n) return;
  store.set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, name: n.slice(0, 120) } : t)) }));
}

export interface MixedAudio {
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * The soundtrack's level at a given point in the finished video: fades belong to the
 * export as a whole, so a split in the middle does not retrigger either one.
 */
function envAt(t: number, e: EditState, total: number): number {
  let v = e.soundVolume;
  if (e.soundFadeIn > 0.001) v *= Math.min(1, t / e.soundFadeIn);
  if (e.soundFadeOut > 0.001) v *= Math.min(1, Math.max(0, (total - t) / e.soundFadeOut));
  return Math.max(0, v);
}

/**
 * Mixes one segment: the clip's own audio (trimmed) plus the soundtrack, returned as
 * planar PCM for the encoder. Null when the segment has nothing to hear.
 *
 * `elapsed` is how much finished output comes before this segment, so the soundtrack
 * plays straight through a split instead of restarting at every cut.
 */
export async function mixSegment(
  clipKey: string,
  clipBytes: Uint8Array | null,
  edit: EditState,
  seg: { start: number; end: number },
  elapsed: number,
  total: number,
): Promise<MixedAudio | null> {
  const segLen = Math.max(0, seg.end - seg.start);
  if (segLen < 0.01) return null;
  const track = trackById(edit.sound);
  const clipGain = edit.mute ? 0 : edit.volume * (track ? edit.soundDuck : 1);
  const wantClip = !!clipBytes && clipGain > 0.001;
  if (!wantClip && !track) return null;

  let clipBuf: AudioBuffer | null = null;
  if (wantClip) {
    try {
      clipBuf = await decode(clipKey, clipBytes!);
    } catch {
      clipBuf = null;
    }
  }
  let trackBuf: AudioBuffer | null = null;
  if (track) {
    try {
      trackBuf = await decode(`t:${track.id}`, await fsx.readBytes(track.file));
    } catch {
      trackBuf = null;
    }
  }
  if (!clipBuf && !trackBuf) return null;

  const frames = Math.max(1, Math.round(segLen * RATE));
  const off = new OfflineAudioContext(2, frames, RATE);

  if (clipBuf) {
    const src = off.createBufferSource();
    src.buffer = clipBuf;
    const g = off.createGain();
    g.gain.value = clipGain;
    src.connect(g).connect(off.destination);
    src.start(0, Math.min(seg.start, Math.max(0, clipBuf.duration - 0.001)), segLen);
  }

  if (trackBuf && edit.soundVolume > 0.001) {
    const src = off.createBufferSource();
    src.buffer = trackBuf;
    // Loop so a short sound covers a long clip.
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = trackBuf.duration;
    const g = off.createGain();
    // The envelope is piecewise linear, so ramping between its corners is exact.
    const corners = [edit.soundFadeIn, total - edit.soundFadeOut]
      .filter((t) => t > elapsed + 1e-4 && t < elapsed + segLen - 1e-4)
      .sort((a, b) => a - b);
    g.gain.setValueAtTime(envAt(elapsed, edit, total), 0);
    for (const t of corners) g.gain.linearRampToValueAtTime(envAt(t, edit, total), t - elapsed);
    g.gain.linearRampToValueAtTime(envAt(elapsed + segLen, edit, total), segLen);
    src.connect(g).connect(off.destination);
    const startAt = (edit.soundStart + elapsed) % Math.max(0.001, trackBuf.duration);
    src.start(0, startAt, segLen);
  }

  const out = await off.startRendering();
  const channels: Float32Array[] = [];
  for (let c = 0; c < out.numberOfChannels; c++) channels.push(new Float32Array(out.getChannelData(c)));
  return { channels, sampleRate: RATE };
}

/** Peaks for a track, computed on demand for anything indexed before peaks existed. */
export async function ensurePeaks(id: string): Promise<number[] | null> {
  const t = trackById(id);
  if (!t) return null;
  if (t.peaks?.length) return t.peaks;
  try {
    const buf = await decode(`t:${id}`, await fsx.readBytes(t.file));
    const peaks = peaksOf(buf);
    store.set((s) => ({ tracks: s.tracks.map((x) => (x.id === id ? { ...x, peaks, dur: buf.duration } : x)) }));
    return peaks;
  } catch {
    return null;
  }
}
