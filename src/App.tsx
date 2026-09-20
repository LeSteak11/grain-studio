import { useEffect } from 'react';
import { Library } from './components/Library';
import { Editor } from './components/Editor';
import { ExportDialog } from './components/ExportDialog';
import { PresetLab } from './components/PresetLab';
import { PostPrompt } from './components/PostPrompt';
import { initApp } from './lib/library';
import { useStore } from './lib/store';

function Busy() {
  const busy = useStore((s) => s.busy);
  if (!busy) return null;
  const pct = busy.total ? Math.round((busy.done / busy.total) * 100) : null;
  return (
    <div className="busy">
      <span>
        {busy.label}
        {busy.total ? ` ${busy.done}/${busy.total}` : '…'}
      </span>
      <div className="bar">
        <div className={pct === null ? 'indet' : ''} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Toast() {
  const t = useStore((s) => s.toast);
  return t ? <div className="toast">{t}</div> : null;
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const error = useStore((s) => s.error);
  const view = useStore((s) => s.view);
  const modal = useStore((s) => s.modal);
  const dragOver = useStore((s) => s.dragOver);

  useEffect(() => {
    void initApp();
    const block = (e: MouseEvent) => {
      if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
    };
    window.addEventListener('contextmenu', block);
    return () => window.removeEventListener('contextmenu', block);
  }, []);

  if (error) {
    return (
      <div className="splash">
        <p>Couldn't open the library.</p>
        <code>{error}</code>
      </div>
    );
  }
  if (!ready) return <div className="splash" />;

  return (
    <>
      {view === 'editor' ? <Editor /> : <Library />}
      {modal === 'export' && <ExportDialog />}
      {modal === 'lab' && <PresetLab />}
      {dragOver && <div className="drop-hint">Drop to import</div>}
      <PostPrompt />
      <Busy />
      <Toast />
    </>
  );
}
