// Autosave: every change to edits / library / recipes is written to disk shortly after it happens.
import { fsx, paths } from './fs';
import { store } from './store';
import { isEdited } from './types';
import { scheduleEditedThumb } from './thumbs';

const EDIT_DELAY = 350;
const LIB_DELAY = 300;

const timers = new Map<string, { t: number; run: () => Promise<void> }>();
const inflight = new Set<Promise<void>>();

let lastEdits = store.get().edits;
let lastPhotos = store.get().photos;
let lastRecipes = store.get().recipes;
let lastFavs = store.get().favPresets;
let lastLabels = store.get().labels;
let lastGroups = store.get().groups;

function updateSaving() {
  const saving = timers.size > 0 || inflight.size > 0;
  if (store.get().saving !== saving) store.set({ saving });
}

function schedule(key: string, delay: number, run: () => Promise<void>) {
  const prev = timers.get(key);
  if (prev) clearTimeout(prev.t);
  const t = window.setTimeout(() => fire(key), delay);
  timers.set(key, { t, run });
  updateSaving();
}

function fire(key: string) {
  const job = timers.get(key);
  if (!job) return Promise.resolve();
  clearTimeout(job.t);
  timers.delete(key);
  const p = job
    .run()
    .catch((e) => console.error('save failed', key, e))
    .finally(() => {
      inflight.delete(p);
      updateSaving();
    });
  inflight.add(p);
  return p;
}

async function writeEdit(id: string) {
  const e = store.get().edits[id];
  if (!store.get().photos.some((p) => p.id === id)) return;
  if (!e || !isEdited(e)) await fsx.remove([paths.edit(id)]);
  else await fsx.writeText(paths.edit(id), JSON.stringify(e));
  scheduleEditedThumb(id);
}

async function writeLibrary() {
  await fsx.writeText(paths.library(), JSON.stringify({ version: 1, photos: store.get().photos }));
}

async function writeCollections() {
  const s = store.get();
  await fsx.writeText(paths.collections(), JSON.stringify({ labels: s.labels, groups: s.groups }, null, 1));
}

async function writePrefs() {
  await fsx.writeText(paths.prefs(), JSON.stringify({ favPresets: store.get().favPresets }));
}

async function writeRecipes() {
  await fsx.writeText(paths.recipes(), JSON.stringify(store.get().recipes, null, 1));
}

function onChange() {
  const s = store.get();
  if (!s.ready) {
    lastEdits = s.edits;
    lastPhotos = s.photos;
    lastRecipes = s.recipes;
    lastFavs = s.favPresets;
    lastLabels = s.labels;
    lastGroups = s.groups;
    return;
  }
  if (s.edits !== lastEdits) {
    const prev = lastEdits;
    lastEdits = s.edits;
    for (const id in s.edits) if (s.edits[id] !== prev[id]) schedule(`e:${id}`, EDIT_DELAY, () => writeEdit(id));
  }
  if (s.photos !== lastPhotos) {
    lastPhotos = s.photos;
    schedule('lib', LIB_DELAY, writeLibrary);
  }
  if (s.recipes !== lastRecipes) {
    lastRecipes = s.recipes;
    schedule('rec', LIB_DELAY, writeRecipes);
  }
  if (s.labels !== lastLabels || s.groups !== lastGroups) {
    lastLabels = s.labels;
    lastGroups = s.groups;
    schedule('coll', LIB_DELAY, writeCollections);
  }
  if (s.favPresets !== lastFavs) {
    lastFavs = s.favPresets;
    schedule('prefs', LIB_DELAY, writePrefs);
  }
}

export function startPersistence() {
  store.subscribe(onChange);
}

/** Write everything pending right now (used on window close). */
export async function flushAll() {
  await Promise.all([...timers.keys()].map(fire));
  await Promise.all([...inflight]);
}
