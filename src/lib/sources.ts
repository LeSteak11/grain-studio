// Decode caches for the editor. Tiers: thumbnail (720) → preview (2560) → full resolution.
// The preview is enough for a fit-to-screen view, so full-res decodes only happen on zoom or large displays.
import { fsx, paths } from './fs';
import { store } from './store';
import { PREVIEW_EDGE } from './thumbgen';

class BitmapCache {
  private map = new Map<string, Promise<ImageBitmap>>();
  constructor(private max: number) {}
  pinned: string | null = null;

  get(id: string, load: () => Promise<ImageBitmap>): Promise<ImageBitmap> {
    const hit = this.map.get(id);
    if (hit) {
      this.map.delete(id);
      this.map.set(id, hit);
      return hit;
    }
    const p = load();
    p.catch(() => this.map.delete(id));
    this.map.set(id, p);
    while (this.map.size > this.max) {
      const victim = [...this.map.keys()].find((k) => k !== this.pinned && k !== id);
      if (!victim) break;
      const vp = this.map.get(victim)!;
      this.map.delete(victim);
      vp.then((b) => b.close()).catch(() => undefined);
    }
    return p;
  }

  has(id: string) {
    return this.map.has(id);
  }

  drop(id: string) {
    this.map.delete(id);
  }
}

const full = new BitmapCache(3);
const previews = new BitmapCache(10);

export function decodeFile(path: string): Promise<ImageBitmap> {
  return fsx.readBytes(path).then((b) => createImageBitmap(new Blob([b as BlobPart])));
}

const photoOf = (id: string) => store.get().photos.find((p) => p.id === id);

export function loadFull(id: string): Promise<ImageBitmap> {
  return full.get(id, () => {
    const photo = photoOf(id);
    return photo ? decodeFile(photo.file) : Promise.reject(new Error('photo not found'));
  });
}

/** Mid-size preview, or the original when the photo is small. Creates the preview file for older imports. */
export function loadPreview(id: string): Promise<ImageBitmap> {
  const photo = photoOf(id);
  if (!photo) return Promise.reject(new Error('photo not found'));
  if (Math.max(photo.w, photo.h) <= PREVIEW_EDGE * 1.15) return loadFull(id);
  if (!photo.pv) {
    // Older import: decode the original once, write a preview for next time.
    return previews.get(id, async () => {
      const b = await loadFull(id);
      const k = PREVIEW_EDGE / Math.max(b.width, b.height);
      const small = await createImageBitmap(b, { resizeWidth: Math.round(b.width * k), resizeHeight: Math.round(b.height * k), resizeQuality: 'high' });
      void savePreview(id, small);
      return small;
    });
  }
  return previews.get(id, () => decodeFile(paths.preview(id)));
}

async function savePreview(id: string, bmp: ImageBitmap) {
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.93 });
    await fsx.writeBytes(paths.preview(id), new Uint8Array(await blob.arrayBuffer()));
    store.set((s) => ({ photos: s.photos.map((p) => (p.id === id ? { ...p, pv: true } : p)) }));
  } catch (e) {
    console.warn('preview save failed', e);
  }
}

export function pin(id: string | null) {
  full.pinned = id;
  previews.pinned = id;
}

export function prefetch(ids: string[]) {
  const run = () => ids.forEach((id) => void loadPreview(id).catch(() => undefined));
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 200);
}

export function dropFull(id: string) {
  full.drop(id);
  previews.drop(id);
}
