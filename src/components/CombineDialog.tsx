import { useState } from 'react';
import { combineClips } from '../lib/export';
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

function readNum(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function CombineDialog() {
  const ids = useStore((s) => s.combineIds);
  const photos = useStore((s) => s.photos);
  const edits = useStore((s) => s.edits);
  const [shape, setShape] = useState('first');
  const [size, setSize] = useState(() => readNum('gs.remixSize', 0));
  const [quality, setQuality] = useState(() => readNum('gs.remixQuality', 0.92));
  const [name, setName] = useState(() => `Remix ${randomName(6)}`);
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

  const run = () => {
    if (!canRun) return;
    try {
      localStorage.setItem('gs.remixSize', String(size));
      localStorage.setItem('gs.remixQuality', String(quality));
    } catch {
      /* ignore */
    }
    const order = [...ids];
    close();
    void combineClips(order, shape, size, quality, clean);
  };

  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal combine" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Make a remix from {clips.length} clips</h3>
        <p className="lede">
          They play top to bottom as one new clip in your library, which you can trim, grade and export like anything else. The originals are
          left alone.
        </p>

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
                <button className="icon" onClick={() => store.set({ combineIds: ids.filter((_, n) => n !== i) })} title="Take out of this remix">
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
          <div className="name-preview">Clips of a different shape get centre-cropped to match.</div>
        </div>

        <div className="field">
          <span>Name</span>
          <div className="name-row">
            <input spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} placeholder="Name this remix" />
            <button className="dice" title="New random name" onClick={() => setName(`Remix ${randomName(6)}`)}>
              🎲
            </button>
          </div>
        </div>

        <div className="field">
          <span>Size (long edge)</span>
          <div className="seg">
            {SIZES.map((sz) => (
              <button key={sz.v} className={size === sz.v ? 'on' : ''} onClick={() => setSize(sz.v)}>
                {sz.label}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span>Quality · {Math.round(quality * 100)}</span>
          <input type="range" className="plain" min={0.6} max={1} step={0.01} value={quality} onChange={(e) => setQuality(+e.target.value)} />
        </label>

        <div className="modal-actions">
          <button className="ghost" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={!canRun} onClick={run}>
            Make remix
          </button>
        </div>
      </div>
    </div>
  );
}
