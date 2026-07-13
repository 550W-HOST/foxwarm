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
- Closing or reloading the whole VS Code browser page only detaches its WebSocket clients. Extension activation lists existing backend terminals on the same node whose cwd is inside the current workspace and recreates attach-mode VS Code terminal views without POSTing new PTYs.
- Explicit user terminal close (`TerminalExitReason.User`) deletes/kills the backend PTY. Window shutdown/reload, process exit, and extension shutdown do not issue an extra DELETE.
- Backend terminals remain process/in-memory state and are still removed on backend/container restart.

`foxwarm-fs` also contributes a `Foxwarm: Add Folder...` command and a remote-indicator menu item for virtual `foxwarm` workspaces. It prompts for an absolute path on the current node and appends that path to the current multi-root workspace.

`foxwarm-terminal` contributes `Foxwarm: New Terminal`, `Foxwarm: Toggle Terminal`, and `Foxwarm: Open Terminal in Editor Area`. The toggle command is bound to <kbd>Ctrl</kbd>+<kbd>`</kbd> inside `foxwarm` virtual workspaces so opening the terminal via the terminal shortcut creates a Foxwarm backend PTY when none exists. When a terminal already exists, the command delegates to VS Code's native `workbench.action.terminal.toggleTerminal`. The bottom-left remote/virtual-workspace menu intentionally only exposes workspace/target actions such as `Foxwarm: Add Folder...`, not terminal creation. Explorer resource context menus include `Open in Foxwarm Terminal`, which opens a backend PTY in the selected directory (or the containing directory for a file).

## Source control MVP

`foxwarm-scm` contributes a read-only Source Control provider for `foxwarm` workspaces. It calls authenticated Git API routes under `/api/vscode-web/git/*` to list working tree changes and opens diff editors comparing `HEAD` with working tree content through read-only `foxwarm-git:` virtual documents.

Current MVP behavior:

- Supports only `nodeId=master`.
- Shows a single `Changes` resource group for working tree status.
- Provides `Foxwarm SCM: Refresh Git Status`.
- Opens `HEAD ↔ Working Tree` diffs for modified, added, deleted, renamed, and untracked files where possible.
- Does not implement staging, committing, pushing, branch management, credentials, blame, history graph, or file watchers.

## Preparing the optional Code workbench

The full browser workbench is intentionally excluded from both Git and the normal `npm run build`. Microsoft does not publish the complete Code - OSS workbench as a supported npm/jsDelivr package, and Microsoft-operated VS Code CDNs are not a public embedding API.

Foxwarm provides two explicit preparation commands. Both write to the ignored default asset directory:

```text
packages/vscode-web/assets/vscode-web/
```

### Build Code - OSS from source

The preferred redistributable path builds the pinned MIT-licensed Code - OSS source configuration:

```sh
npm run build:code
```

The command builds and runs `Dockerfile.code-oss`, a pinned Node 24 builder containing the upstream Linux native-build prerequisites. Inside that container, the source builder shallow-fetches the commit recorded in `code-oss-version.json`, verifies that its product configuration is `Code - OSS` / `MIT`, installs the upstream dependencies, downloads its declared builtin extensions, and runs upstream's standalone `vscode-web-min-ci` packager. That current packager bundles the web entry points directly from TypeScript source with esbuild, avoiding the all-in-one desktop/server declaration build and symbol mangler. The source and dependency cache lives under ignored `packages/vscode-web/.cache/code-oss/` by default and is written with the invoking user's uid/gid.

This is a large optional build. Expect several GB of temporary/cache usage and a running Docker daemon. Useful overrides are forwarded into the container:

```sh
npm run build:code -- --commit=<full-sha> --cache=/path/to/cache --out=/path/to/assets
```

For environments that already provide the exact Node version and native prerequisites, bypass Docker explicitly:

```sh
npm --prefix packages/vscode-web run build:code:local
```

### Download Microsoft's prebuilt workbench

For development or licensed internal use, download the pinned Microsoft `web-standalone` product build:

```sh
npm run download:code
```

This follows the same update endpoint used by `@vscode/test-web`, but the resulting Microsoft product build is governed by the [Visual Studio Code product license](https://code.visualstudio.com/license), not merely the Code - OSS MIT source license. Review that license before redistribution or public hosting. To deliberately follow the latest Stable/Insiders build instead of the pinned commit:

```sh
npm run download:code -- --latest --quality=stable
```

`npm --prefix packages/vscode-web run prepare:assets` remains an alias of the pinned download command for the existing spike workflow.

At runtime the route can also read assets from another directory:

```sh
FOXWARM_VSCODE_WEB_ASSET_DIR=/path/to/vscode-web-assets npm run start:notmux
```

When the required static files exist (`out/nls.messages.js`, `out/vs/workbench/workbench.web.main.internal.css`, `out/vs/workbench/workbench.web.main.internal.js`), `/vscode-web` emits a VS Code Web workbench bootstrap that includes `foxwarm-fs` as an additional browser builtin extension. Direct launches open the requested `folderUri`; embedded launches open the persistent workspace configuration created under the Foxwarm state directory. The default folder URI can be overridden with `FOXWARM_VSCODE_WEB_DEFAULT_FOLDER_URI`; otherwise the route prefers `/app` when running in the Docker test environment and falls back to the host checkout path when present.

When the assets are absent, authenticated requests to `/vscode-web` return a styled `503 Code is not built` page rather than a blank workbench. It shows both preparation commands and the configured asset location. Individual missing static assets continue to return `404`.

## Main WebUI entry

The authenticated main WebUI presents the feature to users as **Code** (the `/vscode-web/` route and internal extension/package names remain unchanged):

- The sidebar `Code` split button opens a master-node workspace, defaulting to `/`, and its dropdown accepts another absolute POSIX path. The selected path and the global `Open in new browser tab` preference are remembered in localStorage.
- Embedded mode creates/focuses a singleton `Code` workbench tab. The actual iframe lives in a persistent top-level portal host and is positioned over the active tab slot, so switching WebUI tabs or views hides rather than unmounts the VS Code browsing context. Its first launch creates `state/vscode-web/foxwarm.code-workspace` (override with `FOXWARM_VSCODE_WEB_WORKSPACE_PATH`). Later folder requests are sent over a same-origin request/ack bridge and appended with the VS Code workspace API without changing the iframe URL or losing open editors and terminals.
- Paths rendered by direct `read`, `write`, `edit`, and `apply_patch` tool cards are Code links for master-node sessions. They open the file in the existing embedded workbench; `read` line ranges become editor selections. New-browser-tab mode carries the initial folder/file in the launch URL instead of trying to control an already-open tab.
- Session headers provide `Open code` using the session's master-node cwd (with a safe `master:/` fallback), plus an adjacent external-link button that always opens a new browser tab.

Launch URLs are derived from the dynamic WebUI API base path and preserve reverse-proxy prefixes. Direct new-browser-tab launches include a `foxwarm://node+master/<absolute-path>` `folderUri`; embedded launches use the persistent workspace configuration plus an initial folder hint. Runtime transfer/pop-out of an already running iframe is intentionally not implemented.

## Not in scope yet

- Committing Code workbench static assets or source/dependency caches.
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
