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

test('sidebarLines mark the selection and the current sandbox', () => {
  const lines = sidebarLines(items, 1, 26, 8);
  assert.ok(lines[1].includes('●'), 'row 0 is the current sandbox');
  assert.ok(lines[2].includes('❯'), 'row 1 is selected');
  assert.ok(lines[0].includes('SANDBOXES'), 'title row');
});

test('sidebarLines pad empty rows when there are few items', () => {
  const lines = sidebarLines(items.slice(0, 1), 0, 26, 6);
  assert.equal(lines.length, 6);
  // last lines are blank content + separator
  assert.ok(lines[5].trimEnd().endsWith('│'));
});

test('sidebarLines render a footer on the last line when provided', () => {
  const lines = sidebarLines(items, 0, 26, 8, 's stop  d del');
  assert.equal(lines.length, 8);
  for (const l of lines) assert.equal(width(l), 26);
  assert.ok(lines[7].includes('s stop'), 'footer on the last line');
  // items now occupy fewer rows (title + footer reserved)
  assert.ok(lines[0].includes('SANDBOXES'));
});

test('renderSidebar styling matches the plain lines when stripped', () => {
  const styled = renderSidebar(items, 1, 26, 8);
  const plain = renderSidebar(items, 1, 26, 8, '', { color: false });
  for (let i = 0; i < styled.length; i++) {
    // eslint-disable-next-line no-control-regex
    assert.equal(styled[i].replace(/\x1b\[[0-9;]*m/g, ''), plain[i]);
  }
});
