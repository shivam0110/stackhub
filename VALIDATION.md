# StackHub 0.8.0 validation

Checked on 26 October 2026. Repository tests use real Git in disposable repositories. Native checks run the actual extension and the editor's built-in Git integration.

## Reproduce

```sh
npm ci
npm test
node test/run-native.cjs /absolute/path/to/editor-cli
npm run package
```

The native launcher creates a separate repository, bare remote, editor profile and extension directory. It prints the location of `result.json` and `editor.log`. It does not disable workspace trust or touch the user's working repositories. If the editor requests trust, approve only the disposable fixture.

## Results

- **28/28 repository checks passed:** metadata validation, malformed journals, graph/composer rendering, branch creation/tracking, partial staging, nested untracked files, literal pathspec characters, rename staging/unstaging, rename-aware change lists, amend/restack, conflicts, interrupted updates, cancellation, parent changes, merged-parent cleanup and push divergence protections. GitHub adapter checks use simulated `gh` responses and real local Git pushes.
- **12/12 native Cursor checks passed:** extension activation, individual nested-file staging/unstaging, rapid concurrent staging, partial staged/unstaged diff, three stacked branches, renamed-file old/new content, added/deleted empty diff sides, commit inspection, navigation, amend/restack, conflict opening/resolution/Continue, native SCM refresh, and initial/rewritten stack pushes to a local bare remote.
- **Code review:** UI and staging share `Git.status()`; branch lists and diff opening share `Git.changes()`. Branch diffs use the built-in Git filesystem through `toGitUri`. No custom blob/text cache or old change-list shape remains. Split/squash/fold are removed from engine, UI, commands and tests.
- **Build/package:** strict host and browser TypeScript builds, formatting and launcher syntax checks pass. Packaging builds through `vscode:prepublish`; the VSIX contains runtime files and excludes source tests, dependencies and earlier VSIX builds.
- **Structural cleanup:** activation, command handling, refresh/staging coordination and native Git integration have separate modules. The sidebar uses a shared typed protocol and separates rendering from DOM interactions. Invalid metadata fails with its file path before resume/abort and remains untouched. All repository and native checks above were rerun.
- **Rendered sidebar:** loaded the compiled browser modules against a disposable real-Git fixture; clicked staging/unstaging and checked the actual index, then dragged a child onto another parent and verified both the graph and saved relationship.

## Limits

- Native verification was on macOS Cursor 1.128.0. The Devin test instance stopped at workspace trust and is not a passing run. Windows/Linux and the minimum declared VS Code version have not been exercised. The Git URI API used by the extension exists in that declared version.
- Hosted GitHub reads were checked in earlier work; hosted PR creation/editing/draft changes and hosted pushes remain unverified. Current tests use local remotes and simulated GitHub responses.
- The UI follows Graphite's documented everyday extension workflow. Hosted Graphite version history and stack-edit pages are outside scope. Getting a remote branch imports branches absent locally; it does not update an existing local branch. Large branching graphs can scroll horizontally.
- Marketplace publication still needs an owned publisher ID and public repository/issues metadata. Local build and native checks do not establish Marketplace readiness.
- The new Ubuntu CI workflow has not run on GitHub yet.
- `npm audit` reports [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) through the development-only `@vscode/vsce` → `@azure/identity` → `@azure/msal-node` chain (two packages flagged). The current identity release requires MSAL 6.x; the fix starts in 7.1.0, so no compatible update is available. These dependencies are excluded from the VSIX. StackHub has no runtime npm dependencies.

Earlier validation established native drag/drop, reload-and-continue recovery and fast staging after the 0.6.1 refresh refactor. This release retains those paths; historical timing figures are not new 0.8.0 measurements.
