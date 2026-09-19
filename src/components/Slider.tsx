import { memo, type CSSProperties } from 'react';

interface Props {
  label: string;
  value: number;
  bi?: boolean;
  /** Display multiplier (VSCO-style ±6 / 0–12 readout). */
  scale?: number;
  defaultValue?: number;
  onBegin: () => void;
  onChange: (v: number) => void;
  onReset: () => void;
}

export const Slider = memo(function Slider({ label, value, bi, scale, defaultValue = 0, onBegin, onChange, onReset }: Props) {
  const min = bi ? -1 : 0;
  const k = scale ?? (bi ? 6 : 12);
  const shown = value * k;
  const text = `${bi && shown > 0.049 ? '+' : ''}${shown.toFixed(1)}`;
  const pct = ((value - min) / (1 - min)) * 100;
  const origin = bi ? 50 : 0;
  const style = { '--a': `${Math.min(pct, origin)}%`, '--b': `${Math.max(pct, origin)}%` } as CSSProperties;
  const changed = Math.abs(value - defaultValue) > 1e-4;
  return (
    <div className={`slider${changed ? ' changed' : ''}`}>
      <div className="slider-head" onDoubleClick={onReset} title="Double-click to reset">
        <span>{label}</span>
        <span className="val">{text}</span>
      </div>
      <input
        type="range"
        min={min}
        max={1}
        step={0.001}
        value={value}
        style={style}
        onPointerDown={onBegin}
        onKeyDown={(e) => {
          if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) onBegin();
        }}
        onDoubleClick={onReset}
        onChange={(e) => onChange(+e.target.value)}
      />
    </div>
  );
});
