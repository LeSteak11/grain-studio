import { getCurrentWindow } from '@tauri-apps/api/window';
import { installDropAndPaste } from './dropin';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { fsx, paths, setRoot } from './fs';
import { clearBusy, setBusy, store, toast, visiblePhotos } from './store';
import { commitMany, forget, getEdit } from './history';
import { flushAll, startPersistence } from './persist';
import { makeThumb, THUMB_CONCURRENCY } from './thumbgen';
import { dropThumbBitmap } from './thumbs';
import { dropFull } from './sources';
import { defaultEdit, isEdited, normalizeEdit, withGeometryOf, type EditState, type Photo, type Recipe } from './types';

export const IMAGE_EXTS = ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'bmp', 'gif', 'avif'];

export async function initApp() {
  try {
    const root = await fsx.root();
    setRoot(root);
    const [libTxt, editsRaw, recTxt, luts] = await Promise.all([
      fsx.readText(paths.library()),
      fsx.readAllText(paths.editsDir(), 'json'),
      fsx.readText(paths.recipes()),
      fsx.listDir(paths.lutsDir(), 'cube'),
    ]);
    let photos: Photo[] = [];
    try {
      photos = libTxt ? (JSON.parse(libTxt).photos ?? []) : [];
    } catch {
      console.error('library.json unreadable');
    }
    const edits: Record<string, EditState> = {};
    for (const [id, txt] of Object.entries(editsRaw)) {
      try {
        edits[id] = normalizeEdit(JSON.parse(txt));
      } catch {
        /* skip corrupt edit */
      }
    }
    let recipes: Recipe[] = [];
    try {
      recipes = recTxt ? JSON.parse(recTxt) : [];
      recipes = recipes.map((r) => ({ ...r, edit: normalizeEdit(r.edit) }));
    } catch {
      recipes = [];
    }
    startPersistence();
    store.set({ ready: true, root, photos, edits, recipes, luts });

    installDropAndPaste();
    await getCurrentWindow().onCloseRequested(async () => {
      await flushAll();
    });
  } catch (e) {
    store.set({ error: String(e) });
  }
}

export async function pickAndImport() {
  const sel = await open({ multiple: true, directory: false, filters: [{ name: 'Images', extensions: IMAGE_EXTS }] });
  if (!sel) return;
  const list = Array.isArray(sel) ? sel : [sel];
  if (list.length) await importPaths(list);
}

let importing = false;
let idSeq = 0;

const ascii = (b: Uint8Array, s: number, e: number) => String.fromCharCode(...b.subarray(s, e));

/** Detects the real image type from its first bytes (browser drops/pastes often lack a usable name). */
export function sniffExt(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'png';
  if (ascii(b, 0, 3) === 'GIF') return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (ascii(b, 4, 8) === 'ftyp' && ascii(b, 8, 11) === 'avi') return 'avif';
  return null;
}

/** One thing to import: returns the library copy's id/path plus its bytes (for the thumbnail). */
export interface ImportJob {
  name: string;
  load: () => Promise<{ id: string; path: string; name: string; bytes: Uint8Array }>;
}

/** Job for raw bytes (browser drag, clipboard, download): written into the library first. */
export function bytesJob(name: string, getBytes: () => Promise<Uint8Array>): ImportJob {
  return {
    name,
    load: async () => {
      const bytes = await getBytes();
      const ext = sniffExt(bytes);
      if (!ext) throw new Error('not a supported image (JPEG, PNG, WebP, AVIF, GIF, BMP)');
      const id = `${Date.now().toString(16)}${(idSeq++ % 0xfffff).toString(16).padStart(5, '0')}`;
      const path = `${paths.originals()}\\${id}.${ext}`;
      await fsx.writeBytes(path, bytes);
      const base = name.replace(/\.[a-z0-9]{2,5}$/i, '') || 'Image';
      return { id, path, name: `${base}.${ext}`, bytes };
    },
  };
}

export async function importPaths(input: string[]) {
  if (importing) {
    toast('Import already running');
    return;
  }
  setBusy('Copying', 0, 0);
  try {
    const skip = store.get().photos.map((p) => `${p.name}|${p.size}`);
    const items = await fsx.importFiles(input, paths.originals(), skip);
    if (!items.length) {
      clearBusy();
      toast('No new photos found');
      return;
    }
    await runImport(
      items.map((it) => ({ name: it.name, load: async () => ({ id: it.id, path: it.path, name: it.name, bytes: await fsx.readBytes(it.path) }) })),
      false,
    );
  } catch (e) {
    clearBusy();
    toast(`Import failed: ${e}`);
  }
}

/** Shared pipeline: load/copy → worker thumbnail → add to library. Opens the editor if `openSingle` and one photo came in. */
export async function runImport(jobs: ImportJob[], openSingle: boolean) {
  if (importing) {
    toast('Import already running');
    return;
  }
  if (!jobs.length) return;
  importing = true;
  const added: string[] = [];
  const errors: string[] = [];
  try {
    let done = 0;
    let buffer: Photo[] = [];
    const flush = () => {
      if (!buffer.length) return;
      const add = buffer;
      buffer = [];
      store.set((s) => ({ photos: [...add, ...s.photos] }));
    };
    const flushTimer = window.setInterval(flush, 250);
    setBusy('Importing', 0, jobs.length);
    const queue = jobs.map((j, i) => ({ j, i }));
    const now = Date.now();
    await Promise.all(
      Array.from({ length: THUMB_CONCURRENCY }, async () => {
        for (let q = queue.shift(); q; q = queue.shift()) {
          let written: string | null = null;
          try {
            const got = await q.j.load();
            written = got.path;
            const size = got.bytes.byteLength;
            const t = await makeThumb(got.bytes);
            await fsx.writeBytes(paths.thumb(got.id), new Uint8Array(t.buf));
            buffer.push({ id: got.id, file: got.path, name: got.name, size, w: t.w, h: t.h, added: now - q.i });
            added.push(got.id);
          } catch (e) {
            console.warn('import failed', q.j.name, e);
            errors.push(e instanceof Error ? e.message : String(e));
            if (written) await fsx.remove([written]).catch(() => undefined);
          }
          done++;
          setBusy('Importing', done, jobs.length);
        }
      }),
    );
    clearInterval(flushTimer);
    flush();
    store.set((s) => ({ photos: [...s.photos].sort((a, b) => b.added - a.added) }));
    const ok = added.length;
    if (!ok) toast(`Couldn't import: ${errors[0] ?? 'unknown error'}`);
    else toast(errors.length ? `Imported ${ok} · ${errors.length} failed (HEIC/RAW aren't supported yet)` : `Imported ${ok} photo${ok === 1 ? '' : 's'}`);
  } finally {
    importing = false;
    clearBusy();
  }
  if (openSingle && added.length === 1) {
    store.set({ filter: 'all' });
    openEditor(added[0]);
  }
}

export async function removePhotos(ids: string[]) {
  if (!ids.length) return;
  const ok = await ask(`Remove ${ids.length} photo${ids.length === 1 ? '' : 's'} from the library? Your original files elsewhere on disk are not touched — only Grain Studio's copies and edits.`, {
    title: 'Remove photos',
    kind: 'warning',
    okLabel: 'Remove',
  });
  if (!ok) return;
  const set = new Set(ids);
  const s = store.get();
  const victims = s.photos.filter((p) => set.has(p.id));
  const edits = { ...s.edits };
  for (const id of ids) {
    delete edits[id];
    forget(id);
    dropThumbBitmap(id);
    dropFull(id);
  }
  store.set({
    photos: s.photos.filter((p) => !set.has(p.id)),
    edits,
    selection: new Set(),
    currentId: s.currentId && set.has(s.currentId) ? null : s.currentId,
    view: s.currentId && set.has(s.currentId) ? 'library' : s.view,
  });
  await fsx.remove(victims.flatMap((p) => [p.file, paths.thumb(p.id), paths.editedThumb(p.id), paths.edit(p.id)]));
  toast(`Removed ${victims.length}`);
}

export function toggleFav(ids: string[]) {
  const set = new Set(ids);
  const s = store.get();
  const allFav = s.photos.filter((p) => set.has(p.id)).every((p) => p.fav);
  store.set({ photos: s.photos.map((p) => (set.has(p.id) ? { ...p, fav: !allFav } : p)) });
}

export function copyEdits(id: string) {
  store.set({ clipboard: getEdit(id) });
  toast('Edits copied');
}

export function pasteEdits(ids: string[]) {
  const clip = store.get().clipboard;
  if (!clip || !ids.length) return;
  const next: Record<string, EditState> = {};
  for (const id of ids) next[id] = withGeometryOf(clip, getEdit(id));
  commitMany(next);
  toast(`Pasted to ${ids.length} photo${ids.length === 1 ? '' : 's'}`);
}

export function resetEdits(ids: string[]) {
  const next: Record<string, EditState> = {};
  for (const id of ids) if (isEdited(store.get().edits[id])) next[id] = defaultEdit();
  if (Object.keys(next).length) commitMany(next);
}

export function openEditor(id: string) {
  store.set({ view: 'editor', currentId: id, selection: new Set([id]), anchor: id });
}

export function openExport(ids: string[]) {
  if (!ids.length) return;
  store.set({ modal: 'export', exportIds: ids });
}

export function step(delta: number) {
  const s = store.get();
  const list = visiblePhotos(s);
  const i = list.findIndex((p) => p.id === s.currentId);
  const next = list[i + delta];
  if (next) store.set({ currentId: next.id, selection: new Set([next.id]), anchor: next.id });
}
