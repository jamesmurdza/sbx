import { test } from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
const { Terminal } = xterm;
import {
  emitRow,
  renderFrameDiff,
  blankFrame,
  frameFromBuffer,
  fadeFrame,
  cellSgr,
  type Frame,
  type Cell,
} from '../src/tui/render.ts';

const cells = (s: string, sgr = ''): Cell[] => [...s].map((ch) => ({ ch, sgr }));

test('fadeFrame forces faint, drops bold, and leaves default cells untouched', () => {
  const frame: Frame = [
    [
      { ch: 'a', sgr: '' }, // default/blank — untouched so blanks don't churn the diff
      { ch: 'b', sgr: '1' }, // bold — bold dropped, faint added
      { ch: 'c', sgr: '38;5;4' }, // coloured — faint prepended
      { ch: 'd', sgr: '2' }, // already faint — stays a single faint
      { ch: 'e', sgr: '1;4;38;5;4' }, // bold+underline+colour — bold gone, underline/colour kept
      { ch: 'f', sgr: '38;5;1' }, // palette colour whose value is 1 — must NOT be stripped
      { ch: 'g', sgr: '1;38;2;1;2;3' }, // bold + RGB(1,2,3) — bold gone, RGB components intact
    ],
  ];
  const faded = fadeFrame(frame);
  assert.deepEqual(
    faded[0].map((c) => c.sgr),
    ['', '2', '2;38;5;4', '2', '2;4;38;5;4', '2;38;5;1', '2;38;2;1;2;3'],
  );
  // Characters are preserved and the input frame is not mutated.
  assert.equal(faded[0].map((c) => c.ch).join(''), 'abcdefg');
  assert.equal(frame[0][1].sgr, '1');
});

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
