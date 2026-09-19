// Full-resolution decode cache for the editor (current + prefetched neighbours).
import { fsx } from './fs';
import { store } from './store';

const MAX = 4;
const cache = new Map<string, Promise<ImageBitmap>>();
let pinned: string | null = null;

export function decodeFile(path: string): Promise<ImageBitmap> {
  return fsx.readBytes(path).then((b) => createImageBitmap(new Blob([b as BlobPart])));
}

export function loadFull(id: string): Promise<ImageBitmap> {
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const photo = store.get().photos.find((p) => p.id === id);
  if (!photo) return Promise.reject(new Error('photo not found'));
  const p = decodeFile(photo.file);
  p.catch(() => cache.delete(id));
  cache.set(id, p);
  while (cache.size > MAX) {
    const victim = [...cache.keys()].find((k) => k !== pinned && k !== id);
    if (!victim) break;
    const vp = cache.get(victim)!;
    cache.delete(victim);
    vp.then((b) => b.close()).catch(() => undefined);
  }
  return p;
}

export function pin(id: string | null) {
  pinned = id;
}

export function prefetch(ids: string[]) {
  const run = () => ids.forEach((id) => void loadFull(id).catch(() => undefined));
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 200);
}

export function dropFull(id: string) {
  cache.delete(id);
}
