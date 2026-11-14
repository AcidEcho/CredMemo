import { fail, type LoginItem } from './types.ts';
import { origin } from './validation.ts';

export function matchingOrigin(entryUrl: string, tabUrl: string): boolean {
  const expected = origin(entryUrl);
  return expected !== null && expected === origin(tabUrl);
}

// 此函数会序列化到目标页面，不能引用扩展上下文或接收整个凭证库。
export function fillPage(expectedOrigin: string, login: LoginItem) {
  if (location.origin !== expectedOrigin) return { error: 'site_mismatch' };
  const visible = (input: HTMLInputElement) => !input.disabled && !input.readOnly && input.type !== 'hidden' && input.getClientRects().length > 0 && getComputedStyle(input).visibility !== 'hidden' && getComputedStyle(input).display !== 'none';
  const fields = [...document.querySelectorAll<HTMLInputElement>('input')].filter(visible);
  const passwords = fields.filter(input => input.type === 'password' && input.autocomplete !== 'new-password');
  const focusedForm = document.activeElement?.closest('form');
  const candidates = focusedForm ? passwords.filter(input => input.form === focusedForm) : passwords;
  if (candidates.length > 1) return { error: 'ambiguous_form' };
  const passwordInput = candidates[0];
  const scope = passwordInput ? fields.filter(input => input.form === passwordInput.form) : fields;
  const users = scope.filter(input => ['text', 'email', 'tel'].includes(input.type));
  const named = users.filter(input => /^(username|email)$/.test(input.autocomplete) || /user|email|login|account/i.test(`${input.name} ${input.id}`));
  const eligible = named.length ? named : users.filter(input => !passwordInput || !!(input.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING));
  if (!passwordInput && eligible.length !== 1) return { error: eligible.length ? 'ambiguous_form' : 'no_fields' };
  const userInput = eligible.length === 1 ? eligible[0] : eligible.at(-1);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return { error: 'fill_failed' };
  let filled = 0;
  for (const [input, value] of [[userInput, login.username], [passwordInput, login.password]] as const) {
    if (!input || !value) continue;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    filled++;
  }
  return filled ? { filled, usernameOnly: !passwordInput } : { error: 'no_fields' };
}

export async function currentTarget(windowId?: unknown) {
  if (windowId !== undefined && (!Number.isInteger(windowId) || Number(windowId) < 0)) fail('invalid_input');
  const [tab] = await chrome.tabs.query({ active: true, ...(windowId === undefined ? { currentWindow: true } : { windowId: Number(windowId) }) });
  if (!tab?.id || !tab.url || !origin(tab.url)) return null;
  const url = new URL(tab.url);
  return { id: tab.id, origin: url.origin, hostname: url.hostname };
}

export async function fillCredential(tabId: unknown, entryUrl: string, login: LoginItem) {
  if (!Number.isInteger(tabId)) fail('fill_failed');
  const tab = await chrome.tabs.get(Number(tabId));
  if (!tab.url || !matchingOrigin(entryUrl, tab.url)) fail('site_mismatch');
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: Number(tabId), frameIds: [0] }, func: fillPage, args: [new URL(entryUrl).origin, login] });
    if (!result?.result) fail('fill_failed');
    if ('error' in result.result) fail(result.result.error ?? 'fill_failed');
    return result.result;
  } catch (error) {
    if (error instanceof Error && ['site_mismatch', 'ambiguous_form', 'no_fields'].includes(error.message)) throw error;
    return fail('fill_failed');
  }
}
