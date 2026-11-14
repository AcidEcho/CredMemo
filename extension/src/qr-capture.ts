import { fail } from './types.ts';
import { readQrImage, type QrRegion } from './qr.ts';

export interface PageScan {
  kind: 'page';
  nonce: string;
  tabId: number;
  windowId: number;
  url: string;
}

async function checkPage(scan: PageScan) {
  const tab = await chrome.tabs.get(scan.tabId);
  if (!tab.active || tab.windowId !== scan.windowId || tab.url !== scan.url) fail('qr_page_changed');
}

export async function capturePageQr(scan: PageScan, region: QrRegion) {
  await checkPage(scan);
  let image: string;
  try { image = await chrome.tabs.captureVisibleTab(scan.windowId, { format: 'png' }); }
  catch { return fail('qr_capture_failed'); }
  await checkPage(scan);
  const bytes = Uint8Array.from(atob(image.slice(image.indexOf(',') + 1)), value => value.charCodeAt(0));
  const token = await readQrImage(new Blob([bytes], { type: 'image/png' }), region);
  await checkPage(scan);
  return token;
}
