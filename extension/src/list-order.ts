import { fail } from './types.ts';

export function moveVisible(full: string[], visible: string[], from: string, to: string): string[] {
  const start = visible.indexOf(from), end = visible.indexOf(to);
  if (start < 0 || end < 0 || new Set(visible).size !== visible.length || visible.some(id => !full.includes(id))) fail('invalid_input');
  const moved = [...visible];
  moved.splice(end, 0, moved.splice(start, 1)[0]);
  const shown = new Set(visible);
  let index = 0;
  return full.map(id => shown.has(id) ? moved[index++] : id);
}
