import { StackEngine } from '../engine/stack';
import { State } from '../engine/types';

import type { BranchView, FileView, ViewState } from './protocol';

export async function readFiles(engine: StackEngine): Promise<FileView[]> {
  return (await engine.git.status()).map(({ path, index, worktree }) => {
    const conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(index + worktree);
    return {
      path,
      staged: !conflict && index !== ' ' && index !== '?',
      unstaged: conflict || worktree !== ' ' || index === '?',
      status: conflict ? '!' : index === '?' ? 'U' : worktree.trim() || index,
    };
  });
}

/** Compare against the saved parent boundary, even when that parent has since moved. */
export async function readDetail(
  engine: StackEngine,
  state: State,
  branch?: string,
  head?: string,
): Promise<ViewState['detail']> {
  const base = branch && state.branches[branch]?.base;
  if (!base || !branch) return;
  head ??= await engine.git.head(branch).catch(() => '');
  if (!head)
    return {
      branch,
      head,
      base,
      files: [],
      error: 'This branch no longer exists. Delete it from StackHub to update its children.',
    };
  try {
    return { branch, head, base, files: await engine.git.changes(base, head) };
  } catch (error) {
    return { branch, head, base, files: [], error: (error as Error).message };
  }
}

export async function readView(
  engine?: StackEngine,
  selected?: string,
  previous?: ViewState,
  metadata?: State,
): Promise<ViewState> {
  const empty: ViewState = { initialized: false, current: '', branches: [], files: [] };
  if (!engine) return empty;
  empty.repository = engine.git.cwd.split(/[\\/]/).pop();
  if (!metadata && !(await engine.initialized())) return empty;
  const state = metadata ?? (await engine.state());
  const [current, rawRefs, files, op] = await Promise.all([
    engine.git.current().catch(() => ''),
    engine.git.raw('for-each-ref', '--format=%(refname:strip=2)%00%(objectname)%00%(committerdate:unix)', 'refs/heads'),
    readFiles(engine),
    engine.operation(),
  ]);
  const refs = new Map(
    rawRefs
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, head, timestamp] = line.split('\0');
        return [name!, { head: head!, updatedAt: timestamp ? Number(timestamp) : undefined }] as const;
      }),
  );
  const branches: BranchView[] = [];
  // Postorder puts every child above its parent, matching a stack read from top to trunk.
  const visit = (name: string) => {
    for (const child of engine.children(state, name)) visit(child);
    const meta = state.branches[name],
      ref = refs.get(name);
    branches.push({
      name,
      head: ref?.head ?? '',
      base: meta?.base,
      parent: meta?.parent,
      updatedAt: ref?.updatedAt,
      current: current === name,
      stale: !!meta && meta.base !== refs.get(meta.parent)?.head,
    });
  };
  visit(state.trunk);
  const focused = branches.find((branch) => branch.name === selected);
  // A cached diff is valid only while both immutable commit boundaries match.
  const detail =
    selected &&
    previous?.detail?.branch === selected &&
    !previous.detail.error &&
    focused?.head === previous.detail.head &&
    focused?.base === previous.detail.base
      ? previous.detail
      : await readDetail(engine, state, selected, focused?.head);
  return {
    repository: empty.repository,
    initialized: true,
    current,
    trunk: state.trunk,
    branches,
    files,
    detail,
    conflict: op
      ? {
          branch: op.steps[op.index]?.branch ?? '',
          progress: `${Math.min(op.index + 1, op.steps.length)}/${op.steps.length}`,
          files: files.filter((file) => file.status === '!').map((file) => file.path),
        }
      : undefined,
  };
}
