import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubBranchUrl } from '../src/open.ts';

test('githubBranchUrl builds a tree URL for repo + branch', () => {
  assert.equal(
    githubBranchUrl('me/teleport', 'teleport/main/abc123'),
    'https://github.com/me/teleport/tree/teleport/main/abc123',
  );
});

test('githubBranchUrl returns null when repo or branch is missing', () => {
  assert.equal(githubBranchUrl(undefined, 'b'), null);
  assert.equal(githubBranchUrl('me/x', undefined), null);
  assert.equal(githubBranchUrl(undefined, undefined), null);
});
