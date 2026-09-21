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
import { VIDEO_EXTS, isVideoName, makeVideoThumb } from './video';
import {
  DEFAULT_LABELS,
  DEFAULT_PLATFORMS,
  LABEL_COLORS,
  defaultEdit,
  isEdited,
  normalizeEdit,
  presetOf,
  shortFor,
  toolsOf,
  withGeometryOf,
  type EditState,
  type Group,
  type Label,
  type PasteMode,
  type Photo,
  type Platform,
  type Recipe,
  type Track,
} from './types';

export const IMAGE_EXTS = ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'bmp', 'gif', 'avif', 'heic', 'heif', ...VIDEO_EXTS];

export async function initApp() {
  try {
    const root = await fsx.root();
    setRoot(root);
    const [libTxt, editsRaw, recTxt, luts, prefsTxt, collTxt, sndTxt] = await Promise.all([
      fsx.readText(paths.library()),
      fsx.readAllText(paths.editsDir(), 'json'),
      fsx.readText(paths.recipes()),
      fsx.listDir(paths.lutsDir(), 'cube'),
      fsx.readText(paths.prefs()),
      fsx.readText(paths.collections()),
      fsx.readText(paths.sounds()),
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
    let favPresets: string[] = [];
    let soundKeys = { jamendo: '', freesound: '' };
    try {
      const pr = prefsTxt ? JSON.parse(prefsTxt) : {};
      favPresets = pr.favPresets ?? [];
      if (pr.soundKeys) soundKeys = { jamendo: String(pr.soundKeys.jamendo ?? ''), freesound: String(pr.soundKeys.freesound ?? '') };
    } catch {
      favPresets = [];
    }
    let tracks: Track[] = [];
    try {
      tracks = sndTxt ? (JSON.parse(sndTxt).tracks ?? []) : [];
    } catch {
      console.error('sounds.json unreadable');
    }
    let labels: Label[] = DEFAULT_LABELS;
    let groups: Group[] = [];
    let platforms: Platform[] = DEFAULT_PLATFORMS;
    try {
      if (collTxt) {
        const c = JSON.parse(collTxt);
        labels = Array.isArray(c.labels) ? c.labels : DEFAULT_LABELS;
        groups = Array.isArray(c.groups) ? c.groups : [];
        if (Array.isArray(c.platforms) && c.platforms.length) platforms = c.platforms;
      }
    } catch {
      /* keep defaults */
    }

    // Tags became labels: fold any old tags in, once.
    const tagNames = new Set<string>();
    for (const p of photos) for (const t of p.tags ?? []) if (t.trim()) tagNames.add(t.trim());
    if (tagNames.size) {
      const byName = new Map(labels.map((l) => [l.name.toLowerCase(), l]));
      const added: Label[] = [];
      for (const t of tagNames) {
        if (byName.has(t.toLowerCase())) continue;
        const l: Label = {
          id: `l${Date.now().toString(36)}${added.length}`,
          name: t.slice(0, 30),
          color: LABEL_COLORS[(labels.length + added.length) % LABEL_COLORS.length],
        };
        added.push(l);
        byName.set(t.toLowerCase(), l);
      }
      labels = [...labels, ...added];
      photos = photos.map((p) => {
        if (!p.tags?.length) return p;
        const ids = new Set(p.labels ?? []);
        for (const t of p.tags) {
          const l = byName.get(t.trim().toLowerCase());
          if (l) ids.add(l.id);
        }
        const { tags: _drop, ...rest } = p;
        return { ...rest, labels: [...ids] };
      });
    }

    // Any platform a photo was marked posted to must exist in the list.
    const known = new Set(platforms.map((p) => p.id));
    for (const p of photos) {
      for (const k of Object.keys(p.posted ?? {})) {
        if (known.has(k)) continue;
        known.add(k);
        const name = k === 'other' ? 'Other' : k.charAt(0).toUpperCase() + k.slice(1);
        platforms = [...platforms, { id: k, name, short: shortFor(name) }];
      }
    }

    startPersistence();
    store.set({ ready: true, root, photos, edits, recipes, luts, favPresets, labels, groups, platforms, tracks, soundKeys });
    void fsx.clearDir(paths.dragDir()).catch(() => undefined);

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
  if (ascii(b, 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(ascii(b, 8, 12))) return 'heic';
  if (ascii(b, 4, 8) === 'ftyp') return 'mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  return null;
}

/** One thing to import: returns the library copy's id/path plus its bytes (for the thumbnail). */
export interface ImportJob {
  name: string;
  load: () => Promise<{ id: string; path: string; name: string; bytes: Uint8Array; created?: number }>;
}

/** Job for raw bytes (browser drag, clipboard, download): written into the library first. */
export function bytesJob(name: string, getBytes: () => Promise<Uint8Array>, created?: number): ImportJob {
  return {
    name,
    load: async () => {
      const bytes = await getBytes();
      const ext = sniffExt(bytes);
      if (!ext) throw new Error('not a supported image or video');
      const id = `${Date.now().toString(16)}${(idSeq++ % 0xfffff).toString(16).padStart(5, '0')}`;
      const base = name.replace(/\.[a-z0-9]{2,5}$/i, '') || 'Image';
      if (ext === 'heic') {
        const tmp = `${paths.originals()}\\${id}.heic`;
        const path = `${paths.originals()}\\${id}.jpg`;
        await fsx.writeBytes(tmp, bytes);
        await fsx.convertHeic(tmp, path);
        return { id, path, name: `${base}.jpg`, bytes: await fsx.readBytes(path), created: created ?? Date.now() };
      }
      const path = `${paths.originals()}\\${id}.${ext}`;
      await fsx.writeBytes(path, bytes);
      return { id, path, name: `${base}.${ext}`, bytes, created: created ?? Date.now() };
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
      items.map((it) => ({ name: it.name, load: async () => ({ id: it.id, path: it.path, name: it.name, bytes: await fsx.readBytes(it.path), created: it.created }) })),
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
  const intoGroupAtStart = store.get().filter.kind === 'group';
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
    // Importing while a group is open drops the new photos into that group.
    const f = store.get().filter;
    const intoGroup = f.kind === 'group' && f.value ? [f.value] : undefined;
    await Promise.all(
      Array.from({ length: THUMB_CONCURRENCY }, async () => {
        for (let q = queue.shift(); q; q = queue.shift()) {
          let written: string | null = null;
          try {
            const got = await q.j.load();
            written = got.path;
            const size = got.bytes.byteLength;
            if (isVideoName(got.name)) {
              const v = await makeVideoThumb(got.bytes);
              await fsx.writeBytes(paths.thumb(got.id), new Uint8Array(v.buf));
              buffer.push({
                id: got.id,
                file: got.path,
                name: got.name,
                size,
                w: v.w,
                h: v.h,
                added: now - q.i,
                created: got.created ?? now,
                groups: intoGroup,
                kind: 'video',
                dur: v.dur,
                audio: v.audio,
              });
              added.push(got.id);
              done++;
              setBusy('Importing', done, jobs.length);
              continue;
            }
            const t = await makeThumb(got.bytes);
            await fsx.writeBytes(paths.thumb(got.id), new Uint8Array(t.buf));
            if (t.pbuf) await fsx.writeBytes(paths.preview(got.id), new Uint8Array(t.pbuf));
            buffer.push({ id: got.id, file: got.path, name: got.name, size, w: t.w, h: t.h, added: now - q.i, pv: !!t.pbuf, created: got.created ?? now, groups: intoGroup });
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
    else toast(errors.length ? `Imported ${ok} · ${errors.length} failed (RAW isn't supported yet)` : `Imported ${ok} photo${ok === 1 ? '' : 's'}`);
  } finally {
    importing = false;
    clearBusy();
  }
  if (openSingle && added.length === 1) {
    if (!intoGroupAtStart) store.set({ filter: { kind: 'all' }, search: '' });
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
  await fsx.remove(victims.flatMap((p) => [p.file, paths.thumb(p.id), paths.editedThumb(p.id), paths.preview(p.id), paths.edit(p.id)]));
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

const PASTE_LABEL: Record<PasteMode, string> = { all: 'Edits', preset: 'Preset', tools: 'Tools' };

/** all = look incl. preset (keeps framing) · preset = only preset + strength · tools = adjustments, keeps target's preset. */
export function pasteEdits(ids: string[], mode: PasteMode = 'all') {
  const clip = store.get().clipboard;
  if (!clip) {
    toast('Copy edits from a photo first');
    return;
  }
  if (!ids.length) return;
  if (mode === 'preset' && !clip.preset) {
    toast('The copied photo has no preset');
    return;
  }
  const fn = mode === 'preset' ? presetOf : mode === 'tools' ? toolsOf : withGeometryOf;
  const next: Record<string, EditState> = {};
  for (const id of ids) next[id] = fn(clip, getEdit(id));
  commitMany(next);
  toast(`${PASTE_LABEL[mode]} pasted to ${ids.length} photo${ids.length === 1 ? '' : 's'}`);
}

/** Apply one preset to many photos, keeping their other edits. */
export function applyPreset(ids: string[], preset: string | null) {
  if (!ids.length) return;
  const next: Record<string, EditState> = {};
  for (const id of ids) {
    const e = getEdit(id);
    next[id] = { ...e, preset, strength: preset ? (e.preset === preset ? e.strength : 1) : e.strength };
  }
  commitMany(next);
  toast(preset ? `Preset applied to ${ids.length} photo${ids.length === 1 ? '' : 's'}` : 'Preset removed');
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
