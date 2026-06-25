import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yoloFlagFor } from '../src/config.ts';

test('known agents map to their permission-skip flag', () => {
  assert.equal(yoloFlagFor('claude'), '--dangerously-skip-permissions');
  assert.equal(yoloFlagFor('codex'), '--yolo');
  assert.equal(yoloFlagFor('gemini'), '--yolo');
  assert.equal(yoloFlagFor('copilot'), '--autopilot');
  assert.equal(yoloFlagFor('kilo'), '--auto');
});

test('unknown agents have no flag', () => {
  assert.equal(yoloFlagFor('somethingelse'), undefined);
});
