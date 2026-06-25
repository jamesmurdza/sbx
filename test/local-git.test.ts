import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseRemoteUrl, slugFromUrl } from '../src/local-git.ts';

test('normaliseRemoteUrl converts ssh forms to https', () => {
  assert.equal(
    normaliseRemoteUrl('git@github.com:owner/repo.git'),
    'https://github.com/owner/repo.git',
  );
  assert.equal(
    normaliseRemoteUrl('ssh://git@github.com/owner/repo.git'),
    'https://github.com/owner/repo.git',
  );
});

test('normaliseRemoteUrl strips embedded credentials', () => {
  assert.equal(
    normaliseRemoteUrl('https://user:token@github.com/owner/repo.git'),
    'https://github.com/owner/repo.git',
  );
});

test('slugFromUrl extracts owner/repo', () => {
  assert.equal(slugFromUrl('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(slugFromUrl('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(slugFromUrl('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(slugFromUrl(null), null);
});
