export interface PageScanLabels {
  hint: string;
  cancel: string;
  small: string;
  scanning: string;
  saved: string;
  failed: string;
  errors: Record<string, string>;
}

// 函数会注入网页的隔离环境，仅接收提示文字和本次扫码标识。
export function selectPageQr(nonce: string, labels: PageScanLabels) {
  const scope = globalThis as typeof globalThis & { credmemoQrCleanup?: () => void };
  scope.credmemoQrCleanup?.();
  const host = document.createElement('div');
  host.id = 'credmemo-qr-selection';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;display:block;';
  const root = host.attachShadow({ mode: 'closed' });
  const surface = document.createElement('div');
  surface.style.cssText = 'position:absolute;inset:0;cursor:crosshair;touch-action:none;background:#11211726;';
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;display:none;border:2px solid #42c795;box-sizing:border-box;pointer-events:none;box-shadow:0 0 0 100vmax #071c1466;';
  const bar = document.createElement('div');
  bar.style.cssText = 'position:absolute;top:18px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:18px;max-width:90%;padding:12px 16px;border:1px solid #d4e7da;border-radius:10px;background:#fff;color:#183e2c;box-shadow:0 5px 24px #0003;font:14px/1.5 system-ui,sans-serif;';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  host.setAttribute('role', 'dialog');
  const show = (message: string, state: string) => { status.textContent = message; host.setAttribute('aria-label', message); host.dataset.state = state; };
  show(labels.hint, 'selecting');
  const cancel = document.createElement('button');
  cancel.textContent = labels.cancel;
  cancel.style.cssText = 'font:inherit;color:#286b50;background:#eaf3ed;border:0;border-radius:6px;padding:5px 10px;white-space:nowrap;cursor:pointer;';
  bar.append(status, cancel); surface.append(box); root.append(surface, bar);
  document.documentElement.append(host);
  let start: { x: number; y: number } | null = null;
  let busy = false;
  let active = true;
  const cleanup = () => {
    active = false; host.remove();
    document.removeEventListener('keydown', keydown, true);
    window.removeEventListener('resize', abort);
    document.removeEventListener('visibilitychange', visibility);
    if (scope.credmemoQrCleanup === cleanup) delete scope.credmemoQrCleanup;
  };
  const abort = () => {
    cleanup();
    void chrome.runtime.sendMessage({ type: 'credmemo-qr-selection', action: 'cancel', nonce }).catch(() => {});
  };
  const keydown = (event: KeyboardEvent) => {
    if (!event.isTrusted) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); abort(); }
    else if ([' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) event.preventDefault();
  };
  const visibility = () => { if (document.hidden) abort(); };
  scope.credmemoQrCleanup = cleanup;
  document.addEventListener('keydown', keydown, true);
  window.addEventListener('resize', abort);
  document.addEventListener('visibilitychange', visibility);
  cancel.addEventListener('click', event => { if (event.isTrusted) abort(); });
  surface.addEventListener('wheel', event => event.preventDefault(), { passive: false });
  surface.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
  const point = (event: PointerEvent) => ({ x: Math.max(0, Math.min(innerWidth, event.clientX)), y: Math.max(0, Math.min(innerHeight, event.clientY)) });
  surface.addEventListener('pointerdown', event => {
    if (!event.isTrusted || event.button !== 0 || busy) return;
    event.preventDefault(); event.stopPropagation(); surface.setPointerCapture(event.pointerId);
    start = point(event); box.style.display = 'block'; surface.style.background = 'transparent';
    Object.assign(box.style, { left: `${start.x}px`, top: `${start.y}px`, width: '0', height: '0' });
    show(labels.hint, 'selecting');
  });
  surface.addEventListener('pointermove', event => {
    if (!start || !event.isTrusted) return;
    const { x, y } = point(event);
    Object.assign(box.style, { left: `${Math.min(start.x, x)}px`, top: `${Math.min(start.y, y)}px`, width: `${Math.abs(x - start.x)}px`, height: `${Math.abs(y - start.y)}px` });
  });
  surface.addEventListener('pointercancel', () => { start = null; box.style.display = 'none'; });
  surface.addEventListener('pointerup', async event => {
    if (!start || !event.isTrusted || busy) return;
    event.preventDefault(); event.stopPropagation();
    const { x, y } = point(event);
    const region = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y), viewportWidth: innerWidth, viewportHeight: innerHeight };
    start = null;
    if (region.width < 12 || region.height < 12) { show(labels.small, 'error'); return; }
    busy = true; show(labels.scanning, 'recognizing'); host.style.visibility = 'hidden';
    try {
      // 先绘制移除框选层的画面，避免遮罩进入二维码截图。
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!active) return;
      const response = await chrome.runtime.sendMessage({ type: 'credmemo-qr-selection', action: 'select', nonce, region });
      if (!active) return;
      if (!response?.ok) throw new Error(response?.error || 'local_error');
      surface.style.display = 'none'; cancel.style.display = 'none'; host.style.pointerEvents = 'none';
      show(labels.saved, 'saved'); host.style.visibility = 'visible'; setTimeout(cleanup, 1800);
    } catch (error) {
      if (!active) return;
      show(labels.errors[(error as Error).message] || labels.failed, 'error');
      host.style.visibility = 'visible'; box.style.display = 'none';
    } finally { busy = false; }
  });
  return { selecting: true };
}

export function clearPageQr() {
  (globalThis as typeof globalThis & { credmemoQrCleanup?: () => void }).credmemoQrCleanup?.();
}
