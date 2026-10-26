export interface BranchView {
  name: string;
  parent?: string;
  current: boolean;
  stale: boolean;
  head: string;
  base?: string;
  updatedAt?: number;
}
/** A partially staged file has both flags set; neither flag replaces Git's index state. */
export interface FileView {
  path: string;
  staged: boolean;
  unstaged: boolean;
  status: string;
}
/** Host-owned repository snapshot sent to the sidebar; `staging` holds pending checkbox targets. */
export interface ViewState {
  repository?: string;
  initialized: boolean;
  current: string;
  trunk?: string;
  branches: BranchView[];
  files: FileView[];
  busy?: string;
  error?: string;
  staging?: Record<string, boolean>;
  detail?: {
    branch: string;
    head: string;
    base: string;
    files: { path: string; status: string; originalPath?: string }[];
    error?: string;
  };
  prs?: Record<string, PullRequestView>;
  githubError?: string;
  modifyBehavior?: 'amend' | 'commit';
  branchLabel?: 'branch' | 'pr';
  defaultDraft?: boolean;
  conflict?: { branch: string; progress: string; files: string[] };
}

/** GitHub fields displayed by the sidebar; host-only merge and repository data stay in the engine. */
export interface PullRequestView {
  number: number;
  state: string;
  isDraft: boolean;
  title?: string;
  headRefOid: string;
  baseRefName: string;
  reviewDecision: string;
  statusCheckRollup: { state?: string; status?: string; conclusion?: string }[] | null;
}
export type ActionName =
  | 'selectRepository'
  | 'initialize'
  | 'refresh'
  | 'focus'
  | 'track'
  | 'checkout'
  | 'create'
  | 'rename'
  | 'delete'
  | 'restack'
  | 'syncMain'
  | 'syncMerged'
  | 'changeParent'
  | 'continue'
  | 'abort'
  | 'conflicts'
  | 'sourceControl'
  | 'push'
  | 'pushStack'
  | 'submit'
  | 'openPR'
  | 'toggleDraft'
  | 'inspect'
  | 'diff'
  | 'compose'
  | 'stage'
  | 'stageAll'
  | 'unstageAll'
  | 'discard'
  | 'discardAll'
  | 'settings'
  | 'openFile'
  | 'up'
  | 'down';
export interface ViewAction {
  action: ActionName;
  branch?: string;
  parent?: string;
  message?: string;
  name?: string;
  mode?: string;
  path?: string;
  staged?: boolean;
}
export type HostMessage =
  | { type: 'state'; state: ViewState }
  | { type: 'committed' }
  | { type: 'stageRejected'; path?: string }
  | { type: 'focus'; branch?: string };
export type WebviewMessage = ViewAction | { action: 'ready' };
