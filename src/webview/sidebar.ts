import type { ActionName, HostMessage, ViewState, WebviewMessage } from '../ui/protocol';
import { age, createMarkup, escape, icon } from './render.js';
import type { LocalState } from './render.js';

interface VsCodeApi {
  getState(): unknown;
  setState(state: LocalState): void;
  postMessage(message: WebviewMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const api = acquireVsCodeApi();
const saved: unknown = api.getState();
const record = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {};
// Persist presentation and unfinished input only; repository state always comes from the host.
const local: LocalState = {
  branch: typeof record.branch === 'string' ? record.branch : null,
  message: typeof record.message === 'string' ? record.message : '',
  name: typeof record.name === 'string' ? record.name : '',
  modify: record.modify === true,
  collapsed: record.collapsed === true,
  showName: !!record.name,
  fileView:
    record.fileView === 'full' || record.fileView === 'tree' || record.fileView === 'compact'
      ? record.fileView
      : 'short',
  folded: Array.isArray(record.folded)
    ? record.folded.filter((value): value is string => typeof value === 'string')
    : [],
};
let state: ViewState = { initialized: false, branches: [], files: [], current: '' };
let stateJSON: string | undefined, filesJSON: string | undefined;
// Cover the message round trip, then hand pending checkbox ownership to the host's staging map.
const awaitingStages = new Map<string, boolean>();
const pendingStages = () => new Map([...Object.entries(state.staging || {}), ...awaitingStages]);
const staging = () => !!(awaitingStages.size || Object.keys(state.staging || {}).length);
const readActions = new Set([
  'focus',
  'diff',
  'openFile',
  'openPR',
  'inspect',
  'conflicts',
  'sourceControl',
  'settings',
]);
let dragged: string | null = null,
  composing = false,
  restoreFocus = true;
let lastClick: { branch: string | null; time: number } = { branch: null, time: 0 };
const appElement = document.getElementById('app');
if (!appElement) throw new Error('The sidebar root is missing.');
const app = appElement;
type Control = HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const save = () => api.setState(local);
let markup = createMarkup(state, local, staging);
function canDrop(parent: string | undefined) {
  return !!(
    markup.editable() &&
    dragged &&
    parent &&
    markup.branchByName(parent)?.head &&
    markup.branchByName(dragged)?.parent !== parent &&
    !markup.below(parent, dragged)
  );
}
/** Return true only after rendering; defer replacement during drag, IME input, or an open menu. */
function render() {
  if (dragged || composing || (document.getElementById('branch-menu') && !state.busy && !state.conflict)) return;
  if (state.initialized && local.branch && !markup.branchByName(local.branch)) {
    local.branch = null;
    save();
  }
  const contextBranch = local.branch || state.current;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection =
    focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
      ? ([focused.selectionStart, focused.selectionEnd, focused.selectionDirection] as const)
      : undefined;
  const focusId = focused?.id,
    focusData = focused?.dataset,
    focusFolder = focused?.closest('summary')?.parentElement?.dataset.folder;
  const scrolls: [string, number][] = ['.graph-scroll', '.details', '.files'].map((selector) => [
    selector,
    app.querySelector<HTMLElement>(selector)?.scrollTop || 0,
  ]);
  app.innerHTML = markup.content();
  app.querySelectorAll<HTMLInputElement>('[data-partial]').forEach((el) => (el.indeterminate = true));
  if (!state.initialized)
    app.querySelectorAll<Control>('[data-action]').forEach((el) => {
      if (!['initialize', 'selectRepository', 'refresh', 'settings'].includes(el.dataset.action ?? ''))
        el.disabled = true;
    });
  app.querySelectorAll<Control>('[data-action=submit], [data-action=push], [data-action=pushStack]').forEach((el) => {
    if (!markup.branchByName(el.dataset.branch || contextBranch)?.parent) el.disabled = true;
  });
  app.querySelectorAll<Control>('[data-branch]').forEach((el) => {
    if (
      markup.branchByName(el.dataset.branch)?.head === '' &&
      !['delete', 'openPR', 'toggleDraft'].includes(el.dataset.action ?? '')
    )
      el.disabled = true;
  });
  if (state.conflict)
    app.querySelectorAll<Control>('[data-action], [data-menu]').forEach((el) => {
      if (
        !['continue', 'abort', 'conflicts', 'sourceControl', 'openFile', 'stageAll', 'unstageAll', 'refresh'].includes(
          el.dataset.action ?? '',
        )
      )
        el.disabled = true;
    });
  if (state.busy)
    app.querySelectorAll<Control>('button, input, textarea, select').forEach((el) => (el.disabled = true));
  updateStaging();
  const element = focusFolder
    ? [...app.querySelectorAll<HTMLElement>('[data-folder]')]
        .find((el) => el.dataset.folder === focusFolder)
        ?.querySelector<HTMLElement>('summary')
    : focusId
      ? document.getElementById(focusId)
      : focusData && Object.keys(focusData).length
        ? [...app.querySelectorAll<Control>('button,input')].find((el) =>
            Object.keys(focusData).every((key) => el.dataset[key] === focusData[key]),
          )
        : undefined;
  if (element && !('disabled' in element && element.disabled)) {
    element.focus({ preventScroll: true });
    if (selection && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
      element.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined);
  }
  scrolls.forEach(([selector, top]) => {
    const el = app.querySelector<HTMLElement>(selector);
    if (el) el.scrollTop = top;
  });
  return true;
}
function updateFiles() {
  const tree = app.querySelector<HTMLElement>('.graph');
  if (tree && !!tree.querySelector<HTMLElement>('[data-changes-row]') !== !!state.files.length) {
    const focus = tree.contains(document.activeElement)
      ? document.activeElement?.closest<HTMLElement>('[data-select]')?.dataset.select
      : undefined;
    tree.outerHTML = markup.graph();
    if (focus !== undefined)
      (
        [...app.querySelectorAll<Control>('button[data-select]')].find((el) => el.dataset.select === focus) ||
        app.querySelector<HTMLElement>('[data-toggle-panel]')
      )?.focus({ preventScroll: true });
  }
  const list = app.querySelector<HTMLElement>('.details:not(.branch-details) .files');
  if (list) {
    const top = list.scrollTop,
      focused = document.activeElement instanceof HTMLElement ? document.activeElement : null,
      data = focused && list.contains(focused) ? focused.dataset : undefined,
      folder = focused?.closest('summary')?.parentElement?.dataset.folder;
    list.innerHTML = markup.fileRows();
    list.scrollTop = top;
    updateStaging();
    if (folder)
      [...list.querySelectorAll<HTMLElement>('[data-folder]')]
        .find((el) => el.dataset.folder === folder)
        ?.querySelector<HTMLElement>('summary')
        ?.focus({ preventScroll: true });
    else if (data && Object.keys(data).length)
      [...list.querySelectorAll<Control>('button,input')]
        .find((el) => !el.disabled && Object.keys(data).every((key) => el.dataset[key] === data[key]))
        ?.focus({ preventScroll: true });
  }
  const count = app.querySelector<HTMLElement>('[data-file-count]');
  if (count) {
    count.textContent = String(state.files.length);
    count.hidden = !state.files.length;
  }
  const summary = app.querySelector<HTMLElement>('[data-staged-count]'),
    staged = markup.composerState().staged;
  if (summary) summary.textContent = `${staged} file${staged === 1 ? '' : 's'} staged`;
}
function updateError() {
  const error = app.querySelector<HTMLElement>('[data-error]');
  if (error) {
    error.textContent = state.error || '';
    error.hidden = !state.error;
  }
  const status = app.querySelector<HTMLElement>('footer > span');
  if (status)
    status.innerHTML = `${icon(state.busy ? 'sync' : 'check')}${state.busy ? escape(state.busy) : state.conflict ? 'Resolve conflicts to continue' : state.error ? 'Action failed' : 'Ready'}`;
}
function updateStaging() {
  const pending = pendingStages(),
    files = new Map(state.files.map((f) => [f.path, f]));
  app.querySelectorAll<Control>('[data-staging-disabled]').forEach((el) => {
    el.disabled = el.dataset.stagingDisabled === 'true';
    delete el.dataset.stagingDisabled;
  });
  app
    .querySelectorAll<Control>('[data-action=stageAll]')
    .forEach((el) => (el.disabled = !!state.busy || !state.files.some((f) => f.unstaged)));
  app
    .querySelectorAll<Control>('[data-action=unstageAll]')
    .forEach((el) => (el.disabled = !!state.busy || !state.files.some((f) => f.staged)));
  app
    .querySelectorAll<Control>('[data-action=discard], [data-action=discardAll]')
    .forEach(
      (el) =>
        (el.disabled =
          !markup.available() || (el.dataset.action === 'discardAll' && !state.files.some((f) => f.unstaged))),
    );
  app.querySelectorAll<HTMLInputElement>('[data-stage]').forEach((el) => {
    const path = el.dataset.stage;
    if (!path) return;
    const file = files.get(path),
      waiting = pending.has(path);
    el.checked = waiting ? !!pending.get(path) : !!file?.staged;
    el.indeterminate = !waiting && !!(file?.staged && file.unstaged);
    el.disabled = !!state.busy || waiting;
  });
  if (pending.size)
    app
      .querySelectorAll<Control>('[data-action], #modify, #composer button, [data-toggle-name], [data-popup=sync]')
      .forEach((el) => {
        if (!readActions.has(el.dataset.action ?? '')) {
          el.dataset.stagingDisabled = String(el.disabled);
          el.disabled = true;
        }
      });
  app.querySelectorAll<HTMLElement>('[data-row]').forEach((el) => {
    const b = markup.branchByName(el.dataset.row);
    el.draggable = !!b?.parent && !!b.head && markup.editable();
  });
  const submit = app.querySelector<HTMLButtonElement>('#composer button[type=submit]');
  if (submit) submit.disabled = !markup.composerState().ready;
}
function closeMenu() {
  document.getElementById('branch-menu')?.remove();
}
function showMenu(branch: string | undefined, x: number, y: number, type = 'branch') {
  if (
    state.busy ||
    (!state.initialized && type !== 'settings') ||
    (['branch', 'sync'].includes(type) && state.conflict)
  )
    return;
  closeMenu();
  const content = markup.menuContent(branch, type);
  if (!content) return;
  const menu = document.createElement('div');
  menu.id = 'branch-menu';
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  if (branch && type === 'branch') menu.dataset.branch = branch;
  menu.innerHTML = content;
  menu.dataset.popup = type;
  app.append(menu);
  menu.querySelectorAll<Control>('button:not([role])').forEach((el) => el.setAttribute('role', 'menuitem'));
  updateStaging();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
function send(data: WebviewMessage) {
  if (['stageAll', 'unstageAll'].includes(data.action)) {
    const staged = data.action === 'stageAll';
    state.files
      .filter((file) => (staged ? file.unstaged : file.staged))
      .forEach((file) => awaitingStages.set(file.path, staged));
    updateStaging();
  }
  api.postMessage(data);
  closeMenu();
}
app.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const popupButton = event.target.closest<HTMLElement>('[data-popup]');
  if (popupButton && !popupButton.closest('#branch-menu')) {
    const rect = popupButton.getBoundingClientRect();
    showMenu(popupButton.dataset.branch, rect.left, rect.bottom, popupButton.dataset.popup);
    return;
  }
  const setting = event.target.closest<HTMLElement>('[data-setting]');
  if (setting) {
    closeMenu();
    app.querySelector<HTMLElement>('[data-popup=settings]')?.focus();
    send({ action: 'settings', name: setting.dataset.setting, mode: setting.dataset.mode });
    return;
  }
  const fileView = event.target.closest<HTMLElement>('[data-file-view]');
  if (fileView) {
    const mode = fileView.dataset.fileView;
    if (mode !== 'short' && mode !== 'full' && mode !== 'tree' && mode !== 'compact') return;
    local.fileView = mode;
    closeMenu();
    save();
    render();
    app.querySelector<HTMLElement>('[data-popup=files], [data-popup=changes]')?.focus();
    return;
  }
  const menu = event.target.closest<HTMLElement>('[data-menu]');
  if (menu) {
    const rect = menu.getBoundingClientRect();
    showMenu(menu.dataset.menu, rect.right, rect.bottom);
    return;
  }
  if (event.target.closest<HTMLElement>('[data-toggle-panel]')) {
    closeMenu();
    local.collapsed = !local.collapsed;
    save();
    render();
    return;
  }
  if (event.target.closest<HTMLElement>('[data-toggle-name]')) {
    closeMenu();
    local.showName = !local.showName;
    local.collapsed = false;
    save();
    render();
    document.getElementById('name')?.focus();
    return;
  }
  const action = event.target.closest<HTMLButtonElement>('[data-action]');
  if (action) {
    if (!action.disabled)
      send({
        // These data attributes are produced only by our typed renderer; the host validates every action.
        action: action.dataset.action as ActionName,
        branch: action.dataset.branch,
        path: action.dataset.path,
        mode: action.dataset.mode,
      });
    return;
  }
  const hadMenu = !!document.getElementById('branch-menu');
  closeMenu();
  const select = event.target.closest<HTMLElement>('[data-select]');
  if (select) {
    if (state.busy) return;
    const branch = select.dataset.select || null,
      time = Date.now();
    local.branch = branch;
    save();
    render();
    if (
      branch &&
      lastClick.branch === branch &&
      time - lastClick.time < 400 &&
      markup.editable() &&
      markup.branchByName(branch)?.head
    )
      send({ action: 'checkout', branch });
    else if (!state.busy) send({ action: 'focus', branch: branch || undefined });
    lastClick = { branch, time };
    return;
  }
  if (hadMenu && !event.target.closest<HTMLElement>('input,textarea')) render();
});
app.addEventListener('contextmenu', (event) => {
  if (!(event.target instanceof Element)) return;
  const row = event.target.closest<HTMLElement>('[data-row]');
  if (!row) return;
  event.preventDefault();
  showMenu(row.dataset.row, event.clientX, event.clientY);
});
function endDrag() {
  dragged = null;
  render();
}
app.addEventListener('dragstart', (event) => {
  if (!(event.target instanceof Element)) return;
  const row = event.target.closest<HTMLElement>('[data-row]');
  if (
    !markup.editable() ||
    !markup.branchByName(row?.dataset.row)?.head ||
    !markup.branchByName(row?.dataset.row)?.parent ||
    event.target.closest<HTMLElement>('[data-menu], [data-action]')
  ) {
    event.preventDefault();
    return;
  }
  closeMenu();
  if (!row?.dataset.row || !event.dataTransfer) return;
  const branch = row.dataset.row;
  dragged = branch;
  lastClick = { branch: null, time: 0 };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', branch);
  app.querySelectorAll<HTMLElement>('[data-row]').forEach((el) => {
    if (markup.below(el.dataset.row, branch)) el.classList.add('drag-source');
  });
  const hint = app.querySelector<HTMLElement>('.drag-hint');
  if (!hint) return;
  hint.hidden = false;
  hint.textContent = `Move ${dragged} onto a branch`;
});
app.addEventListener('dragover', (event) => {
  if (!(event.target instanceof Element)) return;
  if (!dragged || !event.dataTransfer) return;
  const branch = dragged;
  const row = event.target.closest<HTMLElement>('[data-row]'),
    parent = row?.dataset.row;
  app.querySelectorAll<HTMLElement>('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  event.dataTransfer.dropEffect = 'none';
  const hint = app.querySelector<HTMLElement>('.drag-hint');
  if (!hint) return;
  if (row && canDrop(parent)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-target');
    const children = state.branches.filter((b) => b.name !== dragged && markup.below(b.name, branch)).length;
    hint.textContent = `Move ${dragged}${children ? ` + ${children} descendant${children === 1 ? '' : 's'}` : ''} onto ${parent}`;
  } else hint.textContent = 'Drop onto a different parent branch';
  const scroll = app.querySelector<HTMLElement>('.graph-scroll');
  if (!scroll) return;
  const rect = scroll.getBoundingClientRect();
  if (event.clientY < rect.top + 24) scroll.scrollTop -= 12;
  if (event.clientY > rect.bottom - 24) scroll.scrollTop += 12;
});
app.addEventListener('drop', (event) => {
  if (!(event.target instanceof Element)) return;
  if (!dragged) return;
  event.preventDefault();
  const branch = dragged,
    parent = event.target.closest<HTMLElement>('[data-row]')?.dataset.row,
    valid = canDrop(parent);
  endDrag();
  if (valid) send({ action: 'changeParent', branch, parent });
});
app.addEventListener('dragend', endDrag);
app.addEventListener(
  'toggle',
  (event) => {
    const folder = event.target;
    if (!(folder instanceof HTMLDetailsElement) || !folder.dataset.folder) return;
    if (!folder.matches('[data-folder]') || local.folded.includes(folder.dataset.folder) === !folder.open) return;
    local.folded = local.folded.filter((path) => path !== folder.dataset.folder);
    if (!folder.open) local.folded.push(folder.dataset.folder);
    save();
  },
  true,
);
app.addEventListener('compositionstart', () => {
  composing = true;
});
app.addEventListener('compositionend', (event) => {
  composing = false;
  const target = event.target;
  if (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
    (target.id === 'message' || target.id === 'name')
  ) {
    local[target.id] = target.value;
    save();
  }
  setTimeout(render, 0);
});
app.addEventListener('input', (event) => {
  const el = event.target;
  if (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    (el.id === 'message' || el.id === 'name')
  ) {
    local[el.id] = el.value;
    save();
    const submit = app.querySelector<HTMLButtonElement>('#composer button[type=submit]');
    if (submit) submit.disabled = !markup.composerState().ready;
  }
});
app.addEventListener('change', (event) => {
  const el = event.target;
  if (!(el instanceof HTMLInputElement)) return;
  if (el.dataset.stage && state.initialized && !state.busy && !pendingStages().has(el.dataset.stage)) {
    const staged = el.checked;
    awaitingStages.set(el.dataset.stage, staged);
    updateStaging();
    send({ action: 'stage', path: el.dataset.stage, staged });
  }
  if (el.id === 'modify') {
    local.modify = el.checked;
    save();
    render();
  }
});
app.addEventListener('submit', (event) => {
  event.preventDefault();
  const { ready, mode } = markup.composerState();
  if (ready) send({ action: 'compose', mode, message: local.message, name: local.name });
});
window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  if (event.data.type === 'state') {
    // File-only updates avoid rebuilding the graph and composer on every staging click.
    const { staging: _staging, files: _files, error: _error, ...renderState } = event.data.state;
    const nextJSON = JSON.stringify(renderState),
      errorChanged = state.error !== _error;
    if (state.repository !== renderState.repository || !renderState.initialized || renderState.busy)
      awaitingStages.clear();
    state = event.data.state;
    markup = createMarkup(state, local, staging);
    for (const path of awaitingStages.keys()) if (Object.hasOwn(state.staging || {}, path)) awaitingStages.delete(path);
    const nextFilesJSON = JSON.stringify(state.files);
    if (nextJSON !== stateJSON) {
      if (render()) {
        stateJSON = nextJSON;
        filesJSON = nextFilesJSON;
      }
    } else {
      if (nextFilesJSON !== filesJSON) {
        updateFiles();
        filesJSON = nextFilesJSON;
      }
      if (errorChanged) updateError();
    }
    updateStaging();
    app.querySelectorAll<HTMLElement>('[data-age]').forEach((el) => {
      el.textContent = age(Number(el.dataset.age));
    });
    if (restoreFocus && state.initialized) {
      restoreFocus = false;
      if (local.branch) send({ action: 'focus', branch: local.branch });
    }
  }
  if (event.data.type === 'stageRejected') {
    event.data.path ? awaitingStages.delete(event.data.path) : awaitingStages.clear();
    updateStaging();
  }
  if (event.data.type === 'focus') {
    local.branch = event.data.branch || null;
    save();
    if (!local.branch || markup.branchByName(local.branch)) render();
  }
  if (event.data.type === 'committed') {
    local.message = '';
    local.name = '';
    local.modify = false;
    save();
    render();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const menu = document.getElementById('branch-menu'),
      branch = menu?.dataset.branch,
      popupName = menu?.dataset.popup;
    closeMenu();
    endDrag();
    const buttons = [...app.querySelectorAll<HTMLElement>('[data-menu], [data-popup]')];
    buttons.find((el) => (branch ? el.dataset.menu === branch : el.dataset.popup === popupName))?.focus();
  }
  const menu = document.getElementById('branch-menu');
  if (menu && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    const items = [...menu.querySelectorAll<Control>('button:not(:disabled)')],
      index = items.findIndex((item) => item === document.activeElement);
    if (items.length) items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
});
send({ action: 'ready' });
