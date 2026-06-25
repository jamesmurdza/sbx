import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmuxConf, writeStatusCommand, displayBranch } from '../src/tui/tmux.ts';

test('displayBranch strips the teleport wrapper and id suffix', () => {
  assert.equal(displayBranch('teleport/agent/swift-quiet-n2xr/24cd570d'), 'agent/swift-quiet-n2xr');
  assert.equal(displayBranch('teleport/main/abcd1234'), 'main');
  // Non-teleport branches are unchanged.
  assert.equal(displayBranch('feature/login'), 'feature/login');
  assert.equal(displayBranch('main'), 'main');
});

test('tmuxConf enables a bottom status bar with our fields', () => {
  const conf = tmuxConf({ shortId: 'abcd1234', agent: 'claude', repo: 'o/r', branch: 'teleport/main/abcd1234' });
  assert.match(conf, /set -g status on/);
  assert.match(conf, /status-position bottom/);
  assert.ok(conf.includes('abcd1234'), 'includes sandbox short id');
  assert.ok(conf.includes('claude'), 'includes agent');
  assert.ok(conf.includes('↟ main'), 'shows the base branch, not the full teleport branch');
  assert.ok(!conf.includes('teleport/main/abcd1234'), 'does not repeat the full branch');
  assert.match(conf, /cat \/tmp\/teleport-status/, 'reads live status file');
});

test('tmuxConf sets terminal capabilities for colour/unicode', () => {
  const conf = tmuxConf({ shortId: 'x', agent: 'claude' });
  assert.match(conf, /default-terminal "screen-256color"/);
  assert.match(conf, /terminal-overrides .*Tc/);
});

test('tmuxConf does NOT bind Ctrl-\\ (teleport intercepts it locally)', () => {
  const conf = tmuxConf({ shortId: 'x', agent: 'claude' });
  assert.ok(!/bind-key -n C-\\/.test(conf), 'Ctrl-\\ must not be bound in tmux');
  assert.match(conf, /Ctrl-\\\\ menu/, 'status hint advertises the menu');
});

test('writeStatusCommand escapes single quotes safely', () => {
  const cmd = writeStatusCommand("it's ok");
  assert.ok(cmd.includes('teleport-status'));
  assert.ok(!/[^\\]'[^\\']*'[^\\]/.test(cmd) || cmd.includes(`'\\''`), 'quotes are escaped');
});
