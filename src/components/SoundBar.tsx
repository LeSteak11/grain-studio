import { useEffect, useRef, useState } from 'react';
import { clamp } from '../lib/geometry';
import { begin, commit, getEdit, setEdit } from '../lib/history';
import { ensurePeaks, trackById } from '../lib/sound';
import { store } from '../lib/store';
import { fmtTime, type EditState } from '../lib/types';

interface Props {
  id: string;
  edit: EditState;
  /** Length of the finished clip, so the strip can show how much of the track is used. */
  outDur: number;
}

/** The soundtrack strip under the video transport: pick where the song starts, and how it sits. */
export function SoundBar({ id, edit, outDur }: Props) {
  const track = trackById(edit.sound);
  const [peaks, setPeaks] = useState<number[] | undefined>(track?.peaks);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPeaks(track?.peaks);
    if (track && !track.peaks?.length) void ensurePeaks(track.id).then((p) => setPeaks(p ?? undefined));
  }, [track?.id, track?.peaks]);

  if (!track) return null;

  const dur = Math.max(0.001, track.dur);
  const startPct = (clamp(edit.soundStart, 0, dur) / dur) * 100;
  const usedPct = Math.min(100 - startPct, (outDur / dur) * 100);
  const loops = outDur > dur - edit.soundStart + 0.05;

  const startAt = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * dur, 0, Math.max(0, dur - 0.05));
  };

  const dragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    begin(id);
    const move = (ev: PointerEvent) => setEdit(id, { ...getEdit(id), soundStart: startAt(ev.clientX) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    setEdit(id, { ...getEdit(id), soundStart: startAt(e.clientX) });
  };

  const num = (key: 'soundVolume' | 'soundDuck' | 'soundFadeIn' | 'soundFadeOut', v: number) => setEdit(id, { ...getEdit(id), [key]: v });

  return (
    <div className="sound-bar">
      <div className="sound-bar-head">
        <span className="sb-icon">♪</span>
        <span className="sb-name" title={track.artist ? `${track.name} — ${track.artist}` : track.name}>
          {track.name}
          {track.artist && <span className="dim"> · {track.artist}</span>}
        </span>
        <span className="dim sb-time">
          from {fmtTime(edit.soundStart)}
          {loops ? ' · loops' : ''}
        </span>
        <span className="spacer" />
        <button className="ghost" onClick={() => store.set({ modal: 'sounds', soundFor: id })}>
          Change
        </button>
        <button className="ghost" onClick={() => commit(id, { ...getEdit(id), sound: null })} title="Take the soundtrack off this clip">
          Remove
        </button>
      </div>

      <div className="sb-wave" ref={barRef} onPointerDown={dragStart} title="Drag to choose where the song starts">
        {peaks?.length ? (
          peaks.map((v, i) => <i key={i} style={{ height: `${Math.max(6, v * 100)}%` }} />)
        ) : (
          <span className="dim sb-loading">reading waveform…</span>
        )}
        <div className="sb-used" style={{ left: `${startPct}%`, width: `${Math.max(1, usedPct)}%` }} />
        <div className="sb-start" style={{ left: `${startPct}%` }} />
      </div>

      <div className="sb-knobs">
        <label>
          <span>Sound</span>
          <input type="range" className="plain" min={0} max={1} step={0.01} value={edit.soundVolume} onPointerDown={() => begin(id)} onChange={(e) => num('soundVolume', +e.target.value)} />
          <b>{Math.round(edit.soundVolume * 100)}%</b>
        </label>
        <label title="How much of the clip's own audio stays under the soundtrack">
          <span>Original</span>
          <input type="range" className="plain" min={0} max={1} step={0.01} value={edit.soundDuck} onPointerDown={() => begin(id)} onChange={(e) => num('soundDuck', +e.target.value)} />
          <b>{Math.round(edit.soundDuck * 100)}%</b>
        </label>
        <label>
          <span>Fade in</span>
          <input type="range" className="plain" min={0} max={3} step={0.1} value={edit.soundFadeIn} onPointerDown={() => begin(id)} onChange={(e) => num('soundFadeIn', +e.target.value)} />
          <b>{edit.soundFadeIn.toFixed(1)}s</b>
        </label>
        <label>
          <span>Fade out</span>
          <input type="range" className="plain" min={0} max={3} step={0.1} value={edit.soundFadeOut} onPointerDown={() => begin(id)} onChange={(e) => num('soundFadeOut', +e.target.value)} />
          <b>{edit.soundFadeOut.toFixed(1)}s</b>
        </label>
      </div>
    </div>
  );
}
