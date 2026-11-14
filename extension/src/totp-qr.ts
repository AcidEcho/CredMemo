import { normalizeTotp } from './totp.ts';
import type { TotpItem } from './types.ts';

// 标准绑定格式仅用于二维码，不接受用户手动粘贴配置链接。
export function totpQrPayload(raw: TotpItem, fallbackLabel: string): string {
  const token = normalizeTotp({ ...raw });
  const label = token.label || fallbackLabel.slice(0, 100) || '2FA';
  const params = new URLSearchParams({ secret: token.secret, algorithm: token.algorithm,
    digits: String(token.digits), period: String(token.period) });
  return `otpauth://totp/${encodeURIComponent(label)}?${params}`;
}
