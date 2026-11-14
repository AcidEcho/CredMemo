import { fail, type TotpItem } from './types.ts';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(secret: string): Uint8Array<ArrayBuffer> {
  const normalized = secret.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]{16,256}$/.test(normalized) || [1, 3, 6].includes(normalized.length % 8)) fail('invalid_totp');
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  if (bits && (value & ((1 << bits) - 1)) !== 0) fail('invalid_totp');
  return new Uint8Array(bytes);
}

export function normalizeTotp(raw: Record<string, unknown>): TotpItem {
  if (typeof raw.secret !== 'string' || raw.secret.length > 2048) fail('invalid_totp');
  const secret = raw.secret.trim().replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  const label = typeof raw.label === 'string' ? raw.label : '';
  const digits = raw.digits ?? 6, period = raw.period ?? 30, algorithm = raw.algorithm ?? 'SHA1';
  decodeBase32(secret);
  if (![6, 8].includes(Number(digits)) || ![15, 30, 60].includes(Number(period)) || !['SHA1', 'SHA256', 'SHA512'].includes(String(algorithm)) || label.length > 100) fail('invalid_totp');
  return { label, secret, digits: Number(digits) as 6 | 8, period: Number(period) as 15 | 30 | 60, algorithm: algorithm as TotpItem['algorithm'] };
}

export async function generateTotp(token: TotpItem, milliseconds = Date.now()) {
  const counter = BigInt(Math.floor(milliseconds / 1000 / token.period));
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, counter);
  const hash = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }[token.algorithm];
  const key = await crypto.subtle.importKey('raw', decodeBase32(token.secret), { name: 'HMAC', hash }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[digest.length - 1] & 15;
  const value = new DataView(digest.buffer).getUint32(offset) & 0x7fffffff;
  return { code: String(value % (10 ** token.digits)).padStart(token.digits, '0'), period: token.period, expires_at: (Number(counter) + 1) * token.period };
}
