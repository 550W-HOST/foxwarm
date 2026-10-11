# Unit: VS Code Web package and extensions

Files: packages/vscode-web/README.md, packages/vscode-web/package.json, packages/vscode-web/code-oss-version.json, packages/vscode-web/yaml-extension-version.json, packages/vscode-web/Dockerfile.code-oss, packages/vscode-web/scripts/build-code-docker.mjs, packages/vscode-web/scripts/build-code-oss.mjs, packages/vscode-web/scripts/prepare-assets.mjs, packages/vscode-web/scripts/prepare-yaml-extension.mjs, packages/vscode-web/scripts/yaml-extension-assets.mjs, packages/vscode-web/test/assetCommands.test.mjs, packages/vscode-web/test/yamlSchema.e2e.mjs, packages/vscode-web/foxwarm-fs/, packages/vscode-web/foxwarm-terminal/, packages/vscode-web/foxwarm-scm/, packages/vscode-web/foxwarm-webui/, skills/webui-markers/SKILL.md
Secondary files: package.json, .gitignore, Dockerfile

## Purpose

Owns optional workbench-asset preparation plus the four Foxwarm browser extensions that provide filesystem/workspace, backend terminal, read-only SCM/commit, and embedded Foxwarm WebUI behavior inside official Code for the Web.

Cross-module contract: [Code integration](../threads/code-integration.md).

## Asset preparation

- `npm run build:code` builds the pinned MIT Code - OSS source in the dedicated Node 24 Docker builder and publishes required ignored assets.
- `build:code:local` is the explicit host-native alternative for an environment with matching Node/native prerequisites.
- `npm run download:code` fetches the pinned Microsoft `web-standalone` product build for licensed/internal use; its product license is distinct from Code - OSS MIT.
- Asset regression coverage distinguishes the root server's pinned Node 24 trixie build/runtime stages, required by its native runtime dependencies, from the Code OSS builder, node runtime, and unrelated test images that remain on bookworm.
- Package-local `prepare:assets` remains an alias of pinned download.
- Workbench assets and source/dependency caches are intentionally absent from Git and ordinary `npm run build`.
- Both workbench preparation paths also download, SHA-256 verify, license-check, and extract the pinned stable `redhat.vscode-yaml` Web extension from Open VSX. The reviewed MIT license and notices are tracked; the artifact remains in ignored optional assets. Preparation applies only a fail-closed exact bundle patch so the telemetry library recognizes the effective disabled default; all other vendor files remain byte-for-byte unchanged.

## `foxwarm-fs`

- Registers the writable, case-sensitive `foxwarm` filesystem provider.
- Preferred URI: `foxwarm://node+<nodeId>/<absolute-path>`; reads the earlier `foxwarm://node/<nodeId>/...` form and writes current shape.
- Implements stat/read-directory/read-file/write-file/create-directory/delete/rename through authenticated routes.
- Contributes Add Folder and fixed hidden add-folder/open-file bridge handling.
- Contributes command-palette actions for the authoritative master app and data roots. They use the fixed authenticated workspace-roots response, add or relabel only the exact URI without replacing unrelated roots, assign stable labels, and open/reveal the root in Explorer.
- Activates the optional Red Hat YAML contributor API and supplies bundled shared App/Models schemas, including both executable and Docker-worktree Node-provider variants, only for exact authoritative master config URIs. Missing YAML assets or APIs log and leave filesystem commands active.
- The supported path is Foxwarm's persistent multi-root workbench. The commands wait for its ordinary folder-change event and keep no global/workspace reload intent; direct bare empty/single-folder launches do not guarantee focus after a workbench reload.
- File watching is a no-op except immediate local events for provider writes; search providers are absent.

## `foxwarm-terminal`

- Registers a browser `Pseudoterminal` profile over Foxwarm terminal REST/WebSocket routes.
- Derives node/cwd from the first `foxwarm` workspace folder.
- Restores backend terminals inside the current workspace after Code reload without POSTing duplicate PTYs.
- User terminal close kills/deletes the backend. Extension/window reload and non-user exit only detach.
- The browser WebSocket automatically answers the terminal route's server-originated protocol pings, so transport keepalive requires no extension application-message changes and does not alter detach/kill semantics.
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
- Tab-group events publish the active Foxwarm target for singular sidebar selection plus all active Foxwarm Chat editor-group session IDs for the browser-local unread visibility contract; ordinary editors clear singular sidebar selection.
- Embedded Chat can request `open-setup` with the fixed `focus: models` field. The controller activates the stable Setup editor, waits for its nonce-bound ready message, and forwards one fixed Models-focus signal; arbitrary focus targets or commands are not bridged.
- Sidebar terminal actions invoke the Code terminal extension rather than nesting a WebUI terminal.
- Same-origin cookie auth is current. Separate isolated webview origins do not yet have scoped credential exchange.

## Commit markers

`skills/webui-markers/SKILL.md` documents the strict standalone model-authored `<foxwarm-commit node="..." path="..." id="..." />` grammar. The extension resolves the repository/commit only after a user click and opens immutable details. Planned, guessed, malformed, user-authored, and fenced-code examples are not actions.

## Dependencies

- Official browser extension API (`vscode`).
- Shared VS Code node-service/Git details modules.
- WebUI fixed bridges and backend route/terminal services.
- Shared pure config schemas and the pinned MIT Red Hat YAML Web extension.
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
- Master app/data folder commands: [D-code-master-workspace-roots](../threads/code-integration.md#d-code-master-workspace-roots).
- Config schema reuse and exact association: [D-code-config-schema-assistance](../threads/code-integration.md#d-code-config-schema-assistance).
