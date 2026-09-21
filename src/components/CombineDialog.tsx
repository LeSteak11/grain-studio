import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { paths } from '../lib/fs';
import { combineClips, type ExportOpts } from '../lib/export';
import { sequenceDuration, type SeqItem } from '../lib/videoexport';
import { randomName, sanitizeName } from '../lib/naming';
import { store, useStore } from '../lib/store';
import { DEFAULT_EDIT, fmtTime, isVideo, type Photo } from '../lib/types';
import { thumbUrl } from './common';

const SIZES = [
  { v: 0, label: 'Original' },
  { v: 2048, label: '2048 px' },
  { v: 1080, label: '1080 px' },
];

const SHAPES = [
  { id: 'first', label: 'First clip' },
  { id: '9:16', label: '9:16' },
  { id: '4:5', label: '4:5' },
  { id: '1:1', label: '1:1' },
  { id: '16:9', label: '16:9' },
];

function loadOpts(): ExportOpts {
  const d: ExportOpts = { dir: paths.exports(), format: 'jpeg', quality: 0.92, size: 0, openAfter: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem('gs.export') ?? '{}') };
  } catch {
    return d;
  }
}

export function CombineDialog() {
  const ids = useStore((s) => s.combineIds);
  const photos = useStore((s) => s.photos);
  const edits = useStore((s) => s.edits);
  const [o, setO] = useState<ExportOpts>(loadOpts);
  const [shape, setShape] = useState('first');
  const [name, setName] = useState(() => randomName());
  const [addToLibrary, setAddToLibrary] = useState(true);
  const set = (p: Partial<ExportOpts>) => setO((x) => ({ ...x, ...p }));
  const close = () => store.set({ modal: null, combineIds: [] });

  const clips = ids.map((id) => photos.find((p) => p.id === id)).filter((p): p is Photo => !!p && isVideo(p));
  const items: SeqItem[] = clips.map((photo) => ({ photo, edit: edits[photo.id] ?? DEFAULT_EDIT }));
  const total = sequenceDuration(items);
  const clean = sanitizeName(name);
  const canRun = clips.length >= 2 && !!clean;

  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    store.set({ combineIds: next });
  };

  const drop = (i: number) => store.set({ combineIds: ids.filter((_, n) => n !== i) });

  const run = () => {
    if (!canRun) return;
    try {
      localStorage.setItem('gs.export', JSON.stringify(o));
    } catch {
      /* ignore */
    }
    const order = [...ids];
    close();
    void combineClips(order, shape, o, clean, addToLibrary);
  };

  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal combine" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Combine {clips.length} clips</h3>
        <p className="lede">They play top to bottom as one video. Each clip keeps its own preset, trim and text.</p>

        <div className="combine-list">
          {clips.map((p, i) => {
            const e = edits[p.id] ?? DEFAULT_EDIT;
            const end = e.trimOut > 0.001 ? Math.min(e.trimOut, p.dur ?? 0) : (p.dur ?? 0);
            const len = Math.max(0, end - Math.min(e.trimIn, p.dur ?? 0));
            return (
              <div className="combine-row" key={p.id}>
                <span className="combine-num">{i + 1}</span>
                <img src={thumbUrl(p)} alt="" draggable={false} />
                <div className="combine-meta">
                  <span className="combine-name">{p.name}</span>
                  <span className="dim">{fmtTime(len)}</span>
                </div>
                <button className="icon" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
                  ↑
                </button>
                <button className="icon" disabled={i === clips.length - 1} onClick={() => move(i, 1)} title="Move down">
                  ↓
                </button>
                <button className="icon" onClick={() => drop(i)} title="Take out of this combine">
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <p className="name-preview">
          Total {fmtTime(total)}
          {clips.length < 2 ? ' · add at least two clips' : ''}
        </p>

        <div className="field">
          <span>Shape</span>
          <div className="seg">
            {SHAPES.map((sh) => (
              <button key={sh.id} className={shape === sh.id ? 'on' : ''} onClick={() => setShape(sh.id)}>
                {sh.label}
              </button>
            ))}
          </div>
          <div className="name-preview">Clips that are a different shape get centre-cropped to match.</div>
        </div>

        <div className="field">
          <span>File name</span>
          <div className="name-row">
            <input spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} placeholder="File name" />
            <span className="ext">.mp4</span>
            <button className="dice" title="Random 15-character name" onClick={() => setName(randomName())}>
              🎲 Randomize
            </button>
          </div>
        </div>

        <div className="field">
          <span>Size (long edge)</span>
          <div className="seg">
            {SIZES.map((sz) => (
              <button key={sz.v} className={o.size === sz.v ? 'on' : ''} onClick={() => set({ size: sz.v })}>
                {sz.label}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span>Video quality · {Math.round(o.quality * 100)}</span>
          <input type="range" className="plain" min={0.6} max={1} step={0.01} value={o.quality} onChange={(e) => set({ quality: +e.target.value })} />
        </label>

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
          <input type="checkbox" checked={addToLibrary} onChange={(e) => setAddToLibrary(e.target.checked)} />
          Add the finished video to my library
        </label>
        <label className="check">
          <input type="checkbox" checked={o.openAfter} onChange={(e) => set({ openAfter: e.target.checked })} />
          Open folder when done
        </label>

        <div className="modal-actions">
          <button className="ghost" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={!canRun} onClick={run}>
            Combine
          </button>
        </div>
      </div>
    </div>
  );
}
