const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Cryptographically random letters+digits (rejection sampling keeps it unbiased). */
export function randomName(len = 15): string {
  let out = '';
  const buf = new Uint8Array(len * 2);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 248 && out.length < len) out += ALPHABET[b % 62];
    }
  }
  return out;
}

/** Strips characters Windows forbids in filenames, trailing dots/spaces and reserved device names. */
export function sanitizeName(raw: string): string {
  let s = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim().slice(0, 120);
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `${s}_`;
  return s;
}
