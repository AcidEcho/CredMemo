import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { editorDraft } from '../../extension/src/editor-draft.ts';

const draft = () => ({ id: '', version: 0, tokenIndex: 0, entry: {
  title: '', url: 'unfinished address', notes: 'Unsaved note',
  logins: [{ label: '', username: '', password: randomUUID() }],
  totps: [{ label: '', secret: '', digits: 6, period: 30, algorithm: 'SHA1' }],
} });

test('scan drafts preserve incomplete fields without requiring a savable credential', () => {
  const input = draft();
  assert.deepEqual(editorDraft(input), input);
  const existing = { ...input, id: randomUUID(), version: 4 };
  assert.deepEqual(editorDraft(existing), existing);
});

test('incomplete HOTP scan drafts preserve counters and GOST parameters', () => {
  const input = draft();
  const token = { ...input.entry.totps[0], type: 'hotp', counter: 41, period: 45, digits: 7, algorithm: 'GOST3411_2012_256' };
  input.entry.totps[0] = token;
  assert.deepEqual(editorDraft(input).entry.totps[0], token);
  assert.throws(() => editorDraft({ ...input, entry: { ...input.entry, totps: [{ ...token, counter: -1 }] } }), { code: 'invalid_input' });
});

test('scan drafts reject oversized data, invalid edit versions and missing target 2FA rows', () => {
  for (const input of [
    { ...draft(), tokenIndex: -1 }, { ...draft(), tokenIndex: 1 }, { ...draft(), tokenIndex: '0' },
    { ...draft(), id: 'other-extension', version: 1 }, { ...draft(), id: randomUUID(), version: 0 },
    { ...draft(), version: 1 },
    { ...draft(), entry: { ...draft().entry, title: 'x'.repeat(151) } },
    { ...draft(), entry: { ...draft().entry, totps: [] } },
    { ...draft(), entry: { ...draft().entry, logins: Array(31).fill({}) } },
    { ...draft(), entry: { ...draft().entry, totps: [{ secret: '', digits: 11, period: 30, algorithm: 'SHA1' }] } },
  ]) assert.throws(() => editorDraft(input), { code: 'invalid_input' });
});
