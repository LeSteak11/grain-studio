import { useState } from 'react';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { baseName, fileNameOf, fsx, paths } from '../lib/fs';
import { extractLutFromBytes, makeChartPng, CHART_W, CHART_H } from '../lib/chart';
import { forgetLut, parseCube, putLut, toCube, userLutId } from '../lib/luts';
import { refreshPreviews } from '../lib/previews';
import { clearBusy, setBusy, store, toast, useStore } from '../lib/store';

function cleanName(raw: string): string {
  const n = raw
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/[-_ ]?(edited|copy|vsco|export(ed)?)$/i, '')
    .trim()
    .slice(0, 40);
  return n || 'Preset';
}

function uniqueName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!lower.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

function addLutName(name: string) {
  store.set((s) => ({ luts: [...s.luts, name].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }));
}

export function PresetLab() {
  const luts = useStore((s) => s.luts);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const close = () => store.set({ modal: null });

  const saveChart = async () => {
    const dest = await save({ defaultPath: 'grain-capture-chart.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (!dest) return;
    setBusy('Building chart', 0, 1);
    try {
      await fsx.writeBytes(dest, await makeChartPng());
      toast('Capture chart saved');
      await fsx.openPath(dest.slice(0, dest.lastIndexOf('\\')) || dest);
    } catch (e) {
      toast(`Couldn't save chart: ${e}`);
    } finally {
      clearBusy();
    }
  };

  const importCharts = async () => {
    const sel = await open({ multiple: true, filters: [{ name: 'Exported charts', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    const files = !sel ? [] : Array.isArray(sel) ? sel : [sel];
    if (!files.length) return;
    let ok = 0;
    const errors: string[] = [];
    for (let i = 0; i < files.length; i++) {
      setBusy('Reading presets', i, files.length);
      const f = files[i];
      try {
        const lut = await extractLutFromBytes(await fsx.readBytes(f));
        const name = uniqueName(cleanName(baseName(fileNameOf(f))), store.get().luts);
        await fsx.writeText(paths.lut(name), toCube(lut, name));
        putLut(userLutId(name), lut);
        addLutName(name);
        ok++;
      } catch (e) {
        errors.push(`${fileNameOf(f)}: ${e instanceof Error ? e.message : e}`);
      }
    }
    clearBusy();
    refreshPreviews(0);
    toast(errors.length ? `Added ${ok}. ${errors[0]}` : `Added ${ok} preset${ok === 1 ? '' : 's'}`);
  };

  const importCubes = async () => {
    const sel = await open({ multiple: true, filters: [{ name: 'LUT', extensions: ['cube'] }] });
    const files = !sel ? [] : Array.isArray(sel) ? sel : [sel];
    let ok = 0;
    const errors: string[] = [];
    for (const f of files) {
      try {
        const txt = (await fsx.readText(f)) ?? '';
        const lut = parseCube(txt);
        const name = uniqueName(cleanName(baseName(fileNameOf(f))), store.get().luts);
        await fsx.writeText(paths.lut(name), txt);
        putLut(userLutId(name), lut);
        addLutName(name);
        ok++;
      } catch (e) {
        errors.push(`${fileNameOf(f)}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (files.length) {
      refreshPreviews(0);
      toast(errors.length ? `Added ${ok}. ${errors[0]}` : `Added ${ok} LUT${ok === 1 ? '' : 's'}`);
    }
  };

  const rename = async (from: string) => {
    const to = cleanName(draft);
    setRenaming(null);
    if (!to || to === from) return;
    if (store.get().luts.some((l) => l.toLowerCase() === to.toLowerCase())) {
      toast('That name is taken');
      return;
    }
    try {
      await fsx.rename(paths.lut(from), paths.lut(to));
    } catch (e) {
      toast(String(e));
      return;
    }
    forgetLut(userLutId(from));
    const oldId = userLutId(from);
    const newId = userLutId(to);
    store.set((s) => {
      const edits = { ...s.edits };
      for (const [k, e] of Object.entries(edits)) if (e.preset === oldId) edits[k] = { ...e, preset: newId };
      return { luts: s.luts.map((l) => (l === from ? to : l)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), edits };
    });
  };

  const remove = async (name: string) => {
    const yes = await ask(`Delete preset “${name}”? Photos using it will lose that look.`, { title: 'Delete preset', kind: 'warning', okLabel: 'Delete' });
    if (!yes) return;
    await fsx.remove([paths.lut(name)]);
    forgetLut(userLutId(name));
    store.set((s) => ({ luts: s.luts.filter((l) => l !== name) }));
  };

  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal lab" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Preset Lab</h3>
        <p className="lede">Turn the presets in your own VSCO account into local presets. The color comes out exactly the same, it works offline, and it stays on this PC.</p>
        <ol className="steps">
          <li>
            <b>Save the capture chart.</b> It's a {CHART_W}×{CHART_H} PNG of 36,000 color patches.
            <button onClick={saveChart}>Save capture chart…</button>
          </li>
          <li>
            <b>Upload it to studio.vsco.co.</b> For each preset: apply it at <b>+12</b> and leave every other tool at 0. Don't crop, and don't add grain, fade or clarity. Then export it at full resolution. Copy/paste edits in Studio makes this quick.
          </li>
          <li>
            <b>Name each exported file after its preset</b> (e.g. <code>A6.jpg</code>, <code>M5.jpg</code>). The filename becomes the preset's name here.
          </li>
          <li>
            <b>Import them.</b> You can pick dozens at once.
            <button className="primary" onClick={importCharts}>
              Import exported charts…
            </button>
          </li>
        </ol>
        <p className="dim small">
          Already have LUTs? <button className="link" onClick={importCubes}>Import .cube files…</button> · Captured presets are for your personal use only, so please don't share them.
        </p>

        <div className="group-head">
          <span>My Presets · {luts.length}</span>
          <button className="link" onClick={() => fsx.openPath(paths.lutsDir())}>
            Open folder
          </button>
        </div>
        <div className="lut-list">
          {luts.length === 0 && <p className="hint">None yet.</p>}
          {luts.map((name) => (
            <div key={name} className="lut-row">
              {renaming === name ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename(name);
                  }}
                >
                  <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => void rename(name)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} />
                </form>
              ) : (
                <span className="lut-name">{name}</span>
              )}
              <button
                className="link"
                onClick={() => {
                  setRenaming(name);
                  setDraft(name);
                }}
              >
                Rename
              </button>
              <button className="link danger" onClick={() => void remove(name)}>
                Delete
              </button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
