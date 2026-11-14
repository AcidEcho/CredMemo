import { fail, type Credential } from './types.ts';
import { object, text } from './validation.ts';

export interface EditorDraft {
  id: string;
  version: number;
  entry: Credential;
  tokenIndex: number;
}

// 扫码前允许暂存未填完整的表单，但仍限制字段、数组和编辑版本。
export function editorDraft(raw: unknown): EditorDraft {
  const input = object(raw), entry = object(input.entry);
  const id = text(input.id, 36), version = Number(input.version);
  if (id ? !/^[0-9a-f-]{36}$/.test(id) || !Number.isSafeInteger(version) || version < 1 : version !== 0) fail('invalid_input');
  if (typeof entry.favorite !== 'boolean' || !Array.isArray(entry.logins) || !Array.isArray(entry.totps)
    || entry.logins.length > 30 || entry.totps.length > 30) fail('invalid_input');
  const tokenIndex = input.tokenIndex;
  if (!Number.isInteger(tokenIndex) || Number(tokenIndex) < 0 || Number(tokenIndex) >= entry.totps.length) fail('invalid_input');
  return { id, version, tokenIndex: Number(tokenIndex), entry: {
    title: text(entry.title, 150), url: text(entry.url, 2000), notes: text(entry.notes, 10000), favorite: entry.favorite,
    logins: entry.logins.map(value => {
      const item = object(value);
      return { label: text(item.label, 100), username: text(item.username, 320), password: text(item.password, 1000) };
    }),
    totps: entry.totps.map(value => {
      const item = object(value);
      if (![6, 8].includes(Number(item.digits)) || ![15, 30, 60].includes(Number(item.period)) || !['SHA1', 'SHA256', 'SHA512'].includes(String(item.algorithm))) fail('invalid_input');
      return { label: text(item.label, 100), secret: text(item.secret, 4096), digits: Number(item.digits), period: Number(item.period), algorithm: item.algorithm } as Credential['totps'][number];
    }),
  } };
}
