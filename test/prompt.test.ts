import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeKey } from '../src/tui/prompt.ts';

test('decodes arrow keys (normal cursor mode)', () => {
  assert.equal(decodeKey(Buffer.from('\x1b[A')), 'up');
  assert.equal(decodeKey(Buffer.from('\x1b[B')), 'down');
  assert.equal(decodeKey(Buffer.from('\x1b[C')), 'right');
  assert.equal(decodeKey(Buffer.from('\x1b[D')), 'left');
});

test('decodes arrow keys (application cursor mode, ESC O A/B/C/D)', () => {
  assert.equal(decodeKey(Buffer.from('\x1bOA')), 'up');
  assert.equal(decodeKey(Buffer.from('\x1bOB')), 'down');
  assert.equal(decodeKey(Buffer.from('\x1bOC')), 'right');
  assert.equal(decodeKey(Buffer.from('\x1bOD')), 'left');
});

test('decodes vim-style j/k', () => {
  assert.equal(decodeKey(Buffer.from('k')), 'up');
  assert.equal(decodeKey(Buffer.from('j')), 'down');
});

test('decodes enter (CR and LF)', () => {
  assert.equal(decodeKey(Buffer.from('\r')), 'enter');
  assert.equal(decodeKey(Buffer.from('\n')), 'enter');
});

test('decodes cancel keys (Ctrl-C, Esc, q)', () => {
  assert.equal(decodeKey(Buffer.from([0x03])), 'cancel');
  assert.equal(decodeKey(Buffer.from([0x1b])), 'cancel');
  assert.equal(decodeKey(Buffer.from('q')), 'cancel');
});

test('decodes Ctrl-D as delete', () => {
  assert.equal(decodeKey(Buffer.from([0x04])), 'delete');
});

test('unknown input is other', () => {
  assert.equal(decodeKey(Buffer.from('z')), 'other');
  assert.equal(decodeKey(Buffer.from('\x1b[Z')), 'other'); // shift-tab
});
