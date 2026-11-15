import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesCurrentSite, moveVisible } from '../../extension/src/list-order.ts';

const entry = (url = '', title = 'Work GitHub', label = '') => ({ id: 'fixture', title, url, totps: [{ label }] });

test('website filtering uses registrable domains, including public and private suffix boundaries', () => {
  assert.ok(matchesCurrentSite(entry('https://github.com'), 'https://login.github.com'));
  assert.ok(matchesCurrentSite(entry('https://accounts.example.co.uk'), 'https://login.example.co.uk'));
  for (const current of ['https://github.com.evil.test', 'https://othergithub.com', 'chrome://extensions/']) {
    assert.ok(!matchesCurrentSite(entry('https://github.com'), current));
  }
  assert.ok(!matchesCurrentSite(entry('https://first.github.io'), 'https://second.github.io'));
  assert.ok(!matchesCurrentSite(entry('https://unrelated.test', 'GitHub'), 'https://github.com'));
  assert.ok(!matchesCurrentSite(entry('https://user:fixture@github.com'), 'https://github.com'));
});

test('credentials without a website match names or OTP issuer labels without partial brand matches', () => {
  assert.ok(matchesCurrentSite(entry(), 'https://github.com'));
  assert.ok(matchesCurrentSite(entry('', '工作 GitHub'), 'https://github.com'));
  assert.ok(matchesCurrentSite(entry('', '工作账号', 'GitHub:fixture@example.test'), 'https://github.com'));
  assert.ok(!matchesCurrentSite(entry('', 'NotGitHub'), 'https://github.com'));
  assert.ok(!matchesCurrentSite(entry('', 'Git'), 'https://github.com'));
  assert.ok(!matchesCurrentSite(entry(), ''));
});

test('reordering a filtered list changes visible slots and preserves all hidden entries', () => {
  const all = ['a', 'hidden1', 'b', 'hidden2', 'c'];
  assert.deepEqual(moveVisible(all, ['a','b','c'], 'c', 'a'), ['c','hidden1','a','hidden2','b']);
  assert.deepEqual(moveVisible(all, ['a','b','c'], 'a', 'c'), ['b','hidden1','c','hidden2','a']);
  assert.deepEqual(moveVisible(all, ['b'], 'b', 'b'), all);
  for (const visible of [['missing'], ['a','a']]) assert.throws(() => moveVisible(all, visible, visible[0], visible[0]));
});
