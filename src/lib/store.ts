import { useSyncExternalStore } from 'react';
import { isEdited, type EditState, type Photo, type Recipe } from './types';

export type Filter = 'all' | 'edited' | 'unedited' | 'fav';

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
  filter: 'all',
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

let memo: { photos: Photo[]; edits: Record<string, EditState>; filter: Filter; out: Photo[] } | null = null;

/** Filtered photo list; returns a stable array while inputs are unchanged. */
export function visiblePhotos(s: AppState): Photo[] {
  if (memo && memo.photos === s.photos && memo.filter === s.filter && (s.filter === 'all' || s.filter === 'fav' || memo.edits === s.edits)) {
    return memo.out;
  }
  let out = s.photos;
  if (s.filter === 'edited') out = s.photos.filter((p) => isEdited(s.edits[p.id]));
  else if (s.filter === 'unedited') out = s.photos.filter((p) => !isEdited(s.edits[p.id]));
  else if (s.filter === 'fav') out = s.photos.filter((p) => p.fav);
  memo = { photos: s.photos, edits: s.edits, filter: s.filter, out };
  return out;
}

export function setBusy(label: string, done: number, total: number) {
  store.set({ busy: { label, done, total } });
}

export function clearBusy() {
  store.set({ busy: null });
}
