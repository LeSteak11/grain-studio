// Tags, labels, groups, dates and "posted" tracking. Everything lives on the Photo records
// (library.json) plus label/group definitions (collections.json), autosaved like the rest.
import { ask } from '@tauri-apps/plugin-dialog';
import { store, toast } from './store';
import { LABEL_COLORS, type Group, type Label, type Photo, type Platform } from './types';

const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function updatePhotos(ids: string[], fn: (p: Photo) => Photo) {
  const set = new Set(ids);
  store.set((s) => ({ photos: s.photos.map((p) => (set.has(p.id) ? fn(p) : p)) }));
}

export const cleanTag = (t: string) => t.trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 40);

/** All tags in use, most used first. */
export function allTags(photos: Photo[]): { tag: string; count: number }[] {
  const m = new Map<string, { tag: string; count: number }>();
  for (const p of photos)
    for (const t of p.tags ?? []) {
      const k = t.toLowerCase();
      const e = m.get(k);
      if (e) e.count++;
      else m.set(k, { tag: t, count: 1 });
    }
  return [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function addTags(ids: string[], raw: string) {
  const tags = raw.split(',').map(cleanTag).filter(Boolean);
  if (!tags.length) return;
  // Reuse the existing spelling of a tag if there is one.
  const known = new Map(allTags(store.get().photos).map((t) => [t.tag.toLowerCase(), t.tag]));
  const final = tags.map((t) => known.get(t.toLowerCase()) ?? t);
  updatePhotos(ids, (p) => {
    const cur = p.tags ?? [];
    const lower = new Set(cur.map((t) => t.toLowerCase()));
    const add = final.filter((t) => !lower.has(t.toLowerCase()));
    return add.length ? { ...p, tags: [...cur, ...add] } : p;
  });
}

export function removeTag(ids: string[], tag: string) {
  const k = tag.toLowerCase();
  updatePhotos(ids, (p) => (p.tags?.some((t) => t.toLowerCase() === k) ? { ...p, tags: p.tags.filter((t) => t.toLowerCase() !== k) } : p));
}

export async function deleteTagEverywhere(tag: string) {
  const ok = await ask(`Remove the tag “${tag}” from every photo?`, { title: 'Delete tag', kind: 'warning', okLabel: 'Delete' });
  if (!ok) return;
  removeTag(
    store.get().photos.map((p) => p.id),
    tag,
  );
  const f = store.get().filter;
  if (f.kind === 'tag' && f.value?.toLowerCase() === tag.toLowerCase()) store.set({ filter: { kind: 'all' } });
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

export function createLabel(name: string): Label | null {
  const n = name.trim().slice(0, 30);
  if (!n) return null;
  const used = new Set(store.get().labels.map((l) => l.color));
  const color = LABEL_COLORS.find((c) => !used.has(c)) ?? LABEL_COLORS[store.get().labels.length % LABEL_COLORS.length];
  const l: Label = { id: uid('l'), name: n, color };
  store.set((s) => ({ labels: [...s.labels, l] }));
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

/** Mark/unmark posted on a platform. `on` undefined = toggle based on whether all already have it. */
export function setPosted(ids: string[], platform: Platform, on?: boolean) {
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
