import { memo, useEffect, useRef, useState } from 'react';
import { Slider } from './Slider';
import { begin, commit, getEdit, setEdit } from '../lib/history';
import { BUILTIN, presetInfo, userLutId } from '../lib/luts';
import { registerTile, unregisterTile } from '../lib/previews';
import { store, toast, useStore } from '../lib/store';
import { withGeometryOf, type EditState } from '../lib/types';

const Tile = memo(function Tile({ pid, code, name, active, onPick }: { pid: string; code: string; name: string; active: boolean; onPick: (pid: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(96 * dpr);
    c.height = Math.round(96 * dpr);
    registerTile(pid, c);
    return () => unregisterTile(pid, c);
  }, [pid]);
  return (
    <button className={`preset-tile${active ? ' on' : ''}`} onClick={() => onPick(pid)} title={name}>
      <canvas ref={ref} />
      <span className="code">{code}</span>
    </button>
  );
});

export function PresetPanel({ id, edit }: { id: string; edit: EditState }) {
  const luts = useStore((s) => s.luts);
  const recipes = useStore((s) => s.recipes);
  const [naming, setNaming] = useState(false);
  const [recipeName, setRecipeName] = useState('');

  const pick = (pid: string) => {
    const e = getEdit(id);
    const preset = pid === 'none' ? null : pid;
    if (e.preset === preset) return;
    commit(id, { ...e, preset, strength: preset ? 1 : e.strength });
  };

  const info = presetInfo(edit.preset);

  const saveRecipe = () => {
    const name = recipeName.trim();
    if (!name) return;
    const e = getEdit(id);
    store.set((s) => ({ recipes: [...s.recipes, { id: `r${Date.now().toString(36)}`, name, edit: e }] }));
    setRecipeName('');
    setNaming(false);
    toast(`Recipe “${name}” saved`);
  };

  return (
    <div className="preset-panel">
      {info && (
        <div className="strength">
          <div className="strength-name">
            <b>{info.code}</b> {info.name !== info.code && <span>{info.name}</span>}
          </div>
          <Slider
            label="Strength"
            value={edit.strength}
            defaultValue={1}
            onBegin={() => begin(id)}
            onChange={(v) => setEdit(id, { ...getEdit(id), strength: v })}
            onReset={() => commit(id, { ...getEdit(id), strength: 1 })}
          />
        </div>
      )}

      <div className="group-head">
        <span>Recipes</span>
        {!naming && (
          <button className="link" onClick={() => setNaming(true)}>
            + Save current
          </button>
        )}
      </div>
      {naming && (
        <form
          className="recipe-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveRecipe();
          }}
        >
          <input autoFocus placeholder="Recipe name" value={recipeName} onChange={(e) => setRecipeName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(false)} />
          <button type="submit">Save</button>
        </form>
      )}
      {recipes.length ? (
        <div className="recipes">
          {recipes.map((r) => (
            <span key={r.id} className="recipe">
              <button onClick={() => commit(id, withGeometryOf(r.edit, getEdit(id)))} title="Apply recipe (keeps your crop)">
                {r.name}
              </button>
              <button
                className="x"
                title="Delete recipe"
                onClick={() => store.set((s) => ({ recipes: s.recipes.filter((x) => x.id !== r.id) }))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        !naming && <p className="hint">Save a full set of edits to reuse in one click.</p>
      )}

      <div className="group-head">
        <span>My Presets</span>
        <button className="link" onClick={() => store.set({ modal: 'lab' })}>
          Capture from VSCO…
        </button>
      </div>
      {luts.length ? (
        <div className="preset-grid">
          {luts.map((name) => (
            <Tile key={name} pid={userLutId(name)} code={name.length <= 4 ? name : name.slice(0, 4)} name={name} active={edit.preset === userLutId(name)} onPick={pick} />
          ))}
        </div>
      ) : (
        <p className="hint">Capture your VSCO presets (or drop in .cube LUTs) in the Preset Lab.</p>
      )}

      <div className="group-head">
        <span>Built-in</span>
      </div>
      <div className="preset-grid">
        <Tile pid="none" code="None" name="No preset" active={!edit.preset} onPick={pick} />
        {BUILTIN.map((b) => (
          <Tile key={b.id} pid={b.id} code={b.code} name={b.name} active={edit.preset === b.id} onPick={pick} />
        ))}
      </div>
    </div>
  );
}
