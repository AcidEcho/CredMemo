import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, SerialQueue, VAULT_KEY, SESSION_KEY, IDLE_TIMEOUT } from '../../extension/src/vault.ts';
import { dataKey, derive, seal, unseal, unbase64, vaultContext, wrapContext, MAX_PLAINTEXT } from '../../extension/src/crypto.ts';
import { normalizeTotp } from '../../extension/src/totp.ts';
import { OTP_TYPES } from '../../extension/src/otp-options.ts';
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

const sample = (): Credential => ({ title: 'Synthetic fixture', url: 'https://login.example.test', notes: '<script>fixture</script>',
  logins: [{ label: 'First', username: 'fixture@example.test', password: crypto.randomUUID() }, { label: 'Second', username: 'another@example.test', password: crypto.randomUUID() }],
  totps: [{ label: 'RFC public test vector', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', type: 'totp', digits: 6, period: 30, algorithm: 'SHA1' }] });

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

test('master verification rejects an out-of-range password even when its wrapped key matches', async () => {
  const { vault, local, session, master } = await fixture();
  await vault.save(sample());
  const envelope = local.values[VAULT_KEY] as VaultEnvelope;
  const secret = crypto.randomUUID().slice(0, 13);
  const key = (session.values[SESSION_KEY] as { key: string }).key;
  envelope.wrappedKey = await seal(await derive(secret, envelope.kdf), { key }, wrapContext(envelope));
  const before = structuredClone(local.values);
  await assert.rejects(vault.export(secret), code('invalid_credentials'));
  await assert.rejects(vault.changePassword(secret, master), code('invalid_credentials'));
  assert.deepEqual(local.values, before);
  assert.equal((await vault.status()).unlocked, true);
  await vault.lock();
  await assert.rejects(vault.unlock(secret), code('invalid_credentials'));
  assert.equal((await vault.status()).unlocked, false);
  assert.deepEqual(local.values, before);
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

test('HOTP advances only explicitly, rejects replayed clicks, and retains its counter after restart', async () => {
  const { vault, local, master } = await fixture();
  const token = normalizeTotp({ type: 'hotp', secret: sample().totps[0].secret });
  const { id } = await vault.save({ ...sample(), totps: [token] });
  assert.equal((await vault.codes()).codes[id][0].code, '755224');
  assert.equal((await vault.codes()).codes[id][0].code, '755224');
  const queue = new SerialQueue();
  const result = await Promise.allSettled([0, 0].map(counter => queue.run(() => vault.advance(id, 0, counter, 1))));
  assert.equal(result[0].status, 'fulfilled');
  assert.equal(result[1].status, 'rejected');
  assert.equal((await vault.codes()).codes[id][0].code, '287082');
  const restarted = new Vault(local, new MemoryStorage());
  await restarted.unlock(master);
  assert.equal((await restarted.get(id)).totps[0].counter, 1);
  await assert.rejects(restarted.advance(id, -1, 1, 2), code('invalid_input'));
  const stale = await restarted.get(id);
  await restarted.save({ ...stale, notes: 'Changed in another window' }, id, stale.version);
  await assert.rejects(restarted.advance(id, 0, 1, stale.version), code('conflict'));
  const current = await restarted.get(id);
  await restarted.save({ ...current, totps: [{ ...token, counter: Number.MAX_SAFE_INTEGER }] }, id, current.version);
  await assert.rejects(restarted.advance(id, 0, Number.MAX_SAFE_INTEGER, current.version + 1), code('counter_exhausted'));
  await restarted.lock();
  await assert.rejects(restarted.advance(id, 0, Number.MAX_SAFE_INTEGER, current.version + 1), code('unauthorized'));
});

test('custom ordering survives edits, restart, encrypted backup and restore with every OTP type', async () => {
  const source = await fixture(), destination = await fixture();
  for (const type of OTP_TYPES) {
    const token = normalizeTotp({ secret: ['hex','hhex'].includes(type) ? '3132333435363738393031323334353637383930' : sample().totps[0].secret,
      type, counter: 9, algorithm: 'GOST3411_2012_512', period: 45, digits: 7 });
    await source.vault.save({ ...sample(), title: type, totps: [token] });
  }
  const before = (await source.vault.list()).entries.map(entry => entry.id);
  const desired = [...before.slice(2), ...before.slice(0, 2)];
  await source.vault.reorder(desired, before);
  const entry = await source.vault.get(desired[1]);
  await source.vault.save({ ...entry, notes: 'Edited after sorting' }, entry.id, entry.version);
  const restarted = new Vault(source.local, new MemoryStorage());
  await restarted.unlock(source.master);
  assert.deepEqual((await restarted.list()).entries.map(entry => entry.id), desired);
  const exported = await restarted.export(source.master), backupPassword = crypto.randomUUID();
  await destination.vault.restore(backupPassword, await restarted.backup(backupPassword));
  assert.deepEqual((await destination.vault.export(destination.master)).entries, exported.entries);
});

test('invalid or stale reorder requests and failed counter writes leave credentials intact', async () => {
  const { vault, local } = await fixture();
  for (const title of ['First', 'Second']) await vault.save({ ...sample(), title });
  const entries = (await vault.list()).entries, ids = entries.map(entry => entry.id);
  const before = structuredClone(local.values);
  for (const next of [[ids[0],ids[0]], [ids[0]], [ids[0],crypto.randomUUID()]]) {
    await assert.rejects(vault.reorder(next, ids), code('invalid_input'));
  }
  await assert.rejects(vault.reorder([...ids].reverse(), [...ids].reverse()), code('conflict'));
  assert.deepEqual(local.values, before);
  const token = normalizeTotp({ type: 'hotp', secret: sample().totps[0].secret });
  const entry = await vault.get(ids[0]);
  await vault.save({ ...entry, totps: [token] }, entry.id, entry.version);
  local.rejectWrites = true;
  await assert.rejects(vault.advance(entry.id, 0, 0, entry.version + 1), code('storage_failed'));
  assert.equal((await vault.get(entry.id)).totps[0].counter, 0);
  await assert.rejects(vault.reorder([...ids].reverse(), ids), code('storage_failed'));
  assert.deepEqual((await vault.list()).entries.map(entry => entry.id), ids);
});

test('stored array order is authoritative even when update timestamps differ', async () => {
  const { vault, local, session } = await fixture();
  for (const title of ['First', 'Second']) await vault.save({ ...sample(), title });
  const envelope = local.values[VAULT_KEY] as VaultEnvelope;
  const key = await dataKey(unbase64((session.values[SESSION_KEY] as { key: string }).key, 32));
  const content = await unseal<{ entries: unknown[] }>(key, envelope.data, vaultContext(envelope));
  const entries = content.entries as ({ updated_at: number } & object)[];
  entries[0].updated_at = 1; entries[1].updated_at = 2;
  envelope.data = await seal(key, { entries }, vaultContext(envelope));
  const ordered = (await vault.list()).entries;
  assert.deepEqual(ordered.map(entry => entry.title), ['Second', 'First']);
  const ids = ordered.map(entry => entry.id);
  await vault.reorder([...ids].reverse(), ids);
  assert.deepEqual((await vault.list()).entries.map(entry => entry.title), ['First', 'Second']);
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
  await assert.rejects(vault.import([sample(), { ...sample(), totps: [{ secret: `otpauth://totp/Fixture?secret=${sample().totps[0].secret}` }] }]), code('invalid_totp'));
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

test('imports accept only credential fields and never trust supplied IDs or versions', async () => {
  const { vault, master } = await fixture();
  const original = sample();
  const suppliedId = crypto.randomUUID();
  await vault.import([{ ...original, id: suppliedId, version: 900, extra: { unexpected: true } }]);
  const [entry] = (await vault.list()).entries;
  assert.notEqual(entry.id, suppliedId);
  assert.equal(entry.version, 1);
  assert.ok(!('extra' in entry));
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
