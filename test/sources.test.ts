import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverSources } from '../src/auth/sources.ts';
import type { AgentDef } from '../src/config.ts';

const agent: AgentDef = {
  name: 'fake',
  startCommand: 'fake',
  apiKeyEnv: 'TELEPORT_TEST_KEY',
  // No keychain (skipped off-darwin) and a cred file that won't exist.
  localCredFile: '.teleport-nonexistent/creds.json',
  sandboxCredFile: '.fake/creds.json',
};

test('discovers an env var source when set', async () => {
  process.env.TELEPORT_TEST_KEY = 'secret-value';
  try {
    const sources = await discoverSources(agent);
    const env = sources.find((s) => s.kind === 'env');
    assert.ok(env, 'expected an env source');
    assert.deepEqual(env!.payload.env, { name: 'TELEPORT_TEST_KEY', value: 'secret-value' });
  } finally {
    delete process.env.TELEPORT_TEST_KEY;
  }
});

test('no sources when nothing is available', async () => {
  delete process.env.TELEPORT_TEST_KEY;
  const sources = await discoverSources(agent);
  assert.equal(sources.length, 0);
});
