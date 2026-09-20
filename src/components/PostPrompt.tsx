import { useEffect } from 'react';
import { setPosted } from '../lib/organize';
import { store, toast, useStore } from '../lib/store';


/** Shown after dragging photos out: one click records where they went. */
export function PostPrompt() {
  const p = useStore((s) => s.postPrompt);
  const platforms = useStore((s) => s.platforms);
  useEffect(() => {
    if (!p) return;
    const t = window.setTimeout(() => store.set({ postPrompt: null }), 20000);
    return () => clearTimeout(t);
  }, [p]);
  if (!p) return null;
  const close = () => store.set({ postPrompt: null });
  const mark = (id: string, label: string) => {
    setPosted(p.ids, id, true);
    close();
    toast(`Marked as posted to ${label}`);
  };
  return (
    <div className="post-prompt">
      <span>
        Posted {p.ids.length === 1 ? 'that' : `those ${p.ids.length}`}?
      </span>
      {platforms.map((pl) => (
        <button key={pl.id} onClick={() => mark(pl.id, pl.name)}>
          {pl.name}
        </button>
      ))}
      <button className="dim" onClick={close}>
        Not yet
      </button>
    </div>
  );
}
