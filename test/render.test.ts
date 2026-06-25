import { test } from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
const { Terminal } = xterm;
import {
  emitRow,
  renderFrameDiff,
  blankFrame,
  frameFromBuffer,
  cellSgr,
  type Frame,
  type Cell,
} from '../src/tui/render.ts';

const cells = (s: string, sgr = ''): Cell[] => [...s].map((ch) => ({ ch, sgr }));

test('emitRow emits SGR only when the style changes, resetting at both ends', () => {
  const row: Cell[] = [
    { ch: 'a', sgr: '' },
    { ch: 'b', sgr: '1' },
    { ch: 'c', sgr: '1' },
    { ch: 'd', sgr: '' },
  ];
  assert.equal(emitRow(row), '\x1b[0ma\x1b[1mbc\x1b[0md\x1b[0m');
});

test('renderFrameDiff repaints only changed rows, positioned absolutely', () => {
  const prev: Frame = [cells('aa'), cells('bb')];
  const next: Frame = [cells('aa'), cells('bX')];
  const out = renderFrameDiff(prev, next);
  assert.ok(!out.includes('\x1b[1;1H'), 'row 0 unchanged → not repainted');
  assert.ok(out.includes('\x1b[2;1H'), 'row 1 changed → repainted at row 2');
  assert.ok(out.includes('\x1b[0K'), 'clears to end of line');
});

test('renderFrameDiff with no prev frame paints every row', () => {
  const next: Frame = [cells('a'), cells('b')];
  const out = renderFrameDiff(null, next);
  assert.ok(out.includes('\x1b[1;1H') && out.includes('\x1b[2;1H'));
});

test('renderFrameDiff honors a row offset (reserved status row)', () => {
  const out = renderFrameDiff(null, [cells('x')], 5);
  assert.ok(out.includes('\x1b[5;1H'));
});

test('blankFrame builds the right dimensions of spaces', () => {
  const f = blankFrame(3, 2);
  assert.equal(f.length, 2);
  assert.equal(f[0].length, 3);
  assert.ok(f[0].every((c) => c.ch === ' ' && c.sgr === ''));
});

// --- cellSgr / frameFromBuffer against a real headless emulator -------------

test('cellSgr and frameFromBuffer extract text + truecolor from xterm', async () => {
  const term = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });
  await new Promise<void>((res) => term.write('\x1b[1;1Hhi\x1b[38;2;255;0;0mR\x1b[0m', () => res()));

  const frame = frameFromBuffer(term.buffer.active, 0, 10, 3);
  assert.equal(frame[0].slice(0, 3).map((c) => c.ch).join(''), 'hiR');
  // 'R' carries truecolor red foreground.
  assert.equal(frame[0][2].sgr, '38;2;255;0;0');
  // bold attribute is surfaced by cellSgr.
  await new Promise<void>((res) => term.write('\x1b[2;1H\x1b[1mB', () => res()));
  const f2 = frameFromBuffer(term.buffer.active, 0, 10, 3);
  assert.ok(f2[1][0].sgr.split(';').includes('1'));
});

test('frameFromBuffer keeps rows at exactly `cols` visual columns with wide glyphs', () => {
  const term = new Terminal({ cols: 6, rows: 1, allowProposedApi: true });
  // Two wide CJK glyphs (width 2 each) + two narrow = 6 visual columns.
  return new Promise<void>((res) => {
    term.write('\x1b[1;1H世界ab', () => {
      const f = frameFromBuffer(term.buffer.active, 0, 6, 1);
      const visual = f[0].reduce((n, c) => n + ([...c.ch][0] && c.ch.charCodeAt(0) > 0x1100 ? 2 : 1), 0);
      assert.equal(visual, 6, 'row spans exactly cols visual columns');
      assert.equal(f[0].map((c) => c.ch).join(''), '世界ab');
      res();
    });
  });
});
