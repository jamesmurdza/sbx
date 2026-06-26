import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidebarLines, renderSidebar, windowStart, type SidebarItem } from '../src/tui/sidebar.ts';
import { width } from '../src/tui/statusbar.ts';

const items: SidebarItem[] = [
  { id: '6c73784c', agent: 'claude', state: 'started', current: true },
  { id: 'b14145cd', agent: 'codex', state: 'started', current: false },
  { id: '0fa69806', agent: 'claude', state: 'stopped', current: false },
];

test('windowStart keeps the selection visible', () => {
  assert.equal(windowStart(0, 3, 5), 0); // fits
  assert.equal(windowStart(9, 10, 4), 6); // clamps to end
  assert.equal(windowStart(5, 10, 4), 3); // centers
  assert.equal(windowStart(0, 10, 4), 0);
});

test('sidebarLines are exactly `width` columns and `height` tall', () => {
  const lines = sidebarLines(items, 0, 26, 8);
  assert.equal(lines.length, 8);
  for (const l of lines) assert.equal(width(l), 26);
});

test('sidebarLines mark the selection with a cursor', () => {
  const lines = sidebarLines(items, 1, 26, 8);
  assert.ok(lines[2].includes('❯'), 'row 1 is selected');
  assert.ok(!lines.join('').includes('●'), 'no active-sandbox dot');
  assert.ok(lines[0].includes('SANDBOXES'), 'title row');
});

test('sidebarLines pad empty rows when there are few items', () => {
  const lines = sidebarLines(items.slice(0, 1), 0, 26, 6);
  assert.equal(lines.length, 6);
  // last lines are blank content + separator
  assert.ok(lines[5].trimEnd().endsWith('│'));
});

test('sidebarLines render a two-row footer at the bottom', () => {
  const lines = sidebarLines(items, 0, 26, 8, ['n new  i info', 'd del  x exit']);
  assert.equal(lines.length, 8);
  for (const l of lines) assert.equal(width(l), 26);
  assert.ok(lines[6].includes('n new'), 'first footer row');
  assert.ok(lines[7].includes('x exit'), 'second footer row not clipped');
  assert.ok(lines[0].includes('SANDBOXES'));
});

test('sidebarLines show the Tab-focus hint in the title row', () => {
  const lines = sidebarLines(items, 0, 26, 8, [], '⇥ agent');
  assert.ok(lines[0].includes('SANDBOXES'), 'still shows the title');
  assert.ok(lines[0].includes('⇥ agent'), 'shows the focus hint');
  assert.equal(width(lines[0]), 26, 'title row stays full width');
});

test('renderSidebar: selection is inverse when focused, bold when not', () => {
  const focused = renderSidebar(items, 1, 26, 8, [], { focused: true });
  const blurred = renderSidebar(items, 1, 26, 8, [], { focused: false });
  assert.ok(focused[2].includes('\x1b[7m'), 'selected row is inverse when focused');
  assert.ok(!blurred[2].includes('\x1b[7m'), 'selected row is not inverse when agent-focused');
  assert.ok(blurred[2].includes('\x1b[1m'), 'selected row is bold (still visible) when agent-focused');
});

test('renderSidebar styling matches the plain lines when stripped', () => {
  const styled = renderSidebar(items, 1, 26, 8);
  const plain = renderSidebar(items, 1, 26, 8, [], { color: false });
  for (let i = 0; i < styled.length; i++) {
    // eslint-disable-next-line no-control-regex
    assert.equal(styled[i].replace(/\x1b\[[0-9;]*m/g, ''), plain[i]);
  }
});
