import { useRef } from 'react';
import { clamp } from '../lib/geometry';
import { segmentsOf } from '../lib/video';
import { fmtTime, type EditState } from '../lib/types';

interface Props {
  dur: number;
  time: number;
  edit: EditState;
  onSeek: (t: number) => void;
  onBegin: () => void;
  onChange: (patch: Partial<EditState>) => void;
}

/** Trim handles, split markers and a scrubbable playhead. */
export function VideoTimeline({ dur, time, edit, onSeek, onBegin, onChange }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const inT = clamp(edit.trimIn, 0, dur);
  const outT = edit.trimOut > 0.001 ? clamp(edit.trimOut, 0, dur) : dur;
  const pct = (t: number) => `${dur ? (t / dur) * 100 : 0}%`;

  const timeAt = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * dur, 0, dur);
  };

  const drag = (onMove: (t: number) => void, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onBegin();
    const move = (ev: PointerEvent) => onMove(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    onMove(timeAt(e.clientX));
  };

  const segs = segmentsOf(edit, dur);

  return (
    <div className="timeline">
      <div
        className="tl-bar"
        ref={barRef}
        onPointerDown={(e) => {
          const t = timeAt(e.clientX);
          onSeek(t);
          const move = (ev: PointerEvent) => onSeek(timeAt(ev.clientX));
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      >
        <div className="tl-trimmed" style={{ left: pct(inT), width: pct(outT - inT) }} />
        {segs.slice(1).map((s, i) => (
          <div key={i} className="tl-seg-line" style={{ left: pct(s.start) }} />
        ))}
        {segs.length > 1 &&
          segs.map((s, i) => (
            <span key={`n${i}`} className="tl-seg-num" style={{ left: pct((s.start + s.end) / 2) }}>
              {i + 1}
            </span>
          ))}
        <div className="tl-handle in" style={{ left: pct(inT) }} onPointerDown={(e) => drag((t) => onChange({ trimIn: Math.min(t, outT - 0.1) }), e)} title="Trim start" />
        <div className="tl-handle out" style={{ left: pct(outT) }} onPointerDown={(e) => drag((t) => onChange({ trimOut: Math.max(t, inT + 0.1) }), e)} title="Trim end" />
        <div className="tl-playhead" style={{ left: pct(time) }} />
      </div>
      <div className="tl-marks">
        {edit.splits
          .filter((t) => t > inT && t < outT)
          .map((t) => (
            <button
              key={t}
              className="tl-mark"
              style={{ left: pct(t) }}
              title={`Split at ${fmtTime(t)} — click to remove`}
              onClick={() => onChange({ splits: edit.splits.filter((x) => x !== t) })}
            >
              ×
            </button>
          ))}
      </div>
      <div className="tl-times">
        <span>{fmtTime(inT)}</span>
        <span className="dim">
          {segs.length > 1 ? `${segs.length} clips · ` : ''}
          {fmtTime(outT - inT)} of {fmtTime(dur)}
        </span>
        <span>{fmtTime(outT)}</span>
      </div>
    </div>
  );
}
