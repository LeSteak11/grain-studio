import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Slider } from './Slider';
import { begin, commit, getEdit, setEdit } from '../lib/history';
import { BUILTIN, presetInfo, userLutId } from '../lib/luts';
import { compareNames, familiesOf, groupByFamily, matchesQuery, parseName } from '../lib/presetnames';
import { registerTile, unregisterTile } from '../lib/previews';
import { store, toast, useStore } from '../lib/store';
import { withGeometryOf, type EditState } from '../lib/types';

type View = 'grid' | 'compact' | 'list';
type SortBy = 'name' | 'name-desc' | 'used';

const TILE_PX: Record<View, number> = { grid: 96, compact: 62, list: 34 };

function readPref<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

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
      { rootMargin: '300px 0px' },
    );
  }
  return observer;
}

interface TileProps {
  pid: string;
  code: string;
  name: string;
  active: boolean;
  fav: boolean;
  used: number;
  view: View;
  onPick: (pid: string) => void;
}

const Tile = memo(function Tile({ pid, code, name, active, fav, used, view, onPick }: TileProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(TILE_PX[view] * dpr);
    c.width = px;
    c.height = px;
    tileIds.set(c, pid);
    const obs = getObserver();
    obs.observe(c);
    return () => {
      obs.unobserve(c);
      unregisterTile(c);
    };
  }, [pid, view]);
  return (
    <div className={`preset-tile v-${view}${active ? ' on' : ''}`} title={`${name}${used ? ` · used on ${used}` : ''}\nRight-click to favorite`}>
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
        {view === 'list' && used > 0 && <span className="used">{used}</span>}
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
  const edits = useStore((s) => s.edits);
  const [naming, setNaming] = useState(false);
  const [recipeName, setRecipeName] = useState('');
  const [q, setQ] = useState('');
  const [family, setFamily] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => readPref('gs.presetView', ['grid', 'compact', 'list'], 'grid'));
  const [sortBy, setSortBy] = useState<SortBy>(() => readPref('gs.presetSort', ['name', 'name-desc', 'used'], 'name'));

  const setViewPref = (v: View) => {
    setView(v);
    try {
      localStorage.setItem('gs.presetView', v);
    } catch {
      /* ignore */
    }
  };
  const setSortPref = (v: SortBy) => {
    setSortBy(v);
    try {
      localStorage.setItem('gs.presetSort', v);
    } catch {
      /* ignore */
    }
  };

  const pick = (pid: string) => {
    const e = getEdit(id);
    const preset = pid === 'none' ? null : pid;
    if (e.preset === preset) return;
    commit(id, { ...e, preset, strength: preset ? 1 : e.strength });
  };

  /** How many photos use each preset. */
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of Object.values(edits)) if (e.preset) m.set(e.preset, (m.get(e.preset) ?? 0) + 1);
    return m;
  }, [edits]);

  const info = presetInfo(edit.preset);
  const mine: Item[] = useMemo(() => luts.map((n) => ({ id: userLutId(n), code: n, name: n })), [luts]);
  const builtin: Item[] = useMemo(() => BUILTIN.map((b) => ({ id: b.id, code: b.code, name: b.name })), []);
  const families = useMemo(() => familiesOf(luts), [luts]);

  const filtered = (items: Item[]) =>
    items.filter((p) => matchesQuery(p.name, q) && (!family || parseName(p.name).family === family));

  const sortItems = (items: Item[]) => {
    const out = [...items];
    if (sortBy === 'used') out.sort((a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) || compareNames(a.name, b.name));
    else if (sortBy === 'name-desc') out.sort((a, b) => compareNames(b.name, a.name));
    else out.sort((a, b) => compareNames(a.name, b.name));
    return out;
  };

  const tile = (p: Item) => (
    <Tile key={p.id} pid={p.id} code={p.code} name={p.name} active={edit.preset === p.id} fav={favs.includes(p.id)} used={usage.get(p.id) ?? 0} view={view} onPick={pick} />
  );

  const grid = (items: Item[], withNone = false) => (
    <div className={`preset-grid v-${view}`}>
      {withNone && !q && !family && <Tile pid="none" code="None" name="No preset" active={!edit.preset} fav={false} used={0} view={view} onPick={pick} />}
      {items.map(tile)}
    </div>
  );

  const myFiltered = sortItems(filtered(mine));
  const builtinFiltered = sortItems(filtered(builtin));
  const favItems = sortItems([...mine, ...builtin].filter((p) => favs.includes(p.id)).filter((p) => matchesQuery(p.name, q)));
  const topMatch = myFiltered[0] ?? builtinFiltered[0];

  const saveRecipe = () => {
    const name = recipeName.trim();
    if (!name) return;
    store.set((s) => ({ recipes: [...s.recipes, { id: `r${Date.now().toString(36)}`, name, edit: getEdit(id) }] }));
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

      <div className="preset-tools">
        <input
          className="search"
          placeholder={`Search ${mine.length + builtin.length} presets`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQ('');
            if (e.key === 'Enter' && topMatch) pick(topMatch.id);
          }}
        />
        <div className="seg small-seg views" title="How the presets are shown">
          {(['grid', 'compact', 'list'] as View[]).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setViewPref(v)} title={v}>
              {v === 'grid' ? '▦' : v === 'compact' ? '▤' : '☰'}
            </button>
          ))}
        </div>
      </div>

      <div className="preset-tools">
        <select className="sort-sel" value={sortBy} onChange={(e) => setSortPref(e.target.value as SortBy)} title="Sort">
          <option value="name">A → Z</option>
          <option value="name-desc">Z → A</option>
          <option value="used">Most used</option>
        </select>
        {(q || family) && (
          <button
            className="link"
            onClick={() => {
              setQ('');
              setFamily(null);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {families.length > 1 && (
        <div className="family-row">
          <button className={family === null ? 'on' : ''} onClick={() => setFamily(null)}>
            All
          </button>
          {families.map((f) => (
            <button key={f.family} className={family === f.family ? 'on' : ''} onClick={() => setFamily(family === f.family ? null : f.family)} title={`${f.count} presets`}>
              {f.family}
              <i>{f.count}</i>
            </button>
          ))}
        </div>
      )}

      {favItems.length > 0 && (
        <>
          <div className="group-head">
            <span>Favorites</span>
          </div>
          {grid(favItems)}
        </>
      )}

      {!q && !family && (
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

      <div className="group-head sticky">
        <span>My Presets · {myFiltered.length}</span>
        <button className="link" onClick={() => store.set({ modal: 'lab' })}>
          Capture from VSCO…
        </button>
      </div>
      {mine.length === 0 ? (
        <p className="hint">Capture your VSCO presets (or drop in .cube LUTs) in the Preset Lab.</p>
      ) : myFiltered.length === 0 ? (
        <p className="hint">No match in your presets.</p>
      ) : sortBy === 'name' && !family && myFiltered.length > 12 ? (
        // Grouped by letter family so long lists stay navigable.
        groupByFamily(myFiltered).map((g) => (
          <div key={g.family}>
            <div className="family-head">{g.family}</div>
            {grid(g.items)}
          </div>
        ))
      ) : (
        grid(myFiltered)
      )}

      <div className="group-head sticky">
        <span>Built-in</span>
      </div>
      {builtinFiltered.length ? grid(builtinFiltered, true) : <p className="hint">No match in the built-in looks.</p>}
    </div>
  );
}
