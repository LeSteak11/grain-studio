import { store } from './store';
import { DEFAULT_EDIT, type EditState } from './types';

const hist = new Map<string, { past: EditState[]; future: EditState[] }>();
const LIMIT = 150;

function h(id: string) {
  let x = hist.get(id);
  if (!x) {
    x = { past: [], future: [] };
    hist.set(id, x);
  }
  return x;
}

export function getEdit(id: string): EditState {
  return store.get().edits[id] ?? DEFAULT_EDIT;
}

/** Set without recording history (use during slider drags after begin()). */
export function setEdit(id: string, next: EditState) {
  store.set((s) => ({ edits: { ...s.edits, [id]: next } }));
}

/** Snapshot the current state as an undo step. */
export function begin(id: string) {
  const x = h(id);
  x.past.push(getEdit(id));
  if (x.past.length > LIMIT) x.past.shift();
  x.future = [];
}

export function commit(id: string, next: EditState) {
  begin(id);
  setEdit(id, next);
}

export function patch(id: string, p: Partial<EditState>) {
  commit(id, { ...getEdit(id), ...p });
}

/** Apply edits to many photos in one store update, each undoable. */
export function commitMany(next: Record<string, EditState>) {
  for (const id of Object.keys(next)) begin(id);
  store.set((s) => ({ edits: { ...s.edits, ...next } }));
}

export function undo(id: string) {
  const x = h(id);
  const prev = x.past.pop();
  if (!prev) return false;
  x.future.push(getEdit(id));
  setEdit(id, prev);
  return true;
}

export function redo(id: string) {
  const x = h(id);
  const next = x.future.pop();
  if (!next) return false;
  x.past.push(getEdit(id));
  setEdit(id, next);
  return true;
}

export function forget(id: string) {
  hist.delete(id);
}
