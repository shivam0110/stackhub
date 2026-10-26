import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Git } from '../src/engine/git';

const git = new Git(tmpdir());

test('fast Git commands complete without writing empty input to a closed pipe', async () => {
  await Promise.all(
    Array.from({ length: 50 }, async () => {
      assert.match(await git.run('--version'), /^git version /);
    }),
  );
});

test('stdin delivers empty and large Unicode content intact', async () => {
  for (const input of ['', 'StackHub → Git\n'.repeat(100000)]) {
    const expected = createHash('sha1')
      .update(`blob ${Buffer.byteLength(input)}\0`)
      .update(input)
      .digest('hex');
    assert.equal((await git.input(input, 'hash-object', '--stdin')).trim(), expected);
  }
});

test('a command rejecting large stdin reports its Git diagnostic instead of EPIPE', async () => {
  await assert.rejects(git.input('x'.repeat(1024 * 1024), 'stackhub-invalid-command'), /not a git command/);
});
