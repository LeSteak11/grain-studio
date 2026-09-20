import { memo, useEffect, useMemo, useRef } from 'react';
import { SaveState, thumbUrl } from './common';
import { PasteMenu, Popover, PresetPicker } from './Menus';
import { Sidebar } from './Sidebar';
import { InfoPanel } from './InfoPanel';
import { fsx, paths } from '../lib/fs';
import { copyEdits, openEditor, openExport, pasteEdits, pickAndImport, removePhotos, resetEdits, toggleFav } from '../lib/library';
import { presetInfo } from '../lib/luts';
import { addTags, setPosted, toggleGroup, toggleLabel } from '../lib/organize';
import { copyImage, dragOutGesture } from '../lib/share';
import { dayKey, sortDate, store, useStore, visiblePhotos, type Sort } from '../lib/store';
import { PLATFORMS, isEdited, isPosted, type Label, type Photo } from '../lib/types';

const SORTS: { id: Sort; label: string }[] = [
  { id: 'created-desc', label: 'Newest first' },
  { id: 'created-asc', label: 'Oldest first' },
  { id: 'added-desc', label: 'Recently added' },
  { id: 'added-asc', label: 'First added' },
  { id: 'name', label: 'Name' },
];

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

const Tile = memo(function Tile({ photo, selected, edited, presetCode, labels }: { photo: Photo; selected: boolean; edited: boolean; presetCode: string | null; labels: Label[] }) {
  const dots = (photo.labels ?? []).map((id) => labels.find((l) => l.id === id)).filter(Boolean) as Label[];
  const posted = Object.keys(photo.posted ?? {});
  return (
    <div
      className={`tile${selected ? ' sel' : ''}`}
      onClick={(e) => clickTile(e, photo.id)}
      onDoubleClick={() => openEditor(photo.id)}
      onPointerDown={(e) => !e.ctrlKey && !e.shiftKey && dragOutGesture(e, () => dragIds(photo.id))}
      title={`${photo.name}${photo.tags?.length ? `\n#${photo.tags.join(' #')}` : ''}\nDouble-click to edit · drag out to share`}
    >
      <img src={thumbUrl(photo)} loading="lazy" decoding="async" alt={photo.name} draggable={false} />
      <div className="tile-meta">
        {photo.fav && <span className="fav">★</span>}
        {edited && <span className="edited">{presetCode ?? 'Edited'}</span>}
      </div>
      <div className="tile-marks">
        {posted.map((p) => (
          <span key={p} className="posted-mark" title={`Posted to ${PLATFORMS.find((x) => x.id === p)?.label}`}>
            {PLATFORMS.find((x) => x.id === p)?.short}
          </span>
        ))}
        {dots.map((l) => (
          <span key={l.id} className="label-dot" style={{ background: l.color }} title={l.name} />
        ))}
      </div>
    </div>
  );
});

export function Library() {
  const photos = useStore(visiblePhotos);
  const total = useStore((s) => s.photos.length);
  const edits = useStore((s) => s.edits);
  const selection = useStore((s) => s.selection);
  const labels = useStore((s) => s.labels);
  const groups = useStore((s) => s.groups);
  const thumbSize = useStore((s) => s.thumbSize);
  const search = useStore((s) => s.search);
  const sort = useStore((s) => s.sort);
  const showInfo = useStore((s) => s.showInfo);
  const filter = useStore((s) => s.filter);

  const gridRef = useRef<HTMLElement>(null);
  const selIds = photos.filter((p) => selection.has(p.id)).map((p) => p.id);
  const byDate = sort !== 'name';

  // Rows of the grid: day headers interleaved with photos when sorting by date.
  const rows = useMemo(() => {
    const s = store.get();
    const out: ({ head: string; count: number } | Photo)[] = [];
    let cur = '';
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      if (byDate) {
        const k = dayKey(sortDate(s, p));
        if (k !== cur) {
          cur = k;
          let count = 0;
          for (let j = i; j < photos.length && dayKey(sortDate(s, photos[j])) === k; j++) count++;
          out.push({ head: k, count });
        }
      }
      out.push(p);
    }
    return out;
  }, [photos, byDate, sort]);

  // Ctrl/⌘ + scroll over the grid resizes the photos.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setThumb(store.get().thumbSize - Math.sign(e.deltaY) * 20);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

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
        else if (k === 'f') document.querySelector<HTMLInputElement>('.searchbox')?.focus();
        else return;
        e.preventDefault();
        return;
      }
      if (e.key === 'Delete' && sel.length) void removePhotos(sel);
      else if (e.key === 'Enter' && sel.length) openEditor(sel[0]);
      else if (e.key === 'Escape') store.set({ selection: new Set() });
      else if (k === 'i') toggleInfo();
      else if (e.key === '[') setThumb(store.get().thumbSize - 20);
      else if (e.key === ']') setThumb(store.get().thumbSize + 20);
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
    v = Math.round(Math.min(460, Math.max(100, v)));
    if (v === store.get().thumbSize) return;
    store.set({ thumbSize: v });
    try {
      localStorage.setItem('gs.thumbSize', String(v));
    } catch {
      /* ignore */
    }
  };

  const setSort = (v: Sort) => {
    store.set({ sort: v });
    try {
      localStorage.setItem('gs.sort', v);
    } catch {
      /* ignore */
    }
  };

  const title =
    filter.kind === 'group'
      ? (groups.find((g) => g.id === filter.value)?.name ?? 'Group')
      : filter.kind === 'label'
        ? (labels.find((l) => l.id === filter.value)?.name ?? 'Label')
        : filter.kind === 'tag'
          ? `#${filter.value}`
          : null;

  return (
    <div className="library">
      <header className="topbar">
        <div className="tb-left">
          <span className="brand">Grain Studio</span>
          <input className="searchbox" placeholder="Search names, tags, notes…  (Ctrl+F)" value={search} onChange={(e) => store.set({ search: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && store.set({ search: '' })} />
        </div>
        <div className="tb-right">
          <SaveState />
          <Popover label={`${SORTS.find((s) => s.id === sort)?.label} ▾`} title="Sort">
            {(close) => (
              <div className="menu">
                {SORTS.map((s) => (
                  <button
                    key={s.id}
                    className={sort === s.id ? 'on' : ''}
                    onClick={() => {
                      setSort(s.id);
                      close();
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </Popover>
          <div className="gridsize" title="Photo size — drag, Ctrl+scroll over the grid, or press [ and ]">
            <span className="gs-small">▪</span>
            <input className="size" type="range" min={100} max={460} step={10} value={thumbSize} onChange={(e) => setThumb(+e.target.value)} aria-label="Photo size" />
            <span className="gs-big">◼</span>
          </div>
          <button className={`ghost${showInfo ? ' on' : ''}`} onClick={toggleInfo} title="Info panel (I)">
            Info
          </button>
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
        <Popover label="Organize ▾" title="Tags, labels, groups">
          {(close) => (
            <div className="menu organize">
              <div className="menu-head">Labels</div>
              {labels.map((l) => (
                <button key={l.id} onClick={() => toggleLabel(selIds, l.id)}>
                  <span className="dot" style={{ background: l.color }} /> {l.name}
                </button>
              ))}
              <div className="menu-head">Groups</div>
              {groups.length === 0 && <span className="menu-empty">No groups yet — make one in the sidebar.</span>}
              {groups.map((g) => (
                <button key={g.id} onClick={() => toggleGroup(selIds, g.id)}>
                  {g.name}
                </button>
              ))}
              <div className="menu-head">Add tag</div>
              <input
                className="tag-input"
                placeholder="Tag, then Enter"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const v = (e.target as HTMLInputElement).value;
                  if (v.trim()) addTags(selIds, v);
                  (e.target as HTMLInputElement).value = '';
                  close();
                }}
              />
            </div>
          )}
        </Popover>
        <Popover label="Posted ▾" title="Mark as posted">
          {(close) => (
            <div className="menu">
              {PLATFORMS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setPosted(selIds, p.id, true);
                    close();
                  }}
                >
                  Posted to {p.label}
                </button>
              ))}
              <button
                onClick={() => {
                  PLATFORMS.forEach((p) => setPosted(selIds, p.id, false));
                  close();
                }}
              >
                Clear posted
              </button>
            </div>
          )}
        </Popover>
        <button onClick={() => toggleFav(selIds)}>Favorite</button>
        <button disabled={selIds.length !== 1} onClick={() => void copyImage(selIds[0])} title="Copy the edited image (Ctrl+Shift+C)">
          Copy image
        </button>
        <button onClick={() => resetEdits(selIds)}>Revert</button>
        <button onClick={() => openExport(selIds)}>Export</button>
        <button className="danger" onClick={() => void removePhotos(selIds)}>
          Remove
        </button>
        <span className="spacer" />
        <button onClick={() => store.set({ selection: new Set() })}>Clear</button>
      </div>

      <div className="lib-body">
        <Sidebar />
        <main className="grid-wrap" ref={gridRef} onClick={() => store.set({ selection: new Set() })}>
          {title && <h2 className="view-title">{title}</h2>}
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
              <p className="dim small">JPEG · PNG · WebP · AVIF · HEIC. Everything stays on this PC and saves automatically.</p>
            </div>
          ) : photos.length === 0 ? (
            <div className="empty">
              <p>Nothing here{search ? ` for “${search}”` : ''}.</p>
              <button className="ghost" onClick={() => store.set({ filter: { kind: 'all' }, search: '' })}>
                Show all photos
              </button>
            </div>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))` }}>
              {rows.map((r) =>
                'head' in r ? (
                  <div key={`h${r.head}`} className="day-head">
                    {new Date(`${r.head}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })}
                    <span className="count">{r.count}</span>
                  </div>
                ) : (
                  <div key={r.id} data-tile={r.id} className="tile-cell" style={{ height: thumbSize }}>
                    <Tile photo={r} selected={selection.has(r.id)} edited={isEdited(edits[r.id])} presetCode={presetInfo(edits[r.id]?.preset ?? null)?.code ?? null} labels={labels} />
                  </div>
                ),
              )}
            </div>
          )}
        </main>
        {showInfo && (
          <aside className="info-col">
            <InfoPanel ids={selIds} />
          </aside>
        )}
      </div>

      <footer className="statusbar">
        <span>
          {photos.length} of {total} photos
          {selIds.length ? ` · ${selIds.length} selected` : ''}
          {` · ${store.get().photos.filter(isPosted).length} posted`}
        </span>
        <span className="dim">Double-click to edit · drag a photo out to post it · I for info · Ctrl+F to search</span>
      </footer>
    </div>
  );
}

function toggleInfo() {
  const v = !store.get().showInfo;
  store.set({ showInfo: v });
  try {
    localStorage.setItem('gs.showInfo', v ? '1' : '0');
  } catch {
    /* ignore */
  }
}
