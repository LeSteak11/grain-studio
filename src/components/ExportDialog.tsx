import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { baseName, fsx, join, paths } from '../lib/fs';
import { exportPhotos, type ExportOpts } from '../lib/export';
import { randomName, sanitizeName } from '../lib/naming';
import { store, useStore } from '../lib/store';

const SIZES = [
  { v: 0, label: 'Original' },
  { v: 4096, label: '4096 px' },
  { v: 2048, label: '2048 px' },
  { v: 1080, label: '1080 px' },
];

type SingleMode = 'custom' | 'random';
type MultiMode = 'original' | 'base' | 'random';

function loadOpts(): ExportOpts {
  const d: ExportOpts = { dir: paths.exports(), format: 'jpeg', quality: 0.92, size: 0, openAfter: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem('gs.export') ?? '{}') };
  } catch {
    return d;
  }
}

function readPref<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

export function ExportDialog() {
  const ids = useStore((s) => s.exportIds);
  const firstName = useStore((s) => s.photos.find((p) => p.id === s.exportIds[0])?.name ?? 'photo');
  const videoCount = useStore((s) => s.photos.filter((p) => s.exportIds.includes(p.id) && p.kind === 'video').length);
  const allVideo = videoCount === ids.length && ids.length > 0;
  const anyVideo = videoCount > 0;
  const single = ids.length === 1;
  const [o, setO] = useState<ExportOpts>(loadOpts);
  const set = (p: Partial<ExportOpts>) => setO((x) => ({ ...x, ...p }));
  const close = () => store.set({ modal: null });

  const [singleMode, setSingleMode] = useState<SingleMode>(() => readPref('gs.nameMode', ['custom', 'random'], 'custom'));
  const [name, setName] = useState(() => (singleMode === 'random' ? randomName() : baseName(firstName)));
  const [multiMode, setMultiMode] = useState<MultiMode>(() => readPref('gs.multiNameMode', ['original', 'base', 'random'], 'original'));
  const [base, setBase] = useState('');
  const [exists, setExists] = useState(false);
  const [example] = useState(() => randomName());

  const ext = allVideo ? 'mp4' : o.format === 'png' ? 'png' : 'jpg';
  const clean = sanitizeName(name);
  const cleanBase = sanitizeName(base) || 'photo';
  const pad = Math.max(2, String(ids.length).length);
  const numbered = (i: number) => `${cleanBase}-${String(i + 1).padStart(pad, '0')}`;

  // Warn before a single export would collide with an existing file.
  useEffect(() => {
    if (!single || !clean) {
      setExists(false);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      fsx
        .exists(join(o.dir, `${clean}.${ext}`))
        .then((v) => alive && setExists(v))
        .catch(() => undefined);
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [single, clean, ext, o.dir]);

  const canRun = single ? !!clean : multiMode !== 'base' || !!sanitizeName(base);

  const run = () => {
    if (!canRun) return;
    try {
      localStorage.setItem('gs.export', JSON.stringify(o));
    } catch {
      /* ignore */
    }
    let names: string[] | undefined;
    if (single) {
      names = [clean];
      savePref('gs.nameMode', singleMode);
    } else {
      if (multiMode === 'base') names = ids.map((_, i) => numbered(i));
      else if (multiMode === 'random') names = ids.map(() => randomName());
      savePref('gs.multiNameMode', multiMode);
    }
    close();
    void exportPhotos(ids, o, names);
  };

  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          Export {ids.length} {allVideo ? (ids.length === 1 ? 'clip' : 'clips') : ids.length === 1 ? 'item' : 'items'}
        </h3>

        {single ? (
          <div className="field">
            <span>File name</span>
            <div className="name-row">
              <input
                autoFocus
                spellCheck={false}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSingleMode('custom');
                }}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => e.key === 'Enter' && run()}
                placeholder="File name"
              />
              <span className="ext">.{ext}</span>
              <button
                className="dice"
                title="Random 15-character name"
                onClick={() => {
                  setName(randomName());
                  setSingleMode('random');
                }}
              >
                🎲 Randomize
              </button>
            </div>
            <div className={`name-preview${exists ? ' warn' : ''}`}>
              {!clean
                ? 'Enter a file name'
                : exists
                  ? `${clean}.${ext} already exists. This will save as ${clean}-1.${ext}`
                  : `Saves as ${clean}.${ext}`}
            </div>
          </div>
        ) : (
          <div className="field">
            <span>File names</span>
            <div className="seg">
              <button className={multiMode === 'original' ? 'on' : ''} onClick={() => setMultiMode('original')}>
                Keep original
              </button>
              <button className={multiMode === 'base' ? 'on' : ''} onClick={() => setMultiMode('base')}>
                Name + number
              </button>
              <button className={multiMode === 'random' ? 'on' : ''} onClick={() => setMultiMode('random')}>
                🎲 Random
              </button>
            </div>
            {multiMode === 'base' && (
              <div className="name-row" style={{ marginTop: 8 }}>
                <input autoFocus spellCheck={false} value={base} onChange={(e) => setBase(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} placeholder="e.g. beach" />
              </div>
            )}
            <div className="name-preview">
              {multiMode === 'original' && `Each photo keeps its own name (${baseName(firstName)}.${ext}, …)`}
              {multiMode === 'base' && (sanitizeName(base) ? `${numbered(0)}.${ext}, ${numbered(1)}.${ext}, …` : 'Type a base name')}
              {multiMode === 'random' && `Each gets its own 15-character name, e.g. ${example}.${ext}`}
            </div>
          </div>
        )}

        <div className="field">
          <span>Size (long edge)</span>
          <div className="seg">
            {SIZES.map((s) => (
              <button key={s.v} className={o.size === s.v ? 'on' : ''} onClick={() => set({ size: s.v })}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        {!allVideo && (
          <div className="field">
            <span>Format{anyVideo ? ' (photos)' : ''}</span>
            <div className="seg">
              <button className={o.format === 'jpeg' ? 'on' : ''} onClick={() => set({ format: 'jpeg' })}>
                JPEG
              </button>
              <button className={o.format === 'png' ? 'on' : ''} onClick={() => set({ format: 'png' })}>
                PNG
              </button>
            </div>
          </div>
        )}
        {(allVideo || o.format === 'jpeg') && (
          <label className="field">
            <span>
              {allVideo ? 'Video quality' : 'Quality'} · {Math.round(o.quality * 100)}
            </span>
            <input type="range" className="plain" min={0.6} max={1} step={0.01} value={o.quality} onChange={(e) => set({ quality: +e.target.value })} />
          </label>
        )}
        {anyVideo && (
          <p className="name-preview">
            {allVideo ? 'Clips export as MP4 (H.264)' : 'Photos use the format above; clips always export as MP4'}
            {' · split clips write one file per piece'}
          </p>
        )}
        <div className="field">
          <span>Folder</span>
          <div className="dir-row">
            <code title={o.dir}>{o.dir}</code>
            <button
              onClick={async () => {
                const d = await open({ directory: true, defaultPath: o.dir });
                if (typeof d === 'string') set({ dir: d });
              }}
            >
              Change…
            </button>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={o.openAfter} onChange={(e) => set({ openAfter: e.target.checked })} />
          Open folder when done
        </label>
        <div className="modal-actions">
          <button className="ghost" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={!canRun} onClick={run}>
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
