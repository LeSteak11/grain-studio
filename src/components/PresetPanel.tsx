import { memo, useEffect, useRef, useState } from 'react';
import { Slider } from './Slider';
import { begin, commit, getEdit, setEdit } from '../lib/history';
import { BUILTIN, presetInfo, userLutId } from '../lib/luts';
import { registerTile, unregisterTile } from '../lib/previews';
import { store, toast, useStore } from '../lib/store';
import { withGeometryOf, type EditState } from '../lib/types';

function toggleFavPreset(pid: string) {
  const favs = store.get().favPresets;
  const on = favs.includes(pid);
  store.set({ favPresets: on ? favs.filter((f) => f !== pid) : [...favs, pid] });
  toast(on ? 'Removed from favorites' : 'Added to favorites');
}

let observer: IntersectionObserver | null = null;
const tileIds = new WeakMap<Element, string>();

/** One shared observer: tiles only render their preview while on screen. */
function getObserver() {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const c = en.target as HTMLCanvasElement;
          const pid = tileIds.get(c);
          if (!pid) continue;
          if (en.isIntersecting) registerTile(pid, c);
          else unregisterTile(c);
        }
      },
      { rootMargin: '200px 0px' },
    );
  }
  return observer;
}

const Tile = memo(function Tile({ pid, code, name, active, fav, onPick }: { pid: string; code: string; name: string; active: boolean; fav: boolean; onPick: (pid: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(96 * dpr);
    c.height = Math.round(96 * dpr);
    tileIds.set(c, pid);
    const obs = getObserver();
    obs.observe(c);
    return () => {
      obs.unobserve(c);
      unregisterTile(c);
    };
  }, [pid]);
  return (
    <div className={`preset-tile${active ? ' on' : ''}`} title={`${name}. Right-click to favorite`}>
      <button
        className="tile-hit"
        onClick={() => onPick(pid)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (pid !== 'none') toggleFavPreset(pid);
        }}
      >
        <canvas ref={ref} />
        <span className="code">{code}</span>
      </button>
      {pid !== 'none' && (
        <button className={`fav-star${fav ? ' on' : ''}`} onClick={() => toggleFavPreset(pid)} title={fav ? 'Unfavorite' : 'Favorite'}>
          {fav ? '★' : '☆'}
        </button>
      )}
    </div>
  );
});

interface Item {
  id: string;
  code: string;
  name: string;
}

export function PresetPanel({ id, edit }: { id: string; edit: EditState }) {
  const luts = useStore((s) => s.luts);
  const recipes = useStore((s) => s.recipes);
  const favs = useStore((s) => s.favPresets);
  const [naming, setNaming] = useState(false);
  const [recipeName, setRecipeName] = useState('');
  const [q, setQ] = useState('');

  const pick = (pid: string) => {
    const e = getEdit(id);
    const preset = pid === 'none' ? null : pid;
    if (e.preset === preset) return;
    commit(id, { ...e, preset, strength: preset ? 1 : e.strength });
  };

  const info = presetInfo(edit.preset);
  const needle = q.trim().toLowerCase();
  const match = (p: Item) => !needle || p.code.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle);
  const mine: Item[] = luts.map((n) => ({ id: userLutId(n), code: n.length <= 4 ? n : n.slice(0, 4), name: n }));
  const builtin: Item[] = BUILTIN.map((b) => ({ id: b.id, code: b.code, name: b.name }));
  const favItems = [...mine, ...builtin].filter((p) => favs.includes(p.id));

  const grid = (items: Item[], withNone = false) => (
    <div className="preset-grid">
      {withNone && !needle && <Tile pid="none" code="None" name="No preset" active={!edit.preset} fav={false} onPick={pick} />}
      {items.filter(match).map((p) => (
        <Tile key={p.id} pid={p.id} code={p.code} name={p.name} active={edit.preset === p.id} fav={favs.includes(p.id)} onPick={pick} />
      ))}
    </div>
  );

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

      <input className="search" placeholder="Search presets" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />

      {favItems.some(match) && (
        <>
          <div className="group-head">
            <span>Favorites</span>
          </div>
          {grid(favItems)}
        </>
      )}

      {!needle && (
        <>
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
                  <button className="x" title="Delete recipe" onClick={() => store.set((s) => ({ recipes: s.recipes.filter((x) => x.id !== r.id) }))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            !naming && <p className="hint">Save a full set of edits to reuse in one click.</p>
          )}
        </>
      )}

      <div className="group-head">
        <span>My Presets</span>
        <button className="link" onClick={() => store.set({ modal: 'lab' })}>
          Capture from VSCO…
        </button>
      </div>
      {mine.length ? grid(mine) : <p className="hint">Capture your VSCO presets (or drop in .cube LUTs) in the Preset Lab.</p>}

      <div className="group-head">
        <span>Built-in</span>
      </div>
      {grid(builtin, true)}
    </div>
  );
}
