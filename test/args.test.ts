import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.ts';

test('no args -> list', () => {
  assert.deepEqual(parseArgs([]), { type: 'list' });
});

test('agent command -> run with args, yolo on by default', () => {
  assert.deepEqual(parseArgs(['claude', '--resume', 'x']), {
    type: 'run',
    command: 'claude',
    args: ['--resume', 'x'],
    yolo: true,
  });
});

test('--safe / --no-yolo opt out of permission skipping', () => {
  assert.equal((parseArgs(['--safe', 'claude']) as { yolo: boolean }).yolo, false);
  assert.equal((parseArgs(['--no-yolo', 'codex']) as { yolo: boolean }).yolo, false);
});

test('--yolo/-y/--dangerous explicitly keep the default (skip prompts)', () => {
  assert.equal((parseArgs(['--yolo', 'claude']) as { yolo: boolean }).yolo, true);
  assert.equal((parseArgs(['-y', 'codex', 'exec']) as { yolo: boolean }).yolo, true);
  assert.equal((parseArgs(['--dangerous', 'gemini']) as { yolo: boolean }).yolo, true);
});

test('a flag with no command is an error', () => {
  assert.equal(parseArgs(['--safe']).type, 'error');
});

test('help variants', () => {
  assert.equal(parseArgs(['help']).type, 'help');
  assert.equal(parseArgs(['--help']).type, 'help');
  assert.equal(parseArgs(['-h']).type, 'help');
});

test('ls and doctor', () => {
  assert.deepEqual(parseArgs(['ls']), { type: 'ls' });
  assert.deepEqual(parseArgs(['doctor']), { type: 'doctor' });
});

test('stop/rm require an id', () => {
  assert.deepEqual(parseArgs(['stop', 'abc123']), { type: 'stop', id: 'abc123' });
  assert.deepEqual(parseArgs(['rm', 'abc123']), { type: 'rm', id: 'abc123' });
  assert.equal(parseArgs(['stop']).type, 'error');
  assert.equal(parseArgs(['rm']).type, 'error');
});

test('push id is optional', () => {
  assert.deepEqual(parseArgs(['push']), { type: 'push', id: undefined });
  assert.deepEqual(parseArgs(['push', 'abc']), { type: 'push', id: 'abc' });
});
