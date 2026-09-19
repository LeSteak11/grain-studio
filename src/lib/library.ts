import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
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

    const webview = getCurrentWebview();
    await webview.onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === 'enter' || p.type === 'over') {
        if (!store.get().dragOver) store.set({ dragOver: true });
      } else if (p.type === 'leave') store.set({ dragOver: false });
      else if (p.type === 'drop') {
        store.set({ dragOver: false });
        if (p.paths.length) void importPaths(p.paths);
      }
    });
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

export async function importPaths(input: string[]) {
  if (importing) {
    toast('Import already running');
    return;
  }
  importing = true;
  try {
    setBusy('Copying', 0, 0);
    const skip = store.get().photos.map((p) => `${p.name}|${p.size}`);
    const items = await fsx.importFiles(input, paths.originals(), skip);
    if (!items.length) {
      toast('No new photos found');
      return;
    }
    let done = 0;
    let failed = 0;
    let buffer: Photo[] = [];
    const flush = () => {
      if (!buffer.length) return;
      const add = buffer;
      buffer = [];
      store.set((s) => ({ photos: [...add, ...s.photos] }));
    };
    const flushTimer = window.setInterval(flush, 250);
    setBusy('Importing', 0, items.length);
    const queue = [...items];
    const now = Date.now();
    await Promise.all(
      Array.from({ length: THUMB_CONCURRENCY }, async () => {
        for (let it = queue.shift(); it; it = queue.shift()) {
          try {
            const bytes = await fsx.readBytes(it.path);
            const t = await makeThumb(bytes);
            await fsx.writeBytes(paths.thumb(it.id), new Uint8Array(t.buf));
            buffer.push({ id: it.id, file: it.path, name: it.name, size: it.size, w: t.w, h: t.h, added: now - items.indexOf(it) });
          } catch (e) {
            console.warn('import failed', it.name, e);
            failed++;
            await fsx.remove([it.path]).catch(() => undefined);
          }
          done++;
          setBusy('Importing', done, items.length);
        }
      }),
    );
    clearInterval(flushTimer);
    flush();
    store.set((s) => ({ photos: [...s.photos].sort((a, b) => b.added - a.added) }));
    const ok = items.length - failed;
    toast(failed ? `Imported ${ok} · ${failed} couldn't be read (HEIC/RAW aren't supported yet)` : `Imported ${ok} photo${ok === 1 ? '' : 's'}`);
  } catch (e) {
    toast(`Import failed: ${e}`);
  } finally {
    importing = false;
    clearBusy();
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
