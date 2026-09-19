import { useRef, useState } from 'react';
import { spline } from '../lib/looks';
import { begin, commit, getEdit, setEdit } from '../lib/history';
import { IDENTITY_CURVE, type Curves, type EditState, type Pt } from '../lib/types';

type Ch = keyof Curves;
const CHANNELS: { id: Ch; label: string; color: string }[] = [
  { id: 'rgb', label: 'RGB', color: '#ededea' },
  { id: 'r', label: 'R', color: '#ef5b5b' },
  { id: 'g', label: 'G', color: '#4cc46a' },
  { id: 'b', label: 'B', color: '#5b8cf0' },
];
const S = 260;
const PAD = 8;
const MIN_GAP = 0.03;

export function CurveEditor({ id, edit }: { id: string; edit: EditState }) {
  const [ch, setCh] = useState<Ch>('rgb');
  const svg = useRef<SVGSVGElement>(null);
  const pts = edit.curve[ch];
  const color = CHANNELS.find((c) => c.id === ch)!.color;

  const toXY = (p: Pt) => [PAD + p[0] * (S - 2 * PAD), PAD + (1 - p[1]) * (S - 2 * PAD)];
  const fromEvent = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * S;
    const y = ((e.clientY - r.top) / r.height) * S;
    return [Math.min(1, Math.max(0, (x - PAD) / (S - 2 * PAD))), Math.min(1, Math.max(0, 1 - (y - PAD) / (S - 2 * PAD)))];
  };
  const write = (next: Pt[]) => {
    const e = getEdit(id);
    setEdit(id, { ...e, curve: { ...e.curve, [ch]: next } });
  };

  const onDown = (ev: React.PointerEvent) => {
    ev.preventDefault();
    const p = fromEvent(ev);
    let list = [...getEdit(id).curve[ch]] as Pt[];
    const rect = svg.current!.getBoundingClientRect();
    const hitR = (12 / rect.width) * 1;
    let idx = list.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < hitR * 1.4);
    begin(id);
    if (idx < 0) {
      // Add a point on the curve at this x.
      if (list.some((q) => Math.abs(q[0] - p[0]) < MIN_GAP)) return;
      list = [...list, [p[0], p[1]] as Pt].sort((a, b) => a[0] - b[0]);
      idx = list.findIndex((q) => q[0] === p[0]);
      write(list);
    }
    const i = idx;
    const move = (e: PointerEvent) => {
      const q = fromEvent(e);
      const cur = [...getEdit(id).curve[ch]] as Pt[];
      const lo = i === 0 ? 0 : cur[i - 1][0] + MIN_GAP;
      const hi = i === cur.length - 1 ? 1 : cur[i + 1][0] - MIN_GAP;
      // Endpoints keep their x; interior points stay between neighbours.
      const x = i === 0 || i === cur.length - 1 ? cur[i][0] : Math.min(hi, Math.max(lo, q[0]));
      cur[i] = [x, q[1]];
      write(cur);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const removeAt = (i: number) => {
    const cur = getEdit(id).curve[ch];
    if (i === 0 || i === cur.length - 1) return;
    const e = getEdit(id);
    commit(id, { ...e, curve: { ...e.curve, [ch]: cur.filter((_, k) => k !== i) } });
  };

  const f = spline(pts);
  let d = '';
  for (let i = 0; i <= 64; i++) {
    const x = i / 64;
    const [px, py] = toXY([x, Math.min(1, Math.max(0, f(x)))]);
    d += `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
  }

  return (
    <div className="curve">
      <div className="curve-tabs">
        {CHANNELS.map((c) => {
          const touched = edit.curve[c.id].some(([x, y]) => Math.abs(x - y) > 1e-4);
          return (
            <button key={c.id} className={`${ch === c.id ? 'on' : ''}${touched ? ' touched' : ''}`} style={{ color: c.color }} onClick={() => setCh(c.id)}>
              {c.label}
            </button>
          );
        })}
        <span className="spacer" />
        <button
          className="link"
          onClick={() => {
            const e = getEdit(id);
            commit(id, { ...e, curve: { ...e.curve, [ch]: IDENTITY_CURVE } });
          }}
        >
          Reset
        </button>
      </div>
      <svg ref={svg} viewBox={`0 0 ${S} ${S}`} className="curve-svg" onPointerDown={onDown}>
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="#2a2a2a">
            <line x1={PAD + g * (S - 2 * PAD)} y1={PAD} x2={PAD + g * (S - 2 * PAD)} y2={S - PAD} />
            <line x1={PAD} y1={PAD + g * (S - 2 * PAD)} x2={S - PAD} y2={PAD + g * (S - 2 * PAD)} />
          </g>
        ))}
        <rect x={PAD} y={PAD} width={S - 2 * PAD} height={S - 2 * PAD} fill="none" stroke="#333" />
        <line x1={PAD} y1={S - PAD} x2={S - PAD} y2={PAD} stroke="#333" strokeDasharray="3 4" />
        <path d={d} fill="none" stroke={color} strokeWidth={2} />
        {pts.map((p, i) => {
          const [x, y] = toXY(p);
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={5.5}
              fill="#111"
              stroke={color}
              strokeWidth={2}
              onDoubleClick={(e) => {
                e.stopPropagation();
                removeAt(i);
              }}
            />
          );
        })}
      </svg>
      <p className="hint">Click to add a point, drag to shape, double-click a point to remove it.</p>
    </div>
  );
}
