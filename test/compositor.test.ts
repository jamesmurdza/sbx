import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampScroll, viewportTop, Compositor } from '../src/tui/compositor.ts';
import type { BarInfo } from '../src/tui/statusbar.ts';

test('clampScroll bounds the offset to [0, max]', () => {
  assert.equal(clampScroll(-5, 100), 0);
  assert.equal(clampScroll(50, 100), 50);
  assert.equal(clampScroll(200, 100), 100);
});

test('viewportTop never goes negative', () => {
  assert.equal(viewportTop(10, 3), 7);
  assert.equal(viewportTop(2, 10), 0);
});

const bar: BarInfo = { shortId: 'abc', agent: 'claude' };

function harness(rows = 6, cols = 20) {
  const writes: string[] = [];
  const toPty: string[] = [];
  const sizes: Array<[number, number]> = [];
  const selected: Array<{ id: string; index: number }> = [];
  const c = new Compositor({
    cols,
    rows,
    bar,
    write: (d) => writes.push(d),
    sendInput: (d) => toPty.push(typeof d === 'string' ? d : Buffer.from(d).toString('binary')),
    onAgentSize: (co, ro) => sizes.push([co, ro]),
    onSidebarSelect: (it, index) => selected.push({ id: it.id, index }),
  });
  return { c, writes, toPty, sizes, selected, out: () => writes.join('') };
}

const sandboxes = [
  { id: 'aaaa1111', agent: 'claude', state: 'started', current: true },
  { id: 'bbbb2222', agent: 'codex', state: 'started', current: false },
  { id: 'cccc3333', agent: 'claude', state: 'stopped', current: false },
];

test('start paints a frame and the status bar on the bottom row', () => {
  const { c, out } = harness(6, 20);
  c.start();
  const s = out();
  assert.ok(s.includes('\x1b[?1049h'), 'enters alt screen');
  assert.ok(s.includes('\x1b[6;1H'), 'positions the status bar on the last row');
  c.stop();
});

test('feed renders agent output into the agent region', async () => {
  const { c, writes } = harness(6, 20);
  c.start();
  c.feed('\x1b[1;1HHELLO');
  // Rendering is coalesced on a timer; poll until it lands (avoids flakiness).
  for (let i = 0; i < 100 && !writes.join('').includes('HELLO'); i++) {
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.ok(writes.join('').includes('HELLO'));
  c.stop();
});

test('keystrokes are forwarded to the PTY untouched when mouse is off', () => {
  const { c, toPty } = harness();
  c.start();
  c.input(Buffer.from('ls\r'));
  assert.equal(toPty.join(''), 'ls\r');
  c.stop();
});

test('Ctrl-] toggles the sidebar and reflows the agent width', () => {
  const { c, writes, sizes } = harness(10, 80);
  c.start();
  c.setSandboxes(sandboxes);
  writes.length = 0;
  c.input(Buffer.from('\x1d')); // Ctrl-]
  assert.ok(writes.join('').includes('SANDBOXES'), 'sidebar painted');
  assert.equal(sizes.length, 1, 'agent reflow requested');
  assert.ok(sizes[0][0] < 80, 'agent width shrank to make room');
  c.input(Buffer.from('\x1d')); // close
  assert.equal(sizes[1][0], 80, 'agent width restored on close');
  c.stop();
});

test('open sidebar captures arrows and Enter activates the selection', () => {
  const { c, selected } = harness(10, 80);
  c.start();
  c.setSandboxes(sandboxes);
  c.input(Buffer.from('\x1d')); // open (selection starts on current = index 0)
  c.input(Buffer.from('\x1b[B')); // down
  c.input(Buffer.from('\r')); // enter
  assert.deepEqual(selected, [{ id: 'bbbb2222', index: 1 }]);
  c.stop();
});

test('keystrokes are NOT forwarded to the agent while the sidebar is open', () => {
  const { c, toPty } = harness(10, 80);
  c.start();
  c.setSandboxes(sandboxes);
  c.input(Buffer.from('\x1d'));
  toPty.length = 0;
  c.input(Buffer.from('x'));
  assert.equal(toPty.join(''), '', 'navigation key swallowed, not sent to agent');
  c.stop();
});

test('stop restores the cursor and leaves the alt screen', () => {
  const { c, writes } = harness();
  c.start();
  writes.length = 0;
  c.stop();
  const s = writes.join('');
  assert.ok(s.includes('\x1b[?25h') && s.includes('\x1b[?1049l'));
});
