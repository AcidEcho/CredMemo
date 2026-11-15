import { fail, type TotpItem } from './types.ts';
import { streebog256hmac, streebog512hmac } from '@li0ard/gost/hmac.js';
import { counterBased, otpOptions } from './otp-options.ts';

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
  let options = otpOptions(raw);
  // 与 Authenticator 一致：非 Base32 字符构成的十六进制密钥自动识别为 HEX 类型。
  if ((!raw.type || raw.type === 'totp' || raw.type === 'hotp') && !/^[A-Z2-7]+$/.test(secret) && /^[0-9A-F]+$/.test(secret)) {
    options = otpOptions({ ...raw, type: counterBased(String(raw.type)) ? 'hhex' : 'hex' });
  }
  if (options.type === 'hex' || options.type === 'hhex') decodeHex(secret);
  else decodeBase32(secret);
  if (label.length > 100) fail('invalid_totp');
  return { label, secret, ...options };
}

export function decodeHex(secret: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9A-Fa-f]{2}){8,256}$/.test(secret)) fail('invalid_totp');
  return Uint8Array.from(secret.match(/../g)!, pair => parseInt(pair, 16));
}

export async function generateTotp(token: TotpItem, milliseconds = Date.now()) {
  const event = counterBased(token.type);
  const counter = BigInt(event ? token.counter ?? 0 : Math.floor(milliseconds / 1000 / token.period));
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, counter);
  const secret = token.type === 'hex' || token.type === 'hhex' ? decodeHex(token.secret) : decodeBase32(token.secret);
  let digest: Uint8Array;
  if (token.algorithm === 'GOST3411_2012_256') digest = streebog256hmac(secret, message);
  else if (token.algorithm === 'GOST3411_2012_512') digest = streebog512hmac(secret, message);
  else {
    const hash = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }[token.algorithm];
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash }, false, ['sign']);
    digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  }
  const offset = digest[digest.length - 1] & 15;
  let value = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(offset) & 0x7fffffff;
  let code = '';
  if (token.type === 'steam') {
    const chars = '23456789BCDFGHJKMNPQRTVWXY';
    for (let i = 0; i < 5; i++) { code += chars[value % chars.length]; value = Math.floor(value / chars.length); }
  } else {
    const digits = token.type === 'battle' ? 8 : token.digits;
    code = String(value % (10 ** digits)).padStart(digits, '0');
  }
  return { code, period: event ? 0 : token.period, expires_at: event ? 0 : (Number(counter) + 1) * token.period,
    ...(event ? { counter: token.counter ?? 0 } : {}) };
}
