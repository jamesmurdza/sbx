import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayBranch,
  statusSegments,
  layoutBar,
  renderStatusBar,
  width,
  type BarInfo,
} from '../src/tui/statusbar.ts';

const info: BarInfo = { shortId: '6c73784c', agent: 'codex', repo: 'me/teleport', branch: 'teleport/main/6c73784c2d3a' };

test('displayBranch reduces teleport working branches to the base', () => {
  assert.equal(displayBranch('teleport/main/6c73784c2d3a'), 'main');
  assert.equal(displayBranch('teleport/feature/x/abcdef12'), 'feature/x');
  assert.equal(displayBranch('my-own-branch'), 'my-own-branch');
});

test('statusSegments builds left id/agent and right repo/branch/live/menu', () => {
  const { left, right } = statusSegments(info, '✓ pushed');
  assert.equal(left, '⚡ 6c73784c  codex');
  assert.equal(right, 'me/teleport  ·  ↟ main  ·  ✓ pushed  ·  Ctrl-] sandboxes');
});

test('statusSegments drops empty fields (no repo/branch/live)', () => {
  const { right } = statusSegments({ shortId: 'a', agent: 'claude' }, '');
  assert.equal(right, 'Ctrl-] sandboxes');
});

test('layoutBar fills to exactly cols with left and right justified', () => {
  const line = layoutBar('L', 'R', 20);
  assert.equal(width(line), 20);
  assert.ok(line.startsWith(' L '));
  assert.ok(line.endsWith(' R '));
});

test('layoutBar drops the right segment before truncating the left when tight', () => {
  const line = layoutBar('LEFTSIDE', 'RIGHTSIDE', 12);
  assert.equal(width(line), 12);
  assert.ok(line.includes('LEFTSIDE'));
  assert.ok(!line.includes('RIGHTSIDE'));
});

test('layoutBar truncates the left segment when even it does not fit', () => {
  const line = layoutBar('VERYLONGLEFT', '', 6);
  assert.equal(width(line), 6);
});

test('renderStatusBar wraps in SGR and the visible text matches the plain layout', () => {
  const plain = renderStatusBar(info, 'x', 60, { color: false });
  const styled = renderStatusBar(info, 'x', 60);
  assert.equal(width(plain), 60);
  // Strip SGR and compare to the plain version.
  // eslint-disable-next-line no-control-regex
  assert.equal(styled.replace(/\x1b\[[0-9;]*m/g, ''), plain);
});
