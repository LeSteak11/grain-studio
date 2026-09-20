import { useMemo } from 'react';
import { Slider } from './Slider';
import { begin, commit, getEdit, setEdit } from '../lib/history';
import { FONTS, WEIGHTS, fontAvailable } from '../lib/textlayer';
import { DEFAULT_TEXT, type EditState, type TextStyle } from '../lib/types';

const QUICK = ['#ffffff', '#000000', '#ffd65a', '#ff5f8f', '#5ad1ff', '#7bf58b'];
const ANCHORS: { x: number; y: number }[] = [
  { x: 0.18, y: 0.14 },
  { x: 0.5, y: 0.14 },
  { x: 0.82, y: 0.14 },
  { x: 0.18, y: 0.5 },
  { x: 0.5, y: 0.5 },
  { x: 0.82, y: 0.5 },
  { x: 0.18, y: 0.86 },
  { x: 0.5, y: 0.86 },
  { x: 0.82, y: 0.86 },
];

export function TextPanel({ id, edit }: { id: string; edit: EditState }) {
  const t = edit.text;
  const fonts = useMemo(() => FONTS.filter((f) => fontAvailable(f.name)), []);
  const set = (patch: Partial<TextStyle>, history = true) => {
    const e = getEdit(id);
    const next = { ...e, text: { ...e.text, ...patch } };
    if (history) commit(id, next);
    else setEdit(id, next);
  };
  const onBegin = () => begin(id);
  const live = (patch: Partial<TextStyle>) => set(patch, false);

  return (
    <div className="textp">
      <textarea
        className="note text-body"
        rows={2}
        placeholder="Type your caption… (Enter makes a new line)"
        value={t.body}
        onChange={(e) => live({ body: e.target.value })}
        onBlur={() => commit(id, getEdit(id))}
      />

      <div className="row2">
        <select value={fonts.some((f) => f.name === t.font) ? t.font : ''} onChange={(e) => set({ font: e.target.value })} title="Font">
          {!fonts.some((f) => f.name === t.font) && <option value="">{t.font} (missing)</option>}
          {fonts.map((f) => (
            <option key={f.name} value={f.name} style={{ fontFamily: f.name }}>
              {f.label}
            </option>
          ))}
        </select>
        <select value={t.weight} onChange={(e) => set({ weight: +e.target.value })} title="Weight">
          {WEIGHTS.map((w) => (
            <option key={w.v} value={w.v}>
              {w.label}
            </option>
          ))}
        </select>
      </div>

      <div className="row2">
        <div className="seg small-seg">
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a} className={t.align === a ? 'on' : ''} onClick={() => set({ align: a })} title={`Align ${a}`}>
              {a === 'left' ? '⯇' : a === 'center' ? '≡' : '⯈'}
            </button>
          ))}
        </div>
        <button className={`chip toggle ${t.caps ? 'on' : 'off'}`} onClick={() => set({ caps: !t.caps })}>
          ALL CAPS
        </button>
      </div>

      <Slider label="Size" value={t.size} scale={100} defaultValue={DEFAULT_TEXT.size} onBegin={onBegin} onChange={(v) => live({ size: Math.max(0.01, v) })} onReset={() => set({ size: DEFAULT_TEXT.size })} />

      <div className="color-row">
        <span>Color</span>
        <input type="color" value={t.color} onChange={(e) => live({ color: e.target.value })} onBlur={() => commit(id, getEdit(id))} />
        {QUICK.map((c) => (
          <button key={c} className={`swatch${t.color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => set({ color: c })} title={c} />
        ))}
      </div>

      <div className="color-row">
        <span>Stroke</span>
        <input type="color" value={t.stroke} onChange={(e) => live({ stroke: e.target.value })} onBlur={() => commit(id, getEdit(id))} />
        {QUICK.map((c) => (
          <button key={c} className={`swatch${t.stroke === c ? ' on' : ''}`} style={{ background: c }} onClick={() => set({ stroke: c })} title={c} />
        ))}
      </div>

      <Slider
        label="Stroke thickness"
        value={t.strokeW}
        scale={100 / 0.4}
        defaultValue={DEFAULT_TEXT.strokeW}
        onBegin={onBegin}
        onChange={(v) => live({ strokeW: v * 0.4 })}
        onReset={() => set({ strokeW: DEFAULT_TEXT.strokeW })}
      />
      <Slider label="Shadow" value={t.shadow} onBegin={onBegin} onChange={(v) => live({ shadow: v })} onReset={() => set({ shadow: 0 })} />
      <Slider label="Opacity" value={t.opacity} defaultValue={1} onBegin={onBegin} onChange={(v) => live({ opacity: v })} onReset={() => set({ opacity: 1 })} />
      <Slider label="Line spacing" value={(t.lineHeight - 0.8) / 1.2} defaultValue={(DEFAULT_TEXT.lineHeight - 0.8) / 1.2} onBegin={onBegin} onChange={(v) => live({ lineHeight: 0.8 + v * 1.2 })} onReset={() => set({ lineHeight: DEFAULT_TEXT.lineHeight })} />

      <div className="group-head">
        <span>Position</span>
        <span className="dim">drag on the photo</span>
      </div>
      <div className="anchors">
        {ANCHORS.map((a, i) => (
          <button key={i} className={Math.abs(a.x - t.x) < 0.02 && Math.abs(a.y - t.y) < 0.02 ? 'on' : ''} onClick={() => set({ x: a.x, y: a.y })} title="Move here" />
        ))}
      </div>

      <button className="link" onClick={() => set({ body: '' })}>
        Clear text
      </button>
    </div>
  );
}
