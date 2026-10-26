const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  openSync,
  closeSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

(async () => {
  const editor = process.argv[2];
  if (!editor)
    throw new Error('Usage: node test/run-native.cjs /absolute/path/to/editor-cli (run npm run build first)');
  const extension = resolve(__dirname, '..');
  const { StackEngine } = require(join(extension, 'dist/src/engine/stack'));
  const root = mkdtempSync(join(tmpdir(), 'stackhub-native-')),
    repo = join(root, 'repo');
  for (const path of ['repo', 'extensions', 'hooks', 'userdata/User']) mkdirSync(join(root, path), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  for (const [key, value] of Object.entries({
    'user.name': 'StackHub verification',
    'user.email': 'check@example.invalid',
    'commit.gpgsign': 'false',
    'core.hooksPath': join(root, 'hooks'),
  }))
    git('config', key, value);
  writeFileSync(join(repo, 'config.txt'), 'feature=base\n');
  writeFileSync(join(repo, 'old name.txt'), Array.from({ length: 12 }, (_, i) => `Original line ${i}\n`).join(''));
  writeFileSync(join(repo, 'deleted.txt'), 'Remove this file on the child branch.\n');
  git('add', '.');
  git('commit', '-m', 'Initial');
  git('init', '--bare', join(root, 'remote.git'));
  git('remote', 'add', 'origin', join(root, 'remote.git'));
  git('push', '-u', 'origin', 'main');
  await (await StackEngine.open(repo)).initialize('main');
  writeFileSync(join(root, 'fixture.json'), JSON.stringify({ repo: realpathSync(repo) }));
  writeFileSync(
    join(root, 'userdata/User/settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'window.restoreWindows': 'none',
      'git.untrackedChanges': 'separate',
      'git.autofetch': false,
      'update.mode': 'none',
      'extensions.autoUpdate': false,
      'telemetry.telemetryLevel': 'off',
    }),
  );
  const output = join(root, 'result.json');
  console.log(`Native fixture and evidence: ${root}`);
  let launchError;
  const log = join(root, 'editor.log'),
    logFile = openSync(log, 'w');
  const child = spawn(
    editor,
    [
      ...(basename(editor).toLowerCase().includes('cursor') ? ['--classic'] : []),
      '--new-window',
      '--user-data-dir',
      join(root, 'userdata'),
      '--extensions-dir',
      join(root, 'extensions'),
      `--extensionDevelopmentPath=${extension}`,
      `--extensionTestsPath=${join(__dirname, 'native.cjs')}`,
      '--skip-welcome',
      '--skip-release-notes',
      repo,
    ],
    { stdio: ['ignore', logFile, logFile] },
  );
  closeSync(logFile);
  child.on('error', (error) => {
    launchError = error;
  });
  child.on('exit', (code) => {
    if (code) launchError = new Error(`Editor exited with ${code}. See ${log}`);
  });
  child.unref();
  let reported = 0;
  for (const deadline = Date.now() + 180000; Date.now() < deadline;) {
    if (launchError) throw launchError;
    if (existsSync(output)) {
      const result = JSON.parse(readFileSync(output, 'utf8'));
      for (const check of result.checks.slice(reported)) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}`);
      reported = result.checks.length;
      if (result.finished) {
        if (!result.passed) throw new Error(`Native verification failed. See ${output}`);
        console.log(`${reported} checks passed. ${output}`);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Native verification timed out. Inspect the test window and ${output}`);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
