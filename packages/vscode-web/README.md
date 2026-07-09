# Foxwarm VS Code Web Spike

This package is the start of a production-shaped integration for official VS Code for the Web.
It is intentionally separate from `packages/webui` so the VS Code workbench and extension-host assets do not enter the main Foxwarm WebUI bundle.

## Current spike scope

- Dedicated authenticated route: `/vscode-web`.
- Dedicated authenticated filesystem API prefix: `/api/vscode-web/fs`.
- Browser web extension: `foxwarm-fs`, served from `/vscode-web/extensions/foxwarm-fs/`.
- Browser web extension: `foxwarm-terminal`, served from `/vscode-web/extensions/foxwarm-terminal/`.
- Browser web extension: `foxwarm-scm`, served from `/vscode-web/extensions/foxwarm-scm/`.
- Optional official VS Code Web static assets served from `/vscode-web/static/` when prepared.
- URI shape: `foxwarm://node+<nodeId>/<absolute-path>`.
  - `node` is the namespace/type layer.
  - `<nodeId>` is currently only `master` on the backend.
  - The remaining URI path is the real absolute filesystem path.

Example workspace folder URI:

```text
foxwarm://node+master/home/ldmbot/git/foxwarm/
```

In the Docker test environment the backend sees the repository at `/app`, so use:

```text
foxwarm://node+master/app/
```

## Authentication

All VS Code Web routes use the same token mechanism as the main WebUI:

- `Cookie: foxwarm_token=<token>` / legacy `alphabot_token=<token>`
- or `Authorization: Bearer <token>`

The browser extension uses same-origin `fetch(..., { credentials: 'include' })`, so the normal WebUI login cookie is sent to `/api/vscode-web/fs/*`. Do not expose the filesystem API without this auth layer.

The terminal extension also uses same-origin cookie auth for `POST /api/terminals` and `WebSocket /api/terminals/stream`. Browser WebSockets cannot set an `Authorization` header, so do not put tokens in terminal WebSocket query strings.

## Terminal profile

`foxwarm-terminal` contributes a `Foxwarm Terminal` profile to the VS Code integrated terminal UI. It is a browser-only VS Code web extension that creates an `ExtensionTerminalOptions` terminal with a `Pseudoterminal` implementation. The pseudoterminal does not spawn a process in the browser; instead it creates a Foxwarm backend PTY and bridges terminal I/O over the existing JSON WebSocket stream.

Current MVP behavior:

- Backend terminal creation is cwd-based and no longer requires a Foxwarm chat session id.
- The terminal cwd is derived from the first VS Code workspace folder URI. For example, `foxwarm://node+master/app/` becomes backend cwd `/app`.
- Only `nodeId=master` is supported.
- Closing the VS Code terminal kills the backend PTY.
- The first terminal MVP does not implement detach/reattach persistence across page reload; backend terminals remain process/in-memory state and are removed on backend/container restart.

`foxwarm-fs` also contributes a `Foxwarm: Open Folder...` command and a remote-indicator menu item for virtual `foxwarm` workspaces. It prompts for an absolute path on the current node and reopens the workbench with that path as the workspace root.

`foxwarm-terminal` contributes `Foxwarm: New Terminal`, `Foxwarm: Toggle Terminal`, and `Foxwarm: Open Terminal in Editor Area`. The toggle command is bound to <kbd>Ctrl</kbd>+<kbd>`</kbd> inside `foxwarm` virtual workspaces so opening the terminal via the terminal shortcut creates a Foxwarm backend PTY when none exists. When a terminal already exists, the command delegates to VS Code's native `workbench.action.terminal.toggleTerminal`. The bottom-left remote/virtual-workspace menu intentionally only exposes workspace/target actions such as `Foxwarm: Open Folder...`, not terminal creation. Explorer resource context menus include `Open in Foxwarm Terminal`, which opens a backend PTY in the selected directory (or the containing directory for a file).

## Source control MVP

`foxwarm-scm` contributes a read-only Source Control provider for `foxwarm` workspaces. It calls authenticated Git API routes under `/api/vscode-web/git/*` to list working tree changes and opens diff editors comparing `HEAD` with working tree content through read-only `foxwarm-git:` virtual documents.

Current MVP behavior:

- Supports only `nodeId=master`.
- Shows a single `Changes` resource group for working tree status.
- Provides `Foxwarm SCM: Refresh Git Status`.
- Opens `HEAD ↔ Working Tree` diffs for modified, added, deleted, renamed, and untracked files where possible.
- Does not implement staging, committing, pushing, branch management, credentials, blame, history graph, or file watchers.

## Preparing official VS Code Web assets

Large official VS Code Web assets are intentionally not committed. To download them into the ignored default asset directory:

```sh
npm --prefix packages/vscode-web run prepare:assets -- --quality=stable
```

The default output is:

```text
packages/vscode-web/assets/vscode-web/
```

At runtime the route can also read assets from another directory:

```sh
FOXWARM_VSCODE_WEB_ASSET_DIR=/path/to/vscode-web-assets npm run start:notmux
```

When the required static files exist (`out/nls.messages.js`, `out/vs/workbench/workbench.web.main.internal.css`, `out/vs/workbench/workbench.web.main.internal.js`), `/vscode-web` emits a VS Code Web workbench bootstrap that includes `foxwarm-fs` as an additional browser builtin extension and opens the requested `folderUri` query parameter. The default folder URI can be overridden with `FOXWARM_VSCODE_WEB_DEFAULT_FOLDER_URI`; otherwise the route prefers `/app` when running in the Docker test environment and falls back to the host checkout path when present.

## Not in scope yet

- Committing VS Code Web static assets.
- File/text search providers.
- File watching.
- Remote node filesystem implementation.

## Validation commands

```sh
npm --prefix packages/shared run build
npx tsc --noEmit
npm --prefix packages/vscode-web test
node --test lib/vscodeWebRoutes.test.js
```
