import { useEffect, useMemo, useRef, useState } from 'react';
import { fileUrl } from '../lib/fs';
import { commit, getEdit } from '../lib/history';
import { pickAndImportAudio, removeTrack, renameTrack, toggleTrackFav } from '../lib/sound';
import { NeedsKey, PROVIDERS, saveFound, searchSounds, type Found, type Provider } from '../lib/soundsearch';
import { store, toast, useStore } from '../lib/store';
import { fmtTime, type Track } from '../lib/types';

function Wave({ peaks, className }: { peaks?: number[]; className?: string }) {
  if (!peaks?.length) return <div className={`wave empty${className ? ` ${className}` : ''}`} />;
  // One bar per ~4 buckets keeps the row light without losing the shape.
  const step = Math.max(1, Math.round(peaks.length / 80));
  const bars: number[] = [];
  for (let i = 0; i < peaks.length; i += step) bars.push(Math.max(...peaks.slice(i, i + step)));
  return (
    <div className={`wave${className ? ` ${className}` : ''}`}>
      {bars.map((v, i) => (
        <i key={i} style={{ height: `${Math.max(6, v * 100)}%` }} />
      ))}
    </div>
  );
}

/** One shared preview player, so starting a sound stops whatever was playing. */
function usePreview() {
  const elRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => {
    const el = new Audio();
    el.preload = 'none';
    el.addEventListener('ended', () => setPlaying(null));
    elRef.current = el;
    return () => {
      el.pause();
      el.src = '';
    };
  }, []);
  const toggle = (key: string, src: string) => {
    const el = elRef.current;
    if (!el) return;
    if (playing === key) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.src = src;
    el.currentTime = 0;
    void el.play().then(
      () => setPlaying(key),
      () => toast('Could not play that sound'),
    );
  };
  return { playing, toggle };
}

function MySounds({ onPick }: { onPick: ((t: Track) => void) | null }) {
  const tracks = useStore((s) => s.tracks);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const { playing, toggle } = usePreview();

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = tracks.filter((t) => {
      if (!words.length) return true;
      const hay = `${t.name} ${t.artist ?? ''} ${(t.tags ?? []).join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    return [...hit].sort((a, b) => Number(!!b.fav) - Number(!!a.fav) || b.added - a.added);
  }, [tracks, q]);

  return (
    <>
      <div className="sound-tools">
        <input className="sound-search" placeholder="Search your sounds" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <button className="ghost" onClick={() => void pickAndImportAudio()}>
          + Add files
        </button>
      </div>
      {!tracks.length && (
        <p className="sound-empty">
          No sounds yet. Add MP3s or WAVs from your computer, or search Jamendo and Freesound on the next tab.
        </p>
      )}
      <div className="sound-list">
        {list.map((t) => (
          <div className="sound-row" key={t.id}>
            <button className="icon play" onClick={() => toggle(t.id, fileUrl(t.file))} title="Preview">
              {playing === t.id ? '❚❚' : '▶'}
            </button>
            <div className="sound-meta">
              {editing === t.id ? (
                <input
                  className="sound-rename"
                  autoFocus
                  defaultValue={t.name}
                  onBlur={(e) => {
                    renameTrack(t.id, e.target.value);
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <span className="sound-name" onDoubleClick={() => setEditing(t.id)} title="Double-click to rename">
                  {t.name}
                </span>
              )}
              <span className="sound-sub">
                {t.artist ? `${t.artist} · ` : ''}
                {fmtTime(t.dur)}
                {t.from && t.from !== 'local' ? ` · ${t.from}` : ''}
              </span>
            </div>
            <Wave peaks={t.peaks} />
            <button className={`icon${t.fav ? ' on' : ''}`} onClick={() => toggleTrackFav(t.id)} title="Favourite">
              {t.fav ? '★' : '☆'}
            </button>
            <button className="icon" onClick={() => void removeTrack(t.id)} title="Remove from the sound library">
              ✕
            </button>
            {onPick && (
              <button className="primary" onClick={() => onPick(t)}>
                Use
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function Online({ onPick }: { onPick: ((t: Track) => void) | null }) {
  const keys = useStore((s) => s.soundKeys);
  const [provider, setProvider] = useState<Provider>('jamendo');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Found[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [needKey, setNeedKey] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const { playing, toggle } = usePreview();

  const meta = PROVIDERS.find((p) => p.id === provider)!;
  const key = keys[provider];

  const run = async () => {
    if (!q.trim()) return;
    setStatus('Searching…');
    setResults([]);
    setNeedKey(false);
    try {
      const found = await searchSounds(provider, q);
      setResults(found);
      setStatus(found.length ? null : 'Nothing matched that.');
    } catch (e) {
      if (e instanceof NeedsKey) {
        setNeedKey(true);
        setStatus(null);
      } else {
        setStatus(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const save = async (f: Found) => {
    setSaving(f.key);
    try {
      const t = await saveFound(f);
      toast(`Added ${t.name}`);
      onPick?.(t);
    } catch (e) {
      toast(`Could not add that: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <div className="sound-tools">
        <div className="seg">
          {PROVIDERS.map((p) => (
            <button key={p.id} className={provider === p.id ? 'on' : ''} onClick={() => setProvider(p.id)}>
              {p.name}
              <span className="dim"> · {p.kind}</span>
            </button>
          ))}
        </div>
        <input
          className="sound-search"
          placeholder={provider === 'jamendo' ? 'lofi, dreamy guitar, slow piano…' : 'whoosh, riser, camera shutter…'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run()}
        />
        <button className="ghost" onClick={() => void run()}>
          Search
        </button>
      </div>

      {(needKey || !key) && (
        <div className="sound-key">
          <p>
            {meta.name} needs a free {meta.keyLabel} before it will answer. Make one at <code>{meta.keyUrl}</code>, then paste it here — it is
            saved with your library and only used for searching.
          </p>
          <input
            placeholder={`${meta.name} ${meta.keyLabel}`}
            defaultValue={key}
            onBlur={(e) => store.set({ soundKeys: { ...keys, [provider]: e.target.value.trim() } })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </div>
      )}

      <p className="sound-note">
        These are Creative Commons catalogues, not the TikTok or Reels sound library — that music is licensed to those apps and only they can
        attach it. For a trending sound, export your clip silent and add it in the app when you post.
      </p>

      {status && <p className="sound-empty">{status}</p>}

      <div className="sound-list">
        {results.map((f) => (
          <div className="sound-row" key={f.key}>
            <button className="icon play" onClick={() => toggle(f.key, f.audio)} title="Preview">
              {playing === f.key ? '❚❚' : '▶'}
            </button>
            <div className="sound-meta">
              <span className="sound-name">{f.name}</span>
              <span className="sound-sub">
                {f.artist ? `${f.artist} · ` : ''}
                {fmtTime(f.dur)} · {f.license}
              </span>
            </div>
            <span className="sound-tags">{f.tags.slice(0, 3).join(' · ')}</span>
            <button className="primary" disabled={saving === f.key} onClick={() => void save(f)}>
              {saving === f.key ? 'Adding…' : 'Add'}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

export function SoundPicker() {
  const forId = useStore((s) => s.soundFor);
  const [tab, setTab] = useState<'mine' | 'online'>('mine');
  const close = () => store.set({ modal: null, soundFor: null });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Attaching a sound starts it at the top of the track at full level.
  const pick = forId
    ? (t: Track) => {
        const e = getEdit(forId);
        commit(forId, { ...e, sound: t.id, soundStart: 0, soundVolume: e.soundVolume || 1 });
        toast(`${t.name} added to the clip`);
        close();
      }
    : null;

  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal sounds" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sound-head">
          <h3>{forId ? 'Choose a sound' : 'Sound library'}</h3>
          <div className="seg">
            <button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>
              My sounds
            </button>
            <button className={tab === 'online' ? 'on' : ''} onClick={() => setTab('online')}>
              Search online
            </button>
          </div>
          <button className="icon" onClick={close} title="Close (Esc)">
            ✕
          </button>
        </div>
        {tab === 'mine' ? <MySounds onPick={pick} /> : <Online onPick={pick} />}
      </div>
    </div>
  );
}
