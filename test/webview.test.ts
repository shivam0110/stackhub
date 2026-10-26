import assert from 'node:assert/strict';
import test from 'node:test';
import type { ViewState } from '../src/ui/protocol';
import { createMarkup } from '../src/webview/render';
import type { LocalState } from '../src/webview/render';

function fixture() {
  const state: ViewState = {
    initialized: true,
    current: 'main',
    trunk: 'main',
    branches: [
      { name: 'feature', parent: 'main', head: 'feature-tip', base: 'main-tip', current: false, stale: false },
      { name: 'main', head: 'main-tip', current: true, stale: false },
    ],
    files: [{ path: 'new/folder/file.ts', staged: true, unstaged: true, status: 'M' }],
  };
  const local: LocalState = {
    branch: null,
    message: '',
    name: '',
    modify: false,
    collapsed: false,
    showName: false,
    fileView: 'short',
    folded: [],
  };
  return { state, local };
}

test('uncommitted changes occupy their own graph lane and never become a branch parent', () => {
  const { state, local } = fixture();
  const graph = createMarkup(state, local, () => false).graph();
  // The child uses x=21; the current branch and its temporary changes tip use x=11.
  assert.match(graph, /d="M21,12 V50 Q21,60 11,60"/);
  assert.match(graph, /class="changes-edge" d="M11,36 V60"/);
  assert.ok(graph.indexOf('data-row="feature"') < graph.indexOf('data-changes-row'));
  assert.ok(graph.indexOf('data-changes-row') < graph.indexOf('data-row="main"'));
});

test('composer waits for staging and allows a blank message only for a nonempty amend', () => {
  const { state, local } = fixture();
  state.current = 'feature';
  local.modify = true;
  const idle = createMarkup(state, local, () => false);
  assert.equal(idle.composerState().mode, 'amend');
  assert.equal(idle.composerState().ready, true);
  assert.equal(createMarkup(state, local, () => true).composerState().ready, false);
  state.modifyBehavior = 'commit';
  assert.equal(idle.composerState().ready, false);
  local.message = 'Update feature';
  assert.equal(idle.composerState().ready, true);
  state.files = [];
  assert.equal(idle.composerState().ready, false);
});

test('file display preserves partial staging, escaped names and selectable menu modes', () => {
  const { state, local } = fixture();
  state.files[0]!.path = 'new/<file>.ts';
  local.fileView = 'tree';
  const markup = createMarkup(state, local, () => false);
  const files = markup.fileRows();
  assert.match(files, /data-folder="new"/);
  assert.match(files, /data-stage="new\/&lt;file&gt;\.ts" checked data-partial/);
  assert.doesNotMatch(files, /<file>/);
  const menu = markup.menuContent(undefined, 'changes');
  assert.match(menu, /data-file-view="tree" role="menuitemradio" aria-checked="true"/);
  assert.match(menu, /data-toggle-name/);
});
