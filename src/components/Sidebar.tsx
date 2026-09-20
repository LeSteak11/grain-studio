import { useMemo, useState, type ReactNode } from 'react';
import { createGroup, createLabel, createPlatform, deleteGroup, deleteLabel, deletePlatform, nextLabelColor, renameGroup, renamePlatform, updateLabel } from '../lib/organize';
import { monthKey, store, useStore, type Filter } from '../lib/store';
import { LABEL_COLORS, createdOf, isEdited, isPosted } from '../lib/types';

const same = (a: Filter, b: Filter) => a.kind === b.kind && (a.value ?? '') === (b.value ?? '');

function Item({ f, label, count, dot, children }: { f: Filter; label: ReactNode; count?: number; dot?: string; children?: ReactNode }) {
  const cur = useStore((s) => s.filter);
  const on = same(cur, f);
  return (
    <div className={`side-item${on ? ' on' : ''}`}>
      <button className="side-main" onClick={() => store.set({ filter: on && f.kind !== 'all' ? { kind: 'all' } : f })}>
        {dot && <span className="dot" style={{ background: dot }} />}
        <span className="side-label">{label}</span>
        {count !== undefined && <span className="count">{count}</span>}
      </button>
      {children && <span className="side-tools">{children}</span>}
    </div>
  );
}

function AddInline({ placeholder, onAdd }: { placeholder: string; onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  if (!open)
    return (
      <button className="side-add" onClick={() => setOpen(true)}>
        + {placeholder}
      </button>
    );
  const done = () => {
    if (v.trim()) onAdd(v);
    setV('');
    setOpen(false);
  };
  return (
    <input
      className="side-input"
      autoFocus
      placeholder={placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done();
        if (e.key === 'Escape') {
          setV('');
          setOpen(false);
        }
      }}
    />
  );
}

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  const [closed, setClosed] = useState(() => {
    try {
      return localStorage.getItem(`gs.side.${id}`) === '0';
    } catch {
      return false;
    }
  });
  return (
    <section className="side-sec">
      <div className="side-head">
        <button
          onClick={() => {
            setClosed(!closed);
            try {
              localStorage.setItem(`gs.side.${id}`, closed ? '1' : '0');
            } catch {
              /* ignore */
            }
          }}
        >
          <span className="chev">{closed ? '▸' : '▾'}</span> {title}
        </button>
      </div>
      {!closed && children}
    </section>
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function Sidebar() {
  const photos = useStore((s) => s.photos);
  const edits = useStore((s) => s.edits);
  const labels = useStore((s) => s.labels);
  const groups = useStore((s) => s.groups);
  const platforms = useStore((s) => s.platforms);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [palette, setPalette] = useState<string | null>(null);

  const c = useMemo(() => {
    const byGroup = new Map<string, number>();
    const byLabel = new Map<string, number>();
    const byMonth = new Map<string, number>();
    const byPlatform = new Map<string, number>();
    let fav = 0;
    let edited = 0;
    let posted = 0;
    let unlabeled = 0;
    let videos = 0;
    for (const p of photos) {
      if (p.kind === 'video') videos++;
      if (p.fav) fav++;
      if (isEdited(edits[p.id])) edited++;
      if (isPosted(p)) posted++;
      if (!p.labels?.length) unlabeled++;
      for (const g of p.groups ?? []) byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
      for (const l of p.labels ?? []) byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
      for (const k of Object.keys(p.posted ?? {})) byPlatform.set(k, (byPlatform.get(k) ?? 0) + 1);
      const m = monthKey(createdOf(p));
      byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
    }
    const months = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    return { byGroup, byLabel, byPlatform, months, fav, edited, posted, unlabeled, videos };
  }, [photos, edits]);

  const startEdit = (id: string, name: string) => {
    setEditing(id);
    setDraft(name);
  };
  const editInput = (commit: (v: string) => void) => (
    <input
      className="side-input"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        commit(draft);
        setEditing(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setEditing(null);
      }}
    />
  );

  let lastYear = '';

  return (
    <nav className="sidebar">
      <Section title="Library" id="lib">
        <Item f={{ kind: 'all' }} label="Everything" count={photos.length} />
        <Item f={{ kind: 'photos' }} label="Photos" count={photos.length - c.videos} />
        <Item f={{ kind: 'videos' }} label="Videos" count={c.videos} />
        <Item f={{ kind: 'fav' }} label="Favorites" count={c.fav} />
        <Item f={{ kind: 'edited' }} label="Edited" count={c.edited} />
        <Item f={{ kind: 'unedited' }} label="Unedited" count={photos.length - c.edited} />
      </Section>

      <Section title="Labels" id="labels">
        {labels.map((l) =>
          editing === l.id ? (
            <div key={l.id}>{editInput((v) => updateLabel(l.id, { name: v }))}</div>
          ) : (
            <div key={l.id}>
              <Item f={{ kind: 'label', value: l.id }} label={l.name} dot={l.color} count={c.byLabel.get(l.id) ?? 0}>
                <button title="Colour" onClick={() => setPalette(palette === l.id ? null : l.id)}>
                  ◐
                </button>
                <button title="Rename" onClick={() => startEdit(l.id, l.name)}>
                  ✎
                </button>
                <button title="Delete label" onClick={() => void deleteLabel(l.id)}>
                  ×
                </button>
              </Item>
              {palette === l.id && (
                <div className="palette">
                  {LABEL_COLORS.map((col) => (
                    <button
                      key={col}
                      className={l.color === col ? 'on' : ''}
                      style={{ background: col }}
                      onClick={() => {
                        updateLabel(l.id, { color: col });
                        setPalette(null);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          ),
        )}
        {labels.length > 0 && <Item f={{ kind: 'unlabeled' }} label="No label" count={c.unlabeled} />}
        <AddInline placeholder="New label" onAdd={(n) => createLabel(n, nextLabelColor(), [...store.get().selection])} />
      </Section>

      <Section title="Posted to" id="post">
        <Item f={{ kind: 'unposted' }} label="Not posted yet" count={photos.length - c.posted} />
        <Item f={{ kind: 'posted' }} label="Posted anywhere" count={c.posted} />
        {platforms.map((p) =>
          editing === p.id ? (
            <div key={p.id}>{editInput((v) => renamePlatform(p.id, v))}</div>
          ) : (
            <Item key={p.id} f={{ kind: 'posted', value: p.id }} label={<span className="indent">{p.name}</span>} count={c.byPlatform.get(p.id) ?? 0}>
              <button title="Rename" onClick={() => startEdit(p.id, p.name)}>
                ✎
              </button>
              <button title="Remove from the list" onClick={() => void deletePlatform(p.id)}>
                ×
              </button>
            </Item>
          ),
        )}
        <AddInline placeholder="Add a platform" onAdd={(n) => createPlatform(n)} />
      </Section>

      <Section title="Groups" id="groups">
        {groups.map((g) =>
          editing === g.id ? (
            <div key={g.id}>{editInput((v) => renameGroup(g.id, v))}</div>
          ) : (
            <Item key={g.id} f={{ kind: 'group', value: g.id }} label={g.name} count={c.byGroup.get(g.id) ?? 0}>
              <button title="Rename" onClick={() => startEdit(g.id, g.name)}>
                ✎
              </button>
              <button title="Delete group" onClick={() => void deleteGroup(g.id)}>
                ×
              </button>
            </Item>
          ),
        )}
        <AddInline
          placeholder="New group"
          onAdd={(n) => {
            const s = store.get();
            const g = createGroup(n, s.view === 'library' ? [...s.selection] : []);
            if (g) store.set({ filter: { kind: 'group', value: g.id } });
          }}
        />
      </Section>

      <Section title="Dates" id="dates">
        {c.months.map(([m, n]) => {
          const [y, mo] = m.split('-');
          const yearHead = y !== lastYear ? <div className="side-year">{y}</div> : null;
          lastYear = y;
          return (
            <div key={m}>
              {yearHead}
              <Item f={{ kind: 'month', value: m }} label={MONTHS[+mo - 1]} count={n} />
            </div>
          );
        })}
      </Section>
    </nav>
  );
}
