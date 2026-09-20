// Labels, groups, dates and "posted" tracking. Labels and groups live in collections.json
// alongside the platforms you post to; everything else sits on the Photo records.
import { ask } from '@tauri-apps/plugin-dialog';
import { store, toast } from './store';
import { LABEL_COLORS, shortFor, type Group, type Label, type Photo, type Platform } from './types';

const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function updatePhotos(ids: string[], fn: (p: Photo) => Photo) {
  const set = new Set(ids);
  store.set((s) => ({ photos: s.photos.map((p) => (set.has(p.id) ? fn(p) : p)) }));
}

/** Toggle membership (label or group) for many photos: if all have it, remove; otherwise add. */
function toggleIn(ids: string[], key: 'labels' | 'groups', value: string) {
  const set = new Set(ids);
  const photos = store.get().photos.filter((p) => set.has(p.id));
  const allHave = photos.length > 0 && photos.every((p) => p[key]?.includes(value));
  updatePhotos(ids, (p) => {
    const cur = p[key] ?? [];
    if (allHave) return { ...p, [key]: cur.filter((v) => v !== value) };
    return cur.includes(value) ? p : { ...p, [key]: [...cur, value] };
  });
  return !allHave;
}

export const toggleLabel = (ids: string[], labelId: string) => toggleIn(ids, 'labels', labelId);

export function toggleGroup(ids: string[], groupId: string) {
  const added = toggleIn(ids, 'groups', groupId);
  const g = store.get().groups.find((x) => x.id === groupId);
  toast(`${added ? 'Added to' : 'Removed from'} “${g?.name ?? 'group'}”`);
}

export function createGroup(name: string, addIds: string[] = []): Group | null {
  const n = name.trim().slice(0, 60);
  if (!n) return null;
  const g: Group = { id: uid('g'), name: n, created: Date.now() };
  store.set((s) => ({ groups: [...s.groups, g] }));
  if (addIds.length) updatePhotos(addIds, (p) => ({ ...p, groups: [...(p.groups ?? []), g.id] }));
  return g;
}

export function renameGroup(id: string, name: string) {
  const n = name.trim().slice(0, 60);
  if (n) store.set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name: n } : g)) }));
}

export async function deleteGroup(id: string) {
  const g = store.get().groups.find((x) => x.id === id);
  const ok = await ask(`Delete the group “${g?.name}”? The photos stay in your library.`, { title: 'Delete group', kind: 'warning', okLabel: 'Delete' });
  if (!ok) return;
  store.set((s) => ({
    groups: s.groups.filter((x) => x.id !== id),
    photos: s.photos.map((p) => (p.groups?.includes(id) ? { ...p, groups: p.groups.filter((x) => x !== id) } : p)),
    filter: s.filter.kind === 'group' && s.filter.value === id ? { kind: 'all' } : s.filter,
  }));
}

/** Next unused colour from the palette. */
export function nextLabelColor(): string {
  const used = new Set(store.get().labels.map((l) => l.color));
  return LABEL_COLORS.find((c) => !used.has(c)) ?? LABEL_COLORS[store.get().labels.length % LABEL_COLORS.length];
}

export function createLabel(name: string, color?: string, addIds: string[] = []): Label | null {
  const n = name.trim().slice(0, 30);
  if (!n) return null;
  const l: Label = { id: uid('l'), name: n, color: color ?? nextLabelColor() };
  store.set((s) => ({ labels: [...s.labels, l] }));
  if (addIds.length) updatePhotos(addIds, (p) => ({ ...p, labels: [...(p.labels ?? []), l.id] }));
  return l;
}

export function updateLabel(id: string, patch: Partial<Label>) {
  store.set((s) => ({ labels: s.labels.map((l) => (l.id === id ? { ...l, ...patch, name: (patch.name ?? l.name).trim().slice(0, 30) || l.name } : l)) }));
}

export async function deleteLabel(id: string) {
  const l = store.get().labels.find((x) => x.id === id);
  const ok = await ask(`Delete the label “${l?.name}”? It will be removed from every photo.`, { title: 'Delete label', kind: 'warning', okLabel: 'Delete' });
  if (!ok) return;
  store.set((s) => ({
    labels: s.labels.filter((x) => x.id !== id),
    photos: s.photos.map((p) => (p.labels?.includes(id) ? { ...p, labels: p.labels.filter((x) => x !== id) } : p)),
    filter: s.filter.kind === 'label' && s.filter.value === id ? { kind: 'all' } : s.filter,
  }));
}

/* ---- Platforms you post to ---- */

export function createPlatform(name: string): Platform | null {
  const n = name.trim().slice(0, 24);
  if (!n) return null;
  if (store.get().platforms.some((p) => p.name.toLowerCase() === n.toLowerCase())) {
    toast('That one is already in the list');
    return null;
  }
  const p: Platform = { id: uid('p'), name: n, short: shortFor(n) };
  store.set((s) => ({ platforms: [...s.platforms, p] }));
  return p;
}

export function renamePlatform(id: string, name: string) {
  const n = name.trim().slice(0, 24);
  if (!n) return;
  store.set((s) => ({ platforms: s.platforms.map((p) => (p.id === id ? { ...p, name: n, short: shortFor(n) } : p)) }));
}

export async function deletePlatform(id: string) {
  const p = store.get().platforms.find((x) => x.id === id);
  const used = store.get().photos.filter((x) => x.posted?.[id]).length;
  const ok = await ask(
    used ? `Remove “${p?.name}”? ${used} photo${used === 1 ? '' : 's'} marked as posted there will lose that mark.` : `Remove “${p?.name}” from the list?`,
    { title: 'Remove platform', kind: 'warning', okLabel: 'Remove' },
  );
  if (!ok) return;
  store.set((s) => ({
    platforms: s.platforms.filter((x) => x.id !== id),
    photos: s.photos.map((x) => {
      if (!x.posted?.[id]) return x;
      const posted = { ...x.posted };
      delete posted[id];
      return { ...x, posted };
    }),
    filter: s.filter.kind === 'posted' && s.filter.value === id ? { kind: 'all' } : s.filter,
  }));
}

/** Mark/unmark posted. `on` undefined = toggle based on whether all already have it. */
export function setPosted(ids: string[], platform: string, on?: boolean) {
  const set = new Set(ids);
  const photos = store.get().photos.filter((p) => set.has(p.id));
  const target = on ?? !photos.every((p) => p.posted?.[platform]);
  const now = Date.now();
  updatePhotos(ids, (p) => {
    const posted = { ...(p.posted ?? {}) };
    if (target) posted[platform] = posted[platform] ?? now;
    else delete posted[platform];
    return { ...p, posted };
  });
  return target;
}

export function setCreated(ids: string[], t: number) {
  if (!Number.isFinite(t)) return;
  updatePhotos(ids, (p) => ({ ...p, created: t }));
}

export function setNote(id: string, note: string) {
  updatePhotos([id], (p) => ({ ...p, note }));
}
