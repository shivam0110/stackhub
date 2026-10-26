export interface Branch {
  parent: string;
  /** Saved parent commit; only commits after this boundary belong to the branch. */
  base: string;
  /** Last known published tip, used to distinguish our rewrites from remote divergence. */
  published?: string;
}
export interface State {
  version: 1;
  trunk: string;
  branches: Record<string, Branch>;
}
export type Step =
  | { kind: 'rebase'; branch: string; parent: string; base: string }
  | { kind: 'ref'; branch: string; target: string }
  | { kind: 'delete'; branch: string };
/** Persisted progress for a stack update, including the refs needed to cancel it. */
export interface Operation {
  id: string;
  cwd: string;
  original: string;
  before: State;
  after: State;
  /** Original tips retained under refs/stackhub/recovery/<id>/. */
  heads: Record<string, string>;
  /** Tips after completed steps; restoring requires these to remain unchanged. */
  expected: Record<string, string>;
  steps: Step[];
  /** Next unfinished step. */
  index: number;
  /** Written before Git runs so a restart can reconcile an unfinished step. */
  running?: { old: string; onto: string };
}
/** Proposed state and ordered steps, with original metadata and tips checked by execute(). */
export interface Plan {
  title: string;
  state: State;
  metadata: string;
  steps: Step[];
  heads: Record<string, string>;
}
