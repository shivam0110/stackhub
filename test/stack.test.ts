import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Git } from '../src/engine/git';
import { StackEngine } from '../src/engine/stack';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'stackhub-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = new Git(dir);
  await git.run('init', '-b', 'main');
  await git.run('config', 'user.name', 'Stack Test');
  await git.run('config', 'user.email', 'test@example.com');
  await git.run('config', 'commit.gpgsign', 'false');
  await git.run('config', 'core.hooksPath', '/dev/null');
  await writeFile(join(dir, 'shared'), 'base\n');
  await git.run('add', '.');
  await git.run('commit', '-m', 'base');
  const engine = await StackEngine.open(dir);
  await engine.initialize('main');
  const commit = async (file: string, content: string, message = file) => {
    await writeFile(join(dir, file), content);
    await git.run('add', file);
    await engine.commit(message);
  };
  return { dir, git, engine, commit };
}

test('milestone: three branches, amend, conflict, resume and atomic leased push', async (t) => {
  const { dir, git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('shared', 'one\n');
  await e.create('two', 'one');
  await commit('shared', 'two\n');
  await e.create('three', 'two');
  await commit('third', 'three\n');
  const remote = await mkdtemp(join(tmpdir(), 'stackhub-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await new Git(remote).run('init', '--bare');
  await git.run('remote', 'add', 'origin', remote);
  await e.push(['one', 'two', 'three'], 'origin');
  await e.checkout('one');
  await writeFile(join(dir, 'shared'), 'amended\n');
  await git.run('add', 'shared');
  await e.commit('amended one', true);
  await assert.rejects(e.execute(await e.plan('restack', 'one')), /Resolve conflicts/);
  assert.deepEqual(await e.conflicts(), ['shared']);
  assert.equal((await e.operation())?.index, 0);
  await writeFile(join(dir, 'shared'), 'resolved\n');
  await git.run('add', 'shared');
  // A new engine instance must resume from disk, as after an editor restart.
  await (await StackEngine.open(dir)).continue();
  assert.equal(await e.operation(), undefined);
  assert.equal(await git.current(), 'one');
  const state = await e.state();
  assert.equal(state.branches.two!.base, await git.head('one'));
  assert.equal(state.branches.three!.base, await git.head('two'));
  assert.equal(await git.run('show', 'three:shared'), 'resolved');
  assert.equal(await git.run('rev-list', '--count', 'one..two'), '1');
  assert.equal(await git.run('rev-list', '--count', 'two..three'), '1');
  await e.push(['one', 'two', 'three'], 'origin');
  for (const branch of ['one', 'two', 'three'])
    assert.equal(await new Git(remote).head(branch), await git.head(branch));
});

test('abort restores already rebased descendants, metadata and checkout', async (t) => {
  const { dir, git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('a', 'one');
  await e.create('two', 'one');
  await commit('b', 'two');
  await e.create('three', 'two');
  await commit('shared', 'three\n');
  const two = await git.head('two');
  const three = await git.head('three');
  const before = await e.state();
  await e.checkout('one');
  await writeFile(join(dir, 'shared'), 'amended\n');
  await git.run('add', 'shared');
  await e.commit('amended', true);
  await assert.rejects(e.execute(await e.plan('restack', 'one')), /Resolve conflicts/);
  assert.equal((await e.operation())?.index, 1);
  const rebased = await git.head('two');
  const external = await git.run('commit-tree', `${rebased}^{tree}`, '-p', rebased, '-m', 'Later work');
  await git.run('update-ref', 'refs/heads/two', external, rebased);
  await assert.rejects(e.abort(), /changed after/);
  assert.equal(await git.head('two'), external);
  await git.run('update-ref', 'refs/heads/two', rebased, external);
  await e.abort();
  assert.equal(await git.head('two'), two);
  assert.equal(await git.head('three'), three);
  assert.deepEqual(await e.state(), before);
  assert.equal(await git.current(), 'one');
});

test('change parent rejects cycles and replays only own commits', async (t) => {
  const { git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('a', 'one');
  await e.create('two', 'one');
  await commit('b', 'two');
  await assert.rejects(e.plan('parent', 'one', 'two'), /descendants/);
  await e.execute(await e.plan('parent', 'two', 'main'));
  assert.equal(await git.run('rev-list', '--count', 'main..two'), '1');
  assert.equal(await git.succeeds('cat-file', '-e', 'two:a'), false);
  assert.equal((await e.state()).branches.two!.parent, 'main');
});

test('sync advances main and reparents children of squash-merged branch', async (t) => {
  const { git, engine: e, commit, dir } = await fixture(t);
  await e.create('one', 'main');
  await commit('a', 'one');
  await e.create('two', 'one');
  await commit('b', 'two');
  await e.checkout('main');
  await git.run('merge', '--squash', 'one');
  await git.run('commit', '-m', 'squash merged one');
  const target = await git.head('main');
  await git.run('update-ref', 'refs/remotes/origin/main', target);
  await e.checkout('two');
  await e.execute(await e.syncPlan('origin', ['one']));
  assert.equal((await e.state()).branches.two!.parent, 'main');
  assert.equal((await e.state()).branches.two!.base, target);
  assert.equal(await git.run('rev-list', '--count', 'main..two'), '1');
  assert.equal(await readFile(join(dir, 'b'), 'utf8'), 'two');
});

test('preserves non-conflicting local work and rejects stale previews, other worktrees and unknown remote divergence', async (t) => {
  const { dir, git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('a', 'one');
  const plan = await e.plan('restack', 'main');
  await commit('b', 'two');
  await assert.rejects(e.execute(plan), /changed since preview/);
  await writeFile(join(dir, 'dirty'), 'dirty');
  await e.checkout('main');
  assert.equal(await readFile(join(dir, 'dirty'), 'utf8'), 'dirty');
  await e.checkout('one');
  await rm(join(dir, 'dirty'));
  const other = await mkdtemp(join(tmpdir(), 'stackhub-linked-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  await git.run('worktree', 'add', other, 'main');
  await assert.rejects(e.checkout('main'), /another worktree/);
  await git.run('worktree', 'remove', other);
  const remote = await mkdtemp(join(tmpdir(), 'stackhub-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  const rg = new Git(remote);
  await rg.run('init', '--bare');
  await git.run('remote', 'add', 'origin', remote);
  await e.push(['one'], 'origin');
  const old = await git.head('one');
  await e.commit('amended', true);
  const external = await git.run('commit-tree', `${old}^{tree}`, '-p', old, '-m', 'someone else');
  await git.run('push', 'origin', `${external}:refs/heads/one`);
  await assert.rejects(e.push(['one'], 'origin'), /diverged remotely/);
  assert.equal(await rg.head('one'), external);
});

test('amend backups, metadata preview guard, and externally rewritten boundaries', async (t) => {
  const { git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('a', 'a');
  const original = await git.head('one');
  await e.commit('renamed commit', true);
  assert.ok(
    (await git.run('for-each-ref', '--format=%(objectname)', 'refs/stackhub/recovery')).split('\n').includes(original),
  );
  const boundary = await git.head('one');
  await e.create('two', 'one');
  await commit('b', 'b');
  const plan = await e.plan('restack', 'main');
  await e.rename('two', 'renamed');
  await assert.rejects(e.execute(plan), /metadata changed/);
  // External rebase of a tracked branch invalidates its saved boundary.
  await git.run('rebase', '--onto', 'main', boundary, 'renamed');
  await assert.rejects(e.execute(await e.plan('restack', 'one')), /saved boundary/);
});

test('sidebar composer creates a stack from the index while preserving unstaged work', async (t) => {
  const { dir, git, engine: e } = await fixture(t);
  await writeFile(join(dir, 'shared'), 'staged version\n');
  await e.stage('shared', true);
  await writeFile(join(dir, 'shared'), 'unstaged version\n');
  await writeFile(join(dir, 'notes.txt'), 'keep this untracked\n');
  await e.createFromStaged('feature/first', 'First change');
  assert.equal(await git.run('show', 'HEAD:shared'), 'staged version');
  assert.equal(await readFile(join(dir, 'shared'), 'utf8'), 'unstaged version\n');
  assert.equal((await e.state()).branches['feature/first']!.parent, 'main');
  await e.stage('shared', true);
  await e.createFromStaged('feature/second', 'Second change');
  assert.equal((await e.state()).branches['feature/second']!.parent, 'feature/first');
  assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'keep this untracked\n');
  await assert.rejects(e.stage('../outside.txt', true), /file changed/);
});

test('sidebar state is child-first and represents partially staged and renamed files', async (t) => {
  const { readView } = await import('../src/ui/model');
  const { dir, git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('file.txt', 'first\n');
  await e.create('two', 'one');
  await commit('two.txt', 'second\n');
  await writeFile(join(dir, 'file.txt'), 'staged\n');
  await e.stage('file.txt', true);
  await writeFile(join(dir, 'file.txt'), 'unstaged\n');
  await git.run('mv', 'two.txt', 'renamed.txt');
  let view = await readView(e);
  assert.deepEqual(
    view.branches.map((b) => b.name),
    ['two', 'one', 'main'],
  );
  assert.deepEqual(
    view.files.find((f) => f.path === 'file.txt'),
    { path: 'file.txt', staged: true, unstaged: true, status: 'M' },
  );
  assert.equal(
    view.files.some((f) => f.path === 'renamed.txt'),
    true,
  );
  await e.stage('renamed.txt', false);
  assert.equal(await git.succeeds('diff', '--cached', '--quiet', '--', 'two.txt', 'renamed.txt'), true);
  view = await readView(e);
  assert.equal(view.current, 'two');
});

test('individual staging handles new folders and literal pathspec characters', async (t) => {
  const { dir, git, engine: e } = await fixture(t);
  await mkdir(join(dir, 'new folder', 'nested'), { recursive: true });
  const paths = ['new folder/nested/[file].txt', 'new folder/nested/f.txt', ':(glob)*.txt', '-flag.txt'];
  for (const path of paths) await writeFile(join(dir, path), `${path}\n`);
  for (const path of [paths[0]!, paths[2]!, paths[3]!]) {
    await e.stage(path, true);
    assert.equal(await git.raw('show', `:${path}`), `${path}\n`);
    assert.deepEqual((await git.raw('diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean), [path]);
    await e.stage(path, false);
    assert.equal(await git.succeeds('diff', '--cached', '--quiet'), true);
    assert.equal(await readFile(join(dir, path), 'utf8'), `${path}\n`);
  }
});

test('staging an edited rename preserves recreated source; unstaging restores both index paths', async (t) => {
  const { dir, git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('old [name].txt', 'first\nsecond\nthird\n');
  await git.run('mv', '--', 'old [name].txt', 'new [name].txt');
  await writeFile(join(dir, 'new [name].txt'), 'first\nsecond\nthird\nfourth\n');
  await writeFile(join(dir, 'old [name].txt'), 'separate unstaged work\n');
  await e.stage('new [name].txt', true);
  assert.equal(await git.raw('show', ':new [name].txt'), 'first\nsecond\nthird\nfourth\n');
  assert.equal(await git.succeeds('cat-file', '-e', ':old [name].txt'), false);
  await e.stage('new [name].txt', false);
  assert.equal(await git.succeeds('diff', '--cached', '--quiet'), true);
  assert.equal(await git.raw('show', ':old [name].txt'), 'first\nsecond\nthird\n');
  assert.equal(await readFile(join(dir, 'old [name].txt'), 'utf8'), 'separate unstaged work\n');
  assert.equal(await readFile(join(dir, 'new [name].txt'), 'utf8'), 'first\nsecond\nthird\nfourth\n');
});

test('branch changes retain rename source even when Git rename display is disabled', async (t) => {
  const { dir, git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('before name.txt', 'first\nsecond\nthird\n');
  const base = await git.head('one');
  await git.run('mv', '--', 'before name.txt', 'after name.txt');
  await writeFile(join(dir, 'after name.txt'), 'first\nsecond\nthird\nfourth\n');
  await git.run('add', '--', 'after name.txt');
  await e.commit('rename and edit');
  await git.run('config', 'diff.renames', 'false');
  const head = await git.head('one');
  const [change] = await git.changes(base, head);
  assert.deepEqual(change, { path: 'after name.txt', originalPath: 'before name.txt', status: 'R' });
  assert.equal(await git.raw('show', `${base}:${change!.originalPath}`), 'first\nsecond\nthird\n');
  assert.equal(await git.raw('show', `${head}:${change!.path}`), 'first\nsecond\nthird\nfourth\n');
});

test('tracking infers rewritten parents, preserves equal-tip ambiguity, and imports remote ancestry', async (t) => {
  const { git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('one', 'one');
  const original = await git.head('one');
  await git.run('switch', '-c', 'untracked');
  await git.run('commit', '--allow-empty', '-m', 'child');
  await e.checkout('one');
  await e.commit('amended one', true);
  const inferred = (await e.trackingOptions('untracked')).find((option) => option.automatic);
  assert.equal(inferred?.name, 'one');
  assert.equal(inferred?.base, original);
  await e.trackStack(
    [{ branch: 'untracked', parent: 'one', base: inferred!.base!, head: await git.head('untracked') }],
    'origin',
  );
  await e.execute(await e.plan('restack', 'one'));
  assert.equal(await git.run('rev-list', '--count', 'one..untracked'), '1');
  await git.run('branch', 'same-a', 'main');
  await git.run('branch', 'same-b', 'main');
  await git.run('switch', '-c', 'equal-child', 'main');
  await git.run('commit', '--allow-empty', '-m', 'ambiguous');
  assert.equal(
    (await e.trackingOptions('equal-child')).some((option) => option.automatic),
    false,
  );
  await e.checkout('main');
  await git.run('branch', '-D', 'same-a', 'same-b', 'equal-child');
  const parent = await git.head('untracked');
  const child = await git.run('commit-tree', `${parent}^{tree}`, '-p', parent, '-m', 'remote child');
  await git.run('update-ref', 'refs/remotes/origin/remote-parent', parent);
  await git.run('update-ref', 'refs/remotes/origin/remote-child', child);
  await e.trackStack(
    [
      { branch: 'remote-parent', parent: 'one', base: await git.head('one'), head: parent },
      { branch: 'remote-child', parent: 'remote-parent', base: parent, head: child },
    ],
    'origin',
  );
  assert.equal(await git.head('remote-child'), child);
  assert.equal((await e.state()).branches['remote-child']!.published, child);
});

test('tracking batches equivalent refs instead of spawning a process per comparison', async (t) => {
  const { git, engine: e } = await fixture(t);
  const base = await git.head('main');
  await git.input(
    Array.from({ length: 40 }, (_, i) => `create refs/heads/alias-${i} ${base}`).join('\n') + '\n',
    'update-ref',
    '--stdin',
  );
  await git.run('switch', '-c', 'untracked');
  await git.run('commit', '--allow-empty', '-m', 'child');
  const raw = e.git.raw.bind(e.git);
  let calls = 0;
  e.git.raw = async (...args) => {
    calls++;
    return raw(...args);
  };
  const options = await e.trackingOptions('untracked');
  assert.equal(options.filter((option) => option.suggested).length, 41);
  assert.equal(
    options.some((option) => option.automatic),
    false,
  );
  assert.ok(calls < 15, `Expected batched Git queries, received ${calls}`);
});

test('delete reparents a middle branch and can remove externally deleted metadata', async (t) => {
  const { git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('one', 'one');
  await e.create('two', 'one');
  await commit('two', 'two');
  await e.create('three', 'two');
  await commit('three', 'three');
  await e.execute(await e.plan('delete', 'two'));
  assert.equal((await e.state()).branches.three!.parent, 'one');
  assert.equal(await git.succeeds('cat-file', '-e', 'three:two'), false);
  await e.checkout('main');
  await git.run('branch', '-D', 'one');
  await e.create('other', 'main');
  await commit('other', 'other');
  await e.commit('amended other', true);
  await assert.rejects(e.plan('parent', 'other', 'one'), /no longer exists/);
  assert.equal(await e.operation(), undefined);
  await e.execute(await e.plan('delete', 'one'));
  assert.equal((await e.state()).branches.one, undefined);
  assert.equal((await e.state()).branches.three!.parent, 'main');
  assert.equal(await git.run('show', 'three:three'), 'three');
  assert.equal(await git.run('rev-list', '--count', 'main..three'), '1');
  await git.run('branch', '-D', 'three');
  const cleanup = await e.plan('delete', 'three');
  assert.equal(cleanup.steps.length, 1);
  await e.execute(cleanup);
  assert.equal((await e.state()).branches.three, undefined);
});

test('push rejects externally rewritten branches without dropping parent work', async (t) => {
  const { git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('one', 'one');
  const parent = await git.head('one');
  await e.create('two', 'one');
  await commit('two', 'two');
  await git.run('rebase', '--onto', 'main', 'one', 'two');
  await assert.rejects(e.push(['two'], 'origin'), /saved boundary/);
  assert.equal(await git.head('one'), parent);
});

test('sync preserves stale children while removing an amended squash-merged parent', async (t) => {
  const { dir, git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('one', 'old parent');
  await e.create('two', 'one');
  await commit('two', 'child');
  await e.checkout('one');
  await writeFile(join(dir, 'one'), 'merged parent');
  await e.stage('one', true);
  await e.commit('', true);
  await e.checkout('main');
  await git.run('merge', '--squash', 'one');
  await git.run('commit', '-m', 'merged');
  await git.run('update-ref', 'refs/remotes/origin/main', await git.head('main'));
  await e.checkout('two');
  await e.execute(await e.syncPlan('origin', ['one']));
  assert.equal(await git.run('show', 'two:one'), 'merged parent');
  assert.equal(await git.run('show', 'two:two'), 'child');
  assert.equal(await git.run('rev-list', '--count', 'main..two'), '1');
});

test('a killed editor releases its lock and resumes a rebase completed before journal persistence', async (t) => {
  const { dir, git, engine: e, commit } = await fixture(t);
  await e.create('one', 'main');
  await commit('one', 'one');
  await e.create('two', 'one');
  await commit('two', 'two');
  await e.checkout('one');
  await e.commit('amended', true);
  const script = `
    const { StackEngine } = require(${JSON.stringify(require.resolve('../src/engine/stack'))});
    (async () => {
      const engine = await StackEngine.open(process.argv[1]);
      const run = engine.git.run.bind(engine.git);
      engine.git.run = async (...args) => {
        const result = await run(...args);
        if (args.includes('rebase')) process.kill(process.pid, 'SIGKILL');
        return result;
      };
      await engine.execute(await engine.plan('restack', 'one'));
    })().catch(error => { console.error(error); process.exit(1); });`;
  await assert.rejects(
    promisify(execFile)(process.execPath, ['-e', script, dir]),
    (error) => (error as { signal?: string }).signal === 'SIGKILL',
  );
  assert.ok((await e.operation())?.running);
  await (await StackEngine.open(dir)).continue();
  assert.equal(await e.operation(), undefined);
  assert.equal((await e.state()).branches.two!.base, await git.head('one'));
  assert.equal(await git.run('rev-list', '--count', 'one..two'), '1');
  assert.equal(await git.current(), 'one');
  assert.equal(await git.succeeds('show-ref', '--verify', 'refs/stackhub/lock'), false);
  await e.exclusive(async () => {
    await assert.rejects(e.checkout('main'), /Another StackHub command/);
  });
});
