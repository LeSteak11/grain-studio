import { LOOK_DEFS, bakeLook } from './looks';
import { fsx, paths } from './fs';

/** 3D LUT, red varies fastest (same order as .cube). data is RGB8 (size^3*3) or RGBA8. */
export interface Lut {
  size: number;
  data: Uint8Array;
}

export interface PresetInfo {
  id: string;
  code: string;
  name: string;
  user: boolean;
}

export const BUILTIN: PresetInfo[] = LOOK_DEFS.map((l) => ({ id: `b:${l.code}`, code: l.code, name: l.name, user: false }));

export const userLutId = (name: string) => `u:${name}`;

export function presetInfo(id: string | null): PresetInfo | null {
  if (!id) return null;
  if (id.startsWith('u:')) {
    const name = id.slice(2);
    return { id, code: name.length <= 4 ? name : name.slice(0, 4), name, user: true };
  }
  return BUILTIN.find((b) => b.id === id) ?? null;
}

const cache = new Map<string, Lut>();
const loading = new Map<string, Promise<Lut | null>>();

export function getLutSync(id: string | null): Lut | null {
  return id ? cache.get(id) ?? null : null;
}

export function getLut(id: string | null): Promise<Lut | null> {
  if (!id) return Promise.resolve(null);
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  let p = loading.get(id);
  if (!p) {
    p = (async () => {
      let lut: Lut | null = null;
      if (id.startsWith('b:')) lut = bakeLook(id.slice(2));
      else if (id.startsWith('u:')) {
        const txt = await fsx.readText(paths.lut(id.slice(2)));
        if (txt) lut = parseCube(txt);
      }
      if (lut) cache.set(id, lut);
      loading.delete(id);
      return lut;
    })().catch(() => {
      loading.delete(id);
      return null;
    });
    loading.set(id, p);
  }
  return p;
}

export function putLut(id: string, lut: Lut) {
  cache.set(id, lut);
}

export function forgetLut(id: string) {
  cache.delete(id);
}

export function parseCube(text: string): Lut {
  let size = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const c = line.charCodeAt(0);
    if ((c >= 48 && c <= 57) || c === 45 || c === 46) {
      const parts = line.split(/\s+/);
      vals.push(+parts[0], +parts[1], +parts[2]);
    } else if (line.startsWith('LUT_3D_SIZE')) size = parseInt(line.split(/\s+/)[1], 10);
    else if (line.startsWith('LUT_1D_SIZE')) throw new Error('1D LUTs are not supported');
    else if (line.startsWith('DOMAIN_MIN')) min = line.split(/\s+/).slice(1).map(Number);
    else if (line.startsWith('DOMAIN_MAX')) max = line.split(/\s+/).slice(1).map(Number);
  }
  if (!size || size < 2 || size > 129) throw new Error('Missing or invalid LUT_3D_SIZE');
  if (vals.length !== size ** 3 * 3) throw new Error(`Expected ${size ** 3} entries, found ${vals.length / 3}`);
  const data = new Uint8Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    const ch = i % 3;
    const v = (vals[i] - min[ch]) / (max[ch] - min[ch] || 1);
    data[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return { size, data };
}

export function toCube(lut: Lut, title: string): string {
  const n = lut.size;
  const stride = lut.data.length === n ** 3 * 4 ? 4 : 3;
  const lines = [`TITLE "${title.replace(/"/g, '')}"`, '# Captured with Grain Studio', `LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let i = 0; i < n ** 3; i++) {
    const o = i * stride;
    lines.push(`${(lut.data[o] / 255).toFixed(4)} ${(lut.data[o + 1] / 255).toFixed(4)} ${(lut.data[o + 2] / 255).toFixed(4)}`);
  }
  return lines.join('\n') + '\n';
}
