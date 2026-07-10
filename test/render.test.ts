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
  fadeAnsiLine,
  rgbFromOsc,
  cellSgr,
  type Frame,
  type Cell,
  type FadeColors,
} from '../src/tui/render.ts';

const cells = (s: string, sgr = ''): Cell[] => [...s].map((ch) => ({ ch, sgr }));

test('fadeFrame blends cell colours halfway toward the background', () => {
  // fg light grey, bg black, 50% blend → every channel halves for the fg blend.
  const colors: FadeColors = { fg: [200, 200, 200], bg: [0, 0, 0] };
  const frame: Frame = [
    [
      { ch: ' ', sgr: '' }, // blank space, default bg → left untouched (no diff churn)
      { ch: 'x', sgr: '' }, // default fg glyph → fades to half the fg
      { ch: 'c', sgr: '38;5;1' }, // palette red (128,0,0) → (64,0,0)
      { ch: 'd', sgr: '1;38;2;100;40;20' }, // bold dropped; RGB fg halved
      { ch: 'u', sgr: '4;38;5;1' }, // underline kept; palette red halved
      { ch: 'z', sgr: '7;38;2;200;0;0' }, // inverse: shows red bg / default(black) fg
      { ch: ' ', sgr: '48;2;80;80;80' }, // bg-filled space → fades fg + bg, not skipped
    ],
  ];
  const faded = fadeFrame(frame, colors, 0.5);
  assert.deepEqual(
    faded[0].map((c) => c.sgr),
    [
      '',
      '38;2;100;100;100',
      '38;2;64;0;0',
      '38;2;50;20;10',
      '4;38;2;64;0;0',
      '38;2;0;0;0;48;2;100;0;0',
      '38;2;100;100;100;48;2;40;40;40',
    ],
  );
  // Characters preserved; input frame not mutated.
  assert.equal(faded[0].map((c) => c.ch).join(''), ' xcduz ');
  assert.equal(frame[0][3].sgr, '1;38;2;100;40;20');
});

test('fadeAnsiLine blends styled runs toward bg, dropping bold/inverse', () => {
  const colors: FadeColors = { fg: [200, 200, 200], bg: [0, 0, 0] };
  // Bold title then a faint separator → both become the same faded grey (no bold).
  assert.equal(
    fadeAnsiLine('\x1b[1mSANDBOXES\x1b[22m\x1b[2m│\x1b[22m', colors, 0.5),
    '\x1b[0m\x1b[38;2;100;100;100mSANDBOXES\x1b[0m\x1b[38;2;100;100;100m│\x1b[0m',
  );
  // Inverse selection → a faded bar (bg-coloured text on faded-fg background);
  // trailing blank spaces with no background are left untouched.
  assert.equal(
    fadeAnsiLine('\x1b[7m❯ item\x1b[27m  \x1b[0m', colors, 0.5),
    '\x1b[0m\x1b[38;2;0;0;0;48;2;100;100;100m❯ item\x1b[0m  \x1b[0m',
  );
});

test('rgbFromOsc parses OSC 10/11 colour replies at any hex width', () => {
  assert.deepEqual(rgbFromOsc('\x1b]11;rgb:0000/0000/0000\x07'), [0, 0, 0]);
  assert.deepEqual(rgbFromOsc('\x1b]10;rgb:ffff/ffff/ffff\x07'), [255, 255, 255]);
  assert.deepEqual(rgbFromOsc('\x1b]11;rgb:ff/80/00\x07'), [255, 128, 0]);
  assert.equal(rgbFromOsc('not a colour'), null);
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
