import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { detectBackground, colorfgbg, colorReplies } from '../src/tui/theme.ts';

/** A fake raw stdin/stdout pair: writes to stdout trigger a queued reply on stdin. */
function fakeTty(reply?: string) {
  const stdin: any = new EventEmitter();
  stdin.isTTY = true;
  stdin.removeListener = EventEmitter.prototype.removeListener.bind(stdin);
  const stdout: any = {
    isTTY: true,
    write: () => {
      if (reply !== undefined) setImmediate(() => stdin.emit('data', Buffer.from(reply, 'binary')));
    },
  };
  return { stdin, stdout };
}

test('detectBackground parses a light terminal response', async () => {
  const { stdin, stdout } = fakeTty('\x1b]11;rgb:ffff/ffff/ffff\x07');
  const bg = await detectBackground(stdin, stdout, 200);
  assert.ok(bg);
  assert.equal(bg.isDark, false);
  assert.equal(bg.osc11, '\x1b]11;rgb:ffff/ffff/ffff\x07');
});

test('detectBackground parses a dark terminal response (ST-terminated)', async () => {
  const { stdin, stdout } = fakeTty('\x1b]11;rgb:0000/0000/0000\x1b\\');
  const bg = await detectBackground(stdin, stdout, 200);
  assert.ok(bg);
  assert.equal(bg.isDark, true);
});

test('detectBackground resolves null on timeout (no reply)', async () => {
  const { stdin, stdout } = fakeTty(undefined);
  const bg = await detectBackground(stdin, stdout, 30);
  assert.equal(bg, null);
});

test('detectBackground returns null without a TTY', async () => {
  const bg = await detectBackground({ isTTY: false } as any, { isTTY: false } as any);
  assert.equal(bg, null);
});

test('colorfgbg encodes light vs dark', () => {
  assert.equal(colorfgbg(true), '15;0');
  assert.equal(colorfgbg(false), '0;15');
});

test('colorReplies echoes OSC 11 and contrasts the foreground', () => {
  const light = colorReplies({ isDark: false, osc11: '\x1b]11;rgb:ffff/ffff/ffff\x07' });
  assert.equal(light.osc11, '\x1b]11;rgb:ffff/ffff/ffff\x07');
  assert.ok(light.osc10.includes('0000/0000/0000'), 'black foreground on a light background');
  const dark = colorReplies({ isDark: true, osc11: '\x1b]11;rgb:0000/0000/0000\x07' });
  assert.ok(dark.osc10.includes('ffff/ffff/ffff'), 'white foreground on a dark background');
});
