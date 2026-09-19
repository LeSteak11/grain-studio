import { memo, useEffect } from 'react';
import { SaveState, thumbUrl } from './common';
import { fsx, paths } from '../lib/fs';
import { copyEdits, openEditor, openExport, pasteEdits, pickAndImport, removePhotos, resetEdits, toggleFav } from '../lib/library';
import { presetInfo } from '../lib/luts';
import { store, useStore, visiblePhotos, type Filter } from '../lib/store';
import { isEdited, type Photo } from '../lib/types';
import { PasteMenu, PresetPicker } from './Menus';
import { copyImage, dragOutGesture } from '../lib/share';

/** Dragging a selected tile drags the whole selection; an unselected tile drags just itself. */
function dragIds(id: string) {
  const s = store.get();
  if (!s.selection.has(id)) return [id];
  return visiblePhotos(s)
    .filter((p) => s.selection.has(p.id))
    .map((p) => p.id);
}

function selectedIds() {
  const s = store.get();
  return visiblePhotos(s)
    .filter((p) => s.selection.has(p.id))
    .map((p) => p.id);
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'edited', label: 'Edited' },
  { id: 'unedited', label: 'Unedited' },
  { id: 'fav', label: 'Favorites' },
];

function clickTile(e: React.MouseEvent, id: string) {
  e.stopPropagation();
  const s = store.get();
  const list = visiblePhotos(s);
  if (e.shiftKey && s.anchor) {
    const a = list.findIndex((p) => p.id === s.anchor);
    const b = list.findIndex((p) => p.id === id);
    if (a >= 0 && b >= 0) {
      const range = list.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id);
      const sel = e.ctrlKey || e.metaKey ? new Set([...s.selection, ...range]) : new Set(range);
      store.set({ selection: sel });
      return;
    }
  }
  if (e.ctrlKey || e.metaKey) {
    const sel = new Set(s.selection);
    if (sel.has(id)) sel.delete(id);
    else sel.add(id);
    store.set({ selection: sel, anchor: id });
    return;
  }
  store.set({ selection: new Set([id]), anchor: id });
}

const Tile = memo(function Tile({ photo, selected, edited, presetCode }: { photo: Photo; selected: boolean; edited: boolean; presetCode: string | null }) {
  return (
    <div
      className={`tile${selected ? ' sel' : ''}`}
      onClick={(e) => clickTile(e, photo.id)}
      onDoubleClick={() => openEditor(photo.id)}
      onPointerDown={(e) => !e.ctrlKey && !e.shiftKey && dragOutGesture(e, () => dragIds(photo.id))}
      title="Double-click to edit · drag out to share"
    >
      <img src={thumbUrl(photo)} loading="lazy" decoding="async" alt={photo.name} draggable={false} />
      <div className="tile-meta">
        {photo.fav && <span className="fav">★</span>}
        {edited && <span className="edited">{presetCode ?? 'Edited'}</span>}
      </div>
    </div>
  );
});

export function Library() {
  const photos = useStore(visiblePhotos);
  const total = useStore((s) => s.photos.length);
  const edits = useStore((s) => s.edits);
  const selection = useStore((s) => s.selection);
  const filter = useStore((s) => s.filter);
  const thumbSize = useStore((s) => s.thumbSize);

  const selIds = photos.filter((p) => selection.has(p.id)).map((p) => p.id);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement || store.get().modal) return;
      const s = store.get();
      const list = visiblePhotos(s);
      const sel = list.filter((p) => s.selection.has(p.id)).map((p) => p.id);
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'a') store.set({ selection: new Set(list.map((p) => p.id)) });
        else if (k === 'c' && e.shiftKey && sel.length === 1) void copyImage(sel[0]);
        else if (k === 'c' && sel.length) copyEdits(sel[0]);
        else if (k === 'v' && e.shiftKey && sel.length) pasteEdits(sel, 'preset');
        else if (k === 'e' && sel.length) openExport(sel);
        else if (k === 'i') void pickAndImport();
        else return;
        e.preventDefault();
        return;
      }
      if (e.key === 'Delete' && sel.length) void removePhotos(sel);
      else if (e.key === 'Enter' && sel.length) openEditor(sel[0]);
      else if (e.key === 'Escape') store.set({ selection: new Set() });
      else if (k === 'f' && sel.length) toggleFav(sel);
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && list.length) {
        const i = list.findIndex((p) => p.id === s.anchor);
        const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))];
        store.set({ selection: new Set([next.id]), anchor: next.id });
        document.querySelector(`[data-tile="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, []);

  const setThumb = (v: number) => {
    store.set({ thumbSize: v });
    try {
      localStorage.setItem('gs.thumbSize', String(v));
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="library">
      <header className="topbar">
        <div className="tb-left">
          <span className="brand">Grain Studio</span>
          <nav className="filters">
            {FILTERS.map((f) => (
              <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => store.set({ filter: f.id })}>
                {f.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="tb-right">
          <SaveState />
          <input className="size" type="range" min={120} max={420} step={10} value={thumbSize} onChange={(e) => setThumb(+e.target.value)} title="Thumbnail size" />
          <button className="ghost" onClick={() => fsx.openPath(paths.root())} title="Open library folder">
            Folder
          </button>
          <button className="ghost" onClick={() => store.set({ modal: 'lab' })}>
            Preset Lab
          </button>
          <button className="primary" onClick={() => void pickAndImport()} title="Import (Ctrl+I) — or drop files/folders anywhere">
            Import
          </button>
        </div>
      </header>

      <div className={`selbar${selIds.length ? ' show' : ''}`}>
        <span>
          <b>{selIds.length}</b> selected
        </span>
        <button onClick={() => selIds[0] && openEditor(selIds[0])}>Edit</button>
        <button disabled={selIds.length !== 1} onClick={() => copyEdits(selIds[0])}>
          Copy edits
        </button>
        <PasteMenu ids={selectedIds} />
        <PresetPicker ids={selectedIds} />
        <button disabled={selIds.length !== 1} onClick={() => void copyImage(selIds[0])} title="Copy the edited image (Ctrl+Shift+C)">
          Copy image
        </button>
        <button onClick={() => toggleFav(selIds)}>Favorite</button>
        <button onClick={() => resetEdits(selIds)}>Revert</button>
        <button onClick={() => openExport(selIds)}>Export</button>
        <button className="danger" onClick={() => void removePhotos(selIds)}>
          Remove
        </button>
        <span className="spacer" />
        <button onClick={() => store.set({ selection: new Set() })}>Clear</button>
      </div>

      <main className="grid-wrap" onClick={() => store.set({ selection: new Set() })}>
        {total === 0 ? (
          <div className="empty">
            <div className="empty-mark" />
            <h2>Your studio is empty</h2>
            <p>Drag photos in from your browser or Explorer, paste an image with Ctrl+V, or</p>
            <button
              className="primary"
              onClick={(e) => {
                e.stopPropagation();
                void pickAndImport();
              }}
            >
              Import photos
            </button>
            <p className="dim small">JPEG · PNG · WebP · AVIF · BMP. Everything stays on this PC and saves automatically.</p>
          </div>
        ) : photos.length === 0 ? (
          <div className="empty">
            <p>Nothing here with this filter.</p>
          </div>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))` }}>
            {photos.map((p) => {
              const e = edits[p.id];
              return (
                <div key={p.id} data-tile={p.id} className="tile-cell" style={{ height: thumbSize }}>
                  <Tile photo={p} selected={selection.has(p.id)} edited={isEdited(e)} presetCode={presetInfo(e?.preset ?? null)?.code ?? null} />
                </div>
              );
            })}
          </div>
        )}
      </main>
      <footer className="statusbar">
        <span>
          {photos.length} of {total} photos
        </span>
        <span className="dim">Double-click to edit · Ctrl/Shift-click to multi-select · Ctrl+C / Ctrl+V copies edits</span>
      </footer>
    </div>
  );
}
