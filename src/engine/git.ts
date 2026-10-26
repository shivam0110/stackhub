import { execFile } from 'node:child_process';

/** Repository-relative paths and Git porcelain XY status; path is the destination for renames. */
export interface GitStatusEntry {
  path: string;
  originalPath?: string;
  index: string;
  worktree: string;
}
/** Tree-to-tree change; originalPath identifies the source of a rename or copy. */
export interface GitChange {
  path: string;
  status: string;
  originalPath?: string;
}

/** Executes native Git without a shell or interactive prompts. */
export class Git {
  constructor(readonly cwd: string) {}

  /** Trims trailing whitespace; use raw() when parsing filenames or NUL-delimited output. */
  async run(...args: string[]): Promise<string> {
    return (await this.raw(...args)).trimEnd();
  }

  raw(...args: string[]): Promise<string> {
    return this.input('', ...args);
  }

  async succeeds(...args: string[]) {
    try {
      await this.run(...args);
      return true;
    } catch {
      return false;
    }
  }

  input(input: string, ...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let inputError: Error | undefined;
      const child = execFile(
        'git',
        args,
        {
          cwd: this.cwd,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
        },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else if (inputError) reject(inputError);
          else resolve(stdout);
        },
      );
      // Wait for Git's result so a closed pipe cannot hide its diagnostic or report failure before it exits.
      child.stdin?.on('error', (error) => {
        inputError = error;
      });
      child.stdin?.end(input || undefined);
    });
  }

  oid(ref: string) {
    return this.run('rev-parse', '--verify', `${ref}^{commit}`);
  }
  head(branch: string) {
    return this.oid(`refs/heads/${branch}`);
  }
  current() {
    return this.run('symbolic-ref', '--quiet', '--short', 'HEAD');
  }
  ancestor(a: string, b: string) {
    return this.succeeds('merge-base', '--is-ancestor', a, b);
  }
  async branches() {
    return (await this.run('for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n').filter(Boolean);
  }
  /** Lists individual untracked files, including files inside new directories. */
  async status(): Promise<GitStatusEntry[]> {
    const tokens = (await this.raw('status', '--porcelain=v1', '--untracked-files=all', '-z')).split('\0');
    const files: GitStatusEntry[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!token) continue;
      const file: GitStatusEntry = { path: token.slice(3), index: token[0]!, worktree: token[1]! };
      // Porcelain -z puts the destination before the source, unlike diff --name-status -z.
      if (/[RC]/.test(token.slice(0, 2))) file.originalPath = tokens[++i]!;
      files.push(file);
    }
    return files;
  }
  async changes(base: string, head: string): Promise<GitChange[]> {
    const tokens = (await this.raw('diff', '--name-status', '--find-renames', '-z', base, head, '--')).split('\0');
    const files: GitChange[] = [];
    for (let i = 0; i < tokens.length;) {
      const status = tokens[i++];
      if (!status) continue;
      const file: GitChange = { path: tokens[i++]!, status: status[0]! };
      if (/^[RC]/.test(status)) {
        file.originalPath = file.path;
        file.path = tokens[i++]!;
      }
      files.push(file);
    }
    return files;
  }
  async clean() {
    if (await this.run('status', '--porcelain'))
      throw new Error('Commit or stash all changes first (including untracked files).');
  }
  async name(name: string) {
    if (
      name.startsWith('-') ||
      name === 'HEAD' ||
      name in Object.prototype ||
      !(await this.succeeds('check-ref-format', '--branch', name))
    )
      throw new Error('Invalid or reserved branch name.');
  }
}
