import { Vault, SerialQueue } from './vault.ts';
import { fail, VaultError } from './types.ts';
import { currentTarget, fillCredential } from './fill.ts';
import { object, origin, text } from './validation.ts';
import { capturePageQr, type PageScan } from './qr-capture.ts';
import { clearPageQr, selectPageQr, type PageScanLabels } from './qr-selection.ts';
import { imageRegion, type QrRegion } from './qr.ts';
import { editorDraft, type EditorDraft } from './editor-draft.ts';

const QR_SCAN_KEY = 'credmemo-qr-scan';
const QR_RESULT_KEY = 'credmemo-qr-result';

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

async function clearScan() {
  const scan = (await chrome.storage.session.get(QR_SCAN_KEY))[QR_SCAN_KEY] as PageScan | undefined;
  await chrome.storage.session.remove(QR_SCAN_KEY);
  if (scan?.kind === 'page') {
    try { await chrome.scripting.executeScript({ target: { tabId: scan.tabId, frameIds: [0] }, func: clearPageQr }); } catch {}
  }
}

async function startPageScan(args: Record<string, unknown>) {
  if (!Number.isInteger(args.windowId) || Number(args.windowId) < 0) fail('invalid_input');
  // 自动重开的弹窗可能不改变后台的焦点窗口，使用弹窗所属窗口定位网页。
  const [tab] = await chrome.tabs.query({ active: true, windowId: Number(args.windowId) });
  if (!tab?.id || !tab.url || !origin(tab.url)) fail('qr_page_unavailable');
  const input = object(args.labels), errors = object(input.errors);
  const labels = Object.fromEntries(['hint', 'cancel', 'small', 'scanning', 'saved', 'failed'].map(key => [key, text(input[key], 200)])) as unknown as PageScanLabels;
  labels.errors = Object.fromEntries(['qr_not_found', 'qr_not_totp', 'invalid_totp', 'totp_only', 'qr_page_changed', 'unauthorized', 'forbidden', 'too_large'].map(key => [key, text(errors[key], 200)]));
  const editor = args.editor === undefined ? undefined : editorDraft(args.editor);
  await clearScan();
  await chrome.storage.session.remove(QR_RESULT_KEY);
  // 草稿只在受信任的浏览器会话内存中暂存，不写入磁盘或注入网页。
  if (editor) await chrome.storage.session.set({ [QR_RESULT_KEY]: { editor, outcome: 'cancelled' } });
  const scan: PageScan = { kind: 'page', nonce: crypto.randomUUID(), tabId: tab.id, windowId: tab.windowId, url: tab.url, editor: !!editor };
  await chrome.storage.session.set({ [QR_SCAN_KEY]: scan });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: selectPageQr, args: [scan.nonce, labels] });
    return { selecting: true };
  } catch { await clearScan(); await chrome.storage.session.remove(QR_RESULT_KEY); return fail('qr_page_unavailable'); }
}

function reopenPopup(windowId: number) {
  setTimeout(() => {
    if (chrome.action.openPopup) void chrome.action.openPopup({ windowId }).catch(() => {});
  }, 100);
}

async function selectionRequest(input: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
  const scan = (await chrome.storage.session.get(QR_SCAN_KEY))[QR_SCAN_KEY] as PageScan | undefined;
  if (!scan || scan.kind !== 'page' || sender.id !== chrome.runtime.id || sender.tab?.id !== scan.tabId || sender.tab.windowId !== scan.windowId
    || sender.url !== scan.url || sender.frameId !== 0 || input.nonce !== scan.nonce) fail('forbidden');
  if (input.action === 'cancel') {
    await chrome.storage.session.remove(QR_SCAN_KEY);
    if (scan.editor) reopenPopup(scan.windowId);
    return { cancelled: true };
  }
  if (input.action !== 'select') fail('invalid_input');
  const expiry = await vault.touch();
  await chrome.alarms.create('vault-lock', { when: expiry.expiresAt });
  imageRegion(input.region, 1, 1);
  const token = await capturePageQr(scan, input.region as QrRegion);
  const title = (token.label || '2FA').slice(0, 150);
  if (scan.editor) {
    const result = (await chrome.storage.session.get(QR_RESULT_KEY))[QR_RESULT_KEY] as { editor: EditorDraft } | undefined;
    if (!result?.editor) fail('qr_page_changed');
    const draft = result.editor;
    draft.entry.totps[draft.tokenIndex] = token;
    if (!draft.entry.title.trim()) draft.entry.title = title;
    await chrome.storage.session.set({ [QR_RESULT_KEY]: { editor: draft, outcome: 'recognized' } });
  } else {
    const saved = await vault.save({ title, url: new URL(scan.url).origin, notes: '', logins: [], totps: [token] });
    await chrome.storage.session.set({ [QR_RESULT_KEY]: { id: saved.id, title } });
  }
  await chrome.storage.session.remove(QR_SCAN_KEY);
  reopenPopup(scan.windowId);
  return { saved: true };
}

async function handle(action: string, args: Record<string, unknown>) {
  switch (action) {
    case 'status': return vault.status();
    case 'initialize': return vault.initialize(args.password);
    case 'unlock': return vault.unlock(args.password);
    case 'lock':
      await chrome.alarms.clear('vault-lock');
      await clearScan();
      await chrome.storage.session.remove(QR_RESULT_KEY);
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
    case 'advance': return vault.advance(args.id, args.index, args.counter, args.version);
    case 'reorder': return vault.reorder(args.ids, args.expected_ids);
    case 'backup': return vault.backup(args.password);
    case 'export': return vault.export(args.password);
    case 'import': return vault.import(args.entries);
    case 'restore': return vault.restore(args.password, args.backup);
    case 'changePassword': return vault.changePassword(args.current_password, args.new_password);
    case 'target': return currentTarget(args.windowId);
    case 'qr-start':
      await vault.touch();
      return startPageScan(args);
    case 'qr-result': {
      await vault.touch();
      const result = (await chrome.storage.session.get(QR_RESULT_KEY))[QR_RESULT_KEY] ?? null;
      if (result && typeof result === 'object' && 'editor' in result) await clearScan();
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
  if (message && typeof message === 'object' && (message as Record<string, unknown>).type === 'credmemo-qr-selection') {
    queue.run(async () => { await ready; return selectionRequest(object(message), sender); }).then(
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

chrome.tabs.onRemoved.addListener(tabId => {
  void queue.run(async () => {
    await ready;
    const scan = (await chrome.storage.session.get(QR_SCAN_KEY))[QR_SCAN_KEY] as PageScan | undefined;
    if (scan?.kind === 'page' && scan.tabId === tabId) await chrome.storage.session.remove(QR_SCAN_KEY);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes['credmemo-session'] && !changes['credmemo-session'].newValue) {
    void queue.run(async () => { await ready; await clearScan(); await chrome.storage.session.remove(QR_RESULT_KEY); });
  }
});
