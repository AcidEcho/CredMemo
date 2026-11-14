import { Vault, SerialQueue } from './vault.ts';
import { fail, VaultError } from './types.ts';
import { currentTarget, fillCredential } from './fill.ts';
import { object, text } from './validation.ts';
import { normalizeTotp } from './totp.ts';

const QR_SCAN_KEY = 'credmemo-qr-scan';
const QR_RESULT_KEY = 'credmemo-qr-result';
interface ScanWindow { kind: 'desktop'; windowId: number; tabId: number; parentWindowId: number; }

const vault = new Vault(chrome.storage.local, chrome.storage.session);
const queue = new SerialQueue();
const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]);

export function trustedSender(sender: chrome.runtime.MessageSender, runtimeId: string): boolean {
  if (sender.id !== runtimeId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === runtimeId && url.pathname === '/popup.html';
  } catch { return false; }
}

async function openScanner() {
  const pending = (await chrome.storage.session.get(QR_SCAN_KEY))[QR_SCAN_KEY] as ScanWindow | undefined;
  if (pending?.kind === 'desktop') {
    try { await chrome.windows.update(pending.windowId, { focused: true }); return { selecting: true }; } catch {}
  }
  const parent = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  const created = await chrome.windows.create({ url: chrome.runtime.getURL('scan.html'), type: 'popup', width: 1040, height: 760, focused: true });
  if (!created?.id || !created.tabs?.[0]?.id || !parent.id) fail('screen_capture_failed');
  await chrome.storage.session.set({ [QR_SCAN_KEY]: { kind: 'desktop', windowId: created.id, tabId: created.tabs[0].id, parentWindowId: parent.id } satisfies ScanWindow });
  return { selecting: true };
}

async function scannerRequest(input: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
  const scan = (await chrome.storage.session.get(QR_SCAN_KEY))[QR_SCAN_KEY] as ScanWindow | undefined;
  if (!scan || scan.kind !== 'desktop' || sender.id !== chrome.runtime.id || sender.tab?.id !== scan.tabId || sender.tab.windowId !== scan.windowId
    || sender.url !== chrome.runtime.getURL('scan.html') || sender.frameId !== 0) fail('forbidden');
  if (input.action === 'status') return vault.status();
  if (input.action !== 'save') fail('invalid_input');
  const token = normalizeTotp(object(input.token));
  const title = (token.label || '2FA').slice(0, 150);
  const saved = await vault.save({ title, url: '', notes: '', favorite: false, logins: [], totps: [token] });
  await chrome.storage.session.set({ [QR_RESULT_KEY]: { id: saved.id, title } });
  await chrome.storage.session.remove(QR_SCAN_KEY);
  // 保存完成后回到发起扫码的浏览器窗口，再打开动态码列表。
  setTimeout(() => {
    void (async () => {
      try {
        await chrome.windows.update(scan.parentWindowId, { focused: true });
        await chrome.action.openPopup({ windowId: scan.parentWindowId });
        await chrome.windows.remove(scan.windowId);
      } catch {}
    })();
  }, 700);
  return { saved: true };
}

async function handle(action: string, args: Record<string, unknown>) {
  switch (action) {
    case 'status': return vault.status();
    case 'initialize': return vault.initialize(args.password);
    case 'unlock': return vault.unlock(args.password);
    case 'lock':
      await chrome.alarms.clear('vault-lock');
      await chrome.storage.session.remove([QR_SCAN_KEY, QR_RESULT_KEY]);
      return vault.lock();
    case 'touch': {
      const result = await vault.touch();
      await chrome.alarms.create('vault-lock', { when: result.expiresAt });
      return result;
    }
    case 'list': return vault.list();
    case 'get': return vault.get(args.id);
    case 'save': return vault.save(args.entry, args.id, args.version);
    case 'delete': return vault.remove(args.id, args.version);
    case 'codes': return vault.codes();
    case 'backup': return vault.backup(args.password);
    case 'export': return vault.export(args.password);
    case 'import': return vault.import(args.entries);
    case 'restore': return vault.restore(args.password, args.backup);
    case 'changePassword': return vault.changePassword(args.current_password, args.new_password);
    case 'target': return currentTarget();
    case 'qr-start':
      await vault.touch();
      return openScanner();
    case 'qr-result': {
      const result = (await chrome.storage.session.get(QR_RESULT_KEY))[QR_RESULT_KEY] ?? null;
      await chrome.storage.session.remove(QR_RESULT_KEY);
      return result;
    }
    case 'fill': {
      const entry = await vault.get(args.id);
      const index = Number(args.index);
      if (!Number.isInteger(index) || index < 0 || !entry.logins[index]) fail('invalid_input');
      return fillCredential(args.tabId, entry.url, entry.logins[index]);
    }
    default: return fail('invalid_input');
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (message && typeof message === 'object' && (message as Record<string, unknown>).type === 'credmemo-scan') {
    queue.run(async () => { await ready; return scannerRequest(object(message), sender); }).then(
      data => reply({ ok: true, data }),
      error => reply({ ok: false, error: error instanceof VaultError ? error.code : 'local_error' }),
    );
    return true;
  }
  if (!trustedSender(sender, chrome.runtime.id)) {
    reply({ ok: false, error: 'forbidden' });
    return false;
  }
  queue.run(async () => {
    await ready;
    const input = object(message);
    if (input.type !== 'credmemo') fail('invalid_input');
    const action = text(input.action, 50);
    const data = await handle(action, object(input.args ?? {}));
    if (['initialize', 'unlock', 'qr-start'].includes(action)) {
      const expiry = await vault.touch();
      await chrome.alarms.create('vault-lock', { when: expiry.expiresAt });
    }
    return data;
  }).then(data => reply({ ok: true, data }), error => reply({ ok: false, error: error instanceof VaultError ? error.code : 'local_error' }));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'vault-lock') void queue.run(async () => { await ready; await vault.status(); });
});

chrome.runtime.onStartup.addListener(() => {
  void queue.run(async () => { await ready; await vault.lock(); });
});

chrome.windows.onRemoved.addListener(windowId => {
  void queue.run(async () => {
    await ready;
    const scan = (await chrome.storage.session.get(QR_SCAN_KEY))[QR_SCAN_KEY] as ScanWindow | undefined;
    if (scan?.kind === 'desktop' && scan.windowId === windowId) await chrome.storage.session.remove(QR_SCAN_KEY);
  });
});
