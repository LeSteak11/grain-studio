import { useCallback, useEffect, useRef, useState } from 'react';
import { Renderer } from '../gl/renderer';
import { EditPanel } from './EditPanel';
import { PresetPanel } from './PresetPanel';
import { CropOverlay } from './CropOverlay';
import { Slider } from './Slider';
import { SaveState, thumbUrl } from './common';
import { begin, commit, getEdit, redo, setEdit, undo } from '../lib/history';
import { copyEdits, openExport, pasteEdits, step, toggleFav } from '../lib/library';
import { PasteMenu } from './Menus';
import { InfoPanel } from './InfoPanel';
import { copyImage, dragOutGesture, renderShareFile } from '../lib/share';
import { drawHistogram } from '../lib/histogram';
import { getLut, getLutSync, presetInfo } from '../lib/luts';
import { refreshPreviews, setPreviewPhoto } from '../lib/previews';
import { loadFull, loadPreview, pin, prefetch } from '../lib/sources';
import { store, toast, useStore, visiblePhotos } from '../lib/store';
import { getThumbBitmap } from '../lib/thumbs';
import { ASPECTS, aspectPx, clamp, fitCrop, orientedDims, outputDims } from '../lib/geometry';
import { DEFAULT_EDIT, FULL_CROP, defaultEdit, fmtTime, isEdited, isVideo, type EditState } from '../lib/types';
import { VideoTimeline } from './VideoTimeline';
import { durationOf, segmentsOf } from '../lib/video';
import { SoundBar } from './SoundBar';
import { trackById } from '../lib/sound';
import { fileUrl } from '../lib/fs';
import { buildTextLayer, layerSize } from '../lib/textlayer';
import { fsx, paths } from '../lib/fs';
import { dropThumbBitmap } from '../lib/thumbs';

type Tab = 'presets' | 'edit' | 'info';

function readTab(): Tab {
  try {
    const v = localStorage.getItem('gs.tab');
    return v === 'edit' || v === 'info' ? v : 'presets';
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
  // null = fit to window. z is a multiplier of the fit scale; cx/cy centre the view in crop space.
  const [zoom, setZoom] = useState<{ z: number; cx: number; cy: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [split, setSplit] = useState<number | null>(null);
  const [showHist, setShowHist] = useState(() => {
    try {
      return localStorage.getItem('gs.hist') === '1';
    } catch {
      return false;
    }
  });
  const vidRef = useRef<HTMLVideoElement>(null);
  /** Second decoder used only for timeline scrubbing, so playback isn't disturbed. */
  const scrubRef = useRef<HTMLVideoElement>(null);
  /** Plays the attached soundtrack in step with the preview. */
  const sndRef = useRef<HTMLAudioElement>(null);
  const scrubJob = useRef<{ t: number; c: HTMLCanvasElement } | null>(null);
  const scrubBusy = useRef(false);
  const [strip, setStrip] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [loopOn, setLoopOn] = useState(true);
  const vfc = useRef(0);
  const lastTimeUi = useRef(0);
  const histRef = useRef<HTMLCanvasElement>(null);
  const histAt = useRef(0);
  const histTimer = useRef(0);
  /** Which resolution tier is on the GPU for the current photo: 0 thumb, 1 preview, 2 full. */
  const tier = useRef<{ id: string | null; level: 0 | 1 | 2; fullLoading: boolean }>({ id: null, level: 0, fullLoading: false });

  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const rRef = useRef<Renderer | null>(null);
  const viewRef = useRef<{ view: [number, number, number, number]; outW: number; outH: number; fit: number; bw: number; bh: number }>({
    view: [0, 0, 1, 1],
    outW: 1,
    outH: 1,
    fit: 1,
    bw: 1,
    bh: 1,
  });
  const isVid = !!photo && isVideo(photo);
  const dur = photo?.dur ?? 0;
  const trimOut = edit.trimOut > 0.001 ? Math.min(edit.trimOut, dur) : dur;
  const live = useRef({ edit, cropMode, compare, zoom, photo, split, showHist, isVid, trimOut, loopOn });
  live.current = { edit, cropMode, compare, zoom, photo, split, showHist, isVid, trimOut, loopOn };
  const raf = useRef(0);
  /** Set while dragging the text, so the drag doesn't also toggle video playback. */
  const dragged = useRef(false);
  const toggleHistRef = useRef<() => void>(() => undefined);
  const toggleZoomRef = useRef<() => void>(() => undefined);
  const togglePlayRef = useRef<() => void>(() => undefined);
  const seekRef = useRef<(d: number) => void>(() => undefined);
  const muteRef = useRef<() => void>(() => undefined);
  const splitRef = useRef<() => void>(() => undefined);
  const zoomByRef = useRef<(f: number) => void>(() => undefined);

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
    const fit = Math.min(bw / outW, bh / outH);
    const z = L.cropMode ? 1 : (L.zoom?.z ?? 1);
    let cssW: number;
    let cssH: number;
    let view: [number, number, number, number] = [0, 0, 1, 1];
    if (z > 1.001) {
      const scale = fit * z;
      const vw = Math.min(1, bw / (outW * scale));
      const vh = Math.min(1, bh / (outH * scale));
      cssW = outW * scale * vw;
      cssH = outH * scale * vh;
      const cx = clamp(L.zoom!.cx, vw / 2, 1 - vw / 2);
      const cy = clamp(L.zoom!.cy, vh / 2, 1 - vh / 2);
      view = [cx - vw / 2, cy - vh / 2, vw, vh];
    } else {
      cssW = outW * fit;
      cssH = outH * fit;
    }
    viewRef.current = { view, outW, outH, fit, bw, bh };
    frame.style.width = `${Math.round(cssW)}px`;
    frame.style.height = `${Math.round(cssH)}px`;
    r.resize(Math.round(cssW) * dpr, Math.round(cssH) * dpr);
    const lut = getLutSync(e.preset);
    if (e.preset && !lut) void getLut(e.preset).then((l) => l && schedule());
    r.render(e, lut, { crop, view, original: L.compare, split: L.cropMode ? null : L.split });

    // Histogram: must read the GL canvas in this same task. Throttled; a trailing update catches the final state.
    if (L.showHist && histRef.current) {
      const now = performance.now();
      clearTimeout(histTimer.current);
      if (now - histAt.current > 90) {
        histAt.current = now;
        drawHistogram(canvasRef.current!, histRef.current);
      } else histTimer.current = window.setTimeout(() => schedule(), 120);
    }

    // Upgrade to full resolution only when the screen shows more detail than the loaded tier holds.
    const t = tier.current;
    if (t.id === L.photo.id && t.level === 1 && !t.fullLoading) {
      const devPerSrc = r.canvas.width / view[2] / outW;
      // Texture and photo.w are both unrotated, so this is the loaded fraction of full resolution.
      const frac = r.srcW / L.photo.w;
      if (devPerSrc > frac * 1.1 && frac < 0.999) {
        t.fullLoading = true;
        const pid = L.photo.id;
        setLoading(true);
        loadFull(pid)
          .then((b) => {
            if (tier.current.id !== pid || !rRef.current) return;
            rRef.current.setImage(b);
            tier.current.level = 2;
            schedule();
          })
          .catch((err) => toast(`Couldn't load full resolution: ${err}`))
          .finally(() => {
            if (tier.current.id === pid) {
              tier.current.fullLoading = false;
              setLoading(false);
            }
          });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Zoom where 1 image pixel = 1 screen pixel. */
  const zoom100 = () => 1 / (viewRef.current.fit * (window.devicePixelRatio || 1));
  const maxZoom = () => Math.max(2, zoom100() * 3);

  /** Zoom by a factor, keeping the point under the cursor (rel 0..1 of the canvas) in place. */
  const zoomBy = useCallback((factor: number, relX = 0.5, relY = 0.5) => {
    const { view, outW, outH, fit, bw, bh } = viewRef.current;
    const cur = live.current.zoom?.z ?? 1;
    const next = clamp(cur * factor, 1, maxZoom());
    if (next <= 1.001) {
      setZoom(null);
      return;
    }
    const qx = view[0] + relX * view[2];
    const qy = view[1] + relY * view[3];
    const vw = Math.min(1, bw / (outW * fit * next));
    const vh = Math.min(1, bh / (outH * fit * next));
    setZoom({ z: next, cx: qx - (relX - 0.5) * vw, cy: qy - (relY - 0.5) * vh });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedule = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      draw();
    });
  }, [draw]);

  // Scroll wheel zooms the photo (a native listener, so the page never scrolls instead).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      if (live.current.cropMode) return;
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const r = canvas.getBoundingClientRect();
      const relX = (e.clientX - r.left) / r.width;
      const relY = (e.clientY - r.top) / r.height;
      const inside = relX >= 0 && relX <= 1 && relY >= 0 && relY <= 1;
      const step = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 400 : 1;
      zoomBy(Math.exp((-e.deltaY * step) / 420), inside ? relX : 0.5, inside ? relY : 0.5);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

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

  // Load the photo: instant thumbnail, then the ~2560px preview. Full res loads on demand in draw().
  useEffect(() => {
    if (!id) return;
    let alive = true;
    pin(id);
    setPreviewPhoto(id);
    setZoom(null);
    setCropMode(false);
    setLoading(false);
    tier.current = { id, level: 0, fullLoading: false };
    if (store.get().photos.find((p) => p.id === id)?.kind === 'video') return;
    (async () => {
      const r = rRef.current;
      if (!r) return;
      let gotPreview = false;
      const pv = loadPreview(id).then((b) => {
        gotPreview = true;
        return b;
      });
      try {
        const t = await getThumbBitmap(id);
        if (alive && !gotPreview && tier.current.level === 0) {
          r.setImage(t);
          schedule();
        }
      } catch {
        /* thumbnail missing: wait for preview */
      }
      try {
        const b = await pv;
        if (!alive || tier.current.level === 2) return;
        r.setImage(b);
        const p = store.get().photos.find((x) => x.id === id);
        tier.current.level = p && b.width >= p.w ? 2 : 1;
        schedule();
      } catch (e) {
        if (alive) toast(`Couldn't open this photo: ${e}`);
      }
      if (!alive) return;
      const l = visiblePhotos(store.get());
      const i = l.findIndex((p) => p.id === id);
      prefetch([l[i + 1]?.id, l[i - 1]?.id].filter(Boolean) as string[]);
    })();
    stripRef.current?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    return () => {
      alive = false;
    };
  }, [id, schedule]);

  // Video: load the file as a blob URL (same-origin, so WebGL can read its frames).
  useEffect(() => {
    if (!id || !isVid) return;
    let alive = true;
    let url = '';
    setPlaying(false);
    setTime(0);
    setLoading(true);
    const v = vidRef.current;
    if (!v) return;
    (async () => {
      try {
        const bytes = await fsx.readBytes(store.get().photos.find((p) => p.id === id)!.file);
        if (!alive) return;
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'video/mp4' }));
        v.src = url;
        if (scrubRef.current) scrubRef.current.src = url;
        v.currentTime = store.get().edits[id]?.trimIn ?? 0;
      } catch (e) {
        if (alive) toast(`Couldn't open this clip: ${e}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      v.pause();
      v.removeAttribute('src');
      v.load();
      const sv = scrubRef.current;
      if (sv) {
        sv.removeAttribute('src');
        sv.load();
      }
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, isVid]);

  // Filmstrip behind the timeline: a dozen frames grabbed once per clip.
  useEffect(() => {
    if (!id || !isVid) return;
    let alive = true;
    setStrip([]);
    const v = scrubRef.current;
    if (!v) return;
    const seek = (t: number) =>
      new Promise<void>((res) => {
        const done = () => {
          v.removeEventListener('seeked', done);
          res();
        };
        v.addEventListener('seeked', done);
        v.currentTime = t;
      });
    const build = async () => {
      const total = store.get().photos.find((p) => p.id === id)?.dur ?? 0;
      if (!total || !v.videoWidth) return;
      const n = 12;
      const out: string[] = [];
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 90;
      const ctx = c.getContext('2d')!;
      for (let i = 0; i < n && alive; i++) {
        await seek(((i + 0.5) / n) * total);
        if (!alive) return;
        const s = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
        const w = c.width / s;
        const h = c.height / s;
        ctx.drawImage(v, (v.videoWidth - w) / 2, (v.videoHeight - h) / 2, w, h, 0, 0, c.width, c.height);
        out.push(c.toDataURL('image/jpeg', 0.5));
        if (alive) setStrip([...out]);
      }
    };
    const onReady = () => void build();
    if (v.readyState >= 2) onReady();
    else v.addEventListener('loadeddata', onReady, { once: true });
    return () => {
      alive = false;
      v.removeEventListener('loadeddata', onReady);
    };
  }, [id, isVid]);

  /** Draw the frame at `t` into the timeline's hover bubble (one seek at a time). */
  const drawPreview = useCallback((t: number, c: HTMLCanvasElement) => {
    scrubJob.current = { t, c };
    const pump = () => {
      const v = scrubRef.current;
      const job = scrubJob.current;
      if (!v || !job || scrubBusy.current || !v.videoWidth) return;
      scrubBusy.current = true;
      scrubJob.current = null;
      const done = () => {
        v.removeEventListener('seeked', done);
        const ctx = job.c.getContext('2d');
        if (ctx) {
          const s = Math.max(job.c.width / v.videoWidth, job.c.height / v.videoHeight);
          const w = job.c.width / s;
          const h = job.c.height / s;
          ctx.drawImage(v, (v.videoWidth - w) / 2, (v.videoHeight - h) / 2, w, h, 0, 0, job.c.width, job.c.height);
        }
        scrubBusy.current = false;
        pump();
      };
      v.addEventListener('seeked', done);
      v.currentTime = job.t;
    };
    pump();
  }, []);

  /** Push the current video frame to the GPU and redraw. */
  const showFrame = useCallback(() => {
    const v = vidRef.current;
    const r = rRef.current;
    if (!v || !r || !v.videoWidth) return;
    r.updateFrame(v);
    draw();
  }, [draw]);

  // Frame loop while playing, with trim bounds and looping.
  useEffect(() => {
    const v = vidRef.current;
    if (!v || !isVid) return;
    const tick = () => {
      const L = live.current;
      showFrame();
      const now = performance.now();
      if (now - lastTimeUi.current > 60) {
        lastTimeUi.current = now;
        setTime(v.currentTime);
      }
      if (v.currentTime >= L.trimOut - 0.02) {
        if (L.loopOn) v.currentTime = L.edit.trimIn;
        else {
          v.pause();
          setTime(v.currentTime);
        }
      }
      vfc.current = v.requestVideoFrameCallback(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      vfc.current = v.requestVideoFrameCallback(tick);
    };
    const onPause = () => {
      setPlaying(false);
      if (vfc.current) v.cancelVideoFrameCallback(vfc.current);
      vfc.current = 0;
    };
    const onSeeked = () => {
      showFrame();
      setTime(v.currentTime);
    };
    const onMeta = () => {
      showFrame();
      setTime(v.currentTime);
    };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('loadeddata', onMeta);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('loadeddata', onMeta);
      if (vfc.current) v.cancelVideoFrameCallback(vfc.current);
      vfc.current = 0;
    };
  }, [isVid, showFrame]);

  // Volume/mute follow the clip's settings; a soundtrack ducks the clip's own audio.
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return;
    v.muted = edit.mute;
    v.volume = Math.min(1, Math.max(0, edit.volume * (edit.sound ? edit.soundDuck : 1)));
  }, [edit.mute, edit.volume, edit.sound, edit.soundDuck]);

  // Load the soundtrack file whenever the chosen track changes.
  useEffect(() => {
    const a = sndRef.current;
    if (!a) return;
    const t = trackById(edit.sound);
    const src = t ? fileUrl(t.file) : '';
    if (a.src !== src) {
      a.pause();
      if (src) a.src = src;
      else a.removeAttribute('src');
    }
    a.loop = true;
  }, [edit.sound]);

  useEffect(() => {
    const a = sndRef.current;
    if (a) a.volume = Math.min(1, Math.max(0, edit.soundVolume));
  }, [edit.soundVolume]);

  // Keep the soundtrack in step with the preview. Fades are applied on export, not here.
  useEffect(() => {
    const v = vidRef.current;
    const a = sndRef.current;
    if (!v || !a || !isVid) return;
    const sync = () => {
      const L = live.current;
      if (!L.edit.sound || !a.duration) return;
      // Where we are in the finished clip maps straight onto the track.
      const into = Math.max(0, v.currentTime - L.edit.trimIn);
      const want = (L.edit.soundStart + into) % Math.max(0.05, a.duration);
      if (Math.abs(a.currentTime - want) > 0.12) a.currentTime = want;
    };
    const onPlay = () => {
      if (!live.current.edit.sound) return;
      sync();
      void a.play().catch(() => undefined);
    };
    const onPause = () => a.pause();
    const onSeeked = () => {
      sync();
      if (v.paused) a.pause();
    };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onSeeked);
      a.pause();
    };
  }, [isVid]);

  // Taking the soundtrack off (or swapping it) should stop whatever is still playing.
  useEffect(() => {
    const a = sndRef.current;
    if (a && !edit.sound) a.pause();
  }, [edit.sound]);

  // Build the text overlay whenever the text or the frame shape changes.
  useEffect(() => {
    if (!photo) return;
    let alive = true;
    const timer = window.setTimeout(async () => {
      const [ow, oh] = outputDims(edit, photo.w, photo.h);
      const [lw, lh] = layerSize(ow, oh);
      const bmp = await buildTextLayer(edit.text, lw, lh).catch(() => null);
      if (!alive || !rRef.current) {
        bmp?.close();
        return;
      }
      rRef.current.setTextLayer(bmp);
      schedule();
    }, 90);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [edit.text, edit.crop, edit.rotate, edit.straighten, photo, schedule]);

  useEffect(() => schedule(), [edit, cropMode, compare, zoom, photo, split, showHist, schedule]);
  useEffect(() => refreshPreviews(), [stored]);

  // Keep a drag-out file warm for the current photo so dragging starts instantly.
  useEffect(() => {
    if (!id) return;
    const t = window.setTimeout(() => void renderShareFile(id).catch(() => undefined), 900);
    return () => clearTimeout(t);
  }, [id, stored]);

  const toggleHist = () =>
    setShowHist((v) => {
      try {
        localStorage.setItem('gs.hist', v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });

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
        else if (k === 'c' && e.shiftKey) void copyImage(cur);
        else if (k === 'c') copyEdits(cur);
        else if (k === 'v' && e.shiftKey) pasteEdits([cur], 'preset');
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
      else if (k === 'z') toggleZoomRef.current();
      else if (e.key === '+' || e.key === '=') zoomByRef.current(1.25);
      else if (e.key === '-' || e.key === '_') zoomByRef.current(1 / 1.25);
      else if (e.key === '0') setZoom(null);
      else if (k === 'f') toggleFav([cur]);
      else if (k === 'p') setTab('presets');
      else if (k === 'i') setTab('info');
      else if (e.key === ' ' && live.current.isVid) {
        e.preventDefault();
        togglePlayRef.current();
      } else if (k === 'm' && live.current.isVid) muteRef.current();
      else if (k === 'j' && live.current.isVid) seekRef.current(-1);
      else if (k === 'l' && live.current.isVid) seekRef.current(1);
      else if (k === 'x' && live.current.isVid) splitRef.current();
      else if (k === 's') setSplit((v) => (v === null ? 0.5 : null));
      else if (k === 'h') toggleHistRef.current();
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

  const seekTo = (t: number) => {
    const v = vidRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(t, dur));
  };
  const togglePlay = () => {
    const v = vidRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime >= trimOut - 0.02 || v.currentTime < edit.trimIn) v.currentTime = edit.trimIn;
      void v.play().catch(() => undefined);
    } else v.pause();
  };
  const splitHere = () => {
    if (!id) return;
    const t = vidRef.current?.currentTime ?? 0;
    if (t <= edit.trimIn + 0.05 || t >= trimOut - 0.05) {
      toast('Move the playhead into the clip first');
      return;
    }
    if (edit.splits.some((x) => Math.abs(x - t) < 0.05)) return;
    commit(id, { ...getEdit(id), splits: [...getEdit(id).splits, t].sort((a, b) => a - b) });
  };
  const setCover = async () => {
    const r = rRef.current;
    const p = photo;
    if (!r || !p || !id) return;
    try {
      const c = document.createElement('canvas');
      const k = Math.min(1, 720 / Math.max(r.canvas.width, r.canvas.height));
      c.width = Math.max(1, Math.round(r.canvas.width * k));
      c.height = Math.max(1, Math.round(r.canvas.height * k));
      c.getContext('2d')!.drawImage(r.canvas as HTMLCanvasElement, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.88));
      if (!blob) throw new Error('could not read the frame');
      await fsx.writeBytes(paths.thumb(id), new Uint8Array(await blob.arrayBuffer()));
      await fsx.remove([paths.editedThumb(id)]);
      dropThumbBitmap(id);
      store.set((s) => ({ photos: s.photos.map((x) => (x.id === id ? { ...x, rev: 0 } : x)) }));
      toast('Cover frame updated');
    } catch (e) {
      toast(`Couldn't set the cover: ${e}`);
    }
  };

  toggleHistRef.current = toggleHist;
  togglePlayRef.current = togglePlay;
  seekRef.current = (d: number) => seekTo((vidRef.current?.currentTime ?? 0) + d);
  muteRef.current = () => id && commit(id, { ...getEdit(id), mute: !getEdit(id).mute });
  splitRef.current = splitHere;
  toggleZoomRef.current = () => (live.current.zoom ? setZoom(null) : zoomBy(zoom100()));
  zoomByRef.current = (f: number) => zoomBy(f);

  if (!id || !photo) return null;

  const onSplitDown = (ev: React.PointerEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const rect = frameRef.current!.getBoundingClientRect();
    const move = (e: PointerEvent) => setSplit(clamp((e.clientX - rect.left) / rect.width, 0.02, 0.98));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

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
    const relX = (ev.clientX - rect.left) / rect.width;
    const relY = (ev.clientY - rect.top) / rect.height;
    zoomBy(zoom100(), relX, relY);
  };

  const onCanvasDown = (ev: React.PointerEvent) => {
    if (cropMode || ev.button !== 0) return;
    // With text on the frame (and not zoomed), dragging moves the text.
    if (!zoom && edit.text.body.trim() && id) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const relOf = (e: { clientX: number; clientY: number }) => ({
        x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
        y: clamp((e.clientY - rect.top) / rect.height, 0, 1),
      });
      const start = relOf(ev);
      const from = { x: edit.text.x, y: edit.text.y };
      let moved = false;
      begin(id);
      const move = (e: PointerEvent) => {
        const r2 = relOf(e);
        if (!moved && Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) < 3) return;
        moved = true;
        dragged.current = true;
        const e0 = getEdit(id);
        setEdit(id, { ...e0, text: { ...e0.text, x: clamp(from.x + (r2.x - start.x), 0, 1), y: clamp(from.y + (r2.y - start.y), 0, 1) } });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (moved) setTimeout(() => (dragged.current = false), 0);
        else dragged.current = false;
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    if (!zoom) return;
    const { view, outW, outH, fit } = viewRef.current;
    const start = { x: view[0] + view[2] / 2, y: view[1] + view[3] / 2 };
    const sx = ev.clientX;
    const sy = ev.clientY;
    const z = zoom.z;
    const move = (e: PointerEvent) =>
      setZoom({ z, cx: start.x - (e.clientX - sx) / (outW * fit * z), cy: start.y - (e.clientY - sy) / (outH * fit * z) });
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
          {isVid && segmentsOf(edit, dur).length > 1 && <span className="dim">· {segmentsOf(edit, dur).length} clips</span>}
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
          <button className={`icon${split !== null ? ' on' : ''}`} onClick={() => setSplit(split === null ? 0.5 : null)} title="Split before/after (S)">
            ◧
          </button>
          <div className="zoombar" title="Zoom — scroll the photo, or drag this slider">
            <button className="icon" onClick={() => setZoom(null)} disabled={!zoom} title="Fit to window (0)">
              Fit
            </button>
            <input
              type="range"
              className="plain zoom-range"
              min={0}
              max={1}
              step={0.001}
              value={Math.log(zoom?.z ?? 1) / Math.log(maxZoom())}
              onChange={(e) => {
                const z = Math.pow(maxZoom(), +e.target.value);
                if (z <= 1.001) setZoom(null);
                else setZoom({ z, cx: zoom?.cx ?? 0.5, cy: zoom?.cy ?? 0.5 });
              }}
            />
            <button className="zoom-pct" onClick={() => zoomBy(zoom100() / (zoom?.z ?? 1))} title="Zoom to 100% (Z)">
              {Math.round((zoom?.z ?? 1) * viewRef.current.fit * (window.devicePixelRatio || 1) * 100)}%
            </button>
          </div>
          <button className={`icon${showHist ? ' on' : ''}`} onClick={toggleHist} title="Histogram (H)">
            ▁▃▆
          </button>
          <button className={`icon${photo.fav ? ' on' : ''}`} onClick={() => toggleFav([id])} title="Favorite (F)">
            {photo.fav ? '★' : '☆'}
          </button>
        </div>
        <div className="tb-right">
          <SaveState />
          <button className="ghost" onClick={() => copyEdits(id)} title="Copy edits (Ctrl+C)">
            Copy edits
          </button>
          <PasteMenu ids={() => [id]} className="ghost-pop" />
          <button className="ghost" onClick={() => void copyImage(id)} title="Copy the edited image to paste anywhere (Ctrl+Shift+C)">
            Copy image
          </button>
          <button className="drag-out" onPointerDown={(e) => dragOutGesture(e, () => [id])} title="Drag the edited photo into Discord, Instagram, a folder…">
            ⠿ Drag out
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
              <video ref={vidRef} className="hidden-video" muted={edit.mute} playsInline preload="auto" />
              <video ref={scrubRef} className="hidden-video" muted playsInline preload="auto" />
              <audio ref={sndRef} className="hidden-video" preload="auto" />
              <canvas ref={canvasRef} onDoubleClick={isVid ? undefined : onCanvasDouble} onClick={isVid && !cropMode ? () => !dragged.current && togglePlay() : undefined} onPointerDown={onCanvasDown} />
              {split !== null && !cropMode && (
                <div className="split-line" style={{ left: `${split * 100}%` }} onPointerDown={onSplitDown}>
                  <span className="split-knob">⇔</span>
                  <span className="split-label l">Before</span>
                  <span className="split-label r">After</span>
                </div>
              )}
              {cropMode && (
                <CropOverlay crop={edit.crop} ratio={ratioPx ? ratioPx / (W / H) : null} onBegin={() => begin(id)} onChange={(c) => setEdit(id, { ...getEdit(id), crop: c })} />
              )}
            </div>
            {compare && <div className="badge">Original</div>}
            {showHist && <canvas ref={histRef} className="histogram" width={240} height={110} />}
            {!compare && info && !cropMode && <div className="badge">{info.code}</div>}
          </div>
          {isVid && !cropMode && (
            <div className="video-bar">
              <div className="transport">
                <button className="icon play" onClick={togglePlay} title="Play / pause (Space)">
                  {playing ? '❚❚' : '▶'}
                </button>
                <span className="tl-clock">
                  {fmtTime(time)} <span className="dim">/ {fmtTime(dur)}</span>
                </span>
                <button className={`icon${loopOn ? ' on' : ''}`} onClick={() => setLoopOn(!loopOn)} title="Loop the trimmed range">
                  ↻
                </button>
                <button className={`icon${edit.mute ? ' on' : ''}`} onClick={() => commit(id, { ...getEdit(id), mute: !edit.mute })} title="Mute (M)">
                  {edit.mute ? '🔇' : '🔊'}
                </button>
                <input
                  type="range"
                  className="plain vol"
                  min={0}
                  max={1}
                  step={0.01}
                  value={edit.volume}
                  onPointerDown={() => begin(id)}
                  onChange={(e) => setEdit(id, { ...getEdit(id), volume: +e.target.value })}
                  title="Volume"
                  disabled={edit.mute || !photo.audio}
                />
                <span className="spacer" />
                <button className="ghost" onClick={() => commit(id, { ...getEdit(id), trimIn: Math.min(time, trimOut - 0.1) })} title="Trim the start to the playhead">
                  Set start
                </button>
                <button className="ghost" onClick={() => commit(id, { ...getEdit(id), trimOut: Math.max(time, edit.trimIn + 0.1) })} title="Trim the end to the playhead">
                  Set end
                </button>
                <button className="ghost" onClick={splitHere} title="Split here (X)">
                  ✂ Split
                </button>
                <button
                  className={`ghost${edit.sound ? ' on' : ''}`}
                  onClick={() => store.set({ modal: 'sounds', soundFor: id })}
                  title="Lay a song or sound effect over this clip"
                >
                  ♪ Sound
                </button>
                <button className="ghost" onClick={() => void setCover()} title="Use this frame as the library thumbnail">
                  Set cover
                </button>
                <button
                  className="ghost"
                  disabled={!isEdited(edit)}
                  onClick={() => commit(id, { ...getEdit(id), trimIn: 0, trimOut: 0, splits: [] })}
                  title="Undo trim and splits"
                >
                  Reset clip
                </button>
              </div>
              <VideoTimeline
                dur={dur}
                time={time}
                edit={edit}
                onSeek={(t) => {
                  seekTo(t);
                  setTime(t);
                }}
                onBegin={() => begin(id)}
                onChange={(patch) => {
                  setEdit(id, { ...getEdit(id), ...patch });
                  // Jump the big preview to whichever handle is moving.
                  const t = patch.trimIn ?? patch.trimOut;
                  if (t !== undefined) {
                    seekTo(t);
                    setTime(t);
                  }
                }}
                strip={strip}
                onPreview={drawPreview}
                joins={photo.remix?.joins}
              />
              <SoundBar id={id} edit={edit} outDur={durationOf(photo, edit)} />
            </div>
          )}
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
                <button className={tab === 'info' ? 'on' : ''} onClick={() => setTab('info')}>
                  Info
                </button>
              </div>
              <div className="side-scroll">
                {tab === 'presets' ? (
                  <PresetPanel id={id} edit={edit} />
                ) : tab === 'info' ? (
                  <InfoPanel ids={[id]} embedded />
                ) : (
                  <EditPanel id={id} edit={edit} onCrop={() => setCropMode(true)} />
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
