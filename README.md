# StackHub

Git stacks in your editor. A Graphite-style sidebar for VS Code, Cursor and Devin that turns a large change into small, dependent branches and pull requests.

## Features

- Browse a visual branch tree, check out branches and inspect diffs.
- Stage files, create stacked branches, track existing branches, commit and amend.
- Restack descendants, sync with main, or drag a branch to change its parent.
- Push stacks safely, create parent-targeted GitHub PRs, and see review and CI status.
- Resolve conflicts in the editor, then continue or cancel the stack update.

StackHub runs native Git commands and uses the editor's diff and conflict tools. GitHub features use the [GitHub CLI](https://cli.github.com/).

## Install

Requires Git and VS Code 1.95+ or a compatible editor. To build the extension from this checkout, use Node.js 24:

```sh
npm ci
npm run package
```

1. Run **Extensions: Install from VSIX…** in your editor and select the generated `stackhub-*.vsix`.
2. Reload the window and open a Git repository.
3. Open **StackHub** in the activity bar, choose **Set up repository**, and select your trunk branch (usually `main`).

For GitHub pull requests, install `gh` and run `gh auth login`. Local stacks work without it.

## Your first stack

1. Make changes, select **Uncommitted changes**, and stage files with the checkboxes.
2. Enter a commit message and choose **Create a new branch**. The current branch becomes its parent.
3. Repeat to add another branch. Click a branch to inspect it; double-click to check it out.
4. Use **Submit N PRs** to push the stack and create PRs. New PRs are drafts by default.

To amend a branch, stage edits and select **Modify**. Descendants restack automatically when the working tree is clean.

| Action                             | When to use it                                 |
| ---------------------------------- | ---------------------------------------------- |
| **Restack descendants**            | An earlier branch changed.                     |
| **Sync with main**                 | Trunk changed; update the stack from its root. |
| **Change parent** or drag-and-drop | Move a branch and its descendants.             |

The gear controls commit behavior, branch labels and draft PRs. The remote defaults to `origin` (`stackhub.remote`).

## Contributing

See `CONTRIBUTING.md` for setup, code flow and checks, and `VALIDATION.md` for verified workflows and current limits.

## License

MIT. See `LICENSE`.
