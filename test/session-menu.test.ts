import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMenuTrigger } from '../src/session.ts';

test('Ctrl-\\ (0x1c) toggles the sidebar', () => {
  assert.equal(isMenuTrigger(Buffer.from([0x1c])), true);
});

test('other single keys do not open the menu', () => {
  assert.equal(isMenuTrigger(Buffer.from([0x1b])), false); // Esc passes through
  assert.equal(isMenuTrigger(Buffer.from('a')), false);
  assert.equal(isMenuTrigger(Buffer.from([0x03])), false); // Ctrl-C
});

test('multi-byte chunks (e.g. pastes) never trigger the sidebar', () => {
  assert.equal(isMenuTrigger(Buffer.from([0x1c, 0x1c])), false);
  assert.equal(isMenuTrigger(Buffer.from('hello')), false);
});
