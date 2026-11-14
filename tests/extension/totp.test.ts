import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase32, normalizeTotp, generateTotp } from '../../extension/src/totp.ts';
import { matchingOrigin } from '../../extension/src/fill.ts';
import type { TotpItem } from '../../extension/src/types.ts';

// RFC 6238 公开向量，用于独立验证三种算法及换码边界。
const secrets = {
  SHA1: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  SHA256: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
  SHA512: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA',
};
const vectors = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
] as const;

test('all RFC 6238 vectors match SHA1, SHA256, SHA512', async () => {
  for (const [seconds, ...expected] of vectors) {
    for (const [index, algorithm] of (['SHA1', 'SHA256', 'SHA512'] as const).entries()) {
      const result = await generateTotp({ secret: secrets[algorithm], algorithm, digits: 8, period: 30, label: '' }, seconds * 1000);
      assert.equal(result.code, expected[index]);
      assert.equal(result.expires_at, (Math.floor(seconds / 30) + 1) * 30);
    }
  }
});

test('6-digit output and 15/30/60-second boundaries', async () => {
  for (const period of [15, 30, 60] as const) {
    const token: TotpItem = { label: '', secret: secrets.SHA1, algorithm: 'SHA1', digits: 6, period };
    const before = await generateTotp(token, period * 1000 - 1);
    const after = await generateTotp(token, period * 1000);
    assert.equal(before.expires_at, period);
    assert.equal(after.expires_at, period * 2);
    assert.notEqual(before.code, after.code);
    assert.equal(before.code.length, 6);
  }
});

test('otpauth parsing honors algorithm and rejects HOTP, invalid Base32, bad options', () => {
  const parsed = normalizeTotp({ secret: `otpauth://totp/Test%3Afixture?secret=${secrets.SHA256}&algorithm=SHA256&digits=8&period=60` });
  assert.equal(parsed.label, 'Test:fixture');
  assert.equal(parsed.algorithm, 'SHA256');
  assert.equal(parsed.period, 60);
  assert.equal(parsed.digits, 8);
  assert.deepEqual(decodeBase32(secrets.SHA1.toLowerCase()), decodeBase32(secrets.SHA1));
  for (const secret of ['INVALID!', 'A'.repeat(17), 'A'.repeat(17) + 'B', 'otpauth://hotp/Test?secret=' + secrets.SHA1]) assert.throws(() => normalizeTotp({ secret }));
  for (const options of [{ digits: 7 }, { period: 45 }, { algorithm: 'MD5' }]) assert.throws(() => normalizeTotp({ secret: secrets.SHA1, ...options }));
});

test('matching requires exact protocol, hostname and port', () => {
  assert.ok(matchingOrigin('https://example.test/login', 'https://example.test/other'));
  for (const url of ['http://example.test', 'https://example.test:8443', 'https://example.test.evil.test', 'https://sub.example.test', 'https://user:fixture@example.test', 'chrome://settings']) assert.ok(!matchingOrigin('https://example.test', url));
  assert.ok(!matchingOrigin('', 'https://example.test'));
});
