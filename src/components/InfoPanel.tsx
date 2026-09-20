import { useMemo, useState } from 'react';
import { addTags, allTags, createGroup, removeTag, setCreated, setNote, setPosted, toggleGroup, toggleLabel } from '../lib/organize';
import { store, useStore } from '../lib/store';
import { PLATFORMS, createdOf, type Photo } from '../lib/types';

const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtShort = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** value for <input type="datetime-local"> in local time */
function toLocalInput(t: number) {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function TagInput({ ids }: { ids: string[] }) {
  const photos = useStore((s) => s.photos);
  const [v, setV] = useState('');
  const suggestions = useMemo(() => allTags(photos).slice(0, 200), [photos]);
  const commit = () => {
    if (v.trim()) addTags(ids, v);
    setV('');
  };
  return (
    <>
      <input
        className="tag-input"
        list="gs-tags"
        placeholder="Add tag, Enter to save"
        value={v}
        onChange={(e) => {
          const val = e.target.value;
          // Typing a comma finishes the tag.
          if (val.includes(',')) {
            addTags(ids, val);
            setV('');
          } else setV(val);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setV('');
        }}
      />
      <datalist id="gs-tags">
        {suggestions.map((t) => (
          <option key={t.tag} value={t.tag} />
        ))}
      </datalist>
    </>
  );
}

export function InfoPanel({ ids, embedded }: { ids: string[]; embedded?: boolean }) {
  const photos = useStore((s) => s.photos);
  const labels = useStore((s) => s.labels);
  const groups = useStore((s) => s.groups);
  const [newGroup, setNewGroup] = useState(false);
  const [groupName, setGroupName] = useState('');

  const sel: Photo[] = photos.filter((p) => ids.includes(p.id));
  if (!sel.length) return <div className="info empty-info">Select a photo to see its details.</div>;
  const one = sel.length === 1 ? sel[0] : null;

  // Tags shared by every selected photo, plus tags only some have.
  const tagCount = new Map<string, { tag: string; n: number }>();
  for (const p of sel)
    for (const t of p.tags ?? []) {
      const k = t.toLowerCase();
      const e = tagCount.get(k);
      if (e) e.n++;
      else tagCount.set(k, { tag: t, n: 1 });
    }
  const tags = [...tagCount.values()].sort((a, b) => b.n - a.n);

  const has = (key: 'labels' | 'groups', id: string) => {
    const n = sel.filter((p) => p[key]?.includes(id)).length;
    return n === 0 ? 'off' : n === sel.length ? 'on' : 'some';
  };

  return (
    <div className={`info${embedded ? ' embedded' : ''}`}>
      <div className="info-head">
        {one ? (
          <>
            <div className="info-name" title={one.name}>
              {one.name}
            </div>
            <div className="dim small">
              {one.w} × {one.h}
            </div>
          </>
        ) : (
          <div className="info-name">{sel.length} photos selected</div>
        )}
      </div>

      <div className="info-sec">
        <span className="info-title">Date</span>
        <input
          type="datetime-local"
          className="date-input"
          value={toLocalInput(createdOf(sel[0]))}
          onChange={(e) => {
            const t = new Date(e.target.value).getTime();
            if (Number.isFinite(t)) setCreated(ids, t);
          }}
        />
        <p className="info-note">
          Added {fmtShort(sel[0].added)}
          {sel.length > 1 && ' · changing this sets the date on all selected'}
        </p>
      </div>

      <div className="info-sec">
        <span className="info-title">Posted</span>
        <div className="post-row">
          {PLATFORMS.map((pl) => {
            const n = sel.filter((p) => p.posted?.[pl.id]).length;
            const state = n === 0 ? '' : n === sel.length ? ' on' : ' some';
            return (
              <button key={pl.id} className={`post-btn${state}`} onClick={() => setPosted(ids, pl.id)} title={one?.posted?.[pl.id] ? `Posted ${fmtDate(one.posted[pl.id]!)}` : `Mark as posted to ${pl.label}`}>
                {pl.label}
                {one?.posted?.[pl.id] && <span className="when">{fmtShort(one.posted[pl.id]!)}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="info-sec">
        <span className="info-title">Tags</span>
        <div className="chips">
          {tags.map((t) => (
            <span key={t.tag} className={`chip${t.n < sel.length ? ' partial' : ''}`}>
              #{t.tag}
              {t.n < sel.length && <i>{t.n}</i>}
              <button onClick={() => removeTag(ids, t.tag)} title="Remove tag">
                ×
              </button>
            </span>
          ))}
        </div>
        <TagInput ids={ids} />
      </div>

      <div className="info-sec">
        <span className="info-title">Labels</span>
        <div className="chips">
          {labels.map((l) => {
            const st = has('labels', l.id);
            return (
              <button key={l.id} className={`chip toggle ${st}`} style={st === 'off' ? undefined : { borderColor: l.color, background: `${l.color}22` }} onClick={() => toggleLabel(ids, l.id)}>
                <span className="dot" style={{ background: l.color }} />
                {l.name}
              </button>
            );
          })}
          {!labels.length && <p className="info-note">Create labels in the sidebar.</p>}
        </div>
      </div>

      <div className="info-sec">
        <span className="info-title">Groups</span>
        <div className="chips">
          {groups.map((g) => {
            const st = has('groups', g.id);
            return (
              <button key={g.id} className={`chip toggle ${st}`} onClick={() => toggleGroup(ids, g.id)}>
                {g.name}
              </button>
            );
          })}
        </div>
        {newGroup ? (
          <input
            className="tag-input"
            autoFocus
            placeholder="New group name"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            onBlur={() => {
              if (groupName.trim()) createGroup(groupName, ids);
              setGroupName('');
              setNewGroup(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setGroupName('');
                setNewGroup(false);
              }
            }}
          />
        ) : (
          <button className="link" onClick={() => setNewGroup(true)}>
            + New group with {sel.length === 1 ? 'this photo' : `these ${sel.length}`}
          </button>
        )}
      </div>

      {one && (
        <div className="info-sec">
          <span className="info-title">Caption / notes</span>
          <textarea className="note" rows={4} placeholder="Caption draft, credits, ideas…" value={one.note ?? ''} onChange={(e) => setNote(one.id, e.target.value)} />
          <button
            className="link"
            onClick={() => {
              void navigator.clipboard.writeText(one.note ?? '');
              store.set({ toast: 'Caption copied' });
            }}
          >
            Copy caption
          </button>
        </div>
      )}
    </div>
  );
}
