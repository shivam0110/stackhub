import * as vscode from 'vscode';
import { join } from 'node:path';
import type { Plan } from '../engine/types';
import type { StackController, BranchItem } from './controller';

/** Editor dialogs and command behavior; the controller serializes mutations and refreshes state. */
export function registerCommands(host: StackController, extensionId: string): void {
  const command = host.registerCommand.bind(host);
  const input = (prompt: string, value?: string) =>
    vscode.window.showInputBox({
      prompt,
      value,
      ignoreFocusOut: true,
      validateInput: (text) => (text.trim() ? undefined : 'A value is required.'),
    });
  async function pickBranch(item?: BranchItem, choose = false) {
    if (item?.branch) return item.branch;
    const state = await host.engine.state();
    const branch = await host.engine.git.current().catch(() => '');
    if (!choose && (branch === state.trunk || state.branches[branch])) return branch;
    return vscode.window.showQuickPick([state.trunk, ...Object.keys(state.branches)], {
      title: 'Choose branch',
      placeHolder: host.current,
    });
  }
  async function preview(plan: Plan, confirm = true) {
    if (!plan.steps.length) {
      void vscode.window.showInformationMessage('Your descendants are already up to date.');
      return;
    }
    const detail = plan.steps
      .map(
        (step) =>
          `${step.kind === 'delete' ? 'Remove' : 'Update'} ${step.branch}${step.kind === 'rebase' ? ` on ${step.parent}` : ''}`,
      )
      .join('\n');
    if (
      !confirm ||
      (await vscode.window.showWarningMessage(plan.title, { modal: true, detail }, 'Confirm')) === 'Confirm'
    )
      await host.engine.execute(plan);
  }
  async function modify(message: string, amend: boolean) {
    const engine = host.engine,
      branch = await engine.git.current();
    const meta = (await engine.state()).branches[branch];
    await engine.commit(message, amend && !!meta && (await engine.git.head(branch)) !== meta.base);
    host.view.clearComposer();
    if (!engine.children(await engine.state(), branch).length) return;
    if (await engine.git.run('status', '--porcelain')) {
      void vscode.window.showInformationMessage(
        'Committed. Commit or stash remaining edits, then restack descendants.',
      );
      return;
    }
    await engine.execute(await engine.plan('restack', branch));
  }
  command('selectRepository', () => host.selectRepository());
  command('settings', async (item) => {
    const { name, mode } = item?.payload ?? {};
    if (!name) return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`);
    if (!(
      (name === 'branchLabel' && ['branch', 'pr'].includes(mode ?? '')) ||
      (name === 'modifyBehavior' && ['amend', 'commit'].includes(mode ?? '')) ||
      (name === 'defaultDraft' && ['draft', 'publish'].includes(mode ?? ''))
    ))
      throw new Error('Unknown StackHub preference.');
    const settings = host.configuration(),
      scope = settings.inspect(name);
    const target =
      scope?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : scope?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await settings.update(name, name === 'defaultDraft' ? mode === 'draft' : mode, target);
  });
  command('refresh', async () => {
    host.invalidatePullRequests();
  });
  command('stageAll', async () => host.engine.stageAll(true));
  command('unstageAll', async () => host.engine.stageAll(false));
  command('stage', async (item) => {
    const payload = item?.payload;
    if (payload?.path && typeof payload.staged === 'boolean') await host.engine.stage(payload.path, payload.staged);
  });
  async function discard(path?: string) {
    if (await host.engine.operation()) throw new Error('Finish or cancel the stack update before discarding changes.');
    const repository = await host.nativeRepository();
    if (!repository)
      throw new Error('The editor’s Git integration is still opening this repository. Refresh and try again.');
    await repository.status();
    if (repository.state.mergeChanges.length) throw new Error('Resolve or cancel conflicts before discarding changes.');
    const target = path && vscode.Uri.joinPath(repository.rootUri, path).toString();
    const files = [...repository.state.workingTreeChanges, ...repository.state.untrackedChanges].filter(
      (change) => !target || change.uri.toString() === target,
    );
    if (!files.length) return;
    const title = path ? `Discard unstaged changes in ${path}?` : 'Discard all unstaged changes?';
    const detail = 'Staged changes are kept. Untracked files are removed using the editor’s Git settings.';
    if ((await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Discard')) === 'Discard')
      await repository.clean([...new Set(files.map((file) => file.uri.fsPath))]);
  }
  command('discard', async (item) => {
    if (item?.payload?.path) await discard(item.payload.path);
  });
  command('discardAll', async () => discard());
  command('openFile', async (item) => {
    const path = item?.payload?.path;
    const file = host.files.find((file) => file.path === path);
    if (!path || !file) return;
    if (file.status === 'U') {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(join(host.engine.git.cwd, path)));
      return;
    }
    const repository = await host.nativeRepository();
    if (!repository)
      throw new Error('The editor’s Git integration is still opening this repository. Refresh and try again.');
    await repository.status();
    await vscode.commands.executeCommand('git.openChange', vscode.Uri.joinPath(repository.rootUri, path));
  });
  command('compose', async (item) => {
    const data = item?.payload;
    if (!data || (!data.message?.trim() && data.mode !== 'amend')) throw new Error('Enter a commit message.');
    const engine = host.engine;
    if (data.mode === 'create') {
      const message = data.message!;
      let name =
        data.name?.trim() ||
        message
          .split('\n')[0]!
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 80);
      if (!name) throw new Error('Enter a branch name.');
      if (!data.name?.trim()) {
        const stem = name;
        let suffix = 2;
        while (await engine.git.succeeds('show-ref', '--verify', `refs/heads/${name}`)) name = `${stem}-${suffix++}`;
      }
      await engine.createFromStaged(name, message);
      host.view.clearComposer();
    } else await modify(data.message || '', data.mode === 'amend');
  });
  command('submit', async (item) => {
    const branch = await pickBranch(item);
    if (!branch) return;
    const engine = host.engine;
    const state = await engine.state();
    const branches = engine.stack(state, branch, item?.payload?.mode !== 'branch');
    const mode = item?.payload?.mode;
    const draft =
      mode === 'review' ? false : mode === 'draft' || host.configuration().get<boolean>('defaultDraft', true);
    await host.github().submit(branches, draft);
    host.invalidatePullRequests();
    void vscode.window.showInformationMessage(`Submitted ${branches.length} branches.`);
  });
  command('initialize', async () => {
    const engine = host.engine;
    const trunk = await vscode.window.showQuickPick(await engine.git.branches(), {
      title: 'Choose trunk (usually main)',
    });
    if (trunk) await engine.initialize(trunk);
  });
  command('create', async (item) => {
    const parent = await pickBranch(item);
    if (!parent) return;
    const name = await input(`New branch stacked on ${parent}`);
    if (name) await host.engine.create(name, parent);
  });
  command('track', async (item) => {
    const engine = host.engine;
    const state = await engine.state();
    const names = (await engine.git.branches()).filter((name) => name !== state.trunk && !state.branches[name]);
    const requested = item?.payload?.branch;
    const choice =
      requested && names.includes(requested)
        ? { name: requested, remote: false }
        : await vscode.window.showQuickPick(
            [
              ...names
                .sort((a, b) => Number(b === host.current) - Number(a === host.current))
                .map((name) => ({
                  label: name,
                  name,
                  remote: false,
                  description: name === host.current ? 'Current branch' : 'Local branch',
                })),
              { label: '$(cloud-download) Get remote branch…', name: '', remote: true },
            ],
            { title: 'Add an existing branch', ignoreFocusOut: true },
          );
    if (!choice) return;
    if (choice.remote) await engine.fetch(host.remote());
    const refs = await engine.trackingRefs(choice.remote ? host.remote() : undefined);
    const branch = choice.remote
      ? (
          await vscode.window.showQuickPick(
            [...refs]
              .filter(([name, ref]) => ref.startsWith('refs/remotes/') && name !== state.trunk)
              .map(([name]) => ({ label: name })),
            { title: 'Get a remote branch and its parents', ignoreFocusOut: true },
          )
        )?.label
      : choice.name;
    if (!branch) return;
    const entries: { branch: string; parent: string; base: string; head: string }[] = [];
    async function resolve(name: string, children: string[]): Promise<boolean> {
      if (name === state.trunk || state.branches[name]) return true;
      const head = await engine.git.oid(refs.get(name)!),
        options = await engine.trackingOptions(name, children, choice!.remote ? host.remote() : undefined);
      if (!options.length) throw new Error(`${name} has no shared history with the trunk or another local branch.`);
      const parent =
        options.find((option) => option.automatic) ??
        (
          await vscode.window.showQuickPick(
            options.map((option) => ({
              label: option.name,
              description: option.suggested ? 'Possible parent' : 'Other branch',
              option,
            })),
            {
              title: `Which branch is ${name} based on?`,
              placeHolder: 'Git history has more than one possible parent',
              ignoreFocusOut: true,
            },
          )
        )?.option;
      if (!parent) return false;
      let base = parent.base;
      if (!base) {
        const commits = (
          await engine.git.run('log', '--reverse', '--first-parent', '--format=%H %s', `${parent.common}..${head}`)
        )
          .split('\n')
          .filter(Boolean);
        const first = await vscode.window.showQuickPick(
          commits.map((line) => {
            const separator = line.indexOf(' ');
            return { label: line.slice(separator + 1), oid: line.slice(0, separator) };
          }),
          { title: `First commit belonging to ${name}`, ignoreFocusOut: true },
        );
        if (!first) return false;
        base = await engine.git.oid(`${first.oid}^`);
      }
      if (!(await resolve(parent.name, [...children, name]))) return false;
      entries.push({ branch: name, parent: parent.name, base, head });
      return true;
    }
    if (!(await resolve(branch, []))) return;
    await engine.trackStack(entries, host.remote());
    if (choice.remote) await engine.checkout(branch);
    host.focusBranch(branch);
  });
  command('checkout', async (item) => {
    const branch = await pickBranch(item, true);
    if (branch) await host.engine.checkout(branch);
  });
  command('up', async () => {
    const engine = host.engine;
    const state = await engine.state();
    const branch = await engine.git.current();
    const children = engine.children(state, branch);
    const child =
      children.length === 1 ? children[0] : await vscode.window.showQuickPick(children, { title: 'Move up to child' });
    if (child) await engine.checkout(child);
  });
  command('down', async () => {
    const engine = host.engine;
    const parent = (await engine.state()).branches[await engine.git.current()]?.parent;
    if (parent) await engine.checkout(parent);
  });
  command('rename', async (item) => {
    const branch = await pickBranch(item);
    if (!branch) return;
    const name = await input(`Rename ${branch}`, branch);
    if (name && name !== branch) await host.engine.rename(branch, name);
  });
  command('delete', async (item) => {
    const branch = await pickBranch(item);
    if (branch) await preview(await host.engine.plan('delete', branch));
  });
  for (const amend of [false, true])
    command(amend ? 'amend' : 'commit', async () => {
      const message = amend ? '' : await input('Commit staged changes');
      if (message !== undefined) await modify(message, amend);
    });
  command('restack', async (item) => {
    const branch = await pickBranch(item);
    if (branch) await preview(await host.engine.plan('restack', branch), false);
  });
  command('changeParent', async (item) => {
    const branch = await pickBranch(item);
    if (!branch) return;
    const engine = host.engine;
    const state = await engine.state();
    const excluded = [branch, ...engine.descendants(state, branch)];
    host.focusBranch(branch);
    const parent =
      item?.payload?.parent ??
      (await vscode.window.showQuickPick(
        (await engine.git.branches()).filter(
          (name) => (name === state.trunk || state.branches[name]) && !excluded.includes(name),
        ),
        { title: `Move ${branch} onto…` },
      ));
    if (parent && parent !== state.branches[branch]?.parent)
      await preview(await engine.plan('parent', branch, parent), false);
  });
  command('syncMain', async () => {
    const engine = host.engine;
    await engine.fetch(host.remote());
    await preview(await engine.syncPlan(host.remote(), []), false);
  });
  command('syncMerged', async () => {
    const engine = host.engine;
    await engine.fetch(host.remote());
    let merged: string[] = [];
    try {
      merged = await host.github().merged();
    } catch (failure) {
      host.output.appendLine(`Merged-branch cleanup: ${String(failure)}`);
      void vscode.window.showInformationMessage('Merged-branch cleanup is unavailable. Syncing with main.');
    }
    const plan = await engine.syncPlan(host.remote(), merged);
    await preview(
      plan,
      plan.steps.some((step) => step.kind === 'delete'),
    );
  });
  command('continue', async () => host.engine.continue());
  command('abort', async () => {
    if (
      (await vscode.window.showWarningMessage(
        'Cancel the restack and return your branches to where they started?',
        { modal: true, detail: 'Conflict resolutions made during the pending rebase will be discarded.' },
        'Cancel restack',
      )) === 'Cancel restack'
    )
      await host.engine.abort();
  });
  command('conflicts', async () => {
    await vscode.commands.executeCommand('workbench.view.scm');
    for (const file of await host.engine.conflicts())
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(join(host.engine.git.cwd, file)));
  });
  command('sourceControl', async () => vscode.commands.executeCommand('workbench.view.scm'));
  for (const all of [false, true])
    command(all ? 'pushStack' : 'push', async (item) => {
      const branch = await pickBranch(item);
      if (!branch) return;
      const engine = host.engine;
      const branches = all ? engine.stack(await engine.state(), branch) : [branch];
      await engine.push(branches, host.remote());
    });
  command('openPR', async (item) => {
    const branch = await pickBranch(item);
    if (!branch) return;
    const pr = await host.github().get(branch);
    if (pr) await vscode.env.openExternal(vscode.Uri.parse(pr.url));
    else void vscode.window.showInformationMessage('No pull request found. Submit the stack first.');
  });
  command('toggleDraft', async (item) => {
    const branch = await pickBranch(item);
    if (!branch) return;
    const pr = await host.github().get(branch);
    if (!pr || pr.state !== 'OPEN') throw new Error('No open pull request. Submit the stack first.');
    await host.github().ready(pr.number, pr.isDraft);
    host.invalidatePullRequests();
    void vscode.window.showInformationMessage(
      pr.isDraft ? 'Pull request is ready for review.' : 'Pull request converted to draft.',
    );
  });
  command('inspect', async (item) => {
    const branch = await pickBranch(item);
    if (!branch) return;
    const engine = host.engine;
    const meta = (await engine.state()).branches[branch];
    const range = meta ? `${meta.base}..refs/heads/${branch}` : `refs/heads/${branch}`;
    const log = await engine.git.run('log', '--max-count=100', '--format=%h %s%n  %an · %ar', range);
    const document = await vscode.workspace.openTextDocument({
      content: log || 'No commits on this branch.',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(document, { preview: true });
  });
  command('diff', async (item) => {
    const branch = await pickBranch(item);
    if (!branch) return;
    const engine = host.engine;
    const meta = (await engine.state()).branches[branch];
    if (!meta) return;
    const head = await engine.git.head(branch),
      files = await engine.git.changes(meta.base, head);
    const path = item?.payload?.path;
    const file = path
      ? files.find((file) => file.path === path)
      : (
          await vscode.window.showQuickPick(
            files.map((file) => ({ label: file.path, description: file.originalPath, file })),
            { title: `${branch} against ${meta.parent}` },
          )
        )?.file;
    if (!file) return;
    const repository = await host.nativeRepository();
    if (!repository)
      throw new Error('The editor’s Git integration is still opening this repository. Refresh and try again.');
    // The native Git provider needs an empty side for additions/deletions, not the working file.
    const empty = ['A', 'D'].includes(file.status)
      ? (await engine.git.input('', 'hash-object', '-t', 'tree', '--stdin')).trim()
      : '';
    const left = host.git.uri(
      vscode.Uri.joinPath(repository.rootUri, file.originalPath ?? file.path),
      file.status === 'A' ? empty : meta.base,
    );
    const right = host.git.uri(vscode.Uri.joinPath(repository.rootUri, file.path), file.status === 'D' ? empty : head);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${file.path} (${meta.parent} ↔ ${branch})`);
  });
}
