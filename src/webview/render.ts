import type { ActionName, BranchView, PullRequestView, ViewState } from '../ui/protocol';

const fileViews = {
  short: 'Short file names',
  full: 'Full file paths',
  tree: 'Tree',
  compact: 'One-letter directories',
};
type FileViewMode = keyof typeof fileViews;
export interface LocalState {
  branch: string | null;
  message: string;
  name: string;
  modify: boolean;
  collapsed: boolean;
  showName: boolean;
  fileView: FileViewMode;
  folded: string[];
}
const reviewLabels: Record<string, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVIEW_REQUIRED: 'Review required',
};
export const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
const paths = {
  sync: '<path d="M13 5A5.5 5.5 0 0 0 3 4L1 6m0-4v4h4M3 11a5.5 5.5 0 0 0 10 1l2-2m0 4v-4h-4"/>',
  upload: '<path d="M8 11V1m-4 4 4-4 4 4M2 10v4h12v-4"/>',
  cloud: '<path d="M4 11a3 3 0 1 1 0-6 4 4 0 0 1 8-1 3.5 3.5 0 0 1 0 7M8 8v7m-3-3 3 3 3-3"/>',
  more: '<circle cx="3" cy="8" r=".7"/><circle cx="8" cy="8" r=".7"/><circle cx="13" cy="8" r=".7"/>',
  settings:
    '<path d="m6 1-.5 2-1.7 1L2 3.5.5 6l1.5 1.5v1L.5 10 2 12.5l1.8-.5 1.7 1L6 15h3l.5-2 1.7-1 1.8.5 1.5-2.5L13 8.5v-1L14.5 6 13 3.5l-1.8.5-1.7-1L9 1Z"/><circle cx="7.5" cy="8" r="2.5"/>',
  trash: '<path d="M2 4h12M6 4V2h4v2M4 4l.5 10h7L12 4M6.5 6v6M9.5 6v6"/>',
  check: '<path d="m3 8 3 3 7-7"/>',
  added: '<rect x="2.5" y="2.5" width="11" height="11"/><path d="M8 5v6M5 8h6"/>',
  removed: '<rect x="2.5" y="2.5" width="11" height="11"/><path d="M5 8h6"/>',
  modified: '<path d="m3 11 7-7 3 3-7 7H3Z M9 5l3 3"/>',
  folder: '<path d="M1 4V2h5l2 2h7v10H1Z"/>',
  up: '<path d="m4 10 4-4 4 4"/>',
  pr: '<circle cx="8" cy="8" r="5"/>',
  down: '<path d="m4 6 4 4 4-4"/>',
  file: '<path d="M4 1h5l4 4v10H4zM9 1v4h4"/>',
};
export const icon = (name: keyof typeof paths) =>
  `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true">${paths[name]}</svg>`;
const button = (
  action: ActionName,
  label: string,
  symbol: keyof typeof paths | null,
  branch?: string | null,
  cls = '',
) =>
  `<button type="button" class="${cls}" data-action="${action}" ${branch ? `data-branch="${escape(branch)}"` : ''} title="${escape(label)}" aria-label="${escape(label)}">${symbol ? icon(symbol) : ''}${cls.includes('icon-only') ? '' : escape(label)}</button>`;
const menuItem = (action: ActionName, label: string, branch?: string) =>
  button(action, label, null, branch, 'menu-item');
const popup = (name: string, label: string, symbol: keyof typeof paths = 'more', branch?: string) =>
  `<button class="icon-only" data-popup="${name}" ${branch ? `data-branch="${escape(branch)}"` : ''} title="${label}" aria-label="${label}">${icon(symbol)}</button>`;
export function age(timestamp?: number) {
  if (!timestamp) return '';
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  return seconds < 60
    ? 'now'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h`
        : `${Math.floor(seconds / 86400)}d`;
}

/** Pure markup and derived UI state. DOM updates and event handling live in sidebar.ts. */
export function createMarkup(state: ViewState, local: LocalState, staging: () => boolean) {
  const available = () => state.initialized && !state.busy && !state.conflict;
  const editable = () => available() && !staging();
  const branchByName = (name: string | null | undefined) => state.branches.find((b) => b.name === name);
  function below(name: string | undefined, ancestor: string | undefined) {
    while (name) {
      if (name === ancestor) return true;
      name = branchByName(name)?.parent;
    }
    return false;
  }
  function prLabel(pr: PullRequestView) {
    return pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.isDraft ? 'Draft' : 'Open';
  }
  function checksLabel(pr: PullRequestView) {
    const checks = pr.statusCheckRollup || [];
    if (!checks.length) return 'No checks';
    if (
      checks.some((c) =>
        ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(
          c.conclusion || c.state || '',
        ),
      )
    )
      return 'Checks failed';
    if (checks.some((c) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion || c.state || '')))
      return 'Checks pending';
    return 'Checks passed';
  }
  function submitCount(branch: string) {
    return state.branches.filter((b) => b.parent && (below(b.name, branch) || below(branch, b.name))).length;
  }
  const fileIcons: Record<string, keyof typeof paths> = { A: 'added', U: 'added', D: 'removed', M: 'modified' };
  const fileIcon = (status: string) => icon(fileIcons[status] ?? 'file');
  const branchLabel = (b: BranchView) => (state.branchLabel === 'pr' ? state.prs?.[b.name]?.title || b.name : b.name);
  function prActions(b: BranchView) {
    if (!b.parent) return '';
    const pr = state.prs?.[b.name];
    const status = pr
      ? button(
          'openPR',
          `#${pr.number} · ${prLabel(pr)}`,
          'pr',
          b.name,
          `icon-only pr-status ${prLabel(pr).toLowerCase()}`,
        )
      : '';
    if (b.current)
      return `${status}${button('submit', `Submit ${submitCount(b.name)} PR${submitCount(b.name) === 1 ? '' : 's'}`, null, b.name, 'submit-stack')}`;
    return `${status}${!pr || pr.state !== 'OPEN' || pr.headRefOid !== b.head || pr.baseRefName !== b.parent ? `<button class="icon-only submit-branch" data-action="submit" data-mode="branch" data-branch="${escape(b.name)}" title="${pr?.state === 'OPEN' ? 'Update pull request' : state.defaultDraft === false ? 'Publish pull request' : 'Submit branch as draft'}" aria-label="Submit ${escape(b.name)}">${icon('upload')}</button>` : ''}`;
  }
  /** Draw the host's child-before-parent ordering; local changes get a separate temporary tip. */
  function graph() {
    const branches = state.branches,
      current = branches.find((b) => b.current),
      hasChanges = state.files.length > 0,
      lanes = new Map<string, number>();
    let next = 0;
    function assign(name: string, lane: number) {
      lanes.set(name, lane);
      // Local changes are the current branch's temporary tip; descendants pass beside it.
      branches
        .filter((b) => b.parent === name)
        .forEach((b, i) => assign(b.name, (hasChanges && name === current?.name) || i ? ++next : lane));
    }
    if (state.trunk) assign(state.trunk, 0);
    const entries: (BranchView | null)[] = [...branches];
    if (hasChanges) entries.splice(current ? branches.indexOf(current) : 0, 0, null);
    const width = 22 + next * 10,
      y = (b: BranchView | null) => entries.indexOf(b) * 24 + 12;
    const x = (b: BranchView | undefined) => 11 + (lanes.get(b?.name ?? '') || 0) * 10;
    const lines = branches
      .filter((b) => b.parent)
      .map((b) => {
        const parent = branchByName(b.parent);
        if (!parent) return '';
        return `<path d="M${x(b)},${y(b)} V${y(parent) - 10} Q${x(b)},${y(parent)} ${x(parent)},${y(parent)}"/>`;
      })
      .join('');
    const working =
      hasChanges && current ? `<path class="changes-edge" d="M${x(current)},${y(null)} V${y(current)}"/>` : '';
    const currentArrow = current ? `<path class="current-arrow" d="M-2,${y(current) - 4} l5,4 -5,4Z"/>` : '';
    const nodes =
      branches
        .map(
          (b) =>
            `<circle class="${b.current ? 'current-node' : ''}" cx="${x(b)}" cy="${y(b)}" r="${b.current ? 4 : 3}"/>`,
        )
        .join('') + (hasChanges ? `<circle class="changes-node" cx="${x(current)}" cy="${y(null)}" r="3"/>` : '');
    const railSpace = `<span class="rail-space"><svg width="${width}" height="1"></svg></span>`;
    const rows = entries.map((b) =>
      b
        ? `<div class="stack-row ${b.current ? 'current' : ''} ${local.branch === b.name ? 'selected' : ''}" role="listitem" data-row="${escape(b.name)}" data-select="${escape(b.name)}" draggable="${!!b.parent && !!b.head && editable()}">${railSpace}<button class="row-label" data-select="${escape(b.name)}" title="${escape(b.name)} · ${b.current ? 'Checked out' : 'Double-click to check out'}${b.parent ? ' · Drag onto a new parent' : ''}">${escape(branchLabel(b))}</button>${!b.head ? '<span class="badge warning">Missing</span>' : b.stale ? '<span class="badge warning" title="The parent changed. Restack this branch.">Needs restack</span>' : ''}${prActions(b)}<span class="branch-age" data-age="${b.updatedAt || ''}" title="Last commit">${age(b.updatedAt)}</span><button class="icon-only row-action" data-menu="${escape(b.name)}" aria-label="Actions for ${escape(b.name)}">${icon('more')}</button></div>`
        : `<div class="stack-row changes-row ${local.branch === null ? 'selected' : ''}" role="listitem" data-changes-row data-select="">${railSpace}<button class="row-label" data-select="" aria-pressed="${local.branch === null}" title="Local working tree changes${state.current ? ' · Checked out: ' + escape(state.current) : ''}">Uncommitted changes</button><span class="count" data-file-count ${state.files.length ? '' : 'hidden'}>${state.files.length}</span></div>`,
    );
    return `<div class="graph" role="list" aria-label="Branch stack"><svg class="rails" width="${width}" height="${entries.length * 24}" aria-hidden="true">${lines}${working}${currentArrow}${nodes}</svg>${rows.join('')}</div>`;
  }
  function composerState() {
    const staged = state.files.filter((f) => f.staged).length,
      branch = branchByName(state.current);
    const modify = local.modify && branch?.parent,
      amend = modify && state.modifyBehavior !== 'commit' && !!branch.head && branch.head !== branch.base;
    const untracked = state.current && !branch;
    const ready = !!(editable() && branch && staged && (local.message.trim() || amend));
    return { staged, branch, modify, amend, untracked, ready, mode: modify ? (amend ? 'amend' : 'commit') : 'create' };
  }
  function fileLabel(path: string) {
    const parts = path.split('/');
    return local.fileView === 'full'
      ? path
      : local.fileView === 'compact'
        ? parts.map((part, i) => (i === parts.length - 1 ? part : part[0])).join('/')
        : parts.at(-1);
  }
  function fileList<T extends { path: string }>(files: T[], row: (file: T) => string) {
    if (local.fileView !== 'tree') return files.map(row).join('');
    type Folder = { folders: Map<string, Folder>; files: T[] };
    const root: Folder = { folders: new Map(), files: [] };
    for (const file of files) {
      let node = root;
      for (const part of file.path.split('/').slice(0, -1)) {
        if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
        node = node.folders.get(part)!;
      }
      node.files.push(file);
    }
    function folder(node: Folder, prefix = ''): string {
      return (
        [...node.folders]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, child]) => {
            const path = prefix + name;
            return `<details class="file-folder" data-folder="${escape(path)}" ${local.folded.includes(path) ? '' : 'open'}><summary>${icon('down')}${icon('folder')}<span>${escape(name)}</span></summary><div class="folder-body">${folder(child, path + '/')}</div></details>`;
          })
          .join('') + node.files.map(row).join('')
      );
    }
    return folder(root);
  }
  function fileRows() {
    return state.files.length
      ? fileList(
          state.files,
          (f) =>
            `<div class="file-row status-${escape(f.status)}"><input type="checkbox" aria-label="Stage ${escape(f.path)}" data-stage="${escape(f.path)}" ${f.staged ? 'checked' : ''} ${f.staged && f.unstaged ? 'data-partial' : ''} ${state.busy ? 'disabled' : ''}><button class="file-name" data-action="openFile" data-path="${escape(f.path)}" title="Open diff: ${escape(f.path)}">${fileIcon(f.status)}<span>${escape(fileLabel(f.path))}</span></button>${f.staged && f.unstaged ? '<span class="file-status" title="This file has both staged and unstaged changes">Partial</span>' : f.status === '!' ? '<span class="file-status">Conflict</span>' : ''}<span class="file-actions"><button class="icon-only" data-action="openFile" data-path="${escape(f.path)}" aria-label="View changes in ${escape(f.path)}">${icon('file')}</button>${f.unstaged && f.status !== '!' ? `<button class="icon-only" data-action="discard" data-path="${escape(f.path)}" aria-label="Discard unstaged changes in ${escape(f.path)}">${icon('trash')}</button>` : ''}</span></div>`,
        )
      : '<p class="empty">No uncommitted changes.</p>';
  }
  function changes() {
    const { staged, branch, modify, amend, untracked, ready, mode } = composerState();
    return `<section class="details ${local.collapsed ? 'collapsed' : ''}" aria-label="Uncommitted changes">${panelHeading('UNCOMMITTED CHANGES')}
    <div class="panel-body"><div class="staging-toolbar"><span data-staged-count>${staged} file${staged === 1 ? '' : 's'} staged</span><div>${button('stageAll', 'Stage all', null, null, 'text-action')}${button('unstageAll', 'Unstage all', null, null, 'text-action')}${button('discardAll', 'Discard all unstaged changes', 'trash', null, 'icon-only')}</div></div>
    ${untracked ? `<div class="notice">${escape(state.current)} isn’t in a stack yet.${button('track', 'Track this branch', 'cloud', state.current)}</div>` : ''}
    <div class="files">${fileRows()}</div>
    <form id="composer">${branch?.parent ? `<div class="composer-meta"><label title="Modify ${escape(state.current)}"><input id="modify" type="checkbox" ${modify ? 'checked' : ''} ${!available() ? 'disabled' : ''}><span>Modify ${escape(state.current)}</span></label></div>` : ''}
    <label class="sr-only" for="message">Commit message</label><textarea id="message" rows="1" placeholder="${amend ? 'Commit message (optional)' : 'Commit message'}" ${!available() ? 'disabled' : ''}>${escape(local.message)}</textarea>
    ${!modify && local.showName ? `<input id="name" aria-label="New branch name" placeholder="Branch name (from commit message)" value="${escape(local.name)}" ${!available() ? 'disabled' : ''}>` : ''}
    <button type="submit" class="primary" data-mode="${mode}" ${!ready ? 'disabled' : ''}>${modify ? 'Commit to the current branch' : 'Create a new branch'}</button></form></div></section>`;
  }
  function panelHeading(title: string, branch?: string) {
    return `<header class="section-heading"><button class="panel-toggle" data-toggle-panel aria-expanded="${!local.collapsed}">${icon(local.collapsed ? 'up' : 'down')}<span>${escape(title)}</span></button>${popup(branch ? 'files' : 'changes', 'File display options', 'more', branch)}</header>`;
  }
  function branchDetails() {
    const b = branchByName(local.branch);
    if (!b) return '';
    const pr = state.prs?.[b.name],
      detail = state.detail?.branch === b.name ? state.detail : undefined;
    return `<section class="details branch-details ${local.collapsed ? 'collapsed' : ''}" aria-label="Branch details">${panelHeading(b.name, b.name)}<div class="panel-body">
    <div class="branch-caption"><span>${b.parent ? 'Changes in branch' : 'Trunk branch'}</span>${b.current ? `<span class="navigation">${b.parent ? button('down', 'Check out parent', 'down', null, 'icon-only') : ''}${state.branches.some((child) => child.parent === b.name) ? button('up', 'Check out child', 'up', null, 'icon-only') : ''}</span>` : ''}</div>
    ${pr ? `<div class="pr-summary">${button('openPR', `#${pr.number} · ${prLabel(pr)}`, 'pr', b.name, `pr-status ${prLabel(pr).toLowerCase()}`)}<span>${escape(reviewLabels[pr.reviewDecision] || 'Awaiting review')} · ${checksLabel(pr)}</span></div>` : ''}
    ${b.stale ? `<div class="notice">The parent changed.${button('restack', 'Restack from parent', 'sync', b.parent)}</div>` : ''}
    <div class="files">${b.parent ? (!detail ? '<p class="empty">Loading changes…</p>' : detail.error ? `<p class="error">${escape(detail.error)}</p>` : detail.files.length ? fileList(detail.files, ({ path, status, originalPath }) => `<div class="file-row status-${escape(status)}"><button class="file-name" data-action="diff" data-branch="${escape(b.name)}" data-path="${escape(path)}" title="${escape(originalPath ? originalPath + ' → ' + path : path)}">${fileIcon(status)}<span>${escape(fileLabel(path))}</span></button></div>`) : '<p class="empty">No changes against parent.</p>') : '<p class="empty">Create a branch to start a stack.</p>'}</div>
    <div class="branch-actions">${b.parent ? `<button data-action="submit" data-mode="branch" data-branch="${escape(b.name)}" title="Submit this branch and its parents">Submit</button>` : ''}<button class="primary" data-action="checkout" data-branch="${escape(b.name)}" ${b.current ? 'disabled' : ''}>${b.current ? 'Checked out' : 'Check out'}</button></div></div></section>`;
  }

  function content() {
    return `<button class="repo-heading" data-action="selectRepository" title="Switch repository">REPO: <span>${escape(state.repository || 'No repository')}</span></button><div class="toolbar"><div class="split-button"><button data-action="syncMerged" title="Sync and clean merged branches" aria-label="Sync">${icon('sync')}Sync</button>${popup('sync', 'Sync options', 'down')}</div><span class="toolbar-spacer"></span>${button('refresh', 'Refresh', 'sync', null, 'icon-only')}${button('track', 'Track or get branch', 'cloud', null, 'icon-only')}${popup('settings', 'StackHub settings', 'settings')}</div>
    <div class="error" role="alert" data-error ${state.error ? '' : 'hidden'}>${escape(state.error)}</div>
    ${
      !state.initialized
        ? `<section class="welcome"><h2>StackHub</h2><p>${state.repository ? 'Choose your trunk branch to start stacking changes.' : 'Open a Git repository to see your branches here.'}</p>${button(state.repository ? 'initialize' : 'selectRepository', state.repository ? 'Set up repository' : 'Select repository', null, null, 'primary')}</section>`
        : `
    ${state.conflict ? `<section class="conflict" role="status"><strong>${state.conflict.files.length ? 'Resolve conflicts to continue' : 'Finish updating your stack'}</strong><p>${escape(state.conflict.branch)} · ${state.conflict.progress}</p><p>${state.conflict.files.length ? 'Resolve the files in the editor, then stage your changes.' : 'Your progress is saved. Continue when you’re ready.'}</p><div class="action-row">${button('conflicts', 'Open conflicts', null)}${button('continue', 'Continue', null, null, 'primary')}${button('abort', 'Cancel', null)}</div></section>` : ''}
    <div class="graph-scroll">${graph()}${state.branches.length === 1 ? '<p class="empty">Stage your changes below and create your first branch.</p>' : ''}</div><div class="drag-hint" role="status" hidden></div>${local.branch === null ? changes() : branchDetails()}`
    }
    <footer role="status"><span ${state.busy ? 'class="working"' : ''}>${icon(state.busy ? 'sync' : 'check')}${state.busy ? escape(state.busy) : state.conflict ? 'Resolve conflicts to continue' : state.error ? 'Action failed' : 'Ready'}</span>${state.githubError ? `<span class="github-status" title="${escape(state.githubError)}">GitHub unavailable</span>` : ''}</footer>`;
  }
  function menuContent(branch: string | undefined, type: string) {
    if (type === 'sync')
      return `${menuItem('syncMain', 'Sync with main')}${menuItem('syncMerged', 'Sync & clean merged branches')}`;
    else if (type === 'settings') {
      const option = (name: string, mode: string, label: string, selected: boolean) =>
        `<button class="menu-item" data-setting="${name}" data-mode="${mode}" role="menuitemradio" aria-checked="${selected}"><span class="menu-check">${selected ? icon('check') : ''}</span>${label}</button>`;
      return `<div class="menu-heading">Branch labels</div>${option('branchLabel', 'branch', 'Branch name', state.branchLabel !== 'pr')}${option('branchLabel', 'pr', 'PR title', state.branchLabel === 'pr')}<hr><div class="menu-heading">Modify branch</div>${option('modifyBehavior', 'amend', 'Amend last commit', state.modifyBehavior !== 'commit')}${option('modifyBehavior', 'commit', 'Create new commit', state.modifyBehavior === 'commit')}<hr><div class="menu-heading">New pull requests</div>${option('defaultDraft', 'draft', 'Draft', state.defaultDraft !== false)}${option('defaultDraft', 'publish', 'Published', state.defaultDraft === false)}<hr>${menuItem('settings', 'Open editor settings')}`;
    } else if (type === 'changes' || type === 'files') {
      return (
        Object.entries(fileViews)
          .map(
            ([value, label]) =>
              `<button class="menu-item" data-file-view="${value}" role="menuitemradio" aria-checked="${local.fileView === value}"><span class="menu-check">${local.fileView === value ? icon('check') : ''}</span>${label}</button>`,
          )
          .join('') +
        '<hr>' +
        (type === 'changes'
          ? `${menuItem('sourceControl', 'Open Source Control')}<button class="menu-item" data-toggle-name>${local.showName ? 'Hide' : 'Choose'} branch name</button>`
          : menuItem('inspect', 'Inspect commits', branch))
      );
    } else {
      const b = branchByName(branch);
      if (!b) return '';
      const pr = state.prs?.[b.name];
      return `<div class="menu-heading">${escape(branch)}</div>${b.head ? `${!b.current ? menuItem('checkout', 'Check out', branch) : ''}${menuItem('create', 'Create branch above', branch)}${menuItem('restack', 'Restack descendants', branch)}${b.parent ? menuItem('changeParent', 'Change parent…', branch) : ''}<hr>${b.parent ? `${menuItem('submit', 'Submit stack', branch)}${menuItem('push', 'Push branch', branch)}${menuItem('pushStack', 'Push stack', branch)}` : ''}${menuItem('inspect', 'Inspect commits', branch)}` : ''}${pr ? menuItem('openPR', 'Open pull request', branch) : ''}${pr?.state === 'OPEN' ? menuItem('toggleDraft', pr.isDraft ? 'Ready for review' : 'Convert to draft', branch) : ''}${b.parent ? `<hr>${b.head ? menuItem('rename', 'Rename branch', branch) : ''}${menuItem('delete', 'Delete branch', branch)}` : ''}`;
    }
  }
  return {
    content,
    menuContent,
    available,
    editable,
    branchByName,
    below,
    graph,
    composerState,
    fileRows,
  };
}
