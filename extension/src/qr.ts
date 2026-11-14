import jsQR from 'jsqr';
import { fail, type TotpItem } from './types.ts';
import { normalizeTotp } from './totp.ts';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface QrRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export function imageRegion(raw: unknown, imageWidth: number, imageHeight: number) {
  const region = raw as QrRegion | null;
  if (!region || ![region.x, region.y, region.width, region.height, region.viewportWidth, region.viewportHeight].every(Number.isFinite)
    || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.viewportWidth <= 0 || region.viewportHeight <= 0
    || region.x + region.width > region.viewportWidth || region.y + region.height > region.viewportHeight) fail('qr_selection_invalid');
  const x = Math.floor(region.x * imageWidth / region.viewportWidth), y = Math.floor(region.y * imageHeight / region.viewportHeight);
  return { x, y, width: Math.min(imageWidth - x, Math.ceil(region.width * imageWidth / region.viewportWidth)),
    height: Math.min(imageHeight - y, Math.ceil(region.height * imageHeight / region.viewportHeight)) };
}

export function totpFromQr(value: string): TotpItem {
  if (!/^otpauth:\/\//i.test(value)) fail('qr_not_totp');
  if (value.length > 2048) fail('invalid_totp');
  let url: URL, label: string;
  try { url = new URL(value); label = decodeURIComponent(url.pathname.slice(1)); }
  catch { return fail('invalid_totp'); }
  if (url.hostname.toLowerCase() !== 'totp') fail('totp_only');
  return normalizeTotp({ secret: url.searchParams.get('secret') ?? '', label,
    digits: Number(url.searchParams.get('digits') ?? 6), period: Number(url.searchParams.get('period') ?? 30),
    algorithm: (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase() });
}

export function decodeQrPixels(data: Uint8ClampedArray, width: number, height: number): TotpItem {
  const result = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  if (!result) fail('qr_not_found');
  return totpFromQr(result.data);
}

export async function readQrImage(file: Blob, region?: QrRegion): Promise<TotpItem> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].includes(file.type)) fail('qr_image_invalid');
  if (file.size > MAX_IMAGE_BYTES) fail('too_large');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { return fail('qr_image_invalid'); }
  try {
    if (bitmap.width * bitmap.height > 32_000_000) fail('too_large');
    const crop = region ? imageRegion(region, bitmap.width, bitmap.height) : { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
    // 先缩放提高截图识别速度，再用更高分辨率识别尺寸较小的二维码。
    for (const limit of [2048, 4096]) {
      const scale = Math.min(1, limit / Math.max(crop.width, crop.height));
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(crop.width * scale)), Math.max(1, Math.round(crop.height * scale)));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) fail('qr_image_invalid');
      context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
      const result = jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      if (result) return totpFromQr(result.data);
      if (scale === 1) break;
    }
    return fail('qr_not_found');
  } finally { bitmap.close(); }
}

