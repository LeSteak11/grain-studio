export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Pt = [number, number];

export interface Curves {
  rgb: Pt[];
  r: Pt[];
  g: Pt[];
  b: Pt[];
}

export const IDENTITY_CURVE: Pt[] = [
  [0, 0],
  [1, 1],
];

export function isIdentityCurve(c: Pt[]): boolean {
  return c.every(([x, y]) => Math.abs(x - y) < 1e-4);
}

export interface Photo {
  id: string;
  /** Absolute path of the library copy of the original. */
  file: string;
  name: string;
  size: number;
  w: number;
  h: number;
  added: number;
  fav?: boolean;
  /** Timestamp of the last edited-thumbnail render; 0/undefined = show the plain thumbnail. */
  rev?: number;
  /** A ~2560px preview JPEG exists (fast editor open). */
  pv?: boolean;
  /** When the photo was made: file creation time, or the moment it was dragged/pasted in. */
  created?: number;
  tags?: string[];
  /** Label ids. */
  labels?: string[];
  /** Group (album) ids. */
  groups?: string[];
  /** Platform -> when it was marked posted. */
  posted?: Partial<Record<Platform, number>>;
  /** Caption / notes. */
  note?: string;
  /** Videos only. */
  kind?: 'video';
  /** Duration in seconds (videos). */
  dur?: number;
  /** The file has an audio track. */
  audio?: boolean;
}

export const isVideo = (p: Photo) => p.kind === 'video';

export function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export type Platform = 'ig' | 'threads' | 'other';

export const PLATFORMS: { id: Platform; label: string; short: string }[] = [
  { id: 'ig', label: 'Instagram', short: 'IG' },
  { id: 'threads', label: 'Threads', short: 'TH' },
  { id: 'other', label: 'Other', short: '✓' },
];

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Group {
  id: string;
  name: string;
  created: number;
}

export const LABEL_COLORS = ['#f5a524', '#e5484d', '#46a758', '#3e7bfa', '#9b5de5', '#e93d82', '#12a594', '#8b8b86'];

export const DEFAULT_LABELS: Label[] = [
  { id: 'l-topost', name: 'To post', color: '#f5a524' },
  { id: 'l-best', name: 'Best', color: '#46a758' },
  { id: 'l-draft', name: 'Draft', color: '#3e7bfa' },
];

export const createdOf = (p: Photo) => p.created ?? p.added;
export const isPosted = (p: Photo) => !!p.posted && Object.keys(p.posted).length > 0;

/** Non-destructive edit recipe. Tool values: bipolar -1..1, unipolar 0..1. */
export interface EditState {
  preset: string | null;
  strength: number;
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  fade: number;
  temperature: number;
  tint: number;
  saturation: number;
  skin: number;
  clarity: number;
  sharpen: number;
  vignette: number;
  grain: number;
  grainSize: number;
  splitShadowHue: number;
  splitShadow: number;
  splitHighlightHue: number;
  splitHighlight: number;
  /** 6 bands x [hue, saturation, lightness]. */
  hsl: number[];
  curve: Curves;
  /** Video trim, in seconds. trimOut 0 means "to the end". */
  trimIn: number;
  trimOut: number;
  /** Split points in seconds, each starting a new clip. */
  splits: number[];
  mute: boolean;
  volume: number;
  crop: Crop;
  aspect: string;
  rotate: number;
  flip: boolean;
  straighten: number;
}

export type NumKey = { [K in keyof EditState]: EditState[K] extends number ? K : never }[keyof EditState];

export interface Recipe {
  id: string;
  name: string;
  edit: EditState;
}

export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 };

export const DEFAULT_EDIT: EditState = {
  preset: null,
  strength: 1,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  fade: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  skin: 0,
  clarity: 0,
  sharpen: 0,
  vignette: 0,
  grain: 0,
  grainSize: 0.5,
  splitShadowHue: 0.55,
  splitShadow: 0,
  splitHighlightHue: 0.08,
  splitHighlight: 0,
  hsl: new Array(18).fill(0),
  trimIn: 0,
  trimOut: 0,
  splits: [],
  mute: false,
  volume: 1,
  curve: { rgb: IDENTITY_CURVE, r: IDENTITY_CURVE, g: IDENTITY_CURVE, b: IDENTITY_CURVE },
  crop: FULL_CROP,
  aspect: 'free',
  rotate: 0,
  flip: false,
  straighten: 0,
};

export function defaultEdit(): EditState {
  return { ...DEFAULT_EDIT, hsl: new Array(18).fill(0), splits: [], curve: { ...DEFAULT_EDIT.curve }, crop: { ...FULL_CROP } };
}

export function normalizeEdit(raw: unknown): EditState {
  const d = defaultEdit();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const out = { ...d } as Record<string, unknown>;
  for (const k of Object.keys(d)) {
    if (k in r && typeof r[k] === typeof (d as unknown as Record<string, unknown>)[k]) out[k] = r[k];
  }
  out.preset = typeof r.preset === 'string' ? r.preset : null;
  out.hsl = Array.isArray(r.hsl) && r.hsl.length === 18 ? r.hsl.map(Number) : d.hsl;
  out.splits = Array.isArray(r.splits) ? r.splits.filter((n) => typeof n === 'number' && n > 0).sort((a, b) => a - b) : [];
  const cv = r.curve as Record<string, unknown> | undefined;
  const okPts = (v: unknown): v is Pt[] =>
    Array.isArray(v) && v.length >= 2 && v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number'));
  out.curve = cv
    ? {
        rgb: okPts(cv.rgb) ? cv.rgb : IDENTITY_CURVE,
        r: okPts(cv.r) ? cv.r : IDENTITY_CURVE,
        g: okPts(cv.g) ? cv.g : IDENTITY_CURVE,
        b: okPts(cv.b) ? cv.b : IDENTITY_CURVE,
      }
    : d.curve;
  const c = r.crop as Crop | undefined;
  out.crop = c && [c.x, c.y, c.w, c.h].every((n) => typeof n === 'number') ? { x: c.x, y: c.y, w: c.w, h: c.h } : d.crop;
  return out as unknown as EditState;
}

const TOOL_KEYS: NumKey[] = [
  'exposure', 'contrast', 'highlights', 'shadows', 'fade', 'temperature', 'tint', 'saturation',
  'skin', 'clarity', 'sharpen', 'vignette', 'grain', 'splitShadow', 'splitHighlight',
];

export function hasGeometry(e: EditState): boolean {
  const c = e.crop;
  return e.rotate !== 0 || e.flip || e.straighten !== 0 || c.x !== 0 || c.y !== 0 || c.w !== 1 || c.h !== 1;
}

/** Trim/split/mute changes count as edits for videos. */
export function hasVideoEdit(e: EditState): boolean {
  return e.trimIn > 0.001 || e.trimOut > 0.001 || e.splits.length > 0 || e.mute || e.volume !== 1;
}

export function hasCurve(e: EditState): boolean {
  const c = e.curve;
  return !(isIdentityCurve(c.rgb) && isIdentityCurve(c.r) && isIdentityCurve(c.g) && isIdentityCurve(c.b));
}

export function isEdited(e?: EditState | null): boolean {
  if (!e) return false;
  if (e.preset) return true;
  if (TOOL_KEYS.some((k) => Math.abs(e[k]) > 1e-4)) return true;
  if (e.hsl.some((v) => Math.abs(v) > 1e-4)) return true;
  if (hasCurve(e)) return true;
  if (hasVideoEdit(e)) return true;
  return hasGeometry(e);
}

export type PasteMode = 'all' | 'preset' | 'tools';

/** Preset-only paste: take src's preset + strength, keep everything else. */
export function presetOf(src: EditState, target: EditState): EditState {
  return { ...target, preset: src.preset, strength: src.strength };
}

/** Tools-only paste: src's adjustments, target's preset and framing. */
export function toolsOf(src: EditState, target: EditState): EditState {
  return { ...withGeometryOf(src, target), preset: target.preset, strength: target.strength };
}

/** Paste semantics: take the look from `src`, keep the target's framing. */
export function withGeometryOf(src: EditState, target: EditState): EditState {
  return {
    ...src,
    hsl: [...src.hsl],
    // Trim points belong to the target clip, not the copied look.
    trimIn: target.trimIn,
    trimOut: target.trimOut,
    splits: [...target.splits],
    mute: target.mute,
    volume: target.volume,
    crop: { ...target.crop },
    aspect: target.aspect,
    rotate: target.rotate,
    flip: target.flip,
    straighten: target.straighten,
  };
}

export interface ToolDef {
  key: NumKey;
  label: string;
  bi: boolean;
}

export const TOOL_SECTIONS: { title: string; tools: ToolDef[] }[] = [
  {
    title: 'Light',
    tools: [
      { key: 'exposure', label: 'Exposure', bi: true },
      { key: 'contrast', label: 'Contrast', bi: true },
      { key: 'highlights', label: 'Highlights', bi: true },
      { key: 'shadows', label: 'Shadows', bi: true },
      { key: 'fade', label: 'Fade', bi: false },
    ],
  },
  {
    title: 'Color',
    tools: [
      { key: 'temperature', label: 'Temperature', bi: true },
      { key: 'tint', label: 'Tint', bi: true },
      { key: 'saturation', label: 'Saturation', bi: true },
      { key: 'skin', label: 'Skin Tone', bi: true },
    ],
  },
  {
    title: 'Detail',
    tools: [
      { key: 'clarity', label: 'Clarity', bi: false },
      { key: 'sharpen', label: 'Sharpen', bi: false },
      { key: 'vignette', label: 'Vignette', bi: false },
      { key: 'grain', label: 'Grain', bi: false },
      { key: 'grainSize', label: 'Grain Size', bi: false },
    ],
  },
];

export const HSL_BANDS = [
  { name: 'Red', color: '#e5484d' },
  { name: 'Orange', color: '#f5a524' },
  { name: 'Yellow', color: '#f2d33a' },
  { name: 'Green', color: '#46a758' },
  { name: 'Blue', color: '#3e7bfa' },
  { name: 'Purple', color: '#9b5de5' },
];

/** Hue swatches for split tone (0..1 hue). */
export const SPLIT_HUES = [0.0, 0.07, 0.13, 0.3, 0.5, 0.58, 0.72, 0.88];

export function hueCss(h: number): string {
  return `hsl(${Math.round(h * 360)} 75% 55%)`;
}
