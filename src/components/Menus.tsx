import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applyPreset, pasteEdits } from '../lib/library';
import { BUILTIN, presetInfo, userLutId } from '../lib/luts';
import { useStore } from '../lib/store';

/** Small click-to-open popover anchored under its button. */
export function Popover({ label, disabled, title, children, className }: { label: ReactNode; disabled?: boolean; title?: string; className?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', off);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className={`pop ${className ?? ''}`} ref={ref} onClick={(e) => e.stopPropagation()}>
      <button disabled={disabled} title={title} className={open ? 'on' : ''} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && <div className="pop-body">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** Paste all / preset only / tools only. */
export function PasteMenu({ ids, className }: { ids: () => string[]; className?: string }) {
  const clip = useStore((s) => s.clipboard);
  const info = presetInfo(clip?.preset ?? null);
  return (
    <Popover label="Paste ▾" disabled={!clip} title="Paste copied edits" className={className}>
      {(close) => (
        <div className="menu">
          <button
            onClick={() => {
              pasteEdits(ids(), 'all');
              close();
            }}
          >
            All edits <kbd>Ctrl+V</kbd>
          </button>
          <button
            disabled={!clip?.preset}
            onClick={() => {
              pasteEdits(ids(), 'preset');
              close();
            }}
          >
            Preset only{info ? ` (${info.code})` : ''} <kbd>Ctrl+Shift+V</kbd>
          </button>
          <button
            onClick={() => {
              pasteEdits(ids(), 'tools');
              close();
            }}
          >
            Tools only (keep each photo's preset)
          </button>
        </div>
      )}
    </Popover>
  );
}

/** Pick a preset (searchable) and apply it to many photos at once. */
export function PresetPicker({ ids }: { ids: () => string[] }) {
  const luts = useStore((s) => s.luts);
  const favs = useStore((s) => s.favPresets);
  const [q, setQ] = useState('');
  const all = useMemo(
    () => [...luts.map((n) => ({ id: userLutId(n), code: n, name: n })), ...BUILTIN.map((b) => ({ id: b.id, code: b.code, name: b.name }))],
    [luts],
  );
  const needle = q.trim().toLowerCase();
  const list = all
    .filter((p) => !needle || p.code.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(favs.includes(b.id)) - Number(favs.includes(a.id)));
  return (
    <Popover label="Preset ▾" title="Apply a preset to the selected photos">
      {(close) => (
        <div className="picker">
          <input autoFocus placeholder="Search presets" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="picker-list">
            <button
              onClick={() => {
                applyPreset(ids(), null);
                close();
              }}
            >
              <b>None</b>
            </button>
            {list.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  applyPreset(ids(), p.id);
                  close();
                }}
              >
                {favs.includes(p.id) && <span className="star">★</span>}
                <b>{p.code}</b>
                {p.name !== p.code && <span className="dim"> {p.name}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}
