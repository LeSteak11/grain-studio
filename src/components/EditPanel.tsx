import { useCallback, useState, type ReactNode } from 'react';
import { Slider } from './Slider';
import { begin, commit, getEdit, setEdit } from '../lib/history';
import { DEFAULT_EDIT, HSL_BANDS, SPLIT_HUES, TOOL_SECTIONS, hueCss, type EditState, type NumKey } from '../lib/types';

function SectionBox({ title, closed, onToggle, children }: { title: string; closed: boolean; onToggle: (t: string) => void; children: ReactNode }) {
  return (
    <section className={`tool-section${closed ? ' closed' : ''}`}>
      <button className="section-title" onClick={() => onToggle(title)}>
        <span>{title}</span>
        <span className="chev">{closed ? '+' : '–'}</span>
      </button>
      {!closed && <div className="section-body">{children}</div>}
    </section>
  );
}

interface Props {
  id: string;
  edit: EditState;
  onCrop: () => void;
}

export function EditPanel({ id, edit, onCrop }: Props) {
  const [band, setBand] = useState(0);
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('gs.closedSections') ?? '{}');
    } catch {
      return {};
    }
  });
  const toggle = useCallback((t: string) => {
    setClosed((prev) => {
      const next = { ...prev, [t]: !prev[t] };
      try {
        localStorage.setItem('gs.closedSections', JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const onBegin = useCallback(() => begin(id), [id]);
  const setNum = (key: NumKey) => (v: number) => setEdit(id, { ...getEdit(id), [key]: v });
  const resetNum = (key: NumKey) => () => commit(id, { ...getEdit(id), [key]: DEFAULT_EDIT[key] });

  const setHsl = (i: number) => (v: number) => {
    const e = getEdit(id);
    const hsl = [...e.hsl];
    hsl[band * 3 + i] = v;
    setEdit(id, { ...e, hsl });
  };
  const resetHsl = (i: number) => () => {
    const e = getEdit(id);
    const hsl = [...e.hsl];
    hsl[band * 3 + i] = 0;
    commit(id, { ...e, hsl });
  };

  return (
    <div className="edit-panel">
      <button className="crop-entry" onClick={onCrop}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
          <path d="M6 2v16h16M2 6h16v16" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        Crop &amp; Straighten
        <kbd>C</kbd>
      </button>

      {TOOL_SECTIONS.map((sec) => (
        <SectionBox key={sec.title} title={sec.title} closed={!!closed[sec.title]} onToggle={toggle}>
          {sec.tools.map((t) => (
            <Slider
              key={t.key}
              label={t.label}
              value={edit[t.key]}
              bi={t.bi}
              defaultValue={DEFAULT_EDIT[t.key]}
              onBegin={onBegin}
              onChange={setNum(t.key)}
              onReset={resetNum(t.key)}
            />
          ))}
        </SectionBox>
      ))}

      <SectionBox title="Split Tone" closed={!!closed['Split Tone']} onToggle={toggle}>
        {(
          [
            ['Shadows', 'splitShadowHue', 'splitShadow'],
            ['Highlights', 'splitHighlightHue', 'splitHighlight'],
          ] as const
        ).map(([label, hueKey, amtKey]) => (
          <div key={label} className="split-row">
            <div className="swatches">
              {SPLIT_HUES.map((h) => (
                <button
                  key={h}
                  className={`swatch${Math.abs(edit[hueKey] - h) < 0.005 ? ' on' : ''}`}
                  style={{ background: hueCss(h) }}
                  title={`${label} tint`}
                  onClick={() => {
                    const e = getEdit(id);
                    commit(id, { ...e, [hueKey]: h, [amtKey]: e[amtKey] || 0.5 });
                  }}
                />
              ))}
            </div>
            <Slider label={label} value={edit[amtKey]} onBegin={onBegin} onChange={setNum(amtKey)} onReset={resetNum(amtKey)} />
          </div>
        ))}
      </SectionBox>

      <SectionBox title="HSL" closed={!!closed.HSL} onToggle={toggle}>
        <div className="hsl-bands">
          {HSL_BANDS.map((b, i) => {
            const touched = edit.hsl.slice(i * 3, i * 3 + 3).some((v) => v !== 0);
            return (
              <button
                key={b.name}
                className={`band${band === i ? ' on' : ''}${touched ? ' touched' : ''}`}
                style={{ background: b.color }}
                title={b.name}
                onClick={() => setBand(i)}
              />
            );
          })}
        </div>
        <Slider label={`${HSL_BANDS[band].name} Hue`} value={edit.hsl[band * 3]} bi onBegin={onBegin} onChange={setHsl(0)} onReset={resetHsl(0)} />
        <Slider label="Saturation" value={edit.hsl[band * 3 + 1]} bi onBegin={onBegin} onChange={setHsl(1)} onReset={resetHsl(1)} />
        <Slider label="Lightness" value={edit.hsl[band * 3 + 2]} bi onBegin={onBegin} onChange={setHsl(2)} onReset={resetHsl(2)} />
      </SectionBox>
    </div>
  );
}
