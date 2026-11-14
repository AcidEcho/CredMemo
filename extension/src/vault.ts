import { base64, createBackup, dataKey, derive, newKdf, openBackup, password, seal, unbase64, unseal, validateEnvelope, vaultContext, wrapContext } from './crypto.ts';
import { fail, type Entry, type StorageArea, type VaultEnvelope, type VaultSession } from './types.ts';
import { credential, exportEntry, importEntries, publicEntry, storedEntries } from './validation.ts';
import { generateTotp } from './totp.ts';

export const VAULT_KEY = 'credmemo-vault';
export const SESSION_KEY = 'credmemo-session';
export const IDLE_TIMEOUT = 15 * 60 * 1000;

export class Vault {
  private local: StorageArea;
  private session: StorageArea;
  private now: () => number;
  constructor(local: StorageArea, session: StorageArea, now = () => Date.now()) {
    this.local = local;
    this.session = session;
    this.now = now;
  }

  async envelope(): Promise<VaultEnvelope | null> {
    const result = await this.local.get(VAULT_KEY);
    return result[VAULT_KEY] === undefined ? null : validateEnvelope(result[VAULT_KEY]);
  }

  private async remember(envelope: VaultEnvelope, rawKey: string) {
    await this.session.set({ [SESSION_KEY]: { vaultId: envelope.id, key: rawKey, lastActive: this.now() } satisfies VaultSession });
  }

  private async sessionKey(envelope: VaultEnvelope): Promise<string> {
    const value = (await this.session.get(SESSION_KEY))[SESSION_KEY] as VaultSession | undefined;
    if (!value || value.vaultId !== envelope.id || typeof value.key !== 'string' || !Number.isFinite(value.lastActive) || this.now() - value.lastActive >= IDLE_TIMEOUT || value.lastActive > this.now() + 1000) {
      await this.lock();
      return fail('unauthorized');
    }
    unbase64(value.key, 32);
    return value.key;
  }

  async status() {
    const envelope = await this.envelope();
    if (!envelope) return { initialized: false, unlocked: false };
    try { await this.sessionKey(envelope); return { initialized: true, unlocked: true }; }
    catch { return { initialized: true, unlocked: false }; }
  }

  async initialize(secret: unknown) {
    if (await this.envelope()) fail('already_initialized');
    const master = password(secret);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const kdf = newKdf();
    const envelope: VaultEnvelope = { format: 'credmemo-vault', version: 2, id: crypto.randomUUID(), revision: 1, kdf,
      wrappedKey: { iv: '', ciphertext: '' }, data: { iv: '', ciphertext: '' } };
    envelope.wrappedKey = await seal(await derive(master, kdf), { key: base64(raw) }, wrapContext(envelope));
    envelope.data = await seal(await dataKey(raw), { entries: [] }, vaultContext(envelope));
    await this.local.set({ [VAULT_KEY]: envelope });
    await this.remember(envelope, base64(raw));
    return { initialized: true, unlocked: true };
  }

  private async unwrap(envelope: VaultEnvelope, secret: unknown): Promise<string> {
    try {
      const wrapped = await unseal<{ key: string }>(await derive(password(secret), envelope.kdf), envelope.wrappedKey, wrapContext(envelope));
      unbase64(wrapped.key, 32);
      return wrapped.key;
    } catch { return fail('invalid_credentials'); }
  }

  async unlock(secret: unknown) {
    const envelope = await this.envelope();
    if (!envelope) fail('not_initialized');
    const raw = await this.unwrap(envelope, secret);
    try {
      const content = await unseal<{ entries: unknown }>(await dataKey(unbase64(raw, 32)), envelope.data, vaultContext(envelope));
      storedEntries(content.entries);
    } catch { return fail('vault_corrupt'); }
    await this.remember(envelope, raw);
    return { initialized: true, unlocked: true };
  }

  async lock() {
    await this.session.remove(SESSION_KEY);
    return { ok: true };
  }

  async touch() {
    const envelope = await this.envelope();
    if (!envelope) fail('unauthorized');
    const raw = await this.sessionKey(envelope);
    await this.remember(envelope, raw);
    return { expiresAt: this.now() + IDLE_TIMEOUT };
  }

  private async access() {
    const envelope = await this.envelope();
    if (!envelope) fail('unauthorized');
    const key = await dataKey(unbase64(await this.sessionKey(envelope), 32));
    try {
      const content = await unseal<{ entries: unknown }>(key, envelope.data, vaultContext(envelope));
      return { envelope, key, entries: storedEntries(content.entries) };
    } catch { return fail('vault_corrupt'); }
  }

  private async commit(current: Awaited<ReturnType<Vault['access']>>, entries: Entry[]) {
    const latest = await this.envelope();
    if (!latest || latest.revision !== current.envelope.revision || latest.id !== current.envelope.id) fail('conflict');
    await this.sessionKey(latest);
    if (entries.length > 5000) fail('vault_full');
    const next = { ...latest, revision: latest.revision + 1 };
    next.data = await seal(current.key, { entries }, vaultContext(next));
    try { await this.local.set({ [VAULT_KEY]: next }); }
    catch { return fail('storage_failed'); }
  }

  async list() {
    return { entries: (await this.access()).entries.map(publicEntry) };
  }

  async get(id: unknown): Promise<Entry> {
    const entry = (await this.access()).entries.find(value => value.id === id);
    if (!entry) fail('not_found');
    return entry;
  }

  async save(raw: unknown, id?: unknown, version?: unknown) {
    const content = credential(raw);
    const current = await this.access();
    const timestamp = Math.floor(this.now() / 1000);
    let entry: Entry;
    if (id !== undefined && id !== '') {
      const existing = current.entries.find(value => value.id === id);
      if (!existing) fail('not_found');
      if (version !== existing.version) fail('conflict');
      entry = { ...content, id: existing.id, version: existing.version + 1, created_at: existing.created_at, updated_at: timestamp };
      current.entries = current.entries.map(value => value.id === id ? entry : value);
    } else {
      entry = { ...content, id: crypto.randomUUID(), version: 1, created_at: timestamp, updated_at: timestamp };
      current.entries.push(entry);
    }
    await this.commit(current, current.entries);
    return { id: entry.id, version: entry.version };
  }

  async remove(id: unknown, version: unknown) {
    const current = await this.access();
    const existing = current.entries.find(value => value.id === id);
    if (!existing) fail('not_found');
    if (version !== existing.version) fail('conflict');
    await this.commit(current, current.entries.filter(value => value.id !== id));
    return { ok: true };
  }

  async codes() {
    const { entries } = await this.access();
    const now = this.now();
    return { now: now / 1000, codes: Object.fromEntries(await Promise.all(entries.map(async entry =>
      [entry.id, await Promise.all(entry.totps.map(token => generateTotp(token, now)))]))) };
  }

  async backup(secret: unknown) {
    const { entries } = await this.access();
    if (!entries.length) fail('no_entries');
    return createBackup(secret, entries.map(exportEntry));
  }

  async export(secret: unknown) {
    const { envelope, entries } = await this.access();
    await this.unwrap(envelope, secret);
    return { format: 'credmemo-export', version: 1, entries: entries.map(exportEntry) };
  }

  async import(raw: unknown) {
    const validated = importEntries(raw);
    const current = await this.access();
    const timestamp = Math.floor(this.now() / 1000);
    const additions = validated.map(content => ({ ...content, id: crypto.randomUUID(), version: 1, created_at: timestamp, updated_at: timestamp }));
    await this.commit(current, [...current.entries, ...additions]);
    return { imported: additions.length };
  }

  async restore(secret: unknown, backup: unknown) {
    await this.access();
    return this.import(await openBackup(secret, backup));
  }

  async changePassword(currentPassword: unknown, nextPassword: unknown) {
    const { envelope } = await this.access();
    const next = password(nextPassword);
    const raw = await this.unwrap(envelope, currentPassword);
    const kdf = newKdf();
    const changed = { ...envelope, kdf };
    changed.wrappedKey = await seal(await derive(next, kdf), { key: raw }, wrapContext(changed));
    await this.local.set({ [VAULT_KEY]: changed });
    await this.lock();
    return { ok: true };
  }
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
