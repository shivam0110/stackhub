const vscode = require('vscode');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, realpathSync, renameSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { execFileSync } = require('node:child_process');
const { StackEngine } = require('../dist/src/engine/stack');
const { readFiles } = require('../dist/src/ui/model');
const manifest = require('../package.json');

exports.run = async () => {
  const repo = vscode.workspace.workspaceFolders[0].uri.fsPath,
    root = dirname(repo),
    output = join(root, 'result.json');
  assert.equal(
    realpathSync(repo),
    JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8')).repo,
    'Run only in the launcher-created fixture',
  );
  const result = {
    host: vscode.env.appName,
    version: vscode.version,
    trusted: vscode.workspace.isTrusted,
    repo,
    checks: [],
    started: new Date().toISOString(),
  };
  const save = () => {
    writeFileSync(output + '.tmp', JSON.stringify(result, null, 2));
    renameSync(output + '.tmp', output);
  };
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    }).trimEnd();
  const write = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const head = (branch) => git('rev-parse', branch),
    current = () => git('branch', '--show-current');
  const state = () => JSON.parse(readFileSync(join(repo, '.git/stackhub/state.json'), 'utf8'));
  const pending = () => existsSync(join(repo, '.git/stackhub/operation.json'));
  const samePath = (a, b) => {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return false;
    }
  };
  async function waitFor(condition, timeout = 10000) {
    for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Native editor condition timed out');
  }
  async function command(name, item, expected = true) {
    assert.equal(await vscode.commands.executeCommand(`stackhub.${name}`, item), expected, name);
  }
  const stage = (path, staged = true) => command('stage', { payload: { path, staged } });
  const compose = (mode, name, message) => command('compose', { payload: { mode, name, message } });
  async function check(name, action) {
    try {
      await action();
      result.checks.push({ name, passed: true });
    } catch (error) {
      result.checks.push({ name, passed: false, error: error.stack });
      throw error;
    } finally {
      save();
    }
  }
  async function diff(path, before, after, originalPath = path) {
    await command('diff', { branch: 'native/c', payload: { path } });
    await waitFor(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff && input.modified.path.endsWith('/' + path);
    });
    const input = vscode.window.tabGroups.activeTabGroup.activeTab.input;
    assert.equal(input.original.scheme, 'git');
    assert.equal(input.modified.scheme, 'git');
    assert.ok(input.original.path.endsWith('/' + originalPath));
    assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), before);
    assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), after);
  }
  let native, engine;
  save();
  try {
    await check('Actual extension and built-in Git activate', async () => {
      if (!vscode.workspace.isTrusted) {
        await vscode.commands.executeCommand('workbench.trust.manage');
        await waitFor(() => vscode.workspace.isTrusted, 60000);
      }
      assert.ok(vscode.workspace.isTrusted, 'Trust the disposable test workspace to run the extension');
      const gitApi = (await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
      await waitFor(() => gitApi.repositories.some((item) => samePath(item.rootUri.fsPath, repo)));
      native = gitApi.repositories.find((item) => samePath(item.rootUri.fsPath, repo));
      await vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`).activate();
      engine = await StackEngine.open(repo);
      await vscode.commands.executeCommand('stackhub.branches.focus');
    });
    await check('Individual nested-file staging and unstaging match sidebar listing', async () => {
      const path = 'new folder/nested/file[1].txt';
      write(path, 'Nested untracked file\n');
      await command('refresh');
      assert.deepEqual(
        (await readFiles(engine)).map((file) => file.path),
        [path],
      );
      await stage(path);
      assert.equal(git('diff', '--cached', '--name-only'), path);
      assert.equal((await readFiles(engine))[0].staged, true);
      await stage(path, false);
      assert.equal(git('diff', '--cached', '--name-only'), '');
      assert.deepEqual((await readFiles(engine))[0], { path, staged: false, unstaged: true, status: 'U' });
      rmSync(join(repo, 'new folder'), { recursive: true });
    });
    await check('Rapid staging clicks preserve index order and other unstaged files', async () => {
      write('rapid-a.txt', 'Leave this unstaged\n');
      write('rapid-b.txt', 'Stage this file\n');
      await command('refresh');
      await Promise.all([stage('rapid-a.txt'), stage('rapid-b.txt')]);
      await stage('rapid-a.txt', false);
      assert.equal(git('diff', '--cached', '--name-only'), 'rapid-b.txt');
      assert.equal(readFileSync(join(repo, 'rapid-a.txt'), 'utf8'), 'Leave this unstaged\n');
      await stage('rapid-b.txt', false);
      rmSync(join(repo, 'rapid-a.txt'));
      rmSync(join(repo, 'rapid-b.txt'));
    });
    await check('Partial staging preserves both versions in native diff', async () => {
      write('config.txt', 'feature=staged\n');
      await stage('config.txt');
      write('config.txt', 'feature=staged\nremaining=unstaged\n');
      await command('refresh');
      assert.deepEqual((await readFiles(engine))[0], { path: 'config.txt', staged: true, unstaged: true, status: 'M' });
      await command('openFile', { payload: { path: 'config.txt' } });
      await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputTextDiff && input.modified.scheme === 'file';
      });
      const input = vscode.window.tabGroups.activeTabGroup.activeTab.input;
      assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), 'feature=staged\n');
      assert.equal(
        (await vscode.workspace.openTextDocument(input.modified)).getText(),
        'feature=staged\nremaining=unstaged\n',
      );
      await stage('config.txt', false);
      git('restore', '--', 'config.txt');
    });
    await check('Create three stacked branches using staged changes', async () => {
      write('a.txt', 'First branch\n');
      await stage('a.txt');
      await compose('create', 'native/a', 'First branch');
      write('config.txt', 'feature=child\n');
      await stage('config.txt');
      await compose('create', 'native/b', 'Child config');
      git('mv', 'old name.txt', 'renamed file.txt');
      write('renamed file.txt', readFileSync(join(repo, 'renamed file.txt'), 'utf8') + 'Child edit\n');
      git('rm', 'deleted.txt');
      write('added.txt', 'Added on child\n');
      await command('stageAll');
      await compose('create', 'native/c', 'Rename, add and delete');
      assert.equal(state().branches['native/a'].parent, 'main');
      assert.equal(state().branches['native/b'].parent, 'native/a');
      assert.equal(state().branches['native/c'].parent, 'native/b');
    });
    await check('Native rename diff opens original and destination contents', async () => {
      const base = state().branches['native/c'].base;
      await diff(
        'renamed file.txt',
        git('show', `${base}:old name.txt`) + '\n',
        git('show', 'native/c:renamed file.txt') + '\n',
        'old name.txt',
      );
    });
    await check('Native added and deleted diffs have correct empty sides', async () => {
      await diff('added.txt', '', 'Added on child\n');
      await diff('deleted.txt', 'Remove this file on the child branch.\n', '');
    });
    await check('Commit inspection opens native text document', async () => {
      await command('inspect', { branch: 'native/c' });
      await waitFor(() => vscode.window.activeTextEditor?.document.languageId === 'plaintext');
      assert.match(vscode.window.activeTextEditor.document.getText(), /Rename, add and delete/);
    });
    await check('Navigation and parent amend restack descendants', async () => {
      await command('down');
      assert.equal(current(), 'native/b');
      await command('up');
      assert.equal(current(), 'native/c');
      await command('checkout', { branch: 'native/a' });
      const oldB = head('native/b'),
        oldC = head('native/c');
      write('parent.txt', 'Parent followup\n');
      await stage('parent.txt');
      await compose('amend', undefined, '');
      assert.notEqual(head('native/b'), oldB);
      assert.notEqual(head('native/c'), oldC);
      assert.equal(state().branches['native/b'].base, head('native/a'));
      assert.equal(state().branches['native/c'].base, head('native/b'));
      assert.equal(current(), 'native/a');
      assert.equal(git('status', '--porcelain'), '');
    });
    await check('Push all branches to disposable bare remote', async () => {
      await command('pushStack', { branch: 'native/c' });
      for (const branch of ['native/a', 'native/b', 'native/c'])
        assert.equal(git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0], head(branch));
    });
    await check('Conflict opens native editor, stages resolution and continues stack', async () => {
      write('config.txt', 'feature=parent\n');
      await stage('config.txt');
      await command('compose', { payload: { mode: 'amend', message: '' } }, false);
      assert.ok(pending());
      assert.match(git('diff', '--name-only', '--diff-filter=U'), /config.txt/);
      await command('conflicts');
      await waitFor(() => samePath(vscode.window.activeTextEditor?.document.uri.fsPath, join(repo, 'config.txt')));
      write('config.txt', 'feature=resolved\n');
      await stage('config.txt');
      await command('continue');
      assert.equal(pending(), false);
      assert.equal(current(), 'native/a');
      assert.equal(git('status', '--porcelain'), '');
      assert.equal(state().branches['native/c'].base, head('native/b'));
      assert.equal(native.state.mergeChanges.length, 0);
      assert.equal(native.state.HEAD.commit, head('HEAD'));
    });
    await check('Rewritten stack pushes with recorded leases', async () => {
      await command('pushStack', { branch: 'native/c' });
      for (const branch of ['native/a', 'native/b', 'native/c'])
        assert.equal(git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0], head(branch));
    });
    result.passed = true;
  } catch (error) {
    result.passed = false;
    throw error;
  } finally {
    result.finished = new Date().toISOString();
    save();
  }
};
