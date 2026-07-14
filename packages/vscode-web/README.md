# Foxwarm VS Code Web Spike

This package is the start of a production-shaped integration for official VS Code for the Web.
It is intentionally separate from `packages/webui` so the VS Code workbench and extension-host assets do not enter the main Foxwarm WebUI bundle.

## Current spike scope

- Dedicated authenticated route: `/vscode-web`.
- Dedicated authenticated filesystem API prefix: `/api/vscode-web/fs`.
- Browser web extension: `foxwarm-fs`, served from `/vscode-web/extensions/foxwarm-fs/`.
- Browser web extension: `foxwarm-terminal`, served from `/vscode-web/extensions/foxwarm-terminal/`.
- Browser web extension: `foxwarm-scm`, served from `/vscode-web/extensions/foxwarm-scm/`.
- Browser web extension: `foxwarm-webui`, served from `/vscode-web/extensions/foxwarm-webui/`.
- Optional official VS Code Web static assets served from `/vscode-web/static/` when prepared.
- URI shape: `foxwarm://node+<nodeId>/<absolute-path>`.
  - `node` is the namespace/type layer.
  - `<nodeId>` can be `master` or a connected CLI node advertising the versioned `vscode-fs` service.
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

VS Code workbench, extension, filesystem, Git, and terminal routes use the same token mechanism as the main WebUI:

- `Cookie: foxwarm_token=<token>` / legacy `alphabot_token=<token>`
- or `Authorization: Bearer <token>`

The browser extension uses same-origin `fetch(..., { credentials: 'include' })`, so the normal WebUI login cookie is sent to `/api/vscode-web/fs/*`. Do not expose the filesystem API without this auth layer.

Code's nested webview bootstrap cannot reliably send the normal login cookie from its sandboxed origin. Foxwarm therefore gives each server process an unguessable `/vscode-web/webview/<capability>/` route scoped only to Code's official `pre/` bootstrap assets. The authenticated workbench receives that capability URL; it does not expose repository data or general static files. Localhost launches use Code's hashed `{{uuid}}.localhost` origin so panel content is origin-isolated from WebUI. Production deployments can provide an equivalent wildcard origin such as `FOXWARM_VSCODE_WEB_WEBVIEW_ORIGIN=https://{{uuid}}.code.example.com`; without one, Foxwarm uses its same-origin capability fallback and patches the bootstrap hostname check (recomputing its CSP hash).

Plain-HTTP access by a non-loopback IP is not a browser secure context, so native `crypto.subtle` and service workers are unavailable. Foxwarm keeps Code webviews functional there with a narrowly scoped SHA-256 fallback used only for Code's parent-origin correlation. The same-origin compatibility path disables the webview service worker on HTTP and HTTPS; this also lets more than one same-origin Foxwarm webview coexist without the service worker's single-origin content routing colliding. Commit details and the built-in Markdown preview are covered by browser E2E. This does **not** make HTTP secure or provide origin isolation—use HTTPS plus a wildcard webview origin for exposed deployments.

Firefox prompts with a browser-native one-item **Paste** menu when a secure page probes `navigator.clipboard.read()` without an explicit paste action. Code's Explorer normally performs that probe before showing its own context menu. Foxwarm's served pinned workbench avoids the probe only for Firefox's menu-visibility check and relies on the extension's in-memory copied-resource state instead; choosing Paste can still request clipboard access normally. This prevents the first-right-click prompt without weakening the actual paste action.

The terminal extension also uses same-origin cookie auth for `POST /api/terminals` and `WebSocket /api/terminals/stream`. Browser WebSockets cannot set an `Authorization` header, so do not put tokens in terminal WebSocket query strings.

## Foxwarm sidebar and chat editors

`foxwarm-webui` contributes a dedicated **Foxwarm** Activity Bar container. Its WebviewView contains a thin outer bridge and an iframe loading the normal WebUI in the strict `foxwarmEmbed=sidebar` mode. That mode renders the session list, search/view controls, settings, and the existing New agent/New session dialogs, but not the WebUI workbench shell. Session selection sends only a versioned `open-session` message checked against the exact iframe source plus a random per-view nonce.

Each selected session opens through a read-only custom editor at a deterministic synthetic `foxwarm-chat:` URI. The editor iframe uses `foxwarmEmbed=chat`, renders exactly one normal `Chat`, and therefore fetches only `GET /api/sessions/:id/history` and listens only to `/api/sessions/:id/stream` for session state. The one sidebar iframe owns the separate global session-list fetch/stream. Hidden chat editors retain context; opening the same URI reveals the existing editor, extension global state restores open chat editors after a Code page reload, and an explicit editor close removes that session from restoration state. Session links inside an embedded chat ask the host extension to open another chat editor, while commit markers retain the fixed `foxwarm-scm.openCommitDetails` bridge.

The embed URLs never contain the WebUI token. They use the normal WebUI cookie and are intended for the current same-public-origin deployment, including reverse-proxy base paths. Chrome and Firefox E2E cover HTTPS with a stripping `/alphabot/` proxy. A separately configured wildcard webview origin—and localhost's default hashed webview origin—can make the inner WebUI a third-party-cookie context; a scoped cross-origin embed credential exchange is intentionally not part of this first phase, so those isolated-origin deployments may show the login view until that flow is designed.

## Terminal profile

`foxwarm-terminal` contributes a `Foxwarm Terminal` profile to the VS Code integrated terminal UI. It is a browser-only VS Code web extension that creates an `ExtensionTerminalOptions` terminal with a `Pseudoterminal` implementation. The pseudoterminal does not spawn a process in the browser; instead it creates a Foxwarm backend PTY and bridges terminal I/O over the existing JSON WebSocket stream.

Current MVP behavior:

- The standalone workbench defaults `window.menuBarVisibility` to `visible`; users can still override the default in Code settings.
- Backend terminal creation is cwd-based and no longer requires a Foxwarm chat session id.
- The terminal cwd is derived from the first VS Code workspace folder URI. For example, `foxwarm://node+master/app/` becomes backend cwd `/app`.
- `nodeId=master` uses the master process PTY manager. A connected CLI node advertising versioned `vscode-pty` runs the PTY in the remote node process and exposes the same Code terminal UI.
- Foxwarm terminals prepend a terminal-scoped `code` helper to `PATH`. `code <file>` opens a file, `code <folder>` / `code --add <folder>` adds a workspace root, and `code --goto <file>:<line>[:column]` opens a location. The helper accepts one existing POSIX path at a time.
- Closing or reloading the whole VS Code browser page only detaches its WebSocket clients. Extension activation lists existing backend terminals on the same node whose cwd is inside the current workspace and recreates attach-mode VS Code terminal views without POSTing new PTYs.
- Explicit user terminal close (`TerminalExitReason.User`) deletes/kills the backend PTY. Window shutdown/reload, process exit, and extension shutdown do not issue an extra DELETE.
- Backend terminals remain process/in-memory state. Master terminals disappear when the master process restarts; remote terminals survive a master reconnect while their CLI node process remains alive, but disappear when that node process restarts.

`foxwarm-fs` also contributes a `Foxwarm: Add Folder...` command and a remote-indicator menu item for virtual `foxwarm` workspaces. It prompts for an absolute path on the current node and appends that path to the current multi-root workspace.

Explorer folder context menus also expose **Add Folder to Workspace** for `foxwarm` directory resources. This calls the same exact-path-deduplicating multi-root workspace operation used by the bridge and terminal helper; it does not replace/reload the Code iframe.

`foxwarm-terminal` contributes `Foxwarm: New Terminal`, `Foxwarm: Toggle Terminal`, and `Foxwarm: Open Terminal in Editor Area`. The toggle command is bound to <kbd>Ctrl</kbd>+<kbd>`</kbd> inside `foxwarm` virtual workspaces so opening the terminal via the terminal shortcut creates a Foxwarm backend PTY when none exists. When a terminal already exists, the command delegates to VS Code's native `workbench.action.terminal.toggleTerminal`. The bottom-left remote/virtual-workspace menu intentionally only exposes workspace/target actions such as `Foxwarm: Add Folder...`, not terminal creation. Explorer resource context menus include `Open in Foxwarm Terminal`, which opens a backend PTY in the selected directory (or the containing directory for a file).

## Source control MVP

`foxwarm-scm` contributes a read-only Source Control provider for `foxwarm` workspaces. It inspects every workspace root, deduplicates roots that resolve to the same Git top-level, and creates one Source Control section per distinct repository. It calls authenticated Git API routes under `/api/vscode-web/git/*` to list working tree changes and opens individual diff editors comparing `HEAD` with working tree content through read-only `foxwarm-git:` virtual documents. Each repository also has an `Open Changes` action backed by Code OSS's multi-diff editor. Changed submodules show the old/new gitlink commit IDs; the backend obtains an unstaged submodule's current HEAD by reading its Git metadata directly and never adds a fallback Git process for this detail.

The same extension opens immutable commit details from a typed `openCommit` request. `GET /api/vscode-web/git/commit` resolves a 7–64 digit hexadecimal commit id, returns metadata plus a first-parent file/stat diff (or empty-tree diff for a root commit), and canonicalizes the repository root. Commit markers open a dedicated `Commit Details` Activity Bar container by default, rather than sharing vertical space with Explorer or Source Control. Its view-title **Open in Editor** action preserves the larger editor-area panel. Both surfaces show Node and Repository as separate metadata fields and offer per-file diffs plus one multi-diff action. Diff documents use full parent/commit object ids rather than mutable branch names; binary files remain listed but do not pretend to have a text diff. Remote commit inspection requires `vscode-git` service version 2.

Current MVP behavior:

- Supports `master` plus connected CLI nodes advertising the versioned `vscode-git` service.
- Opens commit metadata and immutable first-parent/root diffs through `vscode-git` v2.
- Shows a single `Changes` resource group for working tree status.
- Provides `Foxwarm SCM: Refresh Git Status`.
- Opens `HEAD ↔ Working Tree` diffs for modified, added, deleted, renamed, and untracked files where possible.
- Does not implement staging, committing, pushing, branch management, credentials, blame, history graph, or file watchers.

## WebUI commit markers

Model-authored assistant text may contain a strict standalone marker after a real commit has been created:

```text
<foxwarm-commit node="master" path="/absolute/repository/path" id="0123456789abcdef" />
```

The main WebUI recognizes this tag only in model text, only outside fenced code blocks, and only as a complete line with exactly the three XML-escaped attributes. Valid markers render an inert single-row card containing the short commit id and `node:path`; Git lookup starts only when the user clicks **Open in Code**. User-authored text, malformed tags, unsafe paths/node ids, extra attributes, and code examples never become actions.

Clicking sends a fixed typed request to the persistent Code iframe or a one-shot new-tab startup URL. Code resolves the commit first, adds the canonical Git top-level to `foxwarm.code-workspace` with exact-root deduplication, survives the resulting workspace reload through extension global state, and opens the details panel. Agents should load the bundled `webui-markers` skill for the canonical grammar and must not emit a marker for a planned, guessed, or inaccessible commit.

## Remote node transport

Remote filesystem, Git, and PTY requests do not invoke model-facing `read`/`write`/`exec` tools. The authenticated node connection advertises versioned `vscode-fs`, `vscode-git`, and optional `vscode-pty` service capabilities. Lifecycle operations use correlated `node_service_request` messages; latency-sensitive PTY input/resize uses fixed fire-and-forget `node_service_command` messages; PTY output/exit uses `node_service_event` messages. Offline nodes return an unavailable response, and older clients that do not advertise a service are rejected instead of silently falling back to master paths.

The CLI node loads official `node-pty` from the separate minimal `packages/cli-node-runtime` package. Node bootstrap installs only that package: official macOS/Windows builds use the packaged prebuilds, while Linux compiles through `node-gyp` and therefore requires Python 3, make, and a C/C++ compiler. Docker node builds treat installation failure as fatal; bare-metal bootstrap warns and continues without advertising `vscode-pty`, preserving its filesystem/Git/tool capabilities. The current URI/path implementation is still POSIX-oriented; Windows path mapping remains separate work even though the native PTY package has a Windows prebuild.

The terminal `code` helper does not receive the WebUI token, node credential, master URL, or browser URL. Each terminal receives a random capability plus a process-local Unix socket path (a named-pipe shape is reserved for Windows). The helper sends cwd/arguments to its local master/node runtime, which resolves and stats the path. Remote requests then travel over the already-authenticated node WebSocket; the master binds the trusted node id and sends only the fixed `foxwarm-fs.handleOpenRequest` operation to the most recently attached Code-capable terminal WebSocket. Ordinary main-WebUI terminal clients do not claim Code control ownership, and helper invocation without an attached Code terminal fails clearly instead of broadcasting to every browser or waiting silently.

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
- Valid model commit cards send only the typed `openCommit` payload. The bridge allowlists that kind to `foxwarm-scm.openCommitDetails`; it does not accept arbitrary Code command names. New-tab commit launches still open the persistent workspace and carry one-shot commit parameters.
- Paths rendered by direct `read`, `write`, `edit`, and `apply_patch` tool cards use the session's current master or remote node. They open the file in the existing embedded workbench; `read` line ranges become editor selections. New-browser-tab mode carries the node/folder/file in the launch URL instead of trying to control an already-open tab.
- Session headers provide `Open code` using the session's current node and cwd (with a safe `master:/` fallback), plus an adjacent external-link button that always opens a new browser tab.

Launch URLs are derived from the dynamic WebUI API base path and preserve reverse-proxy prefixes. Runtime bootstrap recomputes the webview capability path from the browser's actual `/.../vscode-web/` pathname, so a stripping proxy does not need `X-Forwarded-Prefix` merely to keep webviews under the public base path. Direct new-browser-tab launches include a `foxwarm://node+<nodeId>/<absolute-path>` `folderUri`; embedded launches use the persistent workspace configuration plus an initial folder hint. Runtime transfer/pop-out of an already running iframe is intentionally not implemented.

## Not in scope yet

- Committing Code workbench static assets or source/dependency caches.
- File/text search providers.
- File watching.
- Native Windows-path workspace support.
- Full desktop `code` CLI compatibility such as installing extensions, opening new windows, waiting for editor close, or accepting multiple paths. The Foxwarm helper intentionally supports only open-file/add-folder/goto operations.

## Validation commands

```sh
npm --prefix packages/shared run build
npx tsc --noEmit
npm --prefix packages/vscode-web test
node --test lib/vscodeWebRoutes.test.js
```
