import { fail, type BackupEnvelope, type Kdf, type Sealed, type VaultEnvelope } from './types.ts';

const encoder = new TextEncoder();
export const ITERATIONS = 600_000;
export const MAX_PLAINTEXT = 6 * 1024 * 1024;

export function base64(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
}

export function unbase64(value: unknown, length?: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > 9 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('invalid_input');
  let text: string;
  try { text = atob(value); } catch { return fail('invalid_input'); }
  const bytes = Uint8Array.from(text, char => char.charCodeAt(0));
  if (length !== undefined && bytes.length !== length) fail('invalid_input');
  return bytes;
}

export function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) fail('weak_password');
  return value;
}

export function masterPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 6 || value.length > 12) fail('weak_master_password');
  return value;
}

export function newKdf(): Kdf {
  return { algorithm: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: base64(crypto.getRandomValues(new Uint8Array(16))) };
}

export async function derive(secret: string, kdf: Kdf): Promise<CryptoKey> {
  if (!kdf || kdf.algorithm !== 'PBKDF2-SHA256' || !Number.isInteger(kdf.iterations) || kdf.iterations < ITERATIONS || kdf.iterations > 2_000_000) fail('invalid_input');
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unbase64(kdf.salt, 16), iterations: kdf.iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function dataKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== 32) fail('invalid_input');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(key: CryptoKey, value: unknown, context: string): Promise<Sealed> {
  const content = encoder.encode(JSON.stringify(value));
  if (content.length > MAX_PLAINTEXT) fail('vault_full');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, content);
  return { iv: base64(iv), ciphertext: base64(new Uint8Array(encrypted)) };
}

export async function unseal<T>(key: CryptoKey, value: Sealed, context: string): Promise<T> {
  if (!value || typeof value !== 'object') fail('invalid_input');
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(value.iv, 12), additionalData: encoder.encode(context) }, key, unbase64(value.ciphertext));
  if (decrypted.byteLength > MAX_PLAINTEXT) fail('vault_full');
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

export function validateEnvelope(raw: unknown): VaultEnvelope {
  if (!raw || typeof raw !== 'object') fail('vault_corrupt');
  const envelope = raw as VaultEnvelope;
  if (envelope.format !== 'credmemo-vault' || envelope.version !== 2 || typeof envelope.id !== 'string' || !/^[0-9a-f-]{36}$/.test(envelope.id) || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1) fail('vault_corrupt');
  return envelope;
}

export const wrapContext = (envelope: VaultEnvelope) => `CredMemo:wrap:2:${envelope.id}:${envelope.kdf.algorithm}:${envelope.kdf.iterations}:${envelope.kdf.salt}`;
export const vaultContext = (envelope: VaultEnvelope) => `CredMemo:vault:2:${envelope.id}:${envelope.revision}`;
const backupContext = (kdf: Kdf) => `CredMemo:backup:2:${kdf.algorithm}:${kdf.iterations}:${kdf.salt}`;

export async function createBackup(secret: unknown, entries: unknown[]): Promise<BackupEnvelope> {
  const kdf = newKdf();
  const key = await derive(password(secret), kdf);
  return { format: 'credmemo-backup', version: 2, kdf, data: await seal(key, { entries }, backupContext(kdf)) };
}

export async function openBackup(secret: unknown, raw: unknown): Promise<unknown[]> {
  try {
    const backup = raw as BackupEnvelope;
    if (!backup || backup.format !== 'credmemo-backup' || backup.version !== 2) fail('backup_invalid');
    const key = await derive(password(secret), backup.kdf);
    const content = await unseal<{ entries: unknown[] }>(key, backup.data, backupContext(backup.kdf));
    if (!Array.isArray(content.entries)) fail('backup_invalid');
    return content.entries;
  } catch { return fail('backup_invalid'); }
}
