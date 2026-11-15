import test from 'node:test';
import assert from 'node:assert/strict';
import { streebog256hmac, streebog512hmac } from '@li0ard/gost/hmac.js';
import { generateTotp, normalizeTotp } from '../../extension/src/totp.ts';
import { totpFromQr } from '../../extension/src/qr.ts';
import { totpQrPayload } from '../../extension/src/totp-qr.ts';
import { OTP_TYPES, OTP_ALGORITHMS } from '../../extension/src/otp-options.ts';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const hex = '3132333435363738393031323334353637383930';

test('RFC 4226 HOTP vectors stay stable across clock changes and support hexadecimal keys', async () => {
  const expected = ['755224','287082','359152','969429','338314','254676','287922','162583','399871','520489'];
  for (const [counter, code] of expected.entries()) for (const type of ['hotp', 'hhex']) {
    const token = normalizeTotp({ secret: type === 'hhex' ? hex : secret, type, counter });
    assert.deepEqual(await generateTotp(token, 0), { code, period: 0, expires_at: 0, counter });
    assert.deepEqual(await generateTotp(token, 1234567890000), await generateTotp(token, 0));
  }
});

test('Steam and Battle.net match independent HMAC-SHA1 vectors', async () => {
  for (const [seconds, expected] of [[0,'GG5F5'],[59,'PV9M4'],[1111111111,'5PP3V']] as const) {
    assert.equal((await generateTotp(normalizeTotp({ type: 'steam', secret }), seconds * 1000)).code, expected);
  }
  assert.equal((await generateTotp(normalizeTotp({ type: 'battle', secret }), 59000)).code, '94287082');
  assert.equal((await generateTotp(normalizeTotp({ type: 'hex', secret: hex, digits: 8 }), 59000)).code, '94287082');
});

test('GOST HMAC implementations match RFC 7836 vectors', () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index);
  const message = Uint8Array.from(Buffer.from('0126bdb87800af214341456563780100', 'hex'));
  assert.equal(Buffer.from(streebog256hmac(key, message)).toString('hex'), 'a1aa5f7de402d7b3d323f2991c8d4534013137010a83754fd0af6d7cd4922ed9');
  assert.equal(Buffer.from(streebog512hmac(key, message)).toString('hex'), 'a59bab22ecae19c65fbde6e5f4e9f5d8549d31f037f9df9b905500e171923a773d5f1530f2ed7e964cb2eedc29e9ad2f3afe93b2814f79f5000ffc0366c251e6');
});

test('all six OTP types and five algorithms round-trip through binding QR without changing codes', async () => {
  for (const type of OTP_TYPES) for (const algorithm of OTP_ALGORITHMS) {
    const token = normalizeTotp({ type, algorithm, secret: ['hex','hhex'].includes(type) ? hex : secret,
      digits: 9, period: 45, counter: 7, label: 'Fixture:public-vector' });
    const restored = totpFromQr(totpQrPayload(token, 'Fixture'));
    assert.deepEqual(await generateTotp(restored, 1234567890000), await generateTotp(token, 1234567890000));
    assert.equal(restored.algorithm, algorithm);
    assert.equal(restored.label, token.label);
  }
});

test('extended parameters are validated and manual configuration URLs remain rejected', async () => {
  for (const options of [{ counter: -1 }, { counter: 0.5 }, { counter: Number.MAX_SAFE_INTEGER + 1 }, { type: 'unknown' }, { algorithm: 'SHA3' }]) {
    assert.throws(() => normalizeTotp({ type: 'hotp', secret, ...options }));
  }
  for (const digits of [1, 7, 9, 10]) {
    const result = await generateTotp(normalizeTotp({ secret, digits, period: 45 }), 59000);
    assert.equal(result.code.length, digits);
    assert.equal(result.expires_at, 90);
  }
  assert.equal(normalizeTotp({ type: 'hotp', secret: hex }).type, 'hhex');
  assert.throws(() => normalizeTotp({ secret: `otpauth://totp/Fixture?secret=${secret}` }));
  assert.equal(totpFromQr(`otpauth://totp/Steam?secret=${secret}&encoder=steam`).type, 'steam');
});
