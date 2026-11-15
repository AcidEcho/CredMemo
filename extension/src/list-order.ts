import { getDomain } from 'tldts';
import { fail } from './types.ts';

interface SiteEntry {
  id: string;
  title: string;
  url: string;
  totps: { label: string }[];
}

function site(url: string) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return { host, domain: getDomain(host, { allowPrivateDomains: true }) || host };
  } catch { return null; }
}

// 仅控制列表展示；凭证填充仍单独校验完整 origin。
export function matchesCurrentSite(entry: SiteEntry, currentUrl: string): boolean {
  const current = site(currentUrl);
  if (!current) return false;
  if (entry.url) return site(entry.url)?.domain === current.domain;
  const brand = getDomain(current.host, { allowPrivateDomains: true }) ? current.domain.split('.')[0] : current.host;
  const names = [entry.title, ...entry.totps.map(token => token.label.split(':')[0])];
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i');
  return names.some(name => name.toLowerCase() === current.host || pattern.test(name));
}

export function moveVisible(full: string[], visible: string[], from: string, to: string): string[] {
  const start = visible.indexOf(from), end = visible.indexOf(to);
  if (start < 0 || end < 0 || new Set(visible).size !== visible.length || visible.some(id => !full.includes(id))) fail('invalid_input');
  const moved = [...visible];
  moved.splice(end, 0, moved.splice(start, 1)[0]);
  const shown = new Set(visible);
  let index = 0;
  return full.map(id => shown.has(id) ? moved[index++] : id);
}
