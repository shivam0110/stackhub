import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StackEngine } from './stack';

const exec = promisify(execFile);
export interface PullRequest {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  title?: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  mergeCommit: { oid: string } | null;
  reviewDecision: string;
  statusCheckRollup: { state?: string; status?: string; conclusion?: string }[] | null;
}
const fields =
  'number,url,state,isDraft,title,headRefOid,headRefName,baseRefName,isCrossRepository,mergeCommit,reviewDecision,statusCheckRollup';

/** GitHub PR operations through gh, scoped to the engine's selected Git remote. */
export class GitHub {
  private repository?: Promise<string>;
  constructor(
    private engine: StackEngine,
    private remote: string,
  ) {}

  private async run(...args: string[]) {
    const repository = await (this.repository ??= this.engine.git.run('remote', 'get-url', this.remote).then((url) => {
      const match = url.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/(.+?)(?:\.git)?$/);
      if (!match) throw new Error('The selected remote must be a GitHub HTTPS or SSH URL.');
      return `${match[1]}/${match[2]}/${match[3]}`;
    }));
    try {
      const { stdout } = await exec('gh', [...args, '--repo', repository], {
        cwd: this.engine.git.cwd,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      });
      return stdout.trim();
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      throw new Error(failure.stderr?.trim() || 'GitHub CLI failed. Install gh and run gh auth login.');
    }
  }

  async get(branch: string): Promise<PullRequest | undefined> {
    const results = JSON.parse(
      await this.run('pr', 'list', '--head', branch, '--state', 'all', '--limit', '100', '--json', fields),
    ) as PullRequest[];
    const prs = results.filter((pr) => !pr.isCrossRepository);
    return prs.find((pr) => pr.state === 'OPEN') ?? prs[0];
  }

  private async pullRequests(branches: string[]) {
    const results: (PullRequest | undefined)[] = [];
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, branches.length) }, async () => {
        while (index < branches.length) {
          const i = index++;
          results[i] = await this.get(branches[i]!);
        }
      }),
    );
    return results;
  }

  async statuses() {
    const branches = Object.keys((await this.engine.state()).branches),
      result: Record<string, PullRequest> = {};
    for (const [index, pr] of (await this.pullRequests(branches)).entries()) if (pr) result[branches[index]!] = pr;
    return result;
  }

  /** Pushes first, then creates or retargets PRs. Retries preserve existing PR content and draft state. */
  async submit(branches: string[], draft: boolean) {
    const state = await this.engine.state();
    // Check GitHub access before pushing; a retry preserves existing PRs.
    const existing = await this.pullRequests(branches);
    await this.engine.push(branches, this.remote);
    for (const [index, branch] of branches.entries()) {
      const parent = state.branches[branch]!.parent;
      const pr = existing[index];
      if (pr?.state === 'OPEN') {
        if (pr.baseRefName !== parent) await this.run('pr', 'edit', String(pr.number), '--base', parent);
      } else {
        const title = await this.engine.git.run('log', '-1', '--format=%s', `refs/heads/${branch}`);
        await this.run(
          'pr',
          'create',
          '--head',
          branch,
          '--base',
          parent,
          '--title',
          title,
          '--body',
          '',
          ...(draft ? ['--draft'] : []),
        );
      }
    }
  }

  ready(number: number, ready: boolean) {
    return this.run('pr', 'ready', String(number), ...(ready ? [] : ['--undo']));
  }

  /** Returns unchanged PR heads whose merge commits are already present in the fetched trunk. */
  async merged() {
    const state = await this.engine.state();
    const result: string[] = [];
    const trunk = await this.engine.git.oid(`refs/remotes/${this.remote}/${state.trunk}`);
    const branches = Object.keys(state.branches),
      prs = await this.pullRequests(branches);
    for (const [index, branch] of branches.entries()) {
      const pr = prs[index];
      // The merge must be in the fetched trunk, with no later local branch work.
      if (
        pr?.state === 'MERGED' &&
        pr.mergeCommit &&
        pr.headRefOid === (await this.engine.git.head(branch)) &&
        (await this.engine.git.ancestor(pr.mergeCommit.oid, trunk))
      )
        result.push(branch);
    }
    return result;
  }
}
