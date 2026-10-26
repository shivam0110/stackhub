import { mkdir, readFile, writeFile, rename, unlink, readdir, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Git } from './git';
import { State, Operation, Plan, Step } from './types';
import { parseOperation, parseState } from './metadata';

const copy = <T>(value: T): T => structuredClone(value);

/** Coordinates native Git using explicit parents and saved commit boundaries. */
export class StackEngine {
  private constructor(
    readonly git: Git,
    readonly directory: string,
  ) {}

  /** Shares metadata and locking across worktrees through Git's common directory. */
  static async open(cwd: string) {
    const git = new Git(cwd);
    const root = await git.run('rev-parse', '--show-toplevel');
    const common = resolve(cwd, await git.run('rev-parse', '--git-common-dir'));
    return new StackEngine(new Git(root), join(common, 'stackhub'));
  }

  private async read<T>(name: string, parse: (value: unknown) => T): Promise<T | undefined> {
    const path = join(this.directory, name);
    try {
      return parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Cannot read StackHub metadata ${path}: ${(error as Error).message}`);
    }
  }

  private async save(name: string, value: unknown) {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, name);
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx');
    try {
      await file.writeFile(JSON.stringify(value, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  }

  /** Serializes StackHub mutations across editor processes; external Git remains independent. */
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const ref = 'refs/stackhub/lock';
    const previous = await this.git.run('rev-parse', '--verify', ref).catch(() => '');
    if (previous) {
      const owner = JSON.parse(await this.git.run('cat-file', 'blob', previous)) as { pid: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
        throw new Error('Invalid StackHub lock owner. Inspect refs/stackhub/lock.');
      try {
        process.kill(owner.pid, 0);
        throw new Error('Another StackHub command is running.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const path = join(this.directory, `lock-${randomUUID()}.json`);
    let token: string;
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, id: randomUUID() }));
      token = await this.git.run('hash-object', '-w', path);
    } finally {
      await unlink(path);
    }
    // Compare-and-swap prevents two editors from claiming a dead owner's lock.
    try {
      await this.git.run('update-ref', ref, token, previous || '0'.repeat(token.length));
    } catch {
      throw new Error('Another StackHub command is running.');
    }
    try {
      return await action();
    } finally {
      await this.git.run('update-ref', '-d', ref, token);
    }
  }

  async state() {
    const state = await this.read('state.json', parseState);
    if (!state) throw new Error('Initialize StackHub and choose a trunk branch first.');
    return state;
  }
  operation() {
    return this.read('operation.json', parseOperation);
  }
  async initialized() {
    return !!(await this.read('state.json', parseState));
  }
  async initialize(trunk: string) {
    return this.exclusive(async () => {
      if (await this.initialized()) throw new Error('This repository is already initialized.');
      await this.git.name(trunk);
      await this.git.head(trunk);
      await this.save('state.json', { version: 1, trunk, branches: {} } satisfies State);
    });
  }

  private async idle() {
    if (await this.operation()) throw new Error('Continue or cancel the pending stack update first.');
    if (
      (await this.rebasing()) ||
      (await this.git.succeeds('rev-parse', '--verify', 'MERGE_HEAD')) ||
      (await this.git.succeeds('rev-parse', '--verify', 'CHERRY_PICK_HEAD'))
    ) {
      throw new Error('Finish the existing Git operation first.');
    }
  }
  private async rebasing() {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const path = resolve(this.git.cwd, await this.git.run('rev-parse', '--git-path', name));
      try {
        await readdir(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return false;
  }
  private async verifyRebase(operation: Operation) {
    const step = operation.steps[operation.index];
    for (const directory of ['rebase-merge', 'rebase-apply']) {
      const path = resolve(this.git.cwd, await this.git.run('rev-parse', '--git-path', `${directory}/head-name`));
      try {
        const branch = (await readFile(path, 'utf8')).trim();
        if (step?.kind !== 'rebase' || branch !== `refs/heads/${step.branch}`)
          throw new Error('An unrelated rebase is running; finish it with Git first.');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new Error('Cannot identify the pending rebase. Inspect it with Git before continuing.');
  }
  async conflicts() {
    return (await this.git.run('diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
  }
  children(state: State, branch: string): string[] {
    return Object.keys(state.branches)
      .filter((name) => state.branches[name]!.parent === branch)
      .sort();
  }
  descendants(state: State, branch: string): string[] {
    return this.children(state, branch).flatMap((child) => [child, ...this.descendants(state, child)]);
  }
  stack(state: State, branch: string, descendants = true) {
    if (!state.branches[branch]) throw new Error('Select a tracked branch.');
    const parents = [branch];
    while (state.branches[parents[0]!]!.parent !== state.trunk) parents.unshift(state.branches[parents[0]!]!.parent);
    return [...parents, ...(descendants ? this.descendants(state, branch) : [])];
  }
  private known(state: State, branch: string) {
    if (branch !== state.trunk && !state.branches[branch]) throw new Error(`Track ${branch} first.`);
  }
  private async available(branches: string[]) {
    const worktrees = (await this.git.run('worktree', 'list', '--porcelain')).split('\n\n');
    for (const block of worktrees) {
      const lines = block.split('\n');
      const path = lines.find((line) => line.startsWith('worktree '))?.slice(9);
      const branch = lines.find((line) => line.startsWith('branch refs/heads/'))?.slice(18);
      if (path && branch && resolve(path) !== this.git.cwd && branches.includes(branch))
        throw new Error(`${branch} is checked out in another worktree: ${path}`);
    }
  }

  async trackingRefs(remote?: string) {
    const refs = new Map<string, string>();
    if (remote) {
      const prefix = `refs/remotes/${remote}/`;
      for (const ref of (await this.git.run('for-each-ref', '--format=%(refname)', prefix))
        .split('\n')
        .filter(Boolean)) {
        if (ref !== `${prefix}HEAD`) refs.set(ref.slice(prefix.length), ref);
      }
    }
    for (const name of await this.git.branches()) refs.set(name, `refs/heads/${name}`);
    return refs;
  }

  async trackingOptions(branch: string, exclude: string[] = [], remote?: string) {
    const state = await this.state(),
      refs = await this.trackingRefs(remote);
    const head = await this.git.oid(refs.get(branch) || `refs/heads/${branch}`);
    const tips = new Map(
      (
        await this.git.run(
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/heads',
          ...(remote ? [`refs/remotes/${remote}/`] : []),
        )
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [ref, oid] = line.split(' ');
          return [ref!, oid!] as const;
        }),
    );
    const bases = new Map<string, Promise<string[]>>(),
      counts = new Map<string, Promise<number>>();
    const readOption = async ([name, ref]: [string, string]) => {
      const parent = tips.get(ref);
      if (!parent) return;
      if (!bases.has(parent))
        bases.set(
          parent,
          this.git
            .run('merge-base', '--all', parent, head)
            .catch(() => '')
            .then((value) => value.split('\n').filter(Boolean)),
        );
      const common = await bases.get(parent)!;
      if (common.length !== 1) return;
      if (name !== state.trunk && parent !== head && common[0] === head) return;
      let base: string | undefined = common[0] === parent ? parent : undefined;
      // Reflogs preserve the fork point when a parent was amended or rebased.
      if (!base) base = await this.git.run('merge-base', '--fork-point', ref, head).catch(() => undefined);
      if (!base && name === state.trunk) base = common[0];
      const boundary = base || common[0]!;
      if (!counts.has(boundary))
        counts.set(boundary, this.git.run('rev-list', '--count', `${boundary}..${head}`).then(Number));
      const commits = await counts.get(boundary)!;
      return { name, base, common: common[0]!, commits, direct: common[0] === parent || name === state.trunk };
    };
    const entries = [...refs].filter(([name]) => name !== branch && !exclude.includes(name));
    let index = 0;
    const options = (
      await Promise.all(
        Array.from({ length: Math.min(8, entries.length) }, async () => {
          const found = [];
          while (index < entries.length) found.push(await readOption(entries[index++]!));
          return found;
        }),
      )
    )
      .flat()
      .filter((option) => option !== undefined);
    const candidates = options.filter((option) => option.base !== undefined);
    // Only a nearest ancestor is automatic; equal tips or merged lineages need a choice.
    const boundaries = [...new Set(candidates.map((option) => option.base!))];
    const nearest = new Set(
      boundaries.length ? (await this.git.run('merge-base', '--independent', ...boundaries)).split('\n') : [],
    );
    const preferred = candidates.filter(
      (option) =>
        nearest.has(option.base!) &&
        !candidates.some(
          (other) =>
            other.base === option.base &&
            ((other.direct && !option.direct) ||
              (other.direct === option.direct && this.descendants(state, option.name).includes(other.name))),
        ),
    );
    return options
      .map((option) => ({
        ...option,
        suggested: preferred.includes(option),
        automatic: preferred.length === 1 && preferred[0] === option,
      }))
      .sort(
        (a, b) => Number(b.suggested) - Number(a.suggested) || a.commits - b.commits || a.name.localeCompare(b.name),
      );
  }

  /** Tracks branches in parent-first order, rechecking tips before importing missing local refs. */
  async trackStack(branches: { branch: string; parent: string; base: string; head: string }[], remote: string) {
    return this.exclusive(async () => {
      await this.idle();
      const state = await this.state(),
        imports: string[] = [];
      for (const { branch, parent, base, head } of branches) {
        await this.git.name(branch);
        this.known(state, parent);
        if (branch === state.trunk || state.branches[branch])
          throw new Error('Branch is already tracked or is the trunk.');
        const local = await this.git.head(branch).catch(() => '');
        if (
          head !== (local || (await this.git.oid(`refs/remotes/${remote}/${branch}`))) ||
          !(await this.git.ancestor(base, head))
        )
          throw new Error('The branch changed. Track it again.');
        if (!local) imports.push(`create refs/heads/${branch} ${head}`);
        state.branches[branch] = { parent, base };
        if ((await this.git.oid(`refs/remotes/${remote}/${branch}`).catch(() => '')) === head)
          state.branches[branch]!.published = head;
      }
      if (imports.length)
        await this.git.input(['start', ...imports, 'prepare', 'commit', ''].join('\n'), 'update-ref', '--stdin');
      await this.save('state.json', state);
    });
  }

  async create(branch: string, parent: string) {
    return this.exclusive(async () => {
      await this.idle();
      await this.git.clean();
      await this.git.name(branch);
      const state = await this.state();
      this.known(state, parent);
      const base = await this.git.head(parent);
      await this.git.run('switch', '-c', branch, `refs/heads/${parent}`);
      state.branches[branch] = { parent, base };
      await this.save('state.json', state);
    });
  }

  async createFromStaged(branch: string, message: string) {
    return this.exclusive(async () => {
      await this.idle();
      await this.git.name(branch);
      const state = await this.state();
      const parent = await this.git.current();
      this.known(state, parent);
      if (!message.trim() || (await this.git.succeeds('diff', '--cached', '--quiet')))
        throw new Error('Stage changes and enter a commit message first.');
      const base = await this.git.head(parent);
      await this.git.run('switch', '-c', branch);
      state.branches[branch] = { parent, base };
      await this.save('state.json', state);
      // Preserve unstaged work. If a hook rejects the commit, the new branch and index remain available.
      await this.git.run('commit', '-m', message);
    });
  }

  async stage(path: string, staged: boolean) {
    return this.exclusive(async () => {
      const file = (await this.git.status()).find((file) => file.path === path);
      if (!file) throw new Error('The file changed since refresh. Refresh and try again.');
      const restoreRename = !staged && file.index === 'R' && file.originalPath;
      const paths = restoreRename ? [path, file.originalPath!] : [path];
      await this.git.run('--literal-pathspecs', ...(staged ? ['add'] : ['restore', '--staged']), '--', ...paths);
    });
  }

  async checkout(branch: string) {
    return this.exclusive(async () => {
      await this.idle();
      await this.available([branch]);
      await this.git.head(branch);
      await this.git.run('switch', branch);
    });
  }

  async stageAll(staged: boolean) {
    return this.exclusive(() =>
      this.git.run(...(staged ? ['add', '--all', '--', '.'] : ['restore', '--staged', '--', '.'])),
    );
  }

  async commit(message: string, amend = false) {
    return this.exclusive(async () => {
      await this.idle();
      const state = await this.state();
      const branch = await this.git.current();
      if (!state.branches[branch]) throw new Error('Check out a tracked branch before committing.');
      if (amend && (await this.git.head(branch)) === state.branches[branch]!.base)
        throw new Error('This branch has no commit to amend.');
      if (!message.trim() && !amend) throw new Error('A commit message is required.');
      if (!amend && (await this.git.succeeds('diff', '--cached', '--quiet')))
        throw new Error('Stage changes in Source Control first.');
      const recovery = amend ? await this.snapshot(state) : undefined;
      await this.git.run(
        'commit',
        ...(amend ? ['--amend'] : []),
        ...(message.trim() ? ['-m', message] : ['--no-edit']),
      );
      if (recovery) {
        recovery.expected[branch] = await this.git.head(branch);
        await this.save(`recovery-${recovery.id}.json`, recovery);
      }
    });
  }

  async rename(branch: string, name: string) {
    return this.exclusive(async () => {
      await this.idle();
      await this.git.name(name);
      await this.available([branch]);
      const state = await this.state();
      if (!state.branches[branch]) throw new Error('Only tracked branches can be renamed.');
      await this.git.run('branch', '-m', branch, name);
      state.branches[name] = state.branches[branch]!;
      delete state.branches[branch];
      delete state.branches[name]!.published;
      for (const item of Object.values(state.branches)) if (item.parent === branch) item.parent = name;
      await this.save('state.json', state);
    });
  }

  private rebaseSteps(state: State, branches: string[]): Step[] {
    return branches.map((branch) => ({
      kind: 'rebase',
      branch,
      parent: state.branches[branch]!.parent,
      base: state.branches[branch]!.base,
    }));
  }
  private async heads(state: State) {
    const tips = new Map(
      (await this.git.run('for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/heads'))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [branch, oid] = line.split(' ');
          return [branch!, oid!] as const;
        }),
    );
    const trunk = tips.get(state.trunk);
    if (!trunk)
      throw new Error(`${state.trunk} no longer exists. Restore the trunk branch before updating your stack.`);
    const heads: Record<string, string> = { [state.trunk]: trunk };
    for (const branch of Object.keys(state.branches)) {
      const head = tips.get(branch);
      if (head) heads[branch] = head;
    }
    return heads;
  }
  /** Builds a preview without changing refs or metadata; descendants are ordered parent first. */
  async plan(kind: 'restack' | 'parent' | 'delete', branch: string, parent?: string): Promise<Plan> {
    const state = copy(await this.state());
    const metadata = JSON.stringify(state);
    this.known(state, branch);
    const heads = await this.heads(state);
    if (kind === 'delete') {
      if (!state.branches[branch]) throw new Error('Select a tracked branch to delete.');
      const descendants = this.descendants(state, branch);
      for (const child of this.children(state, branch)) state.branches[child]!.parent = state.branches[branch]!.parent;
      delete state.branches[branch];
      return {
        title: `Delete ${branch}`,
        state,
        metadata,
        heads,
        steps: [...this.rebaseSteps(state, descendants), { kind: 'delete', branch }],
      };
    }
    const descendants = this.descendants(state, branch);
    if (kind === 'parent') {
      if (!parent || !state.branches[branch]) throw new Error('Choose a branch and its new parent.');
      this.known(state, parent);
      if (!heads[parent]) throw new Error(`${parent} no longer exists. Choose an existing parent branch.`);
      if (parent === branch || descendants.includes(parent))
        throw new Error('A branch cannot be parented to itself or its descendants.');
      state.branches[branch]!.parent = parent;
    }
    const branches = kind === 'parent' ? [branch, ...descendants] : descendants;
    return {
      title: kind === 'parent' ? `Move ${branch} onto ${parent}` : `Restack descendants of ${branch}`,
      state,
      metadata,
      heads,
      steps: this.rebaseSteps(state, branches),
    };
  }

  /** Call after fetching; merged must contain only branches verified safe to remove. */
  async syncPlan(remote: string, merged: string[]): Promise<Plan> {
    const state = copy(await this.state());
    const metadata = JSON.stringify(state);
    const heads = await this.heads(state);
    const target = await this.git.oid(`refs/remotes/${remote}/${state.trunk}`);
    if (!(await this.git.ancestor(heads[state.trunk]!, target)))
      throw new Error('Local trunk diverged from the remote. Reconcile it before syncing.');
    const removed = new Set(merged.filter((branch) => !!state.branches[branch]));
    for (const item of Object.values(state.branches)) {
      while (removed.has(item.parent)) item.parent = state.branches[item.parent]!.parent;
    }
    for (const branch of removed) delete state.branches[branch];
    return {
      title: `Sync with ${remote}/${state.trunk}; remove ${removed.size} merged branches`,
      state,
      metadata,
      heads,
      steps: [
        { kind: 'ref', branch: state.trunk, target },
        ...this.rebaseSteps(state, this.descendants(state, state.trunk)),
        ...[...removed].map((branch) => ({ kind: 'delete' as const, branch })),
      ],
    };
  }

  private async snapshot(state: State): Promise<Operation> {
    const heads = await this.heads(state);
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    for (const [branch, oid] of Object.entries(heads))
      await this.git.run('update-ref', `refs/stackhub/recovery/${id}/${branch}`, oid);
    const operation: Operation = {
      id,
      cwd: this.git.cwd,
      original: await this.git.current(),
      before: copy(state),
      after: copy(state),
      heads,
      expected: copy(heads),
      steps: [],
      index: 0,
    };
    await this.save(`recovery-${id}.json`, operation);
    return operation;
  }

  /** Revalidates the preview, saves recovery refs, and journals progress before changing branches. */
  async execute(plan: Plan) {
    return this.exclusive(async () => {
      await this.idle();
      await this.git.clean();
      const state = await this.state();
      if (JSON.stringify(state) !== plan.metadata)
        throw new Error('Stack metadata changed since preview. Preview again.');
      if (JSON.stringify(await this.heads(state)) !== JSON.stringify(plan.heads))
        throw new Error('Branches changed since preview. Preview again.');
      await this.available(plan.steps.map((step) => step.branch));
      for (const step of plan.steps) {
        if (step.kind === 'rebase') {
          await this.verifyBoundary(step.branch, step.base, plan.heads[step.branch]);
          if (await this.git.run('rev-list', '--merges', `${step.base}..refs/heads/${step.branch}`))
            throw new Error(`Merge commits on ${step.branch} are not supported; use a linear branch history.`);
        }
      }
      const operation = await this.snapshot(state);
      operation.after = plan.state;
      operation.steps = plan.steps;
      await this.save('operation.json', operation);
      await this.advance(operation);
    });
  }

  private async verifyBoundary(branch: string, base: string, head?: string) {
    if (!head) throw new Error(`${branch} no longer exists. Delete it from StackHub to update its children.`);
    if (!(await this.git.ancestor(base, head)))
      throw new Error(`${branch} no longer contains its saved boundary. Reconcile its metadata before restacking.`);
  }

  private async finishStep(operation: Operation, step: Step) {
    if (step.kind === 'delete') delete operation.expected[step.branch];
    else operation.expected[step.branch] = await this.git.head(step.branch);
    if (step.kind === 'rebase') operation.after.branches[step.branch]!.base = operation.running!.onto;
    operation.index++;
    delete operation.running;
    await this.save('operation.json', operation);
  }

  private async advance(operation: Operation) {
    while (operation.index < operation.steps.length) {
      const step = operation.steps[operation.index]!;
      if (!operation.running) {
        await this.git.clean();
        const old = operation.expected[step.branch] ?? '';
        const current = (await this.git.succeeds('show-ref', '--verify', `refs/heads/${step.branch}`))
          ? await this.git.head(step.branch)
          : '';
        if (current !== old) throw new Error(`${step.branch} changed outside StackHub. Recovery is paused.`);
        operation.running = {
          old,
          onto: step.kind === 'rebase' ? await this.git.head(step.parent) : step.kind === 'ref' ? step.target : '',
        };
        await this.save('operation.json', operation);
      }
      if (step.kind === 'rebase') {
        try {
          await this.git.run(
            '-c',
            'rebase.updateRefs=false',
            '-c',
            'rebase.autoStash=false',
            'rebase',
            '--onto',
            operation.running.onto,
            step.base,
            step.branch,
          );
        } catch (error) {
          throw new Error(
            `${(error as Error).message}\n${(await this.rebasing()) ? 'Resolve conflicts in Source Control, stage resolutions, then click Continue.' : 'Progress saved. Continue to retry or Cancel to restore your branches.'}`,
          );
        }
      } else {
        if ((await this.git.current().catch(() => '')) === step.branch) await this.git.run('switch', '--detach');
        if (step.kind === 'ref')
          await this.git.run(
            'update-ref',
            `refs/heads/${step.branch}`,
            step.target,
            operation.running.old || '0'.repeat(40),
          );
        else if (operation.running.old)
          await this.git.run('update-ref', '-d', `refs/heads/${step.branch}`, operation.running.old);
      }
      await this.finishStep(operation, step);
    }
    await this.save('state.json', operation.after);
    const parent = operation.before.branches[operation.original]?.parent;
    const destination = (await this.git.succeeds('show-ref', '--verify', `refs/heads/${operation.original}`))
      ? operation.original
      : parent && operation.expected[parent]
        ? parent
        : operation.after.trunk;
    await this.git.run('switch', destination);
    await this.save(`recovery-${operation.id}.json`, operation);
    await unlink(join(this.directory, 'operation.json'));
  }

  /** Resumes a conflict or interrupted update in the worktree where it began. */
  async continue() {
    return this.exclusive(async () => {
      const operation = await this.operation();
      if (!operation) throw new Error('No pending stack update.');
      if (operation.cwd !== this.git.cwd) throw new Error(`Continue in ${operation.cwd}.`);
      await this.available(operation.steps.slice(operation.index).map((step) => step.branch));
      if (operation.running) {
        const step = operation.steps[operation.index]!;
        if (await this.rebasing()) {
          await this.verifyRebase(operation);
          await this.git.run('rebase', '--continue');
          await this.finishStep(operation, step);
        } else {
          const current = (await this.git.succeeds('show-ref', '--verify', `refs/heads/${step.branch}`))
            ? await this.git.head(step.branch)
            : '';
          // Git may have completed before the process saved finishStep().
          if (current !== operation.running.old) {
            const complete =
              step.kind === 'delete'
                ? !current
                : step.kind === 'ref'
                  ? current === operation.running.onto
                  : await this.git.ancestor(operation.running.onto, current);
            if (!complete)
              throw new Error('Branch changed unexpectedly; inspect saved recovery refs before proceeding.');
            await this.finishStep(operation, step);
          }
        }
      }
      await this.advance(operation);
    });
  }

  /** Restores the original refs and metadata, refusing to overwrite later branch changes. */
  async abort() {
    return this.exclusive(async () => {
      const operation = await this.operation();
      if (!operation) throw new Error('No pending stack update.');
      if (operation.cwd !== this.git.cwd) throw new Error(`Abort in ${operation.cwd}.`);
      if (await this.rebasing()) {
        await this.verifyRebase(operation);
        await this.git.run('rebase', '--abort');
      }
      await this.git.clean();
      if (operation.running) {
        const step = operation.steps[operation.index]!;
        const current = (await this.git.succeeds('show-ref', '--verify', `refs/heads/${step.branch}`))
          ? await this.git.head(step.branch)
          : '';
        if (current !== operation.running.old)
          throw new Error(
            'Interrupted step may have completed. Continue once to reconcile before aborting, or inspect recovery refs.',
          );
      }
      await this.restore(operation);
      await unlink(join(this.directory, 'operation.json'));
    });
  }

  private async restore(operation: Operation) {
    const names = [...new Set([...Object.keys(operation.heads), ...Object.keys(operation.expected)])];
    await this.available(names);
    for (const branch of names) {
      const current = (await this.git.succeeds('show-ref', '--verify', `refs/heads/${branch}`))
        ? await this.git.head(branch)
        : undefined;
      if (current !== operation.expected[branch])
        throw new Error(
          `${branch} changed after this operation. Restore manually from refs/stackhub/recovery/${operation.id}/ to preserve later work.`,
        );
    }
    await this.git.run('switch', '--detach');
    const updates = names.map((branch) =>
      operation.heads[branch]
        ? `update refs/heads/${branch} ${operation.heads[branch]} ${operation.expected[branch] || '0'.repeat(operation.heads[branch]!.length)}`
        : `delete refs/heads/${branch} ${operation.expected[branch]}`,
    );
    await this.git.input(['start', ...updates, 'prepare', 'commit', ''].join('\n'), 'update-ref', '--stdin');
    await this.save('state.json', operation.before);
    await this.git.run('switch', operation.original);
  }

  async fetch(remote: string) {
    await this.git.run('fetch', '--prune', '--', remote);
  }

  /** Pushes atomically with explicit leases; non-fast-forward updates require a known remote tip. */
  async push(branches: string[], remote: string) {
    return this.exclusive(async () => {
      if (!branches.length) throw new Error('Select at least one branch to push.');
      await this.idle();
      const state = await this.state();
      const local: Record<string, string> = {};
      for (const branch of branches) {
        if (!state.branches[branch]) throw new Error(`Track ${branch} first.`);
        local[branch] = await this.git.head(branch);
        if (state.branches[branch]!.base !== (await this.git.head(state.branches[branch]!.parent)))
          throw new Error(`Restack ${branch} before pushing.`);
        await this.verifyBoundary(branch, state.branches[branch]!.base, local[branch]);
      }
      const refs = await this.git.run(
        'ls-remote',
        '--heads',
        '--',
        remote,
        ...branches.map((branch) => `refs/heads/${branch}`),
      );
      const tips = new Map(
        refs
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [oid, ref] = line.split(/\s+/);
            return [ref!, oid!] as const;
          }),
      );
      const leases: string[] = [];
      for (const branch of branches) {
        const actual = tips.get(`refs/heads/${branch}`) ?? '';
        if (
          actual &&
          actual !== local[branch] &&
          !(await this.git.ancestor(actual, local[branch]!)) &&
          state.branches[branch]!.published !== actual
        )
          throw new Error(
            `${branch} diverged remotely. Fetch and reconcile it before pushing; StackHub will not overwrite an unknown remote tip.`,
          );
        leases.push(`--force-with-lease=refs/heads/${branch}:${actual}`);
      }
      await this.git.run(
        'push',
        '--atomic',
        ...leases,
        '--',
        remote,
        ...branches.map((branch) => `${local[branch]}:refs/heads/${branch}`),
      );
      for (const branch of branches) state.branches[branch]!.published = local[branch]!;
      await this.save('state.json', state);
    });
  }
}
