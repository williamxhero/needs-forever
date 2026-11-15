import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameWorkspacePath } from '../src/main-session-provider.js';

test('Desktop workspace identity comparison follows Windows path semantics', () => {
  const equal = sameWorkspacePath('D:/WILL/STOCK/QuantResearch', 'd:\\will\\stock\\quantresearch');
  assert.equal(equal, process.platform === 'win32');
});

test('Desktop workspace identity comparison preserves exact equality', () => {
  assert.equal(sameWorkspacePath('D:/WILL/STOCK/QuantResearch', 'D:/WILL/STOCK/QuantResearch'), true);
});

test('Desktop workspace identity comparison rejects a different workspace', () => {
  assert.equal(sameWorkspacePath('D:/WILL/STOCK/QuantResearch', 'D:/WILL/STOCK/OtherTask'), false);
});
