import { useState } from 'react';
import {
  createGroup,
  createLabel,
  createPlatform,
  deleteGroup,
  deleteLabel,
  deletePlatform,
  setCreated,
  setNote,
  setPosted,
  toggleGroup,
  toggleLabel,
} from '../lib/organize';
import { store, useStore } from '../lib/store';
import { createdOf, type Photo, kindWord } from '../lib/types';

const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtShort = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** value for <input type="datetime-local"> in local time */
function toLocalInput(t: number) {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

export function InfoPanel({ ids, embedded }: { ids: string[]; embedded?: boolean }) {
  const photos = useStore((s) => s.photos);
  const labels = useStore((s) => s.labels);
  const groups = useStore((s) => s.groups);
  const platforms = useStore((s) => s.platforms);
  const [newGroup, setNewGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [newLabel, setNewLabel] = useState(false);
  const [labelName, setLabelName] = useState('');
  const [newPlatform, setNewPlatform] = useState(false);
  const [platformName, setPlatformName] = useState('');
  /** Which section is in "manage" mode, where items show a delete button. */
  const [managing, setManaging] = useState<'labels' | 'groups' | 'platforms' | null>(null);

  const sel: Photo[] = photos.filter((p) => ids.includes(p.id));
  if (!sel.length) return <div className="info empty-info">Select a photo to see its details.</div>;
  const one = sel.length === 1 ? sel[0] : null;

  const addInput = (value: string, setValue: (v: string) => void, placeholder: string, commit: () => void, cancel: () => void) => (
    <input
      className="tag-input"
      autoFocus
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') cancel();
      }}
    />
  );

  const manageBtn = (which: 'labels' | 'groups' | 'platforms', count: number) =>
    count > 0 ? (
      <button className={`manage${managing === which ? ' on' : ''}`} onClick={() => setManaging(managing === which ? null : which)} title="Rename or delete these">
        {managing === which ? 'Done' : 'Edit'}
      </button>
    ) : null;

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
          <div className="info-name">{sel.length} {kindWord(sel)} selected</div>
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
        <span className="info-title">
          Posted {manageBtn('platforms', platforms.length)}
        </span>
        <div className="post-row">
          {platforms.map((pl) => {
            const n = sel.filter((p) => p.posted?.[pl.id]).length;
            const state = n === 0 ? '' : n === sel.length ? ' on' : ' some';
            return (
              <span key={pl.id} className="post-wrap">
                <button className={`post-btn${state}`} onClick={() => setPosted(ids, pl.id)} title={one?.posted?.[pl.id] ? `Posted ${fmtDate(one.posted[pl.id]!)}` : `Mark as posted to ${pl.name}`}>
                  {pl.name}
                  {one?.posted?.[pl.id] && <span className="when">{fmtShort(one.posted[pl.id]!)}</span>}
                </button>
                {managing === 'platforms' && (
                  <button className="kill" title={`Remove ${pl.name} from the list`} onClick={() => void deletePlatform(pl.id)}>
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
        {newPlatform
          ? addInput(
              platformName,
              setPlatformName,
              'Instagram, TikTok, Pinterest…',
              () => {
                if (platformName.trim()) createPlatform(platformName);
                setPlatformName('');
                setNewPlatform(false);
              },
              () => {
                setPlatformName('');
                setNewPlatform(false);
              },
            )
          : (
            <button className="add-line" onClick={() => setNewPlatform(true)}>
              + Add a platform
            </button>
          )}
      </div>

      <div className="info-sec">
        <span className="info-title">
          Labels {manageBtn('labels', labels.length)}
        </span>
        <div className="chips">
          {labels.map((l) => {
            const st = has('labels', l.id);
            return (
              <span key={l.id} className="chip-wrap">
                <button className={`chip toggle ${st}`} style={st === 'off' ? undefined : { borderColor: l.color, background: `${l.color}22` }} onClick={() => toggleLabel(ids, l.id)}>
                  <span className="dot" style={{ background: l.color }} />
                  {l.name}
                </button>
                {managing === 'labels' && (
                  <button className="kill" title={`Delete the label “${l.name}”`} onClick={() => void deleteLabel(l.id)}>
                    ×
                  </button>
                )}
              </span>
            );
          })}
          {!labels.length && <p className="info-note">No labels yet — make one below.</p>}
        </div>
        {newLabel ? (
          <input
            className="tag-input"
            autoFocus
            placeholder="Label name"
            value={labelName}
            onChange={(e) => setLabelName(e.target.value)}
            onBlur={() => {
              if (labelName.trim()) createLabel(labelName, undefined, ids);
              setLabelName('');
              setNewLabel(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setLabelName('');
                setNewLabel(false);
              }
            }}
          />
        ) : (
          <button className="add-line" onClick={() => setNewLabel(true)}>
            + New label for {sel.length === 1 ? 'this' : `these ${sel.length}`}
          </button>
        )}
      </div>

      <div className="info-sec">
        <span className="info-title">
          Groups {manageBtn('groups', groups.length)}
        </span>
        <div className="chips">
          {groups.map((g) => {
            const st = has('groups', g.id);
            return (
              <span key={g.id} className="chip-wrap">
                <button className={`chip toggle ${st}`} onClick={() => toggleGroup(ids, g.id)}>
                  {g.name}
                </button>
                {managing === 'groups' && (
                  <button className="kill" title={`Delete the group “${g.name}”`} onClick={() => void deleteGroup(g.id)}>
                    ×
                  </button>
                )}
              </span>
            );
          })}
          {!groups.length && <p className="info-note">No groups yet.</p>}
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
          <button className="add-line" onClick={() => setNewGroup(true)}>
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
