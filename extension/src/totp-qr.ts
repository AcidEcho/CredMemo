import { decodeHex, normalizeTotp } from './totp.ts';
import { counterBased } from './otp-options.ts';
import type { TotpItem } from './types.ts';

// 标准绑定格式仅用于二维码，不接受用户手动粘贴配置链接。
export function totpQrPayload(raw: TotpItem, fallbackLabel: string): string {
  const token = normalizeTotp({ ...raw });
  const label = token.label || fallbackLabel.slice(0, 100) || '2FA';
  let secret = token.secret, type = token.type;
  if (type === 'hex' || type === 'hhex') {
    let bits = 0, value = 0;
    secret = '';
    for (const byte of decodeHex(token.secret)) {
      value = (value << 8) | byte; bits += 8;
      while (bits >= 5) { bits -= 5; secret += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value >>> bits) & 31]; }
    }
    if (bits) secret += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value << (5 - bits)) & 31];
    type = type === 'hhex' ? 'hotp' : 'totp';
  }
  const params = new URLSearchParams({ secret, algorithm: token.algorithm, digits: String(token.digits) });
  if (counterBased(token.type)) params.set('counter', String(token.counter));
  else params.set('period', String(token.period));
  return `otpauth://${type}/${encodeURIComponent(label)}?${params}`;
}
