# Unit: VS Code Web package and extensions

Files: packages/vscode-web/README.md, packages/vscode-web/package.json, packages/vscode-web/code-oss-version.json, packages/vscode-web/Dockerfile.code-oss, packages/vscode-web/scripts/build-code-docker.mjs, packages/vscode-web/scripts/build-code-oss.mjs, packages/vscode-web/scripts/prepare-assets.mjs, packages/vscode-web/test/assetCommands.test.mjs, packages/vscode-web/foxwarm-fs/, packages/vscode-web/foxwarm-terminal/, packages/vscode-web/foxwarm-scm/, packages/vscode-web/foxwarm-webui/, skills/webui-markers/SKILL.md
Secondary files: package.json, .gitignore

## Purpose

Owns optional workbench-asset preparation plus the four Foxwarm browser extensions that provide filesystem/workspace, backend terminal, read-only SCM/commit, and embedded Foxwarm WebUI behavior inside official Code for the Web.

Cross-module contract: [Code integration](../threads/code-integration.md).

## Asset preparation

- `npm run build:code` builds the pinned MIT Code - OSS source in the dedicated Node 24 Docker builder and publishes required ignored assets.
- `build:code:local` is the explicit host-native alternative for an environment with matching Node/native prerequisites.
- `npm run download:code` fetches the pinned Microsoft `web-standalone` product build for licensed/internal use; its product license is distinct from Code - OSS MIT.
- Package-local `prepare:assets` remains an alias of pinned download.
- Workbench assets and source/dependency caches are intentionally absent from Git and ordinary `npm run build`.

## `foxwarm-fs`

- Registers the writable, case-sensitive `foxwarm` filesystem provider.
- Preferred URI: `foxwarm://node+<nodeId>/<absolute-path>`; reads the earlier `foxwarm://node/<nodeId>/...` form and writes current shape.
- Implements stat/read-directory/read-file/write-file/create-directory/delete/rename through authenticated routes.
- Contributes Add Folder and fixed hidden add-folder/open-file bridge handling.
- File watching is a no-op except immediate local events for provider writes; search providers are absent.

## `foxwarm-terminal`

- Registers a browser `Pseudoterminal` profile over Foxwarm terminal REST/WebSocket routes.
- Derives node/cwd from the first `foxwarm` workspace folder.
- Restores backend terminals inside the current workspace after Code reload without POSTing duplicate PTYs.
- User terminal close kills/deletes the backend. Extension/window reload and non-user exit only detach.
- Contributes new/toggle/editor/open-here commands. Remote PTY requires advertised `vscode-pty`.
- Terminal-scoped `code` helper supports one existing POSIX file/folder or goto target via local capability IPC.

## `foxwarm-scm`

- Discovers every workspace root, deduplicates canonical Git top-levels, and creates one read-only Source Control provider per repository.
- Shows one working-tree Changes group, individual immutable/working diffs, and multi-diff.
- Supports direct commit details in a dedicated Activity Bar view and optional editor panel, with first-parent/root immutable diffs and binary-safe listing.
- Submodule status derives Gitlink metadata/current submodule HEAD without spawning a fallback Git process for the missing porcelain field.
- Implements no staging, commit, push, branch, credentials, watcher, blame, or history graph.

## `foxwarm-webui`

- Contributes the Foxwarm Activity Bar sidebar plus read-only custom editors for session Chat, Agents, and Setup.
- Embeds strict leaf WebUI roots (`foxwarmEmbed=sidebar|chat|agents|setup`) through exact-source and random-nonce checked fixed messages.
- Deterministic target URIs deduplicate editors. Generalized extension global state restores open targets and reads the older session-only key once.
- Tab-group events publish the active Foxwarm target; ordinary editors clear sidebar selection.
- Sidebar terminal actions invoke the Code terminal extension rather than nesting a WebUI terminal.
- Same-origin cookie auth is current. Separate isolated webview origins do not yet have scoped credential exchange.

## Commit markers

`skills/webui-markers/SKILL.md` documents the strict standalone model-authored `<foxwarm-commit node="..." path="..." id="..." />` grammar. The extension resolves the repository/commit only after a user click and opens immutable details. Planned, guessed, malformed, user-authored, and fenced-code examples are not actions.

## Dependencies

- Official browser extension API (`vscode`).
- Shared VS Code node-service/Git details modules.
- WebUI fixed bridges and backend route/terminal services.
- esbuild for the four browser-extension bundles.

## Compatibility

- Filesystem URI reader accepts the earlier authority/path shape; new links use `node+<id>` authority.
- WebUI editor restoration reads the former session-only state and writes current generalized state.
- Package-local pinned prepare command remains an alias; large workbench assets remain optional.

## Canonical ownership

- Browser-extension workbench architecture and optional assets: [D-code-official-workbench](../threads/code-integration.md#d-code-official-workbench).
- Terminal detach/reattach/kill lifecycle: [D-code-terminal-lifecycle](../threads/code-integration.md#d-code-terminal-lifecycle).
- Read-only SCM/commit boundary: [D-code-read-only-scm](../threads/code-integration.md#d-code-read-only-scm).
- Commit marker interaction: [D-code-model-commit-marker](../threads/code-integration.md#d-code-model-commit-marker).
