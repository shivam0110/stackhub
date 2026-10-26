import * as vscode from 'vscode';
import { StackEngine } from '../engine/stack';
import { GitHub, type PullRequest } from '../engine/github';
import type { State } from '../engine/types';
import { StackView } from '../ui/view';
import { readView, readFiles, readDetail } from '../ui/model';
import type { ViewAction, ViewState } from '../ui/protocol';
import { EditorGit } from './nativeGit';

export interface BranchItem {
  branch: string;
  payload?: ViewAction;
}
type CommandHandler = (item?: BranchItem) => Promise<unknown>;
type CommandName = Exclude<ViewAction['action'], 'focus'> | 'commit' | 'amend';

const fileCommands = new Set(['stage', 'stageAll', 'unstageAll']);
const readCommands = new Set(['settings', 'sourceControl', 'openFile', 'openPR', 'inspect', 'diff', 'conflicts']);
const refreshGitCommands = new Set([
  'refresh',
  'initialize',
  'discard',
  'discardAll',
  'compose',
  'create',
  'track',
  'checkout',
  'up',
  'down',
  'rename',
  'delete',
  'commit',
  'amend',
  'restack',
  'changeParent',
  'syncMain',
  'syncMerged',
  'continue',
  'abort',
  'push',
  'pushStack',
  'submit',
]);

/** Owns the selected repository and sidebar snapshot, including stale-read guards and the Git index queue. */
export class StackController implements vscode.Disposable {
  readonly view: StackView;
  private readonly subscriptions: vscode.Disposable[] = [];
  private repository?: StackEngine;
  private configurationUri?: vscode.Uri;
  private state?: State;
  private selected?: string;
  private busy?: string;
  private error?: string;
  private refreshId = 0;
  private detailId = 0;
  private refreshing?: Promise<void>;
  // Git has one index per worktree, so independent checkbox clicks must still run in order.
  private stagingQueue = Promise.resolve();
  private readonly staging = new Map<string, boolean>();
  private nativeRefreshTimer?: ReturnType<typeof setTimeout>;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private gitListener?: vscode.Disposable;
  private prs?: Record<string, PullRequest>;
  private githubError?: string;
  private lastPrRefresh = 0;
  private loadingPrs = false;
  private model: ViewState = { initialized: false, current: '', branches: [], files: [] };

  constructor(
    context: vscode.ExtensionContext,
    readonly git: EditorGit,
    readonly output: vscode.OutputChannel,
  ) {
    this.view = new StackView(context, (message) => this.dispatch(message));
    this.subscriptions.push(
      vscode.window.registerWebviewViewProvider('stackhub.branches', this.view, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('stackhub')) this.publish();
      }),
    );
  }

  get engine(): StackEngine {
    if (!this.repository) throw new Error('Open or select a Git repository first.');
    return this.repository;
  }

  get current(): string {
    return this.model.current;
  }
  get files(): ViewState['files'] {
    return this.model.files;
  }
  configuration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('stackhub', this.configurationUri);
  }
  remote(): string {
    return this.configuration().get<string>('remote', 'origin');
  }
  github(): GitHub {
    return new GitHub(this.engine, this.remote());
  }
  nativeRepository() {
    return this.git.repository(this.repository);
  }
  invalidatePullRequests(): void {
    this.lastPrRefresh = 0;
  }
  focusBranch(branch: string): void {
    this.selected = branch;
    this.view.focusBranch(branch);
  }

  async start(): Promise<void> {
    await this.selectRepository();
    this.pollTimer = setInterval(() => this.refreshIfIdle(), 5000);
  }

  dispose(): void {
    clearInterval(this.pollTimer);
    clearTimeout(this.nativeRefreshTimer);
    clearTimeout(this.changeTimer);
    this.gitListener?.dispose();
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }

  private async dispatch(message: ViewAction): Promise<void> {
    const branch = message.branch || this.current;
    if (
      message.branch &&
      message.action !== 'track' &&
      this.state &&
      branch !== this.state.trunk &&
      !this.state.branches[branch]
    )
      return;
    if (message.action === 'focus') {
      this.selected = message.branch;
      await this.refreshDetail();
      return;
    }
    await vscode.commands.executeCommand(`stackhub.${message.action}`, { branch, payload: message });
  }

  private publish(): void {
    const settings = this.configuration();
    this.view.update({
      ...this.model,
      busy: this.busy,
      staging: this.staging.size ? Object.fromEntries(this.staging) : undefined,
      error: this.error,
      prs: this.prs,
      githubError: this.githubError,
      modifyBehavior: settings.get<'amend' | 'commit'>('modifyBehavior', 'amend'),
      branchLabel: settings.get<'branch' | 'pr'>('branchLabel', 'branch'),
      defaultDraft: settings.get<boolean>('defaultDraft', true),
    });
  }

  private async refreshDetail(): Promise<void> {
    const id = ++this.detailId,
      repository = this.repository,
      branch = this.selected;
    this.model = { ...this.model, detail: undefined };
    this.publish();
    if (!repository || !this.state) return;
    const detail = await readDetail(
      repository,
      this.state,
      branch,
      this.model.branches.find((item) => item.name === branch)?.head,
    );
    // Discard results from an earlier selection, repository, or commit snapshot.
    if (id !== this.detailId || repository !== this.repository || this.selected !== branch) return;
    const focused = this.model.branches.find((item) => item.name === branch);
    if (detail && (detail.head !== focused?.head || detail.base !== focused?.base)) return this.refreshDetail();
    this.model = { ...this.model, detail };
    this.publish();
  }

  private async refreshPullRequests(): Promise<void> {
    if (!this.repository || !this.state || this.loadingPrs || Date.now() - this.lastPrRefresh < 60000) return;
    const repository = this.repository,
      target = this.remote();
    this.loadingPrs = true;
    this.lastPrRefresh = Date.now();
    try {
      if (!(await repository.git.run('remote', 'get-url', target).catch(() => ''))) return;
      const next = await new GitHub(repository, target).statuses();
      if (this.repository === repository && this.remote() === target) {
        this.prs = next;
        this.githubError = undefined;
      }
    } catch (failure) {
      if (this.repository === repository && this.remote() === target) {
        this.prs = undefined;
        this.githubError = (failure as Error).message;
      }
    } finally {
      this.loadingPrs = false;
      this.publish();
    }
  }

  /** Coalesce reads; a forced refresh waits for an in-flight read and then reads again. */
  private refresh(force = false): Promise<void> {
    if (this.refreshing) return force ? this.refreshing.then(() => this.refresh(true)) : this.refreshing;
    const id = ++this.refreshId,
      repository = this.repository;
    this.refreshing = (async () => {
      const nextState = repository && (await repository.initialized()) ? await repository.state() : undefined;
      const branch = this.selected,
        selection = this.detailId;
      const next = await readView(repository, branch, this.model, nextState);
      if (id !== this.refreshId || repository !== this.repository) return;
      if (selection !== this.detailId) {
        const focused = next.branches.find((item) => item.name === this.selected);
        next.detail =
          this.model.detail?.branch === this.selected &&
          this.model.detail?.head === focused?.head &&
          this.model.detail?.base === focused?.base
            ? this.model.detail
            : undefined;
      }
      this.model = next;
      this.state = nextState;
      this.publish();
      void this.refreshPullRequests();
      if (this.selected && this.state?.branches[this.selected] && !this.model.detail) void this.refreshDetail();
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshFiles(repository: StackEngine): Promise<void> {
    // A full refresh started before this index update must not replace the newer file list.
    ++this.refreshId;
    const files = await readFiles(repository);
    if (repository !== this.repository) return;
    this.model = {
      ...this.model,
      files,
      conflict: this.model.conflict && {
        ...this.model.conflict,
        files: files.filter((file) => file.status === '!').map((file) => file.path),
      },
    };
  }

  private async refreshNativeGit(): Promise<void> {
    await this.nativeRepository()
      .then((repository) => repository?.status())
      .catch((failure) => this.output.appendLine(`Editor Git refresh: ${String(failure)}`));
  }

  private scheduleNativeRefresh(): void {
    clearTimeout(this.nativeRefreshTimer);
    this.nativeRefreshTimer = setTimeout(() => {
      if (!this.busy) void this.refreshNativeGit();
    }, 100);
  }

  private refreshIfIdle(): void {
    if (this.view.visible && !this.busy && !this.staging.size)
      void this.refresh().catch((failure) => this.output.appendLine(String(failure)));
  }

  async selectRepository(): Promise<void> {
    const roots = [
      ...new Set([...this.git.roots, ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)]),
    ];
    const candidates: StackEngine[] = [];
    for (const root of roots) {
      const candidate = await StackEngine.open(root).catch(() => undefined);
      if (candidate && !candidates.some((item) => item.git.cwd === candidate.git.cwd)) candidates.push(candidate);
    }
    const choice =
      candidates.length < 2
        ? candidates[0]
        : (
            await vscode.window.showQuickPick(
              candidates.map((candidate) => ({ label: candidate.git.cwd, candidate })),
              { title: 'Select Git repository' },
            )
          )?.candidate;
    if (choice) {
      this.repository = choice;
      this.model = { initialized: false, current: '', branches: [], files: [] };
      this.selected = undefined;
      this.prs = undefined;
      this.githubError = undefined;
      this.lastPrRefresh = 0;
      this.view.focusBranch('');
    }
    this.gitListener?.dispose();
    const repository = await this.nativeRepository();
    this.configurationUri = repository?.rootUri ?? (this.repository && vscode.Uri.file(this.repository.git.cwd));
    this.gitListener = repository?.state.onDidChange(() => {
      clearTimeout(this.changeTimer);
      this.changeTimer = setTimeout(() => this.refreshIfIdle(), 100);
    });
    await this.refresh(true);
  }

  /** All entry points share one mutation guard; staging uses a separate ordered index queue. */
  registerCommand(name: CommandName, action: CommandHandler): void {
    this.subscriptions.push(
      vscode.commands.registerCommand(`stackhub.${name}`, async (item?: BranchItem) => {
        if (this.busy || (this.staging.size && !fileCommands.has(name) && !readCommands.has(name))) {
          if (fileCommands.has(name)) this.view.rejectStaging(item?.payload?.path);
          return;
        }
        if (fileCommands.has(name)) return this.runStaging(name, action, item);
        if (readCommands.has(name)) {
          try {
            await action(item);
            return true;
          } catch (failure) {
            this.output.appendLine(String(failure));
            void vscode.window.showErrorMessage((failure as Error).message);
            return false;
          }
        }
        return this.runMutation(name, action, item);
      }),
    );
  }

  private async runStaging(name: CommandName, action: CommandHandler, item?: BranchItem): Promise<boolean | undefined> {
    const repository = this.engine,
      target = name !== 'unstageAll';
    const paths =
      name === 'stage'
        ? item?.payload?.path
          ? [item.payload.path]
          : []
        : this.model.files.filter((file) => (target ? file.unstaged : file.staged)).map((file) => file.path);
    // Keep bulk staging busy even when the displayed file list is older than the worktree.
    if (name !== 'stage' && !paths.length) paths.push('');
    const staged = name === 'stage' ? item?.payload?.staged : target;
    if (!paths.length || typeof staged !== 'boolean' || paths.some((path) => this.staging.has(path))) {
      this.view.rejectStaging(item?.payload?.path);
      return;
    }
    ++this.refreshId;
    this.error = undefined;
    paths.forEach((path) => this.staging.set(path, staged));
    this.publish();
    let success = true;
    const work = this.stagingQueue.then(async () => {
      try {
        await action(item);
      } catch (failure) {
        success = false;
        this.error = (failure as Error).message;
        this.output.appendLine(String(failure));
        void vscode.window.showErrorMessage(this.error);
      } finally {
        try {
          await this.refreshFiles(repository);
        } catch (failure) {
          success = false;
          this.error = String(failure);
        }
        paths.forEach((path) => this.staging.delete(path));
        this.publish();
        this.scheduleNativeRefresh();
      }
    });
    this.stagingQueue = work.catch((failure) => this.output.appendLine(String(failure)));
    await work;
    return success;
  }

  private async runMutation(name: CommandName, action: CommandHandler, item?: BranchItem): Promise<boolean> {
    ++this.refreshId;
    ++this.detailId;
    this.busy = 'Working…';
    this.error = undefined;
    this.publish();
    try {
      await action(item);
      return true;
    } catch (failure) {
      this.output.appendLine(`${new Date().toISOString()} ${(failure as Error).stack}`);
      try {
        if (this.repository && (await this.repository.operation()) && (await this.repository.conflicts()).length)
          return false;
      } catch (inspectionFailure) {
        this.output.appendLine(`Conflict status: ${String(inspectionFailure)}`);
      }
      this.error = (failure as Error).message;
      void vscode.window.showErrorMessage(this.error);
      return false;
    } finally {
      if (refreshGitCommands.has(name)) await this.refreshNativeGit();
      try {
        if (name === 'discard' || name === 'discardAll') await this.refreshFiles(this.engine);
        else if (name !== 'selectRepository' && name !== 'toggleDraft') await this.refresh(true);
      } catch (failure) {
        this.error ??= String(failure);
      }
      this.busy = undefined;
      this.publish();
      if (name === 'toggleDraft') void this.refreshPullRequests();
    }
  }
}
