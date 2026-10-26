import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import type { StackEngine } from '../engine/stack';

export interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    onDidChange: vscode.Event<void>;
    workingTreeChanges: { uri: vscode.Uri }[];
    untrackedChanges: { uri: vscode.Uri }[];
    mergeChanges: { uri: vscode.Uri }[];
  };
  status(): Promise<void>;
  clean(paths: string[]): Promise<void>;
}
interface GitApi {
  repositories: GitRepository[];
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}
interface GitExtension {
  getAPI(version: 1): GitApi;
}

/** The editor owns Git document URIs, native diffs, discarded-file handling and SCM refreshes. */
export class EditorGit {
  private constructor(private readonly api: GitApi) {}

  static async activate(): Promise<EditorGit> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) throw new Error('Enable the editor’s built-in Git extension to use StackHub.');
    return new EditorGit((await extension.activate()).getAPI(1));
  }

  get roots(): string[] {
    return this.api.repositories.map((repository) => repository.rootUri.fsPath);
  }

  async repository(engine?: StackEngine): Promise<GitRepository | undefined> {
    if (!engine) return;
    const root = await realpath(engine.git.cwd);
    for (const repository of this.api.repositories) {
      if ((await realpath(repository.rootUri.fsPath)) === root) return repository;
    }
  }

  uri(uri: vscode.Uri, ref: string): vscode.Uri {
    return this.api.toGitUri(uri, ref);
  }
}
