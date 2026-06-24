import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBox } from '../src/tui/overlay.ts';

test('computeBox centers the box in the terminal', () => {
  const g = computeBox('Title', ['one', 'two', 'three'], 100, 40, 'hint');
  // Horizontally + vertically centered.
  assert.equal(g.startCol, Math.floor((100 - g.width) / 2) + 1);
  assert.equal(g.startRow, Math.floor((40 - g.height) / 2) + 1);
  // Height = items + top + hint + bottom.
  assert.equal(g.height, 3 + 3);
});

test('computeBox clamps width to the terminal and never goes off-screen', () => {
  const longLabel = 'x'.repeat(200);
  const g = computeBox('T', [longLabel], 40, 20, 'hint');
  assert.ok(g.width <= 40, 'box fits within columns');
  assert.ok(g.startCol >= 1 && g.startRow >= 1);
});
