import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePageQr, type PageScan } from '../../extension/src/qr-capture.ts';

const scan: PageScan = { kind: 'page', nonce: 'fixture', tabId: 7, windowId: 3, url: 'https://qr.example.test/setup' };
const region = { x: 20, y: 20, width: 200, height: 200, viewportWidth: 1000, viewportHeight: 800 };
const page = { id: 7, windowId: 3, url: scan.url, active: true };
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;

test('capture refuses an inactive, moved or navigated tab before taking any screenshot', async t => {
  const original = globalThis.chrome;
  t.after(() => { if (original) globalThis.chrome = original; else Reflect.deleteProperty(globalThis, 'chrome'); });
  let captures = 0;
  for (const changed of [{ active: false }, { windowId: 4 }, { url: 'https://other.example.test' }]) {
    globalThis.chrome = { tabs: { get: async () => ({ ...page, ...changed }), captureVisibleTab: async () => { captures++; } } } as unknown as typeof chrome;
    await assert.rejects(capturePageQr(scan, region), code('qr_page_changed'));
  }
  assert.equal(captures, 0);
});

test('capture errors return an actionable error without attempting image decoding', async t => {
  const original = globalThis.chrome;
  t.after(() => { if (original) globalThis.chrome = original; else Reflect.deleteProperty(globalThis, 'chrome'); });
  globalThis.chrome = { tabs: { get: async () => page, captureVisibleTab: async () => { throw new Error('Permission revoked'); } } } as unknown as typeof chrome;
  await assert.rejects(capturePageQr(scan, region), code('qr_capture_failed'));
});

test('a page change during screenshot capture discards the image before decoding', async t => {
  const original = globalThis.chrome;
  t.after(() => { if (original) globalThis.chrome = original; else Reflect.deleteProperty(globalThis, 'chrome'); });
  let reads = 0;
  globalThis.chrome = { tabs: {
    get: async () => ({ ...page, url: reads++ ? 'https://other.example.test' : page.url }),
    captureVisibleTab: async () => 'data:image/png;base64,AA==',
  } } as unknown as typeof chrome;
  await assert.rejects(capturePageQr(scan, region), code('qr_page_changed'));
  assert.equal(reads, 2);
});
