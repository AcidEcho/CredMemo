import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { decodeQrPixels, imageRegion, readQrImage, totpFromQr } from '../../extension/src/qr.ts';
import { totpQrPayload } from '../../extension/src/totp-qr.ts';
import { generateTotp } from '../../extension/src/totp.ts';

const publicSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;

function image(text: string, inverted = false) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const scale = 5, size = (modules.size + 8) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const qx = Math.floor(x / scale) - 4, qy = Math.floor(y / scale) - 4;
    const black = qx >= 0 && qy >= 0 && qx < modules.size && qy < modules.size && !!modules.get(qy, qx);
    const pixel = black !== inverted ? 0 : 255;
    const offset = (y * size + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = pixel;
  }
  return { data, size };
}

test('QR recognition decodes standard and inverted TOTP QR images locally', () => {
  for (const inverted of [false, true]) {
    const { data, size } = image(`otpauth://totp/Test%3Afixture?secret=${publicSecret}&digits=8&period=60&algorithm=SHA256`, inverted);
    const token = decodeQrPixels(data, size, size);
    assert.equal(token.label, 'Test:fixture');
    assert.equal(token.secret, publicSecret);
    assert.equal(token.digits, 8);
    assert.equal(token.period, 60);
    assert.equal(token.algorithm, 'SHA256');
  }
});

test('generated binding QR retains the secret, label, parameters and matching verification codes', async () => {
  for (const algorithm of ['SHA1', 'SHA256', 'SHA512'] as const) {
    const token = { secret: publicSecret, label: '示例:fixture+test@example.test', type: 'totp' as const, algorithm, digits: 8 as const, period: 60 as const };
    const payload = totpQrPayload(token, 'Fallback');
    const { data, size } = image(payload);
    const decoded = decodeQrPixels(data, size, size);
    assert.deepEqual(decoded, token);
    assert.deepEqual(await generateTotp(decoded, 60000), await generateTotp(token, 60000));
  }
  const raw = { secret: publicSecret, label: '', type: 'totp' as const, algorithm: 'SHA1' as const, digits: 6 as const, period: 30 as const };
  assert.equal(totpFromQr(totpQrPayload(raw, 'Example & fixture')).label, 'Example & fixture');
  assert.throws(() => totpQrPayload({ ...raw, secret: 'INVALID' }, 'Fixture'), code('invalid_totp'));
});

test('blank image, ordinary QR, malformed OTP and unsupported settings are rejected', () => {
  assert.throws(() => decodeQrPixels(new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100), code('qr_not_found'));
  const { data, size } = image('https://example.test');
  assert.throws(() => decodeQrPixels(data, size, size), code('qr_not_totp'));
  assert.throws(() => totpFromQr('otpauth://totp/Test?secret=INVALID'), code('invalid_totp'));
  assert.throws(() => totpFromQr(`otpauth://unknown/Test?secret=${publicSecret}`), code('totp_only'));
  assert.throws(() => totpFromQr(`otpauth://totp/Test?secret=${publicSecret}&digits=11`), code('invalid_totp'));
});

test('unsupported image types and oversized files fail before image decoding', async () => {
  await assert.rejects(readQrImage(new Blob(['<svg/>'], { type: 'image/svg+xml' })), code('qr_image_invalid'));
  await assert.rejects(readQrImage(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' })), code('too_large'));
});

test('selection coordinates map to screenshot pixels at different display scales', () => {
  const region = { x: 80, y: 50, width: 240, height: 260, viewportWidth: 1000, viewportHeight: 800 };
  assert.deepEqual(imageRegion(region, 2000, 1600), { x: 160, y: 100, width: 480, height: 520 });
  assert.deepEqual(imageRegion({ ...region, x: 760, y: 540 }, 1250, 1000), { x: 950, y: 675, width: 300, height: 325 });
});

test('invalid or out-of-viewport selections are rejected before cropping', () => {
  const region = { x: 80, y: 50, width: 240, height: 260, viewportWidth: 1000, viewportHeight: 800 };
  for (const changes of [{ x: -1 }, { width: 0 }, { height: NaN }, { x: 900 }, { y: 700 }, { viewportWidth: 0 }, { width: '240' }]) {
    assert.throws(() => imageRegion({ ...region, ...changes }, 2000, 1600), code('qr_selection_invalid'));
  }
});
