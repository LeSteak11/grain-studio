// VSCO-style preset names: a letter family, a number, then an optional suffix (A6, A10+, A1Pro, HB1+).
export interface ParsedName {
  family: string;
  num: number;
  suffix: string;
}

const RE = /^([A-Za-z]+)\s*(\d+)?\s*(.*)$/;

export function parseName(name: string): ParsedName {
  const m = RE.exec(name.trim());
  if (!m) return { family: '#', num: 0, suffix: name };
  return { family: (m[1] || '#').toUpperCase(), num: m[2] ? parseInt(m[2], 10) : 0, suffix: (m[3] || '').trim() };
}

/** A1 < A6 < A8+ < A10+ — numbers compared as numbers, not text. */
export function compareNames(a: string, b: string): number {
  const x = parseName(a);
  const y = parseName(b);
  return x.family.localeCompare(y.family) || x.num - y.num || x.suffix.localeCompare(y.suffix) || a.localeCompare(b);
}

/** Families in use, each with its preset count. */
export function familiesOf(names: string[]): { family: string; count: number }[] {
  const m = new Map<string, number>();
  for (const n of names) {
    const f = parseName(n).family;
    m.set(f, (m.get(f) ?? 0) + 1);
  }
  return [...m.entries()].map(([family, count]) => ({ family, count })).sort((a, b) => a.family.localeCompare(b.family));
}

/** Loose match: "a1" hits A1Pro and A10+, "+" hits every plus preset. */
export function matchesQuery(name: string, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return name.toLowerCase().replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));
}

export function groupByFamily<T extends { name: string }>(items: T[]): { family: string; items: T[] }[] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const f = parseName(it.name).family;
    const arr = m.get(f);
    if (arr) arr.push(it);
    else m.set(f, [it]);
  }
  return [...m.entries()]
    .map(([family, list]) => ({ family, items: list.sort((a, b) => compareNames(a.name, b.name)) }))
    .sort((a, b) => a.family.localeCompare(b.family));
}
