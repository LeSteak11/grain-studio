// Drag-and-drop and Ctrl+V for images from anywhere: Explorer files/folders, images dragged
// out of Chrome/Brave, and "Copy image" clipboard data. Nothing has to be saved first.
import { invoke } from '@tauri-apps/api/core';
import { bytesJob, pasteEdits, runImport, type ImportJob } from './library';
import { store, toast, visiblePhotos } from './store';
import { addTrack } from './sound';
import { isAudioName } from './types';
import { draggingOut } from './share';

const IMG_URL = /\.(jpe?g|jfif|png|webp|avif|gif|bmp)(\?|#|$)/i;
const MEDIA_FILE = /\.(jpe?g|jfif|png|webp|avif|gif|bmp|heic|heif|mp4|m4v|mov|webm)$/i;

function urlName(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return last.replace(/[<>:"/\\|?*]/g, '').slice(0, 80) || 'Web image';
  } catch {
    return 'Web image';
  }
}

function stamp(prefix: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function dataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(',');
  const meta = url.slice(5, comma);
  const body = url.slice(comma + 1);
  if (meta.includes(';base64')) {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

/** Downloads through the native side so there are no CORS limits. */
async function download(url: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('download_url', { url }));
}

function urlJob(url: string): ImportJob | null {
  if (url.startsWith('data:image/')) return bytesJob(stamp('Web image'), async () => dataUrlBytes(url));
  if (/^https?:\/\//i.test(url)) return bytesJob(urlName(url), () => download(url));
  return null;
}

/** Best image URL in a drag/clipboard payload. <img src> beats the link, since dragging a linked image gives the page link in uri-list. */
function findImageUrl(html: string, uriList: string, plain: string): string | null {
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const img = doc.querySelector('img');
    const src = img?.getAttribute('src') || img?.getAttribute('data-src');
    if (src) {
      const srcset = img?.getAttribute('srcset');
      // Prefer the largest srcset candidate when present.
      if (srcset) {
        const best = srcset
          .split(',')
          .map((s) => s.trim().split(/\s+/))
          .map(([u, w]) => ({ u, w: parseFloat(w) || 0 }))
          .sort((a, b) => b.w - a.w)[0];
        if (best?.u && /^(https?:|data:)/.test(best.u)) return best.u;
      }
      if (/^(https?:|data:)/.test(src)) return src;
    }
  }
  const uri = uriList
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('#'));
  if (uri) return uri;
  const t = plain.trim();
  if (/^https?:\/\/\S+$/i.test(t) && IMG_URL.test(t)) return t;
  if (t.startsWith('data:image/')) return t;
  return null;
}

async function walkEntry(entry: FileSystemEntry, out: File[], depth = 0): Promise<void> {
  if (entry.isFile) {
    out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
  } else if (entry.isDirectory && depth < 8) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walkEntry(e, out, depth + 1);
    }
  }
}

const isImageFile = (f: File) => f.type.startsWith('image/') || f.type.startsWith('video/') || MEDIA_FILE.test(f.name);
const isAudioFile = (f: File) => (f.type.startsWith('audio/') || isAudioName(f.name)) && !isImageFile(f);

/** Audio dropped on the window joins the sound library instead of the photo grid. */
async function takeAudio(list: File[]): Promise<number> {
  let ok = 0;
  for (const f of list) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const ext = (f.name.split('.').pop() ?? 'mp3').toLowerCase();
      if (await addTrack(bytes, ext, { name: f.name.replace(/\.[a-z0-9]{2,5}$/i, '') })) ok++;
    } catch (e) {
      console.warn('audio drop failed', f.name, e);
    }
  }
  return ok;
}

/** Pulls everything out of a DataTransfer synchronously (it's wiped after the event), then imports. */
function takeTransfer(dt: DataTransfer): (() => Promise<void>) | null {
  const entries = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.() ?? null);
  const files = [...dt.files];
  const html = dt.getData('text/html');
  const uri = dt.getData('text/uri-list');
  const plain = dt.getData('text/plain');
  const hasDir = entries.some((e) => e?.isDirectory);

  if (files.length || hasDir) {
    return async () => {
      let list = files;
      if (hasDir) {
        list = [];
        for (const e of entries) if (e) await walkEntry(e, list);
      }
      const sounds = list.filter(isAudioFile);
      if (sounds.length) {
        const added = await takeAudio(sounds);
        if (added) toast(`Added ${added} sound${added === 1 ? '' : 's'}`);
      }
      const skip = new Set(store.get().photos.map((p) => `${p.name}|${p.size}`));
      const imgs = list.filter(isImageFile).filter((f) => !skip.has(`${f.name}|${f.size}`));
      if (!imgs.length) {
        if (!sounds.length) toast(list.length ? 'No new images in that drop' : 'Nothing to import');
        return;
      }
      await runImport(
        // Files from Explorer keep their own date; clipboard images get "now".
        imgs.map((f) => {
          const pasted = !f.name || f.name === 'image.png';
          return bytesJob(pasted ? stamp('Pasted image') : f.name, async () => new Uint8Array(await f.arrayBuffer()), pasted ? Date.now() : f.lastModified || Date.now());
        }),
        true,
      );
    };
  }
  const url = findImageUrl(html, uri, plain);
  const job = url ? urlJob(url) : null;
  if (job) return () => runImport([job], true);
  return null;
}

function editableTarget(t: EventTarget | null) {
  return (t instanceof HTMLInputElement && t.type !== 'range') || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
}

function hasPayload(dt: DataTransfer | null) {
  if (!dt) return false;
  const types = [...dt.types];
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html');
}

export function installDropAndPaste() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasPayload(e.dataTransfer) || draggingOut) return;
    e.preventDefault();
    depth++;
    if (!store.get().dragOver) store.set({ dragOver: true });
  });
  window.addEventListener('dragover', (e) => {
    if (!hasPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) store.set({ dragOver: false });
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    store.set({ dragOver: false });
    if (!e.dataTransfer || store.get().modal || draggingOut) return;
    const run = takeTransfer(e.dataTransfer);
    if (run) void run().catch((err) => toast(`Import failed: ${err}`));
    else toast("Couldn't find an image, video or sound in that drop");
  });

  // Ctrl+V: an image on the clipboard gets imported; otherwise it pastes copied edits.
  window.addEventListener('paste', (e) => {
    if (editableTarget(e.target) || store.get().modal || !e.clipboardData) return;
    e.preventDefault();
    const dt = e.clipboardData;
    const hasImage = [...dt.files].some(isImageFile) || /<img\s/i.test(dt.getData('text/html')) || findImageUrl('', '', dt.getData('text/plain')) !== null;
    if (hasImage) {
      const run = takeTransfer(dt);
      if (run) {
        void run().catch((err) => toast(`Paste failed: ${err}`));
        return;
      }
    }
    const s = store.get();
    if (!s.clipboard) {
      toast('Nothing to paste. Copy an image (right-click → Copy image) or copy some edits first');
      return;
    }
    const ids = s.view === 'editor' && s.currentId ? [s.currentId] : visiblePhotos(s).filter((p) => s.selection.has(p.id)).map((p) => p.id);
    if (ids.length) pasteEdits(ids);
  });
}
