import type { QrRegion } from './qr.ts';

export function installQrSelection(canvas: HTMLCanvasElement, box: HTMLElement, select: (region: QrRegion) => void) {
  let start: { x: number; y: number } | null = null;
  const point = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)), rect };
  };
  const reset = () => { start = null; box.hidden = true; };
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isTrusted || canvas.getAttribute('aria-busy') === 'true') return;
    event.preventDefault(); canvas.setPointerCapture(event.pointerId);
    const { x, y } = point(event); start = { x, y }; box.hidden = false;
    Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: '0', height: '0' });
  });
  canvas.addEventListener('pointermove', event => {
    if (!start || !event.isTrusted) return;
    const { x, y } = point(event);
    Object.assign(box.style, { left: `${Math.min(start.x, x)}px`, top: `${Math.min(start.y, y)}px`, width: `${Math.abs(x - start.x)}px`, height: `${Math.abs(y - start.y)}px` });
  });
  canvas.addEventListener('pointerup', event => {
    if (!start || !event.isTrusted) return;
    const { x, y, rect } = point(event);
    const region = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y), viewportWidth: rect.width, viewportHeight: rect.height };
    start = null; select(region);
  });
  canvas.addEventListener('pointercancel', reset);
  return reset;
}
