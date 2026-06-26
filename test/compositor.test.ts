import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Compositor } from '../src/tui/compositor.ts';
import type { BarInfo } from '../src/tui/statusbar.ts';

const bar: BarInfo = { shortId: 'abc', agent: 'claude' };

function harness(rows = 6, cols = 20) {
  const writes: string[] = [];
  const toPty: string[] = [];
  const sizes: Array<[number, number]> = [];
  const selected: Array<{ id: string; index: number }> = [];
  const sessionActions: string[] = [];
  const inlineActions: Array<{ kind: string; id: string }> = [];
  const deleteCurrent: Array<{ id: string; neighbour: string | null }> = [];
  const newCount: number[] = [];
  const infoFor: string[] = [];
  const openBranchFor: string[] = [];
  const selectionChanges: string[] = [];
  const c = new Compositor({
    cols,
    rows,
    bar,
    write: (d) => writes.push(d),
    sendInput: (d) => toPty.push(typeof d === 'string' ? d : Buffer.from(d).toString('binary')),
    onAgentSize: (co, ro) => sizes.push([co, ro]),
    onSidebarSelect: (it, index) => selected.push({ id: it.id, index }),
    onSelectionChange: (it) => selectionChanges.push(it.id),
    onSessionAction: (a) => sessionActions.push(a),
    onNew: () => newCount.push(1),
    onInfo: (it) => infoFor.push(it.id),
    onOpenBranch: (it) => openBranchFor.push(it.id),
    onDeleteCurrent: (cur, nb) => deleteCurrent.push({ id: cur.id, neighbour: nb?.id ?? null }),
    onDeleteOther: (it) => inlineActions.push({ kind: 'delete', id: it.id }),
  });
  return { c, writes, toPty, sizes, selected, sessionActions, deleteCurrent, inlineActions, newCount, infoFor, openBranchFor, selectionChanges, out: () => writes.join('') };
}

const sandboxes = [
  { id: 'aaaa1111', agent: 'claude', state: 'started', current: true },
  { id: 'bbbb2222', agent: 'codex', state: 'started', current: false },
  { id: 'cccc3333', agent: 'claude', state: 'stopped', current: false },
];

test('agentFocused tracks the sidebar, modal, and two-pane arrow focus', async () => {
  const { c } = harness(12, 80);
  c.start();
  c.setSandboxes(sandboxes);
  assert.equal(c.agentFocused(), true, 'agent has focus by default');
  c.input(Buffer.from('\x1d')); // open the sidebar (focuses it)
  assert.equal(c.agentFocused(), false, 'sidebar captures input when focused');
  c.input(Buffer.from('\x1b[C')); // → hand focus to the agent (sidebar stays open)
  assert.equal(c.agentFocused(), true, 'agent has focus while the sidebar is still open');
  c.input(Buffer.from('\x1b[D')); // ← back to the sidebar
  assert.equal(c.agentFocused(), false, 'focus moved back to the sidebar');
  c.input(Buffer.from('d')); // open the delete modal
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(c.agentFocused(), false, 'modal captures input');
  c.input(Buffer.from('\x1b')); // Esc → cancel modal
  c.input(Buffer.from('\x1d')); // close the sidebar
  assert.equal(c.agentFocused(), true, 'focus returns to the agent');
  c.stop();
});

test('with the sidebar open, → forwards typing to the agent (not the sidebar)', () => {
  const { c, toPty, newCount } = harness(12, 80);
  c.start();
  c.setSandboxes(sandboxes);
  c.input(Buffer.from('\x1d')); // open the sidebar (focused)
  c.input(Buffer.from('n')); // 'n' is a sidebar hotkey → new sandbox
  assert.equal(newCount.length, 1, 'sidebar consumed the hotkey');
  assert.equal(toPty.join(''), '', 'nothing went to the agent yet');

  c.input(Buffer.from('\x1b[C')); // → focus the agent
  c.input(Buffer.from('n')); // now a literal key for the agent
  c.input(Buffer.from('hi'));
  assert.equal(newCount.length, 1, 'no extra sidebar action while agent-focused');
  assert.equal(toPty.join(''), 'nhi', 'keys typed into the agent with the sidebar still open');

  c.input(Buffer.from('\x1b[D')); // ← focus the sidebar again
  c.input(Buffer.from('n')); // hotkey works again
  assert.equal(newCount.length, 2, 'sidebar hotkeys work after ← returns focus');
  c.stop();
});

test('answers the agent OSC 10/11 colour queries when replies are set', () => {
  const { c, toPty } = harness(6, 20);
  c.start();
  c.setColorReplies({ osc10: '\x1b]10;rgb:0000/0000/0000\x07', osc11: '\x1b]11;rgb:ffff/ffff/ffff\x07' });
  c.feed('\x1b]11;?\x07'); // agent asks for the background
  c.feed('\x1b]10;?\x07'); // agent asks for the foreground
  assert.ok(toPty.join('').includes('\x1b]11;rgb:ffff/ffff/ffff\x07'), 'replied with the background');
  assert.ok(toPty.join('').includes('\x1b]10;rgb:0000/0000/0000\x07'), 'replied with the foreground');
  c.stop();
});

test('does not answer colour queries before replies are known', () => {
  const { c, toPty } = harness(6, 20);
  c.start();
  c.feed('\x1b]11;?\x07');
  assert.equal(toPty.join('').includes('rgb:'), false, 'stays silent without detected colours');
  c.stop();
});

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

test('x detaches the session; n requests a new sandbox', () => {
  const { c, sessionActions, newCount } = harness(12, 80);
  c.start();
  c.setSandboxes(sandboxes); // index 0 is current
  c.input(Buffer.from('\x1d')); // open (selection starts on current = 0)
  c.input(Buffer.from('x')); // detach the whole session
  assert.deepEqual(sessionActions, ['detached']);
  c.input(Buffer.from('n')); // request a new sandbox
  assert.equal(newCount.length, 1);
  c.stop();
});

test('moving the selection fires onSelectionChange (live preview)', () => {
  const { c, selectionChanges } = harness(12, 80);
  c.start();
  c.setSandboxes(sandboxes);
  c.input(Buffer.from('\x1d')); // open (selection on current, index 0)
  c.input(Buffer.from('\x1b[B')); // down → bbbb2222
  c.input(Buffer.from('\x1b[B')); // down → cccc3333
  c.input(Buffer.from('\x1b[B')); // already at end → no change, no event
  assert.deepEqual(selectionChanges, ['bbbb2222', 'cccc3333']);
  c.stop();
});

test('i and g act on the selected sandbox', () => {
  const { c, infoFor, openBranchFor } = harness(12, 80);
  c.start();
  c.setSandboxes(sandboxes);
  c.input(Buffer.from('\x1d')); // open; selection on current (index 0)
  c.input(Buffer.from('\x1b[B')); // down → bbbb2222
  c.input(Buffer.from('i'));
  c.input(Buffer.from('g'));
  assert.deepEqual(infoFor, ['bbbb2222']);
  assert.deepEqual(openBranchFor, ['bbbb2222']);
  c.stop();
});

const tick = () => new Promise((res) => setTimeout(res, 25));

test('deleting the current sandbox hands off to a neighbour (keeps the flow)', async () => {
  const { c, deleteCurrent, sessionActions } = harness(12, 80);
  c.start();
  c.setSandboxes(sandboxes); // current = aaaa1111, others present
  c.input(Buffer.from('\x1d')); // open, selection on current
  c.input(Buffer.from('d')); // open the delete modal
  await tick();
  c.input(Buffer.from('\r')); // Return = default (Delete)
  await tick();
  assert.deepEqual(deleteCurrent, [{ id: 'aaaa1111', neighbour: 'bbbb2222' }]);
  assert.deepEqual(sessionActions, [], 'no abrupt session-ending action');
  c.stop();
});

test('deleting the current sandbox with no other sandbox ends the session', async () => {
  const { c, deleteCurrent } = harness(12, 80);
  c.start();
  c.setSandboxes([sandboxes[0]]); // only the current sandbox
  c.input(Buffer.from('\x1d'));
  c.input(Buffer.from('d'));
  await tick();
  c.input(Buffer.from('\r'));
  await tick();
  assert.deepEqual(deleteCurrent, [{ id: 'aaaa1111', neighbour: null }]);
  c.stop();
});

test('deleting another sandbox removes it optimistically and survives a stale refresh', async () => {
  const { c, writes, inlineActions } = harness(14, 80);
  c.start();
  c.setSandboxes(sandboxes); // aaaa(cur), bbbb, cccc
  c.input(Buffer.from('\x1d'));
  c.input(Buffer.from('\x1b[B')); // select bbbb2222
  c.input(Buffer.from('d'));
  await tick();
  c.input(Buffer.from('\r')); // Return = Delete
  await tick();
  assert.deepEqual(inlineActions, [{ kind: 'delete', id: 'bbbb2222' }]);

  // A stale refresh still listing bbbb keeps it hidden (no flicker/reappear).
  c.setSandboxes(sandboxes);
  writes.length = 0;
  await tick();
  assert.ok(!writes.join('').includes('bbbb2222'), 'optimistically removed despite stale refresh');

  // Server confirms bbbb gone → the filter clears.
  c.setSandboxes([sandboxes[0], sandboxes[2]]);
  await tick();
  writes.length = 0;
  c.setSandboxes(sandboxes);
  await tick();
  assert.ok(writes.join('').includes('bbbb2222'), 'filter cleared after server confirmed deletion');
  c.stop();
});

test('delete modal: Return deletes, Esc cancels', async () => {
  const { c, inlineActions } = harness(12, 80);
  c.start();
  c.setSandboxes(sandboxes);
  c.input(Buffer.from('\x1d'));
  c.input(Buffer.from('\x1b[B')); // select bbbb2222

  c.input(Buffer.from('d')); // open modal
  await tick();
  c.input(Buffer.from('\x1b')); // Esc → cancel
  await tick();
  assert.deepEqual(inlineActions, [], 'cancelled, no delete');

  c.input(Buffer.from('d')); // open modal again
  await tick();
  c.input(Buffer.from('\r')); // Return = default (Delete)
  await tick();
  assert.deepEqual(inlineActions, [{ kind: 'delete', id: 'bbbb2222' }]);
  c.stop();
});

// Presses `d` to open the delete modal and returns the painted output (whose
// title names the selected sandbox).
async function modalAfterDelete(c: Compositor, writes: string[]): Promise<string> {
  writes.length = 0;
  c.input(Buffer.from('d'));
  for (let i = 0; i < 50 && !writes.join('').includes('Delete sandbox'); i++) {
    await new Promise((res) => setTimeout(res, 10));
  }
  return writes.join('');
}

test('selection follows the same sandbox by id when the list reorders', async () => {
  const { c, writes } = harness(12, 80);
  c.start();
  c.setSandboxes(sandboxes); // [aaaa(cur), bbbb, cccc]
  c.input(Buffer.from('\x1d'));
  c.input(Buffer.from('\x1b[B')); // select bbbb2222
  c.setSandboxes([sandboxes[2], sandboxes[1], sandboxes[0]]); // reorder
  const out = await modalAfterDelete(c, writes);
  assert.ok(out.includes('Delete sandbox bbbb2222?'), 'still on bbbb2222 after reorder');
  c.stop();
});

test('a newly attached sandbox (e.g. just created) pulls the selection onto it', async () => {
  const { c, writes } = harness(14, 80);
  c.start();
  c.setSandboxes(sandboxes); // [aaaa(cur), bbbb, cccc]
  c.input(Buffer.from('\x1d')); // open, selection on current (aaaa)
  c.input(Buffer.from('\x1b[B')); // move selection to bbbb2222
  // A new sandbox is created: it lands at the top and becomes the attached one.
  const created = { id: 'dddd4444', agent: 'claude', state: 'started', current: true };
  c.setSandboxes([created, { ...sandboxes[0], current: false }, sandboxes[1], sandboxes[2]]);
  const out = await modalAfterDelete(c, writes);
  assert.ok(out.includes('Delete sandbox dddd4444?'), 'selection jumped to the newly attached sandbox');
  c.stop();
});

test('deleting the selected sandbox keeps the cursor on the neighbour', async () => {
  const { c, writes } = harness(12, 80);
  c.start();
  c.setSandboxes(sandboxes); // [aaaa(cur), bbbb, cccc]
  c.input(Buffer.from('\x1d'));
  c.input(Buffer.from('\x1b[B')); // select bbbb2222 (index 1)
  // Simulate the post-delete refresh: bbbb is gone.
  c.setSandboxes([sandboxes[0], sandboxes[2]]); // [aaaa(cur), cccc]
  const out = await modalAfterDelete(c, writes);
  assert.ok(out.includes('Delete sandbox cccc3333?'), 'cursor moved to the neighbour, not the current sandbox');
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

test('a modal renders in the agent pane and resolves on Enter (sidebar stays up)', async () => {
  const { c, writes } = harness(14, 80);
  c.start();
  c.setSandboxes(sandboxes);
  c.input(Buffer.from('\x1d')); // open the sidebar
  writes.length = 0;
  const p = c.menu('Choose', [
    { label: 'alpha', value: 'a' },
    { label: 'beta', value: 'b' },
  ]);
  for (let i = 0; i < 50 && !writes.join('').includes('Choose'); i++) {
    await new Promise((res) => setTimeout(res, 10));
  }
  const out = writes.join('');
  assert.ok(out.includes('Choose') && out.includes('alpha'), 'modal shown in the agent pane');
  // The modal never repaints the sidebar band — its writes are all at columns
  // past the sidebar width (no escape positions a row at column 1 here).
  assert.ok(!/\x1b\[\d+;1H[^\x1b]*alpha/.test(out), 'modal not drawn over the sidebar');

  c.input(Buffer.from('\x1b[B')); // down → beta
  c.input(Buffer.from('\r')); // enter
  assert.equal(await p, 'b');
  c.stop();
});

test('a modal can be cancelled with Esc', async () => {
  const { c } = harness(14, 80);
  c.start();
  c.setSandboxes(sandboxes);
  c.input(Buffer.from('\x1d'));
  const p = c.menu('Choose', [{ label: 'alpha', value: 'a' }]);
  await new Promise((res) => setTimeout(res, 20));
  c.input(Buffer.from('\x1b')); // Esc
  assert.equal(await p, null);
  c.stop();
});

test('openSidebar opens the sidebar (idempotently) as the entry menu', () => {
  const { c, writes, sizes } = harness(10, 80);
  c.start();
  c.setSandboxes(sandboxes);
  writes.length = 0;
  c.openSidebar();
  assert.ok(writes.join('').includes('SANDBOXES'), 'sidebar shown');
  assert.equal(sizes.length, 1, 'reflowed once');
  c.openSidebar(); // already open → no extra reflow
  assert.equal(sizes.length, 1);
  c.stop();
});

test('resetAgent shows a placeholder until the next agent output arrives', async () => {
  const { c, writes } = harness(8, 40);
  c.start();
  writes.length = 0;
  c.resetAgent('connecting…');
  assert.ok(writes.join('').includes('connecting…'), 'placeholder shown');
  writes.length = 0;
  c.feed('\x1b[1;1HNEWAGENT');
  for (let i = 0; i < 50 && !writes.join('').includes('NEWAGENT'); i++) {
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.ok(writes.join('').includes('NEWAGENT'), 'agent output replaces the placeholder');
  c.stop();
});

test('setBar updates the status bar fields without a full restart', () => {
  const { c, writes } = harness(8, 40);
  c.start();
  writes.length = 0;
  c.setBar({ shortId: 'zzzz9999', agent: 'gemini' });
  // bar repaint is coalesced; force it via a reset which renders synchronously
  c.resetAgent('');
  assert.ok(writes.join('').includes('zzzz9999'), 'new sandbox id shown in the bar');
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
