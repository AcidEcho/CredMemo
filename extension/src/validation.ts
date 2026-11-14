import { fail, type Credential, type Entry, type LoginItem } from './types.ts';
import { normalizeTotp } from './totp.ts';

export function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_input');
  return raw as Record<string, unknown>;
}

export function text(raw: unknown, maximum: number, fallback = ''): string {
  const value = raw ?? fallback;
  if (typeof value !== 'string' || value.length > maximum) fail('invalid_input');
  return value;
}

export function origin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

function login(raw: unknown): LoginItem {
  const item = object(raw);
  const username = text(item.username, 320), password = text(item.password, 1000);
  if (!username.trim() && !password) fail('credential_required');
  return { label: text(item.label, 100), username, password };
}

export function credential(raw: unknown): Credential {
  const item = object(raw);
  const title = text(item.title, 150).trim();
  if (!title) fail('title_required');
  let url = text(item.url, 2000).trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (url && (!origin(url) || /\s/.test(url))) fail('invalid_url');
  const logins = item.logins ?? [], totps = item.totps ?? [];
  if (!Array.isArray(logins) || !Array.isArray(totps) || logins.length > 30 || totps.length > 30) fail('invalid_input');
  if (!logins.length && !totps.length) fail('credential_required');
  if (item.favorite !== undefined && typeof item.favorite !== 'boolean') fail('invalid_input');
  return { title, url, notes: text(item.notes, 10000), favorite: item.favorite === true,
    logins: logins.map(login), totps: totps.map(value => normalizeTotp(object(value))) };
}

export function importEntries(raw: unknown): Credential[] {
  if (!Array.isArray(raw) || raw.length > 5000) fail('import_invalid');
  if (!raw.length) fail('empty_import');
  return raw.map(credential);
}

export function storedEntries(raw: unknown): Entry[] {
  if (!Array.isArray(raw) || raw.length > 5000) fail('vault_corrupt');
  const ids = new Set<string>();
  return raw.map(value => {
    const item = object(value);
    const id = text(item.id, 36);
    if (!/^[0-9a-f-]{36}$/.test(id) || ids.has(id) || !Number.isSafeInteger(item.version) || Number(item.version) < 1 || !Number.isSafeInteger(item.created_at) || !Number.isSafeInteger(item.updated_at)) fail('vault_corrupt');
    ids.add(id);
    return { ...credential(item), id, version: Number(item.version), created_at: Number(item.created_at), updated_at: Number(item.updated_at) };
  });
}

export function publicEntry(entry: Entry) {
  return { ...entry, logins: entry.logins.map(({ password: _password, ...item }) => item), totps: entry.totps.map(({ secret: _secret, ...item }) => item) };
}

export function exportEntry(entry: Entry): Credential {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...content } = entry;
  return content;
}
