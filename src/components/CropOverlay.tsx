import { useRef } from 'react';
import { clamp } from '../lib/geometry';
import type { Crop } from '../lib/types';

const MIN = 0.04;
type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

/** ratio: locked normalized aspect (cropW/cropH in 0..1 units), or null for free. */
function drag(start: Crop, h: Handle, dx: number, dy: number, ratio: number | null): Crop | null {
  if (h === 'move') {
    return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  }
  let l = start.x;
  let t = start.y;
  let r = start.x + start.w;
  let b = start.y + start.h;
  if (h.includes('w')) l = clamp(l + dx, 0, r - MIN);
  if (h.includes('e')) r = clamp(r + dx, l + MIN, 1);
  if (h.includes('n')) t = clamp(t + dy, 0, b - MIN);
  if (h.includes('s')) b = clamp(b + dy, t + MIN, 1);
  if (ratio) {
    let nw = r - l;
    let nh = b - t;
    if (h === 'n' || h === 's') nw = nh * ratio;
    else if (h === 'e' || h === 'w') nh = nw / ratio;
    else if (nw / nh > ratio) nw = nh * ratio;
    else nh = nw / ratio;
    if (h.includes('w')) l = r - nw;
    else if (h.includes('e')) r = l + nw;
    else {
      const cx = (l + r) / 2;
      l = cx - nw / 2;
      r = cx + nw / 2;
    }
    if (h.includes('n')) t = b - nh;
    else if (h.includes('s')) b = t + nh;
    else {
      const cy = (t + b) / 2;
      t = cy - nh / 2;
      b = cy + nh / 2;
    }
    if (l < -1e-6 || t < -1e-6 || r > 1 + 1e-6 || b > 1 + 1e-6) return null;
  }
  return { x: l, y: t, w: r - l, h: b - t };
}

interface Props {
  crop: Crop;
  ratio: number | null;
  onBegin: () => void;
  onChange: (c: Crop) => void;
}

export function CropOverlay({ crop, ratio, onBegin, onChange }: Props) {
  const box = useRef<HTMLDivElement>(null);

  const down = (h: Handle) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = box.current!.getBoundingClientRect();
    const start = { ...crop };
    const sx = e.clientX;
    const sy = e.clientY;
    onBegin();
    const move = (ev: PointerEvent) => {
      const next = drag(start, h, (ev.clientX - sx) / el.width, (ev.clientY - sy) / el.height, ratio);
      if (next) onChange(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const style = { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` };
  const handles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  return (
    <div className="crop-overlay" ref={box}>
      <div className="crop-rect" style={style} onPointerDown={down('move')}>
        <div className="thirds" />
        {handles.map((h) => (
          <div key={h} className={`handle h-${h}`} onPointerDown={down(h)} />
        ))}
      </div>
    </div>
  );
}
