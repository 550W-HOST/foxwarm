# Thread: Code integration

## Overview

Foxwarm hosts optional official Code for the Web assets in a separate workbench and connects them to the main WebUI, master/remote filesystems, backend terminals, read-only Git, and embedded Foxwarm views through four browser extensions.

## Components

- [VS Code Web routes](../units/src-vscode-web-routes.md) — workbench/static/webview serving and filesystem/Git APIs.
- [VS Code Web extensions](../units/vscode-web-extensions.md) — asset preparation, filesystem, terminal, SCM, and Foxwarm WebUI browser extensions.
- [Shared config schemas](../units/shared-config-schemas.md) — public-safe Draft-07 objects reused by Setup and Code.
- [WebUI app](../units/webui-app.md) — Code launch planning, persistent iframe host, tool-file actions, commit cards, and dynamic public paths.
- [shared VS Code node service](../units/shared-vscode-node-service.md) — fixed filesystem/Git service implementation.
- [terminal router](../units/src-terminal-router.md) — local/remote PTY lifecycle and browser streams.
- [node communication](./node-communication.md) — versioned service transport.

## Workbench and URI model

- Official workbench assets are optional and excluded from the main WebUI bundle, Git, and ordinary build.
- Preferred resources use `foxwarm://node+<nodeId>/<absolute-posix-path>`.
- Each Node has a persistent `node-<encoded-node-id>.code-workspace`. Embedded and new-window launches select that Node’s workspace. Folder requests use path containment: covered descendants are revealed, and a new ancestor replaces contained roots.
- The filesystem extension exposes fixed commands for the authoritative master app and data roots. They route to the master workbench, add or reveal the normalized root using the same containment rules, then focus Explorer; they never derive these roots from a session node or cwd.
- A pinned MIT Red Hat YAML Web extension consumes the same static config schemas as Setup through a local contributor. Only the authoritative master app/models file URIs match.
- Main WebUI presents the feature as **Code** while route/package identifiers remain `/vscode-web`.

## WebUI launch and bridge

- `API_BASE_PATH` is converted to the deployment-relative `/vscode-web/` path; launch URLs preserve reverse-proxy prefixes.
- Embedded mode uses the shared [Workbench content host](../units/webui-workbench-content.md#d-workbench-stable-content) for each Node’s iframe, while App retains independent bridge controllers before lazy iframe creation. A restored inactive Code tab, or a logically active Code tab while the mobile list hides the workbench surface, does not create it; the first Code tab actually shown as active in any visible expanded workbench pane starts it. Ordinary tab switching then hides/repositions the persistent iframe without unmounting it. Pane collapse and explicit Code-tab close follow [D-code-persistent-workspace](#d-code-persistent-workspace).
- Parent/workbench communication is versioned, exact-origin/source checked, and allowlisted to add-folder, open-file, open-commit, and fixed master App/Data commands with acknowledgements. Master-folder commands invoked inside another Node’s frame use an exact-source/origin-checked reverse message to select master’s tab. Standalone workbenches open a master window for those commands.
- Every open-file request first ensures its Node’s workspace contains the file (use a containing Session cwd when supplied, otherwise the file parent), opens the editor, and focuses/reveals the resource in Explorer.
- Direct `read`, `write`, `edit` (including actionable patches) tool paths remain plain text; after exact node/cwd/path resolution, an adjacent icon-only Code action may issue the open-file request. See [D-webui-tool-call-region](../units/webui-tool-timeline.md#d-webui-tool-call-region) for the interaction contract. Memory tools, nested descriptors, and ambiguous paths remain inert.
- New-tab mode carries initial target parameters without `embedded=true`; it does not control an already-open tab. The `nodeId` parameter selects the persistent Node workspace independently of iframe presentation. Only iframe launches set `embedded=true`; older embedded-only URLs remain readable.
- Moving the WebUI Code tab to a browser window uses this existing standalone new-tab mode with the selected tab’s Node/path. It is a fresh standalone Code launch, not transfer of the running embedded iframe; only after `window.open` succeeds does WebUI remove that Node’s source Code tab and destroy its embedded frame.

## Files, services, and terminals

- Master file/Git operations execute locally; remote operations require matching advertised `vscode-fs`/`vscode-git` versions.
- Optional `vscode-pty` owns remote PTY process state and emits fixed service events through the authenticated node connection.
- Terminal browser WebSockets attach to backend PTYs. After authenticated attachment, the server sends a WebSocket protocol ping every 30 seconds as transport keepalive; browser clients answer protocol pong automatically. Page reload or transport close detaches; explicit user close deletes.
- Terminal `code` helper uses a process-local random capability/socket and one Code-control terminal attachment; it has no browser/master credential.

## SCM and commit markers

- `foxwarm-scm` is read-only: status, individual/multi-diff, submodule transitions, and direct immutable commit details.
- Strict standalone model-authored commit markers render inert cards in WebUI; only a user click performs Git lookup/open.
- Commit resolution canonicalizes the Git top-level before adding a root; a new commit-only workspace starts empty. Persistent workspaces show the details after folder reconciliation without waiting for a reload. Legacy bare-folder launches retain Node-scoped reload-resume state.

## Nested Foxwarm WebUI

- Code's Foxwarm sidebar embeds the normal session list/navigation leaf.
- Session, Agents, and Setup open deterministic read-only custom editors that embed strict leaf roots, not CSS-hidden full App instances.
- Fixed source/nonce messages open targets and report active target. An ordinary editor clears Foxwarm selection.
- Current authentication uses same-public-origin cookies. A cross-origin credential exchange for isolated wildcard webview origins is not implemented. The nonce-bound active-target bridge retains its singular selected target and also carries the deduplicated session IDs of every active Foxwarm Chat editor group for browser-local unread suppression/acknowledgement; that attention contract is canonical in [webui-session-list](../units/webui-session-list.md#design-decisions).

## Webview deployment

- Localhost uses hashed webview origins.
- Exposed production should use HTTPS. Webview origins are selected automatically; there is no wildcard-origin setting.
- Same-origin capability fallback is functional but not origin-isolated; plain HTTP is not made secure by its narrow hash/service-worker compatibility patches.

## Compatibility

- Foxwarm bootstrap, migration and default backfill publish complete workspace documents by same-directory atomic replacement. Code-initiated edits retain the ordinary filesystem write API; consumers that depend on an edit must observe its completion before reading. Add-folder bridge acknowledgements follow the workspace update and Explorer focus; the original-App fixture waits for them before its next launcher interaction.
- The legacy mixed-Node `foxwarm.code-workspace` is read once, distributing folder descriptors by URI authority (including legacy URI readers) and copying workspace settings to Node-specific files. The old file is archived as `.migrated`; subsequent writes use only the new files. Existing target files retain their folders. Legacy WebUI Code tab/layout IDs become the master tab.
- Filesystem URI parser reads the earlier `foxwarm://node/<nodeId>/...` form; writers use current `node+<id>` authority.
- Generalized WebUI editor restore reads the older session-only extension state once.
- Missing optional workbench assets return an actionable 503 rather than a blank workbench.

## Design decisions

### D-code-official-workbench

**Directly selected product/implementation constraint.** Official Code for the Web replaces a bespoke file-editor workspace; this choice constrains the integration, not just its appearance. Browser extensions and optional asset packaging implement it under [workbench resource lifetimes](../behaviors/workbench-and-chat.md#mounted-visible-and-running-are-independent).

Use official Code for the Web with browser extensions, not a Monaco clone or server-side Node extension host. Keep optional official workbench assets/caches separate from the ordinary WebUI bundle and source repository.

### D-code-real-path-uri

**Selected namespace design with real external/persisted URI consumers.** It serves [environment-local path meaning](../behaviors/nodes-workspaces-and-permissions.md#paths-belong-to-an-environment-and-an-operation). Node authority and real paths remain visible; managed drive conversion is a boundary adaptation, not a rewrite of native Session cwd or a promise of UNC support.

Represent node identity in URI authority and retain the absolute slash-based path as URI path; do not invent opaque workspace-root IDs. Windows Main presents an absolute native drive path as `/C:/...` within the unchanged `foxwarm://node+master/...` URI. The normalized Code root `/C:` also denotes the mapped drive root, since the existing slash-based consumers remove a trailing separator. Only local Code filesystem/Git/terminal dispatch converts those representations back to a fully qualified native path; ordinary native `C:` remains drive-relative, not an absolute Session/tool cwd. Native Session cwd and ordinary tool metadata remain unchanged; WebUI Code actions normalize native drive targets at presentation. Remote POSIX paths and legacy URI readers retain their existing namespace. UNC and device-path mapping are not supported by this drive-only adaptation.

### D-code-persistent-workspace

**User-selected per-Node resource separation**, preserving [independent mounted/visible/running lifetimes](../behaviors/workbench-and-chat.md#mounted-visible-and-running-are-independent).

Each Node has one Code tab, one persistent multi-root workspace, and independent editors, terminals, bridge, and iframe. The tab title identifies its Node. The iframe starts on first actual visibility in an expanded pane of the displayed workbench surface, not merely because its tab was restored or logically active. Once started, ordinary tab switching, workbench hiding, and pane collapse preserve that same iframe and background workbench state. Explicit close destroys only that Node’s iframe and pending bridge requests; reopening starts a new frame using its persisted workspace. Memory use therefore grows with the number of started Node tabs.

Requests select the target Node’s tab, including repository-Node commit opens, tool-file actions, and launcher selection. A covered folder is revealed without another root; a newly added ancestor replaces its contained roots, preserving unrelated roots. Opening a file reveals and focuses it in Explorer, adding a containing Session cwd or its parent only when no root covers it. These rules apply to master and remote Nodes. New-window preference and move-to-browser-window use the target Node’s persistent workspace; moving removes the source frame only after the browser accepts the window.

### D-code-fixed-remote-services

**Derived transport design under [ordinary administrator/Node authority](../behaviors/workbench-and-chat.md#code-and-terminal-do-not-inherit-arbitrary-chat-authority).** Existing official clients independently constrain service versions and namespaces. Fixed authenticated services implement Code operations without fabricating model credentials or a Session principal.

Filesystem, Git, PTY, and helper behavior use authenticated fixed versioned services, not model tools or shell credentials. The .NET [service transport](../units/external-node-services.md) and [terminal router](../units/terminal.md#remote-router) implement the existing official-client boundary without a fabricated Session/model principal. Remote Git responses and helper requests use the captured authenticated Node namespace; peer identity fields never become Master path or control authority. Missing/old service versions reject without fallback.

### D-code-config-schema-assistance

Setup and Code reuse one public-safe build-time source for the Models and App Draft-07 schemas; they do not expose a schema endpoint or configuration values. Code bundles the pinned MIT Red Hat YAML Web extension from a SHA-256-verified Open VSX artifact and registers local schema content through its contributor API. Association is restricted to the exact normalized `foxwarm://node+master/...` URIs for the active app and models files returned by the authoritative fixed server response; remote nodes, arbitrary same filenames, and unrelated YAML do not match. The persistent Foxwarm workspace disables Red Hat telemetry, SchemaStore, Kubernetes CRD fetching, and extension recommendations by default without overwriting explicit values already stored in that workspace. A reviewed fail-closed preparation patch makes the telemetry library treat the effective disabled default as configured; all other vendor files remain unchanged. Diagnostics, hover, and completion are advisory: Setup keeps canonical backend validation, while a direct Code save can bypass those semantic validators. Missing optional YAML assets degrade to a clear extension-host log and do not disable Foxwarm filesystem commands.

### D-code-master-workspace-roots

Code commands for the Foxwarm app and data folders obtain `BASE_DIR` and the resolved `DATA_ROOT_DIR` from a fixed authenticated Code filesystem response. Both targets always use master, regardless of the current workspace, Session Node, or cwd. A command in a remote workbench routes to master’s tab (or a master window from standalone Code). The master workbench applies the same path-containment rules as other folder requests, relabels an exact root with its stable product label, awaits the ordinary workspace-folder change, and reveals the target in Explorer. When both runtime roots share a path, they use one combined label. No reload-resume state or ownership protocol is used for these commands.

### D-code-terminal-lifecycle

**Directly selected resource-lifetime constraint.** Reconnection should reattach rather than kill backend work; explicit Close owns termination. It serves [surface/resource separation](../behaviors/workbench-and-chat.md#mounted-visible-and-running-are-independent). Keepalive pings are a transport mechanism, not an idle-kill or backend liveness policy.

Page/extension reload and terminal WebSocket close detach backend terminals; only explicit user close kills them. Matching terminals reattach after reload. An authenticated, successfully attached terminal stream receives a server-originated WebSocket protocol ping every 30 seconds so idle browser connections remain active through intermediaries. This ping is transport keepalive only: it is not a PTY idle timeout, liveness ledger, or backend lifecycle signal.

### D-code-read-only-scm

**Directly selected feature boundary within [official Code integration](#d-code-official-workbench).** Review and diff are the product scope. Git commands and immutable detail views implement that scope; reuse of a general Git library does not authorize staging, pushing or another credential surface.

SCM and commit details support status/review/diff only. They do not add staging, commit, push, branch, credential, watcher, blame, or history-graph behavior.

### D-code-model-commit-marker

Only strict standalone model-authored markers outside code fences produce click-activated commit cards. Code opens canonical immutable details after the click.

## Canonical ownership

Dynamic public-path ownership is canonical in [D-webui-dynamic-base-path](../modules/webui.md#d-webui-dynamic-base-path).

## Verification

`packages/webui/test/mainHostCode.e2e.mjs` exercises the original App, official workbench and browser extensions through file edits, terminal effects, immutable commit views, embedded leaf views, workspace restoration, advisory YAML diagnostics and prefixed authenticated writes. After terminal close/reload, it waits for the requested Chat route and completion of staged Session navigation before clicking the original file action: a retained Chat root can already match while the previous pane/preview is still displayed. Static stage labels and elapsed times survive whole-file interruption in the existing runner log, separating startup-config evaluation/request from YAML restoration input/save/verification. Passive native-dialog records identify the App or Code popup, current stage, type and bounded message without handling the dialog. Failure projection uses bounded cached frame paths without query strings or browser evaluation, so collecting diagnostics cannot wait on an unresponsive renderer. The prefixed workbench also records passive dialog/page errors and caches main-frame navigation/lifecycle events, recent response statuses, failed requests and pending resource paths/counts. These event-derived snapshots and the cached browser version distinguish a missing navigation commit, unfinished resource fetch and missing DOM readiness without making another browser request after failure. Assertion and runner deadlines remain independent of that projection.

The commit-diff stage subscribes before clicking the real file action and waits for the immutable Git-content response for the selected Node, workspace, file, side and commit. It checks HTTP status, committed text and rendered modified-side content within the existing 30-second readiness budget. Mounting `.monaco-diff-editor` alone is insufficient: the shell can exist while its asynchronous content-provider requests are still pending. The response path accepts the deployment prefix.

## Open questions

- Cross-origin credential exchange for a future isolated webview host remains undesigned.
- UNC/device workspace paths, search providers, and filesystem watching remain out of scope.
