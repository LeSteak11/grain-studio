import { convertFileSrc, invoke } from '@tauri-apps/api/core';

let ROOT = '';
export const setRoot = (r: string) => {
  ROOT = r;
};

export const join = (...parts: string[]) => parts.join('\\').replace(/\\{2,}/g, '\\');

export const paths = {
  library: () => join(ROOT, 'library.json'),
  recipes: () => join(ROOT, 'recipes.json'),
  prefs: () => join(ROOT, 'prefs.json'),
  originals: () => join(ROOT, 'originals'),
  editsDir: () => join(ROOT, 'edits'),
  edit: (id: string) => join(ROOT, 'edits', `${id}.json`),
  thumb: (id: string) => join(ROOT, 'thumbs', `${id}.jpg`),
  editedThumb: (id: string) => join(ROOT, 'thumbs', `${id}.e.jpg`),
  preview: (id: string) => join(ROOT, 'previews', `${id}.jpg`),
  dragDir: () => join(ROOT, 'drag'),
  lutsDir: () => join(ROOT, 'luts'),
  lut: (name: string) => join(ROOT, 'luts', `${name}.cube`),
  exports: () => join(ROOT, 'Exports'),
  root: () => ROOT,
};

export interface ImportedFile {
  id: string;
  path: string;
  name: string;
  size: number;
}

export const fsx = {
  root: () => invoke<string>('library_root'),
  readText: (path: string) => invoke<string | null>('read_text', { path }),
  writeText: (path: string, contents: string) => invoke<void>('write_text', { path, contents }),
  readAllText: (dir: string, ext: string) => invoke<Record<string, string>>('read_all_text', { dir, ext }),
  listDir: (dir: string, ext: string) => invoke<string[]>('list_dir', { dir, ext }),
  readBytes: async (path: string) => new Uint8Array(await invoke<ArrayBuffer>('read_bytes', { path })),
  writeBytes: (path: string, data: Uint8Array, unique = false) =>
    invoke<string>('write_bytes', data, {
      headers: unique ? { 'x-path': encodeURIComponent(path), 'x-unique': '1' } : { 'x-path': encodeURIComponent(path) },
    }),
  importFiles: (paths: string[], dest: string, skip: string[]) => invoke<ImportedFile[]>('import_files', { paths, dest, skip }),
  remove: (paths: string[]) => invoke<void>('remove_paths', { paths }),
  rename: (from: string, to: string) => invoke<void>('rename_path', { from, to }),
  openPath: (path: string) => invoke<void>('open_path', { path }),
  convertHeic: (src: string, dst: string) => invoke<void>('convert_heic', { src, dst }),
  clearDir: (path: string) => invoke<void>('clear_dir', { path }),
  exists: (path: string) => invoke<boolean>('path_exists', { path }),
};

export function fileUrl(path: string, rev?: number): string {
  const u = convertFileSrc(path);
  return rev ? `${u}?v=${rev}` : u;
}

export function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
