import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../src/engine/git';
import { StackEngine } from '../src/engine/stack';
import { GitHub, PullRequest } from '../src/engine/github';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'stackhub-github-')),
    bin = join(dir, 'bin'),
    bare = join(dir, 'remote.git');
  const path = process.env.PATH;
  t.after(async () => {
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(bin);
  await mkdir(bare);
  const git = new Git(dir),
    remote = new Git(bare);
  await remote.run('init', '--bare');
  await git.run('init', '-b', 'main');
  await git.run('config', 'user.name', 'Stack Test');
  await git.run('config', 'user.email', 'test@example.com');
  await git.run('config', 'commit.gpgsign', 'false');
  await git.run('config', 'core.hooksPath', '/dev/null');
  await writeFile(join(dir, '.gitignore'), '/bin/\n/remote.git/\n/ssh.cjs\n/prs.json\n/calls.jsonl\n');
  await git.run('add', '.gitignore');
  await git.run('commit', '-m', 'base');
  // Git pushes/fetches are real; only SSH routing and GitHub responses are local.
  const ssh = join(dir, 'ssh.cjs');
  await writeFile(
    ssh,
    `const {spawnSync}=require('node:child_process'); const command=process.argv.find(a=>/^git-(upload|receive)-pack /.test(a)); if(!command) process.exit(1); process.exit(spawnSync(command.split(' ')[0],[${JSON.stringify(bare)}],{stdio:'inherit'}).status ?? 1);`,
  );
  await git.run('config', 'core.sshCommand', `${JSON.stringify(process.execPath)} ${JSON.stringify(ssh)}`);
  await git.run('remote', 'add', 'origin', 'git@github.com:stackhub/fixture.git');
  await git.run('push', 'origin', 'main');
  const data = join(dir, 'prs.json'),
    calls = join(dir, 'calls.jsonl');
  await writeFile(data, JSON.stringify({ prs: [] }));
  await writeFile(calls, '');
  await writeFile(
    join(bin, 'gh'),
    `#!${process.execPath}
const fs=require('node:fs'), {execFileSync}=require('node:child_process');
const args=process.argv.slice(2), data=${JSON.stringify(data)}, state=JSON.parse(fs.readFileSync(data,'utf8'));
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
const arg=flag=>args[args.indexOf(flag)+1], fail=message=>{console.error(message);process.exit(1)};
if(arg('--repo')!=='github.com/stackhub/fixture') fail('Wrong repository');
if(args[1]==='list') {
  if(state.failList) fail('GitHub authentication failed');
  let prs=state.prs;
  if(args.includes('--head')) prs=prs.filter(pr=>pr.headRefName===arg('--head'));
  console.log(JSON.stringify(prs.slice(0,Number(arg('--limit')))));process.exit();
}
if(args[1]==='create') {
  const branch=arg('--head'); if(state.failCreate===branch) fail('Simulated GitHub interruption');
  const oid=execFileSync('git',['-C',${JSON.stringify(bare)},'rev-parse','refs/heads/'+branch],{encoding:'utf8'}).trim();
  state.prs.unshift({number:state.prs.length+1,url:'https://github.com/stackhub/fixture/pull/'+(state.prs.length+1),state:'OPEN',isDraft:args.includes('--draft'),headRefOid:oid,headRefName:branch,baseRefName:arg('--base'),isCrossRepository:false,reviewDecision:'',statusCheckRollup:[],mergeCommit:null,title:arg('--title'),body:arg('--body')});
} else {
  const pr=state.prs.find(pr=>pr.number===Number(args[2]));if(!pr) fail('Missing PR');
  if(args[1]==='edit') pr.baseRefName=arg('--base');
  else if(args[1]==='ready') pr.isDraft=args.includes('--undo');
  else fail('Unknown command');
}
fs.writeFileSync(data,JSON.stringify(state));
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${path}`;
  const engine = await StackEngine.open(dir);
  await engine.initialize('main');
  const create = async (branch: string, parent = 'main') => {
    await engine.create(branch, parent);
    await writeFile(join(dir, branch), branch);
    await git.run('add', branch);
    await engine.commit(branch);
  };
  const read = async () =>
    JSON.parse(await readFile(data, 'utf8')) as {
      prs: (PullRequest & { title?: string; body?: string })[];
      failList?: boolean;
      failCreate?: string;
    };
  const save = (state: Awaited<ReturnType<typeof read>>) => writeFile(data, JSON.stringify(state));
  return {
    git,
    remote,
    engine,
    github: new GitHub(engine, 'origin'),
    create,
    read,
    save,
    calls: async () =>
      (await readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}

test('submit uses parent bases, safely retries partial PR creation and preserves existing content', async (t) => {
  const { git, remote, engine, github, create, read, save, calls } = await fixture(t);
  await create('one');
  await create('two', 'one');
  await create('three', 'two');
  await save({ prs: [], failCreate: 'two' });
  await assert.rejects(github.submit(['one', 'two', 'three'], true), /interruption/);
  let data = await read();
  assert.equal(data.prs.length, 1);
  data.prs[0]!.title = 'Keep my title';
  data.prs[0]!.body = 'Keep my description';
  data.prs[0]!.isDraft = false;
  delete data.failCreate;
  await save(data);
  await github.submit(['one', 'two', 'three'], true);
  data = await read();
  assert.equal(data.prs.length, 3);
  for (const [branch, parent] of [
    ['one', 'main'],
    ['two', 'one'],
    ['three', 'two'],
  ]) {
    const pr = data.prs.find((pr) => pr.headRefName === branch)!;
    assert.equal(pr.baseRefName, parent);
    assert.equal(await remote.head(branch!), await git.head(branch!));
    assert.equal(pr.isDraft, branch !== 'one');
  }
  assert.equal(data.prs.find((pr) => pr.headRefName === 'one')!.title, 'Keep my title');
  assert.equal(data.prs.find((pr) => pr.headRefName === 'one')!.body, 'Keep my description');
  const pr = data.prs.find((pr) => pr.headRefName === 'two')!;
  await github.ready(pr.number, true);
  assert.equal((await github.get('two'))!.isDraft, false);
  await github.ready(pr.number, false);
  assert.equal((await github.get('two'))!.isDraft, true);
  await engine.checkout('one');
  await engine.commit('amended one', true);
  await engine.execute(await engine.plan('restack', 'one'));
  await github.submit(['one', 'two', 'three'], false);
  assert.equal((await read()).prs.length, 3);
  for (const branch of ['one', 'two', 'three']) assert.equal(await remote.head(branch), await git.head(branch));
  assert.equal(
    (await calls()).filter((args) => args[1] === 'create' && args[args.indexOf('--head') + 1] === 'one').length,
    1,
  );
});

test('tracked PR status remains available beyond the newest 100 repository PRs and excludes forks', async (t) => {
  const { git, github, create, read, save } = await fixture(t);
  await create('one');
  await github.submit(['one'], true);
  const old = (await read()).prs[0]!;
  const newer = Array.from({ length: 100 }, (_, i) => ({
    ...old,
    number: i + 2,
    headRefName: `unrelated-${i}`,
    state: 'CLOSED',
  }));
  await save({ prs: [...newer, { ...old, number: 102, isCrossRepository: true }, old] });
  const status = await github.statuses();
  assert.equal(status.one?.number, old.number);
  assert.equal(status.one?.headRefOid, await git.head('one'));
  assert.deepEqual(Object.keys(status), ['one']);
});

test('merged cleanup requires unchanged branch head and merge included in fetched trunk', async (t) => {
  const { git, github, create, read, save } = await fixture(t);
  await create('one');
  await github.submit(['one'], true);
  const data = await read(),
    head = await git.head('one'),
    trunk = await git.head('main');
  const merge = await git.run('commit-tree', `${head}^{tree}`, '-p', trunk, '-m', 'Squash merge');
  Object.assign(data.prs[0]!, { state: 'MERGED', mergeCommit: { oid: merge } });
  await save(data);
  assert.deepEqual(await github.merged(), []);
  await git.run('update-ref', 'refs/remotes/origin/main', merge);
  assert.deepEqual(await github.merged(), ['one']);
  await git.run('commit', '--allow-empty', '-m', 'Later work');
  assert.deepEqual(await github.merged(), []);
});

test('GitHub preflight failure does not push a stack', async (t) => {
  const { github, remote, create, save, calls } = await fixture(t);
  await create('one');
  await save({ prs: [], failList: true });
  await assert.rejects(github.submit(['one'], true), /authentication failed/);
  assert.equal(await remote.succeeds('show-ref', '--verify', 'refs/heads/one'), false);
  assert.equal(
    (await calls()).some((args) => args[1] === 'create'),
    false,
  );
});
