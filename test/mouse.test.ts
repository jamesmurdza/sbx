import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSgrMouse,
  translateToAgent,
  protocolWantsEvent,
  encodeMouse,
  trackMouseEncoding,
  isWheel,
  wheelDirection,
  type MouseEvent,
} from '../src/tui/mouse.ts';

const press = (over = {}): MouseEvent => ({ button: 0, col: 5, row: 3, pressed: true, motion: false, ...over });

test('extractSgrMouse decodes press and release and separates passthrough bytes', () => {
  const { events, rest } = extractSgrMouse('a\x1b[<0;12;7Mb\x1b[<0;12;7mc');
  assert.equal(rest, 'abc');
  assert.deepEqual(events, [
    { button: 0, col: 12, row: 7, pressed: true, motion: false },
    { button: 0, col: 12, row: 7, pressed: false, motion: false },
  ]);
});

test('extractSgrMouse flags motion reports (button bit 32)', () => {
  const { events } = extractSgrMouse('\x1b[<35;4;4M');
  assert.equal(events[0].motion, true);
});

test('extractSgrMouse leaves a partial sequence in rest', () => {
  const { events, rest } = extractSgrMouse('\x1b[<0;12');
  assert.equal(events.length, 0);
  assert.equal(rest, '\x1b[<0;12');
});

test('translateToAgent swallows events on the status row', () => {
  assert.equal(translateToAgent(press({ row: 24 }), 23), null);
  assert.deepEqual(translateToAgent(press({ row: 23 }), 23), press({ row: 23 }));
});

test('protocolWantsEvent filters by the agent protocol', () => {
  const motion = press({ motion: true });
  const release = press({ pressed: false });
  assert.equal(protocolWantsEvent(press(), 'none'), false);
  assert.equal(protocolWantsEvent(press(), 'x10'), true);
  assert.equal(protocolWantsEvent(release, 'x10'), false); // x10 = press only
  assert.equal(protocolWantsEvent(motion, 'vt200'), false); // no motion
  assert.equal(protocolWantsEvent(release, 'vt200'), true);
  assert.equal(protocolWantsEvent(motion, 'any'), true);
});

test('encodeMouse SGR round-trips through extractSgrMouse', () => {
  const e = press({ button: 2, col: 40, row: 10 });
  const { events } = extractSgrMouse(encodeMouse(e, 'sgr'));
  assert.deepEqual(events[0], e);
});

test('encodeMouse default (X10) uses +32 offsets and reports release as button 3', () => {
  assert.equal(encodeMouse(press({ button: 0, col: 1, row: 1 }), 'default'), '\x1b[M\x20\x21\x21');
  assert.equal(encodeMouse(press({ button: 0, col: 1, row: 1, pressed: false }), 'default'), '\x1b[M\x23\x21\x21');
});

test('encodeMouse urxvt uses decimal with +32 on the button', () => {
  assert.equal(encodeMouse(press({ button: 0, col: 5, row: 3 }), 'urxvt'), '\x1b[32;5;3M');
});

test('trackMouseEncoding follows DECSET/DECRST toggles', () => {
  assert.equal(trackMouseEncoding('\x1b[?1006h', 'default'), 'sgr');
  assert.equal(trackMouseEncoding('\x1b[?1015h', 'default'), 'urxvt');
  assert.equal(trackMouseEncoding('\x1b[?1006l', 'sgr'), 'default');
  assert.equal(trackMouseEncoding('no toggles here', 'sgr'), 'sgr');
});

test('wheel helpers detect direction', () => {
  assert.equal(isWheel(press({ button: 64 })), true);
  assert.equal(isWheel(press({ button: 0 })), false);
  assert.equal(wheelDirection(press({ button: 64 })), 1);
  assert.equal(wheelDirection(press({ button: 65 })), -1);
  assert.equal(wheelDirection(press({ button: 0 })), 0);
});
