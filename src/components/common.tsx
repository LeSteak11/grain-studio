import { fileUrl, paths } from '../lib/fs';
import { useStore } from '../lib/store';
import type { Photo } from '../lib/types';

export function thumbUrl(p: Photo): string {
  return p.rev ? fileUrl(paths.editedThumb(p.id), p.rev) : fileUrl(paths.thumb(p.id));
}

export function SaveState() {
  const saving = useStore((s) => s.saving);
  return <span className={`save-state${saving ? ' saving' : ''}`}>{saving ? 'Saving…' : 'Saved'}</span>;
}
