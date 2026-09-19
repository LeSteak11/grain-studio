import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { paths } from '../lib/fs';
import { exportPhotos, type ExportOpts } from '../lib/export';
import { store, useStore } from '../lib/store';

const SIZES = [
  { v: 0, label: 'Original' },
  { v: 4096, label: '4096 px' },
  { v: 2048, label: '2048 px' },
  { v: 1080, label: '1080 px' },
];

function loadOpts(): ExportOpts {
  const d: ExportOpts = { dir: paths.exports(), format: 'jpeg', quality: 0.92, size: 0, openAfter: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem('gs.export') ?? '{}') };
  } catch {
    return d;
  }
}

export function ExportDialog() {
  const ids = useStore((s) => s.exportIds);
  const [o, setO] = useState<ExportOpts>(loadOpts);
  const set = (p: Partial<ExportOpts>) => setO((x) => ({ ...x, ...p }));
  const close = () => store.set({ modal: null });

  const run = () => {
    try {
      localStorage.setItem('gs.export', JSON.stringify(o));
    } catch {
      /* ignore */
    }
    close();
    void exportPhotos(ids, o);
  };

  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          Export {ids.length} photo{ids.length === 1 ? '' : 's'}
        </h3>
        <label className="field">
          <span>Size (long edge)</span>
          <div className="seg">
            {SIZES.map((s) => (
              <button key={s.v} className={o.size === s.v ? 'on' : ''} onClick={() => set({ size: s.v })}>
                {s.label}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Format</span>
          <div className="seg">
            <button className={o.format === 'jpeg' ? 'on' : ''} onClick={() => set({ format: 'jpeg' })}>
              JPEG
            </button>
            <button className={o.format === 'png' ? 'on' : ''} onClick={() => set({ format: 'png' })}>
              PNG
            </button>
          </div>
        </label>
        {o.format === 'jpeg' && (
          <label className="field">
            <span>Quality · {Math.round(o.quality * 100)}</span>
            <input type="range" className="plain" min={0.6} max={1} step={0.01} value={o.quality} onChange={(e) => set({ quality: +e.target.value })} />
          </label>
        )}
        <label className="field">
          <span>Folder</span>
          <div className="dir-row">
            <code title={o.dir}>{o.dir}</code>
            <button
              onClick={async () => {
                const d = await open({ directory: true, defaultPath: o.dir });
                if (typeof d === 'string') set({ dir: d });
              }}
            >
              Change…
            </button>
          </div>
        </label>
        <label className="check">
          <input type="checkbox" checked={o.openAfter} onChange={(e) => set({ openAfter: e.target.checked })} />
          Open folder when done
        </label>
        <div className="modal-actions">
          <button className="ghost" onClick={close}>
            Cancel
          </button>
          <button className="primary" onClick={run}>
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
