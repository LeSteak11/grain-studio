import { useCallback, useEffect, useRef, useState } from 'react';
import { Renderer } from '../gl/renderer';
import { EditPanel } from './EditPanel';
import { PresetPanel } from './PresetPanel';
import { CropOverlay } from './CropOverlay';
import { Slider } from './Slider';
import { SaveState, thumbUrl } from './common';
import { begin, commit, getEdit, redo, setEdit, undo } from '../lib/history';
import { copyEdits, openExport, pasteEdits, step, toggleFav } from '../lib/library';
import { getLut, getLutSync, presetInfo } from '../lib/luts';
import { refreshPreviews, setPreviewPhoto } from '../lib/previews';
import { loadFull, pin, prefetch } from '../lib/sources';
import { store, toast, useStore, visiblePhotos } from '../lib/store';
import { getThumbBitmap } from '../lib/thumbs';
import { ASPECTS, aspectPx, clamp, fitCrop, orientedDims, outputDims } from '../lib/geometry';
import { DEFAULT_EDIT, FULL_CROP, defaultEdit, isEdited, type EditState } from '../lib/types';

type Tab = 'presets' | 'edit';

function readTab(): Tab {
  try {
    return localStorage.getItem('gs.tab') === 'edit' ? 'edit' : 'presets';
  } catch {
    return 'presets';
  }
}

export function Editor() {
  const id = useStore((s) => s.currentId);
  const photo = useStore((s) => s.photos.find((p) => p.id === s.currentId));
  const stored = useStore((s) => (s.currentId ? s.edits[s.currentId] : undefined));
  const list = useStore(visiblePhotos);
  const hasClip = useStore((s) => !!s.clipboard);
  const edit: EditState = stored ?? DEFAULT_EDIT;

  const [tab, setTabState] = useState<Tab>(readTab);
  const [cropMode, setCropMode] = useState(false);
  const [compare, setCompare] = useState(false);
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const rRef = useRef<Renderer | null>(null);
  const viewRef = useRef<{ view: [number, number, number, number]; outW: number; outH: number }>({ view: [0, 0, 1, 1], outW: 1, outH: 1 });
  const live = useRef({ edit, cropMode, compare, zoom, photo });
  live.current = { edit, cropMode, compare, zoom, photo };
  const raf = useRef(0);

  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem('gs.tab', t);
    } catch {
      /* ignore */
    }
  };

  const draw = useCallback(() => {
    const r = rRef.current;
    const stage = stageRef.current;
    const frame = frameRef.current;
    const L = live.current;
    if (!r || !r.hasImage || !stage || !frame || !L.photo) return;
    const e = L.edit;
    const crop = L.cropMode ? FULL_CROP : e.crop;
    const [outW, outH] = outputDims(e, L.photo.w, L.photo.h, crop);
    const pad = L.cropMode ? 56 : 28;
    const bw = Math.max(50, stage.clientWidth - pad * 2);
    const bh = Math.max(50, stage.clientHeight - pad * 2);
    const dpr = window.devicePixelRatio || 1;
    let cssW: number;
    let cssH: number;
    let view: [number, number, number, number] = [0, 0, 1, 1];
    if (L.zoom && !L.cropMode) {
      const vw = Math.min(1, (bw * dpr) / outW);
      const vh = Math.min(1, (bh * dpr) / outH);
      cssW = (vw * outW) / dpr;
      cssH = (vh * outH) / dpr;
      const cx = clamp(L.zoom.x, vw / 2, 1 - vw / 2);
      const cy = clamp(L.zoom.y, vh / 2, 1 - vh / 2);
      view = [cx - vw / 2, cy - vh / 2, vw, vh];
    } else {
      const s = Math.min(bw / outW, bh / outH);
      cssW = outW * s;
      cssH = outH * s;
    }
    viewRef.current = { view, outW, outH };
    frame.style.width = `${Math.round(cssW)}px`;
    frame.style.height = `${Math.round(cssH)}px`;
    r.resize(Math.round(cssW) * dpr, Math.round(cssH) * dpr);
    const lut = getLutSync(e.preset);
    if (e.preset && !lut) void getLut(e.preset).then((l) => l && schedule());
    r.render(e, lut, { crop, view, original: L.compare });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedule = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      draw();
    });
  }, [draw]);

  // GL context for the lifetime of the editor view.
  useEffect(() => {
    let r: Renderer;
    try {
      r = new Renderer(canvasRef.current!);
    } catch (e) {
      toast(String(e));
      return;
    }
    rRef.current = r;
    const ro = new ResizeObserver(() => schedule());
    ro.observe(stageRef.current!);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      r.dispose();
      r.gl.getExtension('WEBGL_lose_context')?.loseContext();
      rRef.current = null;
      pin(null);
    };
  }, [schedule]);

  // Load the photo: instant thumbnail first, then full resolution.
  useEffect(() => {
    if (!id) return;
    let alive = true;
    pin(id);
    setPreviewPhoto(id);
    setZoom(null);
    setCropMode(false);
    setLoading(true);
    (async () => {
      const r = rRef.current;
      if (!r) return;
      let gotFull = false;
      const full = loadFull(id).then((b) => {
        gotFull = true;
        return b;
      });
      try {
        const t = await getThumbBitmap(id);
        if (alive && !gotFull) {
          r.setImage(t);
          schedule();
        }
      } catch {
        /* thumbnail missing: wait for full */
      }
      try {
        const b = await full;
        if (!alive) return;
        r.setImage(b);
        schedule();
      } catch (e) {
        if (alive) toast(`Couldn't open this photo: ${e}`);
      }
      if (!alive) return;
      setLoading(false);
      const l = visiblePhotos(store.get());
      const i = l.findIndex((p) => p.id === id);
      prefetch([l[i + 1]?.id, l[i - 1]?.id].filter(Boolean) as string[]);
    })();
    stripRef.current?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    return () => {
      alive = false;
    };
  }, [id, schedule]);

  useEffect(() => schedule(), [edit, cropMode, compare, zoom, photo, schedule]);
  useEffect(() => refreshPreviews(), [stored]);

  useEffect(() => {
    if (id && !photo) store.set({ view: 'library' });
  }, [id, photo]);

  // Keyboard shortcuts.
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      const isRange = tgt instanceof HTMLInputElement && tgt.type === 'range';
      if ((tgt instanceof HTMLInputElement && !isRange) || tgt instanceof HTMLTextAreaElement) return;
      const cur = store.get().currentId;
      if (!cur || store.get().modal) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z') e.shiftKey ? redo(cur) : undo(cur);
        else if (k === 'y') redo(cur);
        else if (k === 'c') copyEdits(cur);
        else if (k === 'v') pasteEdits([cur]);
        else if (k === 'e') openExport([cur]);
        else return;
        e.preventDefault();
        return;
      }
      if (e.key === '\\') {
        setCompare(true);
        return;
      }
      if (e.key === 'Escape') {
        if (live.current.cropMode) setCropMode(false);
        else store.set({ view: 'library' });
        return;
      }
      if (isRange) return;
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (k === 'c') setCropMode((v) => !v);
      else if (k === 'z') setZoom((z) => (z ? null : { x: 0.5, y: 0.5 }));
      else if (k === 'f') toggleFav([cur]);
      else if (k === 'p') setTab('presets');
      else if (k === 'e') setTab('edit');
    };
    const ku = (e: KeyboardEvent) => {
      if (e.key === '\\') setCompare(false);
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, []);

  if (!id || !photo) return null;

  const [W, H] = orientedDims(edit.rotate, photo.w, photo.h);
  const ratioPx = aspectPx(edit.aspect, W, H);
  const index = list.findIndex((p) => p.id === id);
  const info = presetInfo(edit.preset);

  const onCanvasDouble = (ev: React.MouseEvent) => {
    if (cropMode) return;
    if (zoom) {
      setZoom(null);
      return;
    }
    const rect = canvasRef.current!.getBoundingClientRect();
    setZoom({ x: (ev.clientX - rect.left) / rect.width, y: (ev.clientY - rect.top) / rect.height });
  };

  const onCanvasDown = (ev: React.PointerEvent) => {
    if (!zoom || cropMode || ev.button !== 0) return;
    const { view, outW, outH } = viewRef.current;
    const start = { x: view[0] + view[2] / 2, y: view[1] + view[3] / 2 };
    const sx = ev.clientX;
    const sy = ev.clientY;
    const dpr = window.devicePixelRatio || 1;
    const move = (e: PointerEvent) => setZoom({ x: start.x - ((e.clientX - sx) * dpr) / outW, y: start.y - ((e.clientY - sy) * dpr) / outH });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const setAspect = (aid: string) => {
    const e = getEdit(id);
    const [w, h] = orientedDims(e.rotate, photo.w, photo.h);
    const r = aspectPx(aid, w, h);
    commit(id, { ...e, aspect: aid, crop: r ? fitCrop(r, w, h) : e.crop });
  };
  const rotate = (d: number) => {
    const e = getEdit(id);
    const rot = (e.rotate + d + 4) % 4;
    const [w, h] = orientedDims(rot, photo.w, photo.h);
    const r = aspectPx(e.aspect, w, h);
    commit(id, { ...e, rotate: rot, crop: r ? fitCrop(r, w, h) : { ...FULL_CROP } });
  };
  const flip = () => {
    const e = getEdit(id);
    const c = e.crop;
    // Source-space flip; when rotated 90/270 add 180° so it reads as a horizontal flip on screen.
    commit(id, { ...e, flip: !e.flip, rotate: e.rotate % 2 ? (e.rotate + 2) % 4 : e.rotate, straighten: -e.straighten, crop: { ...c, x: 1 - c.x - c.w } });
  };

  return (
    <div className="editor">
      <header className="topbar">
        <div className="tb-left">
          <button className="ghost" onClick={() => store.set({ view: 'library' })} title="Back to Studio (Esc)">
            ‹ Studio
          </button>
          <span className="filename" title={photo.name}>
            {photo.name}
          </span>
          <span className="dim">
            {index + 1} / {list.length}
          </span>
          {loading && <span className="dim pulse">loading full res…</span>}
        </div>
        <div className="tb-center">
          <button className="icon" onClick={() => undo(id)} title="Undo (Ctrl+Z)">
            ↶
          </button>
          <button className="icon" onClick={() => redo(id)} title="Redo (Ctrl+Shift+Z)">
            ↷
          </button>
          <button
            className={`icon${compare ? ' on' : ''}`}
            onPointerDown={() => setCompare(true)}
            onPointerUp={() => setCompare(false)}
            onPointerLeave={() => setCompare(false)}
            title="Hold to compare with original (\)"
          >
            ◐
          </button>
          <button className={`icon${zoom ? ' on' : ''}`} onClick={() => setZoom(zoom ? null : { x: 0.5, y: 0.5 })} title="Zoom 100% (Z, or double-click)">
            1:1
          </button>
          <button className={`icon${photo.fav ? ' on' : ''}`} onClick={() => toggleFav([id])} title="Favorite (F)">
            {photo.fav ? '★' : '☆'}
          </button>
        </div>
        <div className="tb-right">
          <SaveState />
          <button className="ghost" onClick={() => copyEdits(id)} title="Copy edits (Ctrl+C)">
            Copy
          </button>
          <button className="ghost" disabled={!hasClip} onClick={() => pasteEdits([id])} title="Paste edits (Ctrl+V)">
            Paste
          </button>
          <button className="ghost" disabled={!isEdited(edit)} onClick={() => commit(id, defaultEdit())} title="Revert to original">
            Revert
          </button>
          <button className="primary" onClick={() => openExport([id])} title="Export (Ctrl+E)">
            Export
          </button>
        </div>
      </header>

      <div className="editor-body">
        <div className="stage-col">
          <div className={`stage${zoom ? ' zoomed' : ''}`} ref={stageRef}>
            <div className="frame" ref={frameRef}>
              <canvas ref={canvasRef} onDoubleClick={onCanvasDouble} onPointerDown={onCanvasDown} />
              {cropMode && (
                <CropOverlay crop={edit.crop} ratio={ratioPx ? ratioPx / (W / H) : null} onBegin={() => begin(id)} onChange={(c) => setEdit(id, { ...getEdit(id), crop: c })} />
              )}
            </div>
            {compare && <div className="badge">Original</div>}
            {!compare && info && !cropMode && <div className="badge">{info.code}</div>}
          </div>
          <div className="filmstrip" ref={stripRef}>
            {list.map((p) => (
              <button key={p.id} data-id={p.id} className={`strip-item${p.id === id ? ' on' : ''}`} onClick={() => store.set({ currentId: p.id, selection: new Set([p.id]), anchor: p.id })}>
                <img src={thumbUrl(p)} loading="lazy" decoding="async" alt="" draggable={false} />
              </button>
            ))}
          </div>
        </div>

        <aside className="side">
          {cropMode ? (
            <div className="crop-panel">
              <div className="group-head">
                <span>Aspect</span>
              </div>
              <div className="aspects">
                {ASPECTS.map((a) => (
                  <button key={a.id} className={edit.aspect === a.id ? 'on' : ''} onClick={() => setAspect(a.id)}>
                    {a.label}
                  </button>
                ))}
              </div>
              <Slider
                label="Straighten"
                value={edit.straighten / 45}
                bi
                scale={45}
                onBegin={() => begin(id)}
                onChange={(v) => setEdit(id, { ...getEdit(id), straighten: v * 45 })}
                onReset={() => commit(id, { ...getEdit(id), straighten: 0 })}
              />
              <div className="btn-row">
                <button onClick={() => rotate(-1)} title="Rotate left">
                  ⟲ Rotate
                </button>
                <button onClick={() => rotate(1)} title="Rotate right">
                  Rotate ⟳
                </button>
                <button onClick={flip}>Flip ⇋</button>
              </div>
              <div className="btn-row">
                <button onClick={() => commit(id, { ...getEdit(id), crop: { ...FULL_CROP }, aspect: 'free', rotate: 0, flip: false, straighten: 0 })}>Reset</button>
                <button className="primary" onClick={() => setCropMode(false)}>
                  Done
                </button>
              </div>
              <p className="hint">Drag the corners or edges; drag inside to move. Esc to finish.</p>
            </div>
          ) : (
            <>
              <div className="tabs">
                <button className={tab === 'presets' ? 'on' : ''} onClick={() => setTab('presets')}>
                  Presets
                </button>
                <button className={tab === 'edit' ? 'on' : ''} onClick={() => setTab('edit')}>
                  Edit
                </button>
              </div>
              <div className="side-scroll">
                {tab === 'presets' ? <PresetPanel id={id} edit={edit} /> : <EditPanel id={id} edit={edit} onCrop={() => setCropMode(true)} />}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
