import { useSyncExternalStore } from 'react';
import { DEFAULT_PLATFORMS, createdOf, isEdited, isPosted, type EditState, type Group, type Label, type Photo, type Platform, type Recipe } from './types';

export type FilterKind = 'all' | 'photos' | 'videos' | 'fav' | 'edited' | 'unedited' | 'posted' | 'unposted' | 'group' | 'label' | 'unlabeled' | 'month';
export interface Filter {
  kind: FilterKind;
  value?: string;
}
export type Sort = 'created-desc' | 'created-asc' | 'added-desc' | 'added-asc' | 'name';

/** Action prompt shown after dragging photos out (e.g. "Posted these?"). */
export interface PostPrompt {
  ids: string[];
  at: number;
}

export interface Busy {
  label: string;
  done: number;
  total: number;
}

export interface AppState {
  ready: boolean;
  error: string | null;
  root: string;
  photos: Photo[];
  edits: Record<string, EditState>;
  /** Names of user LUTs in the luts folder (id = "u:" + name). */
  luts: string[];
  recipes: Recipe[];
  /** Preset ids starred by the user (shown first). */
  favPresets: string[];
  view: 'library' | 'editor';
  currentId: string | null;
  selection: Set<string>;
  anchor: string | null;
  filter: Filter;
  search: string;
  sort: Sort;
  labels: Label[];
  groups: Group[];
  platforms: Platform[];
  postPrompt: PostPrompt | null;
  showInfo: boolean;
  thumbSize: number;
  clipboard: EditState | null;
  busy: Busy | null;
  toast: string | null;
  modal: null | 'export' | 'lab';
  exportIds: string[];
  dragOver: boolean;
  saving: boolean;
}

function readNum(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function readStr<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

let state: AppState = {
  ready: false,
  error: null,
  root: '',
  photos: [],
  edits: {},
  luts: [],
  recipes: [],
  favPresets: [],
  view: 'library',
  currentId: null,
  selection: new Set(),
  anchor: null,
  filter: { kind: 'all' },
  search: '',
  sort: readStr('gs.sort', ['created-desc', 'created-asc', 'added-desc', 'added-asc', 'name'], 'created-desc'),
  labels: [],
  groups: [],
  platforms: DEFAULT_PLATFORMS,
  postPrompt: null,
  showInfo: readStr('gs.showInfo', ['1', '0'], '1') === '1',
  thumbSize: readNum('gs.thumbSize', 220),
  clipboard: null,
  busy: null,
  toast: null,
  modal: null,
  exportIds: [],
  dragOver: false,
  saving: false,
};

const listeners = new Set<() => void>();

export const store = {
  get: () => state,
  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useStore<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(state));
}

let toastTimer: number | undefined;
export function toast(msg: string) {
  store.set({ toast: msg });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => store.set({ toast: null }), 2800);
}

export const monthKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Date that drives sorting/grouping for the current sort mode. */
export const sortDate = (s: AppState, p: Photo) => (s.sort.startsWith('added') ? p.added : createdOf(p));

function matchesFilter(s: AppState, p: Photo): boolean {
  const f = s.filter;
  switch (f.kind) {
    case 'photos':
      return p.kind !== 'video';
    case 'videos':
      return p.kind === 'video';
    case 'fav':
      return !!p.fav;
    case 'edited':
      return isEdited(s.edits[p.id]);
    case 'unedited':
      return !isEdited(s.edits[p.id]);
    case 'posted':
      return f.value ? !!p.posted?.[f.value] : isPosted(p);
    case 'unposted':
      return !isPosted(p);
    case 'group':
      return !!p.groups?.includes(f.value!);
    case 'label':
      return !!p.labels?.includes(f.value!);
    case 'unlabeled':
      return !p.labels?.length;
    case 'month':
      return monthKey(createdOf(p)) === f.value;
    default:
      return true;
  }
}

function matchesSearch(s: AppState, p: Photo, words: string[]): boolean {
  if (!words.length) return true;
  const hay = [
    p.name,
    p.note ?? '',
    ...(p.labels ?? []).map((id) => s.labels.find((l) => l.id === id)?.name ?? ''),
    ...(p.groups ?? []).map((id) => s.groups.find((g) => g.id === id)?.name ?? ''),
  ]
    .join(' ')
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

let memo: { key: unknown[]; out: Photo[] } | null = null;

/** Filtered + searched + sorted photo list; stable array while inputs are unchanged. */
export function visiblePhotos(s: AppState): Photo[] {
  const needsEdits = s.filter.kind === 'edited' || s.filter.kind === 'unedited';
  const key = [s.photos, s.filter, s.search, s.sort, s.labels, s.groups, needsEdits ? s.edits : null];
  if (memo && memo.key.every((k, i) => k === key[i])) return memo.out;
  const words = s.search.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/^#/, ''));
  const out = s.photos.filter((p) => matchesFilter(s, p) && matchesSearch(s, p, words));
  const by = s.sort;
  if (by === 'name') out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  else {
    const dir = by.endsWith('asc') ? 1 : -1;
    const get = by.startsWith('added') ? (p: Photo) => p.added : createdOf;
    out.sort((a, b) => (get(a) - get(b)) * dir);
  }
  memo = { key, out };
  return out;
}

export function setBusy(label: string, done: number, total: number) {
  store.set({ busy: { label, done, total } });
}

export function clearBusy() {
  store.set({ busy: null });
}
