import { isAbsolute } from 'node:path';
import { Operation, State, Step } from './types';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function branch(value: unknown): string {
  check(
    typeof value === 'string' &&
      value.length > 0 &&
      !value.startsWith('-') &&
      value !== 'HEAD' &&
      !(value in Object.prototype) &&
      !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
      !value.includes('..') &&
      !value.includes('@{') &&
      !value.endsWith('.') &&
      value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock')),
    'Invalid or reserved branch name.',
  );
  return value;
}

function oid(value: unknown): string {
  check(typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value), 'Invalid commit ID.');
  return value;
}

/** Validates persisted relationships before graph traversal or Git mutation. */
export function parseState(value: unknown): State {
  const data = object(value, 'State');
  check(data.version === 1, 'Unsupported metadata version.');
  const state: State = { version: 1, trunk: branch(data.trunk), branches: {} };
  for (const [name, value] of Object.entries(object(data.branches, 'Branches'))) {
    branch(name);
    check(name !== state.trunk, 'The trunk cannot also be a tracked branch.');
    const item = object(value, `Branch ${name}`);
    state.branches[name] = { parent: branch(item.parent), base: oid(item.base) };
    if (item.published !== undefined) state.branches[name]!.published = oid(item.published);
  }
  const visited = new Set([state.trunk]);
  for (const name of Object.keys(state.branches)) {
    const path = new Set<string>();
    let parent = name;
    while (!visited.has(parent)) {
      check(!path.has(parent), `Parent cycle at ${parent}.`);
      check(Object.hasOwn(state.branches, parent), `Missing parent ${parent}.`);
      path.add(parent);
      parent = state.branches[parent]!.parent;
    }
    for (const name of path) visited.add(name);
  }
  return state;
}

function tips(value: unknown, state: State): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value, 'Branch tips')).map(([name, value]) => {
      branch(name);
      check(name === state.trunk || Object.hasOwn(state.branches, name), `Unknown branch tip ${name}.`);
      return [name, oid(value)];
    }),
  );
}

/** Checks journal invariants without assuming whether the last Git command finished before a crash. */
export function parseOperation(value: unknown): Operation {
  const data = object(value, 'Operation');
  check(typeof data.id === 'string' && /^\d+-[0-9a-f]{8}$/.test(data.id), 'Invalid recovery ID.');
  check(typeof data.cwd === 'string' && isAbsolute(data.cwd), 'Invalid operation worktree.');
  const before = parseState(data.before),
    after = parseState(data.after),
    heads = tips(data.heads, before),
    expected = tips(data.expected, before);
  check(before.trunk === after.trunk && heads[before.trunk], 'Invalid operation trunk.');
  check(
    Object.keys(after.branches).every((name) => Object.hasOwn(before.branches, name)),
    'Unexpected new branch.',
  );
  check(Array.isArray(data.steps), 'Steps must be an array.');
  const seen = new Set<string>();
  const steps: Step[] = data.steps.map((value) => {
    const step = object(value, 'Step'),
      name = branch(step.branch);
    check(!seen.has(name), `Repeated step for ${name}.`);
    seen.add(name);
    if (step.kind === 'ref') {
      check(name === before.trunk, 'Only the trunk may have a ref step.');
      return { kind: 'ref', branch: name, target: oid(step.target) };
    }
    check(Object.hasOwn(before.branches, name), `Unknown step branch ${name}.`);
    if (step.kind === 'delete') {
      check(!Object.hasOwn(after.branches, name), `Deleted branch ${name} remains tracked.`);
      return { kind: 'delete', branch: name };
    }
    check(step.kind === 'rebase', 'Unknown step kind.');
    check(heads[name] && after.branches[name]?.parent === step.parent, `Invalid rebase parent for ${name}.`);
    check(step.base === before.branches[name]!.base, `Invalid rebase boundary for ${name}.`);
    return { kind: 'rebase', branch: name, parent: branch(step.parent), base: oid(step.base) };
  });
  check(
    typeof data.index === 'number' && Number.isInteger(data.index) && data.index >= 0 && data.index <= steps.length,
    'Invalid step index.',
  );
  const completed = new Map(steps.slice(0, data.index).map((step) => [step.branch, step]));
  const positions = new Map(steps.map((step, index) => [step.branch, index]));
  for (const [name, item] of Object.entries(before.branches)) {
    const next = after.branches[name],
      position = positions.get(name);
    const step = position === undefined ? undefined : steps[position];
    check(next || step?.kind === 'delete', `Missing deletion step for ${name}.`);
    if (!next) continue;
    check(next.published === item.published, `Unexpected published tip change for ${name}.`);
    check(next.parent === item.parent || step?.kind === 'rebase', `Missing rebase step for ${name}.`);
    check(next.base === item.base || completed.get(name)?.kind === 'rebase', `Unexpected boundary change for ${name}.`);
    if (step?.kind === 'rebase') {
      const parentPosition = positions.get(step.parent);
      check(parentPosition === undefined || parentPosition < position!, `Rebase parent follows ${name}.`);
    }
  }
  for (const name of new Set([...Object.keys(heads), ...Object.keys(expected)])) {
    const step = completed.get(name);
    check(
      step?.kind === 'delete'
        ? expected[name] === undefined
        : step?.kind === 'ref'
          ? expected[name] === step.target
          : step?.kind === 'rebase'
            ? !!expected[name]
            : expected[name] === heads[name],
      `Inconsistent saved tip for ${name}.`,
    );
  }
  const operation: Operation = {
    id: data.id,
    cwd: data.cwd,
    original: branch(data.original),
    before,
    after,
    heads,
    expected,
    steps,
    index: data.index,
  };
  if (data.running !== undefined) {
    const running = object(data.running, 'Running step'),
      step = steps[data.index];
    check(step, 'A completed operation cannot have a running step.');
    const old = expected[step.branch] ?? '';
    check(running.old === old, 'Running step does not match its saved tip.');
    const onto = step.kind === 'delete' ? '' : oid(running.onto);
    check(running.onto === onto && (step.kind !== 'ref' || onto === step.target), 'Invalid running target.');
    operation.running = { old, onto };
  }
  return operation;
}
