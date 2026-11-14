import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, SerialQueue, VAULT_KEY, SESSION_KEY, IDLE_TIMEOUT } from '../../extension/src/vault.ts';
import { dataKey, seal, unseal, MAX_PLAINTEXT } from '../../extension/src/crypto.ts';
import { credential, publicEntry } from '../../extension/src/validation.ts';
import type { StorageArea, Credential, VaultEnvelope } from '../../extension/src/types.ts';

class MemoryStorage implements StorageArea {
  values: Record<string, unknown> = {};
  rejectWrites = false;
  async get(key: string) { return structuredClone({ [key]: this.values[key] }); }
  async set(values: Record<string, unknown>) {
    if (this.rejectWrites) throw new Error('quota');
    Object.assign(this.values, structuredClone(values));
  }
  async remove(key: string) { delete this.values[key]; }
}

const sample = (): Credential => ({ title: 'Synthetic fixture', url: 'https://login.example.test', notes: '<script>fixture</script>', favorite: false,
  logins: [{ label: 'First', username: 'fixture@example.test', password: crypto.randomUUID() }, { label: 'Second', username: 'another@example.test', password: crypto.randomUUID() }],
  totps: [{ label: 'RFC public test vector', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', digits: 6, period: 30, algorithm: 'SHA1' }] });

async function fixture() {
  const local = new MemoryStorage(), session = new MemoryStorage();
  let time = 1_700_000_000_000;
  const master = crypto.randomUUID().slice(0, 12);
  const vault = new Vault(local, session, () => time);
  await vault.initialize(master);
  return { vault, local, session, master, advance: (ms: number) => { time += ms; } };
}

const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;

test('new master passwords accept 6 and 12 characters and reject invalid bounds without creating data', async () => {
  for (const secret of [undefined, null, 123456, crypto.randomUUID().slice(0, 5), crypto.randomUUID().slice(0, 13)]) {
    const local = new MemoryStorage(), vault = new Vault(local, new MemoryStorage());
    await assert.rejects(vault.initialize(secret), code('weak_master_password'));
    assert.deepEqual(local.values, {});
  }
  for (const length of [6, 12]) {
    const vault = new Vault(new MemoryStorage(), new MemoryStorage());
    const master = crypto.randomUUID().slice(0, length);
    await vault.initialize(master);
    await vault.save(sample());
    await vault.lock();
    await vault.unlock(master);
    assert.equal((await vault.export(master)).entries.length, 1);
    await assert.rejects(vault.backup(crypto.randomUUID().slice(0, 6)), code('weak_password'));
  }
});

test('account-only, 2FA-only and combined credentials persist independently', async () => {
  const { vault, local, master } = await fixture();
  const value = sample();
  const shapes = [ { ...value, totps: [] }, { ...value, logins: [] }, value ];
  const ids: string[] = [];
  for (const entry of shapes) ids.push((await vault.save(entry)).id);
  const restarted = new Vault(local, new MemoryStorage());
  await restarted.unlock(master);
  for (const [index, id] of ids.entries()) {
    const actual = await restarted.get(id);
    assert.equal(actual.logins.length, shapes[index].logins.length);
    assert.equal(actual.totps.length, shapes[index].totps.length);
  }
});

test('initialization encrypts persistent values; restart retains data and requires unlock', async () => {
  const { vault, local, master } = await fixture();
  const entry = sample();
  const { id } = await vault.save(entry);
  const persistent = JSON.stringify(local.values);
  for (const value of [master, entry.title, entry.logins[0].username, entry.logins[0].password, entry.totps[0].secret]) assert.ok(!persistent.includes(value));
  const restarted = new Vault(local, new MemoryStorage());
  assert.deepEqual(await restarted.status(), { initialized: true, unlocked: false });
  await assert.rejects(restarted.get(id), code('unauthorized'));
  await assert.rejects(restarted.unlock(crypto.randomUUID()), code('invalid_credentials'));
  await restarted.unlock(master);
  assert.equal((await restarted.get(id)).logins[0].password, entry.logins[0].password);
  await assert.rejects(restarted.initialize(master), code('already_initialized'));
});

test('list omits passwords and TOTP secrets, detail retains multiple accounts', async () => {
  const { vault } = await fixture();
  const { id } = await vault.save(sample());
  const list = (await vault.list()).entries;
  assert.equal(list.length, 1);
  assert.equal(list[0].logins.length, 2);
  assert.ok(!('password' in list[0].logins[0]));
  assert.ok(!('secret' in list[0].totps[0]));
  assert.deepEqual(list[0], publicEntry(await vault.get(id)));
  assert.match((await vault.codes()).codes[id][0].code, /^\d{6}$/);
});

test('updates and deletes reject stale versions without discarding current data', async () => {
  const { vault } = await fixture();
  const value = sample(), { id } = await vault.save(value);
  await vault.save({ ...value, title: 'Updated' }, id, 1);
  await assert.rejects(vault.save(value, id, 1), code('conflict'));
  await assert.rejects(vault.remove(id, 1), code('conflict'));
  assert.equal((await vault.get(id)).title, 'Updated');
  await vault.remove(id, 2);
  await assert.rejects(vault.get(id), code('not_found'));
});

test('passive reads and code refresh do not extend idle timeout; interaction does', async () => {
  const { vault, session, advance } = await fixture();
  await vault.save(sample());
  advance(IDLE_TIMEOUT - 1);
  await vault.list(); await vault.codes();
  advance(1);
  assert.equal((await vault.status()).unlocked, false);
  assert.equal(session.values[SESSION_KEY], undefined);
  await assert.rejects(vault.list(), code('unauthorized'));
  const active = await fixture();
  active.advance(IDLE_TIMEOUT - 1); await active.vault.touch();
  active.advance(IDLE_TIMEOUT - 1);
  assert.equal((await active.vault.status()).unlocked, true);
  await active.vault.lock();
  assert.equal((await active.vault.status()).unlocked, false);
});

test('service-worker recreation reuses browser-session key; browser-session loss locks', async () => {
  const { vault, local, session } = await fixture();
  await vault.save(sample());
  const replacement = new Vault(local, session, () => 1_700_000_000_000);
  assert.equal((await replacement.list()).entries.length, 1);
  await session.remove(SESSION_KEY);
  await assert.rejects(replacement.list(), code('unauthorized'));
});

test('invalid imports are atomic, empty imports and oversized batches are rejected', async () => {
  const { vault, local } = await fixture();
  await vault.save(sample());
  const before = structuredClone(local.values);
  await assert.rejects(vault.import([sample(), { title: 'Missing credentials' }]), code('credential_required'));
  await assert.rejects(vault.import([]), code('empty_import'));
  await assert.rejects(vault.import(Array(5001).fill(sample())), code('import_invalid'));
  assert.deepEqual(local.values, before);
  assert.equal((await vault.import([sample(), sample()])).imported, 2);
  assert.equal((await vault.list()).entries.length, 3);
});

test('encrypted backup restores into another vault; incorrect password does not modify it', async () => {
  const source = await fixture(), destination = await fixture();
  const value = sample(), backupPassword = crypto.randomUUID();
  await source.vault.save(value);
  const backup = await source.vault.backup(backupPassword);
  assert.ok(!JSON.stringify(backup).includes(value.logins[0].password));
  const before = structuredClone(destination.local.values);
  await assert.rejects(destination.vault.restore(crypto.randomUUID(), backup), code('backup_invalid'));
  await assert.rejects(destination.vault.restore(backupPassword, { ...backup, kdf: { ...backup.kdf, iterations: 1 } }), code('backup_invalid'));
  assert.deepEqual(destination.local.values, before);
  assert.equal((await destination.vault.restore(backupPassword, backup)).imported, 1);
  const entry = (await destination.vault.list()).entries[0];
  assert.equal((await destination.vault.get(entry.id)).logins[0].password, value.logins[0].password);
});

test('export requires master password; password change preserves ciphertext and locks all sessions', async () => {
  const { vault, local, master } = await fixture();
  const { id } = await vault.save(sample());
  await assert.rejects(vault.export(crypto.randomUUID()), code('invalid_credentials'));
  assert.equal((await vault.export(master)).entries.length, 1);
  const before = structuredClone(local.values[VAULT_KEY] as VaultEnvelope), next = crypto.randomUUID().slice(0, 6);
  for (const length of [5, 13]) {
    await assert.rejects(vault.changePassword(master, crypto.randomUUID().slice(0, length)), code('weak_master_password'));
    assert.deepEqual(local.values[VAULT_KEY], before);
    assert.equal((await vault.status()).unlocked, true);
  }
  await vault.changePassword(master, next);
  assert.deepEqual((local.values[VAULT_KEY] as VaultEnvelope).data, before.data);
  assert.equal((await vault.status()).unlocked, false);
  await assert.rejects(vault.unlock(master), code('invalid_credentials'));
  await vault.unlock(next);
  assert.equal((await vault.get(id)).title, 'Synthetic fixture');
});

test('authenticated encryption detects changed ciphertext, context, and revision', async () => {
  const key = await dataKey(crypto.getRandomValues(new Uint8Array(32)));
  const sealed = await seal(key, { fixture: true }, 'test-context');
  assert.deepEqual(await unseal(key, sealed, 'test-context'), { fixture: true });
  await assert.rejects(unseal(key, sealed, 'other-context'));
  const tampered = { ...sealed, ciphertext: (sealed.ciphertext[0] === 'A' ? 'B' : 'A') + sealed.ciphertext.slice(1) };
  await assert.rejects(unseal(key, tampered, 'test-context'));
  const { vault, local, master } = await fixture();
  (local.values[VAULT_KEY] as VaultEnvelope).revision++;
  await vault.lock();
  await assert.rejects(vault.unlock(master), code('vault_corrupt'));
});

test('capacity and storage-write failure preserve the existing vault', async () => {
  const key = await dataKey(crypto.getRandomValues(new Uint8Array(32)));
  await assert.rejects(seal(key, 'x'.repeat(MAX_PLAINTEXT), 'test'), code('vault_full'));
  const { vault, local } = await fixture();
  const before = structuredClone(local.values);
  local.rejectWrites = true;
  await assert.rejects(vault.save(sample()), code('storage_failed'));
  assert.deepEqual(local.values, before);
});

test('credential validation rejects unsafe URLs and oversized fields', () => {
  for (const url of ['https://user:fixture@example.test', 'javascript:alert(1)', 'https://bad host.test']) assert.throws(() => credential({ ...sample(), url }), code('invalid_url'));
  assert.throws(() => credential({ ...sample(), title: 'x'.repeat(151) }), code('invalid_input'));
  assert.throws(() => credential({ ...sample(), logins: [], totps: [] }), code('credential_required'));
  assert.equal(credential({ ...sample(), url: 'example.test' }).url, 'https://example.test');
});

test('legacy imports discard retired groups while preserving credentials', async () => {
  const { vault, master } = await fixture();
  const original = sample();
  await vault.import([{ ...original, group: 'Legacy fixture' }]);
  const [entry] = (await vault.list()).entries;
  assert.ok(!('group' in entry));
  assert.deepEqual((await vault.get(entry.id)).logins, original.logins);
  assert.deepEqual((await vault.export(master)).entries[0], original);
});

test('serial queue preserves order and continues after failure', async () => {
  const queue = new SerialQueue(), order: number[] = [];
  const results = await Promise.allSettled([
    queue.run(async () => { order.push(1); throw new Error('expected'); }),
    queue.run(async () => { order.push(2); return 2; }),
    queue.run(async () => { order.push(3); return 3; }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[2].status, 'fulfilled');
});
