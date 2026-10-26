import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../src/engine/git';
import { parseOperation, parseState } from '../src/engine/metadata';
import { StackEngine } from '../src/engine/stack';
import { Operation, State } from '../src/engine/types';

const a = 'a'.repeat(40),
  b = 'b'.repeat(40),
  c = 'c'.repeat(40);
const state = (): State => ({
  version: 1,
  trunk: 'main',
  branches: { one: { parent: 'main', base: a }, two: { parent: 'one', base: b } },
});
const operation = (): Operation => ({
  id: '1234567890-abcdef12',
  cwd: tmpdir(),
  original: 'one',
  before: state(),
  after: state(),
  heads: { main: a, one: b, two: c },
  expected: { main: a, one: b, two: c },
  steps: [{ kind: 'rebase', branch: 'two', parent: 'one', base: b }],
  index: 0,
});

test('metadata rejects malformed state, invalid names, missing parents and cycles', () => {
  assert.deepEqual(parseState(state()), state());
  const sha256 = state();
  sha256.branches.one!.base = 'a'.repeat(64);
  assert.deepEqual(parseState(sha256), sha256);
  const invalid: unknown[] = [null, [], { ...state(), version: 2 }, { ...state(), branches: [] }];
  for (const change of [
    (s: State) => {
      s.branches.one!.base = 'HEAD';
    },
    (s: State) => {
      s.branches.one!.parent = 'missing';
    },
    (s: State) => {
      s.branches.one!.parent = 'two';
    },
    (s: State) => {
      s.branches.one!.parent = 'one';
    },
    (s: State) => {
      s.trunk = '-main';
    },
    (s: State) => {
      s.trunk = 'toString';
    },
    (s: State) => {
      s.branches['bad\nbranch'] = { parent: 'main', base: a };
    },
    (s: State) => {
      s.branches.main = { parent: 'main', base: a };
    },
  ]) {
    const value = state();
    change(value);
    invalid.push(value);
  }
  invalid.push(JSON.parse(`{"version":1,"trunk":"main","branches":{"__proto__":{"parent":"main","base":"${a}"}}}`));
  for (const value of invalid) assert.throws(() => parseState(value));
});

test('journals accept paused rebases, completed steps and missing branches being deleted', () => {
  const pending = operation();
  pending.running = { old: c, onto: b };
  assert.deepEqual(parseOperation(pending), pending);
  const completed = operation();
  completed.index = 1;
  completed.expected.two = a;
  completed.after.branches.two!.base = c;
  assert.deepEqual(parseOperation(completed), completed);
  const deleted = operation();
  delete deleted.heads.two;
  delete deleted.expected.two;
  delete deleted.after.branches.two;
  deleted.steps = [{ kind: 'delete', branch: 'two' }];
  deleted.running = { old: '', onto: '' };
  assert.deepEqual(parseOperation(deleted), deleted);
});

test('journals reject inconsistent progress before any refs can be restored', () => {
  for (const change of [
    (o: Operation) => {
      o.index = -1;
    },
    (o: Operation) => {
      o.index = 2;
    },
    (o: Operation) => {
      o.index = 0.5;
    },
    (o: Operation) => {
      o.id = '../outside';
    },
    (o: Operation) => {
      o.heads.unrelated = a;
    },
    (o: Operation) => {
      o.expected.one = c;
    },
    (o: Operation) => {
      o.after.branches.two!.parent = 'main';
    },
    (o: Operation) => {
      o.steps.push(o.steps[0]!);
    },
    (o: Operation) => {
      o.steps = [{ kind: 'ref', branch: 'two', target: a }];
    },
    (o: Operation) => {
      o.running = { old: a, onto: b };
    },
    (o: Operation) => {
      o.running = { old: c, onto: 'HEAD' };
    },
    (o: Operation) => {
      o.index = 1;
      o.running = { old: c, onto: b };
    },
    (o: Operation) => {
      delete o.after.branches.two;
      o.steps = [];
    },
    (o: Operation) => {
      o.steps = [];
      o.after.branches.two!.parent = 'main';
    },
    (o: Operation) => {
      o.steps.push({ kind: 'rebase', branch: 'one', parent: 'main', base: a });
    },
  ]) {
    const value = operation();
    change(value);
    assert.throws(() => parseOperation(value));
  }
});

test('invalid files identify their path and remain untouched when read or resumed', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'stackhub-metadata-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = new Git(cwd);
  await git.run('init', '-b', 'main');
  await git.run(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--allow-empty',
    '-m',
    'base',
  );
  const engine = await StackEngine.open(cwd);
  await engine.initialize('main');
  const head = await git.head('main'),
    statePath = join(engine.directory, 'state.json');
  await writeFile(statePath, '{broken');
  await assert.rejects(engine.initialized(), /state\.json/);
  assert.equal(await readFile(statePath, 'utf8'), '{broken');
  const operationPath = join(engine.directory, 'operation.json'),
    content = JSON.stringify({ ...operation(), index: 99 });
  await writeFile(operationPath, content);
  await assert.rejects(engine.continue(), /operation\.json.*Invalid step index/);
  await assert.rejects(engine.abort(), /operation\.json.*Invalid step index/);
  assert.equal(await readFile(operationPath, 'utf8'), content);
  assert.equal(await git.head('main'), head);
});
