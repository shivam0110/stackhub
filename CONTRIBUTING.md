# Contributing

Use Node.js 24, npm and Git. GitHub CLI authentication is needed only to exercise hosted PR features.

```sh
npm ci
npm test
npm run package
```

Press **F5** in VS Code or a compatible editor to open an extension development host. Run `npm run watch` while editing; reload the development host after changes. Run `npm run format` before submitting a change.

## Code flow

`webview/sidebar.ts` sends an action → `ui/view.ts` validates it → `extension/commands.ts` calls the engine → Git updates the repository → `extension/controller.ts` refreshes the model → the sidebar renders.

| Location                              | Responsibility                                                            |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `src/webview/sidebar.ts`, `render.ts` | Typed DOM interactions and pure rendering                                 |
| `resources/sidebar.css`               | Sidebar styles                                                            |
| `src/ui/view.ts`, `model.ts`          | Webview messages and display state                                        |
| `src/ui/protocol.d.ts`                | Shared host/browser message types                                         |
| `src/extension.ts`                    | Activation and registration                                               |
| `src/extension/`                      | Commands/dialogs, refresh/staging coordination and native Git integration |
| `src/engine/git.ts`                   | Git execution, status and rename-aware diffs                              |
| `src/engine/stack.ts`, `types.ts`     | Relationships, rebases, continuation and safe pushes                      |
| `src/engine/metadata.ts`              | Validation of saved relationships and interrupted updates                 |
| `src/engine/github.ts`                | PR operations through `gh`                                                |

Git owns repository changes; the engine coordinates commands across branches. The editor's Git integration supplies file viewers, conflict editing and discard behavior. There are no runtime npm dependencies. The host compiles to CommonJS and the sidebar to browser ES modules; `npm run build` and `npm run watch` handle both.

Each tracked branch stores its parent, its last saved parent commit (`base`) and its last published tip. The saved boundary determines which commits a rebase replays. Metadata lives in `stackhub/` inside Git's common directory: `state.json` holds relationships and `operation.json` holds an interrupted stack update. Original commits are retained under `refs/stackhub/recovery/` for cancellation.

## Checks

- `npm test` checks formatting and launcher syntax, compiles the host and sidebar with strict TypeScript, and runs metadata/rendering checks plus engine tests against disposable Git repositories. GitHub responses are simulated.
- `npm run package` builds a VSIX; it does not publish anything.
- For editor integration changes, run the native checks after building:

```sh
node test/run-native.cjs /absolute/path/to/editor-cli
```

The native runner uses a separate editor profile, repository and local bare remote. If prompted, trust only that fixture. It prints the paths to its results and editor log. See [VALIDATION.md](VALIDATION.md) for platform coverage and hosted GitHub limits.

CI runs the repository checks and packaging on Ubuntu. Native editor checks remain manual.

## Changes and releases

Keep changes focused. Use Git commands for repository operations, keep editor APIs out of the engine, and document non-obvious contracts with JSDoc. Add regression coverage for behavior changes, especially staging, rebases and push safety. Bug reports should include reproduction steps, editor/Git versions and relevant StackHub output with private data removed.

The extension uses publisher `shivam0110` and the repository URLs in `package.json`. Before publishing, verify registry access, hosted GitHub operations and supported editors, update [VALIDATION.md](VALIDATION.md), then build the release. Local packaging alone does not establish Marketplace readiness.
