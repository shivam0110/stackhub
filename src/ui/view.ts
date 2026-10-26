import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ActionName, HostMessage, ViewAction, ViewState } from './protocol';

const actions = [
  'selectRepository',
  'initialize',
  'refresh',
  'focus',
  'track',
  'checkout',
  'create',
  'rename',
  'delete',
  'restack',
  'syncMain',
  'syncMerged',
  'changeParent',
  'continue',
  'abort',
  'conflicts',
  'sourceControl',
  'push',
  'pushStack',
  'submit',
  'openPR',
  'toggleDraft',
  'inspect',
  'diff',
  'compose',
  'stage',
  'stageAll',
  'unstageAll',
  'discard',
  'discardAll',
  'settings',
  'openFile',
  'up',
  'down',
] as const satisfies readonly ActionName[];
/** Check the webview message shape; command handlers and the engine validate its meaning. */
export function validAction(value: unknown): value is ViewAction {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.action === 'string' &&
    actions.some((action) => action === data.action) &&
    ['branch', 'parent', 'message', 'name', 'mode', 'path'].every(
      (key) => data[key] === undefined || typeof data[key] === 'string',
    ) &&
    (data.staged === undefined || typeof data.staged === 'boolean')
  );
}

/** Message bridge only: repository reads and mutations stay in the extension host. */
export class StackView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private state: ViewState = { initialized: false, current: '', branches: [], files: [] };
  constructor(
    private context: vscode.ExtensionContext,
    private dispatch: (action: ViewAction) => Promise<void>,
  ) {}
  get visible() {
    return this.view?.visible ?? false;
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'resources');
    const scripts = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [root, scripts] };
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'sidebar.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'sidebar.js'));
    const nonce = randomBytes(24).toString('base64');
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src ${view.webview.cspSource} 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>StackHub branches</title></head><body><main id="app" aria-label="StackHub"><p class="empty">Loading branches…</p></main><script type="module" nonce="${nonce}" src="${js}"></script></body></html>`;
    const listener = view.webview.onDidReceiveMessage(async (value) => {
      if (value?.action === 'ready') {
        this.update(this.state);
        return;
      }
      if (validAction(value)) await this.dispatch(value);
    });
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) void this.dispatch({ action: 'refresh' });
    });
    view.onDidDispose(() => {
      listener.dispose();
      visibility.dispose();
      if (this.view === view) this.view = undefined;
    });
  }
  private post(message: HostMessage) {
    void this.view?.webview.postMessage(message);
  }
  update(state: ViewState) {
    this.state = state;
    this.post({ type: 'state', state });
  }
  clearComposer() {
    this.post({ type: 'committed' });
  }
  rejectStaging(path?: string) {
    this.post({ type: 'stageRejected', path });
  }
  focusBranch(branch: string) {
    this.post({ type: 'focus', branch });
  }
}
