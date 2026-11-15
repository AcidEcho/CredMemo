import test from 'node:test';
import assert from 'node:assert/strict';
import { moveVisible } from '../../extension/src/list-order.ts';

test('reordering a filtered list changes visible slots and preserves all hidden entries', () => {
  const all = ['a', 'hidden1', 'b', 'hidden2', 'c'];
  assert.deepEqual(moveVisible(all, ['a','b','c'], 'c', 'a'), ['c','hidden1','a','hidden2','b']);
  assert.deepEqual(moveVisible(all, ['a','b','c'], 'a', 'c'), ['b','hidden1','c','hidden2','a']);
  assert.deepEqual(moveVisible(all, ['b'], 'b', 'b'), all);
  for (const visible of [['missing'], ['a','a']]) assert.throws(() => moveVisible(all, visible, visible[0], visible[0]));
});
