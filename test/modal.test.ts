import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modalFrame, type ModalState } from '../src/tui/modal.ts';

const text = (frame: { ch: string }[][]) => frame.map((row) => row.map((c) => c.ch).join('')).join('\n');

test('modalFrame renders a centered menu box with title and items', () => {
  const state: ModalState = {
    kind: 'menu',
    title: 'Pick agent',
    items: [
      { label: 'claude', value: 'claude' },
      { label: 'codex', value: 'codex' },
    ],
    selected: 1,
    resolve: () => {},
  };
  const frame = modalFrame(state, 40, 12);
  assert.equal(frame.length, 12);
  assert.equal(frame[0].length, 40);
  const t = text(frame);
  assert.ok(t.includes('Pick agent'), 'title shown');
  assert.ok(t.includes('claude') && t.includes('codex'), 'items shown');
  // The selected item (codex, index 1) is inverse-styled.
  const row = frame.find((r) => r.map((c) => c.ch).join('').includes('codex'))!;
  assert.ok(row.some((c) => c.sgr === '7'), 'selected row is inverse');
});

test('modalFrame prompt shows the typed value with a cursor', () => {
  const state: ModalState = { kind: 'prompt', title: 'Custom', placeholder: 'hint', value: 'abc', resolve: () => {} };
  const t = text(modalFrame(state, 30, 8));
  assert.ok(t.includes('Custom'));
  assert.ok(t.includes('abc█'), 'value + cursor shown');
});

test('modalFrame info renders the title and lines', () => {
  const state: ModalState = {
    kind: 'info',
    title: 'Sandbox abc',
    lines: ['ID       abc123', 'Branch   teleport/main/abc'],
    resolve: () => {},
  };
  const t = text(modalFrame(state, 50, 12));
  assert.ok(t.includes('Sandbox abc'));
  assert.ok(t.includes('teleport/main/abc'));
  assert.ok(t.includes('Esc to close'));
});

test('modalFrame prompt shows the dim placeholder when empty', () => {
  const state: ModalState = { kind: 'prompt', title: 'Custom', placeholder: 'type here', value: '', resolve: () => {} };
  const frame = modalFrame(state, 30, 8);
  assert.ok(text(frame).includes('type here'));
  const row = frame.find((r) => r.map((c) => c.ch).join('').includes('type here'))!;
  assert.ok(row.some((c) => c.sgr === '2'), 'placeholder is dim');
});
