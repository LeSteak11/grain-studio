// Online sound search. Two catalogues, both free, both needing a key you paste in once:
//   Jamendo   - music, Creative Commons, good for beds and full songs.
//   Freesound - effects, Creative Commons, good for whooshes, risers and stings.
// Neither carries chart music or TikTok remixes; nothing legal does.
import { fsx } from './fs';
import { store } from './store';
import { addTrack, type TrackMeta } from './sound';

export type Provider = 'jamendo' | 'freesound';

export const PROVIDERS: { id: Provider; name: string; kind: string; keyUrl: string; keyLabel: string }[] = [
  { id: 'jamendo', name: 'Jamendo', kind: 'Music', keyUrl: 'https://devportal.jamendo.com/signup', keyLabel: 'Client ID' },
  { id: 'freesound', name: 'Freesound', kind: 'Effects', keyUrl: 'https://freesound.org/apiv2/apply/', keyLabel: 'API key' },
];

export interface Found {
  key: string;
  provider: Provider;
  name: string;
  artist: string;
  dur: number;
  tags: string[];
  license: string;
  /** Page to credit. */
  url: string;
  /** Streamable + downloadable mp3. */
  audio: string;
}

const q = (s: string) => encodeURIComponent(s.trim());

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);

/** A missing key is the normal state, not an error — the UI asks for one. */
export class NeedsKey extends Error {
  constructor(public provider: Provider) {
    super('key needed');
  }
}

async function searchJamendo(query: string, key: string): Promise<Found[]> {
  if (!key) throw new NeedsKey('jamendo');
  const url =
    `https://api.jamendo.com/v3.0/tracks/?client_id=${q(key)}&format=json&limit=40&audioformat=mp32` +
    `&include=musicinfo&groupby=artist_id&search=${q(query)}`;
  const raw = await fsx.fetchText(url);
  const json = JSON.parse(raw) as Record<string, unknown>;
  const head = json.headers as Record<string, unknown> | undefined;
  if (head && str(head.status) === 'failed') throw new Error(str(head.error_message, 'Jamendo refused that request'));
  return asArray(json.results)
    .map((r): Found | null => {
      const t = r as Record<string, unknown>;
      const info = t.musicinfo as Record<string, unknown> | undefined;
      const tags = info?.tags as Record<string, unknown> | undefined;
      const audio = str(t.audio) || str(t.audiodownload);
      if (!audio) return null;
      return {
        key: `j${str(t.id)}`,
        provider: 'jamendo' as const,
        name: str(t.name, 'Untitled'),
        artist: str(t.artist_name),
        dur: num(t.duration),
        tags: [...asArray(tags?.genres), ...asArray(tags?.vartags)].map((x) => str(x)).filter(Boolean).slice(0, 6),
        license: `Jamendo · ${str(t.license_ccurl) ? 'Creative Commons' : 'see track page'}`,
        url: str(t.shareurl) || str(t.license_ccurl),
        audio,
      };
    })
    .filter((x): x is Found => !!x);
}

async function searchFreesound(query: string, key: string): Promise<Found[]> {
  if (!key) throw new NeedsKey('freesound');
  const url =
    'https://freesound.org/apiv2/search/text/?page_size=40&sort=score' +
    `&fields=id,name,username,duration,previews,license,url,tags&query=${q(query)}`;
  const raw = await fsx.fetchText(url, `Token ${key.trim()}`);
  const json = JSON.parse(raw) as Record<string, unknown>;
  if (typeof json.detail === 'string') throw new Error(json.detail);
  return asArray(json.results)
    .map((r): Found | null => {
      const t = r as Record<string, unknown>;
      const pv = t.previews as Record<string, unknown> | undefined;
      const audio = str(pv?.['preview-hq-mp3']) || str(pv?.['preview-lq-mp3']);
      if (!audio) return null;
      return {
        key: `f${str(t.id) || num(t.id)}`,
        provider: 'freesound' as const,
        name: str(t.name, 'Untitled'),
        artist: str(t.username),
        dur: num(t.duration),
        tags: asArray(t.tags).map((x) => str(x)).filter(Boolean).slice(0, 6),
        license: `Freesound · ${str(t.license, 'see sound page')}`,
        url: str(t.url),
        audio,
      };
    })
    .filter((x): x is Found => !!x);
}

export async function searchSounds(provider: Provider, query: string): Promise<Found[]> {
  if (!query.trim()) return [];
  const keys = store.get().soundKeys;
  return provider === 'jamendo' ? searchJamendo(query, keys.jamendo) : searchFreesound(query, keys.freesound);
}

/** Downloads a search result into the sound library. */
export async function saveFound(f: Found) {
  const bytes = await fsx.download(f.audio);
  const meta: TrackMeta = {
    name: f.name,
    artist: f.artist || undefined,
    tags: f.tags,
    from: f.provider,
    license: f.license,
    url: f.url || undefined,
  };
  const track = await addTrack(bytes, 'mp3', meta);
  if (!track) throw new Error('that download was not playable audio');
  return track;
}
