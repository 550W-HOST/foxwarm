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
- Direct new-tab launches can open one folder. Embedded launches use a persistent `foxwarm.code-workspace`, so later folders append without replacing the iframe or losing editor/terminal state.
- The filesystem extension exposes fixed commands for the authoritative master app and data roots. They add an exact normalized root to the current multi-root workspace, then open Explorer and reveal it; they never derive these roots from a session node or cwd.
- A pinned MIT Red Hat YAML Web extension consumes the same static config schemas as Setup through a local contributor. Only the authoritative master app/models file URIs match.
- Main WebUI presents the feature as **Code** while route/package identifiers remain `/vscode-web`.

## WebUI launch and bridge

- `API_BASE_PATH` is converted to the deployment-relative `/vscode-web/` path; launch URLs preserve reverse-proxy prefixes.
- Embedded mode owns one top-level iframe portal. A restored inactive Code tab, or a logically active Code tab while the mobile list hides the workbench surface, does not create it; the first Code tab actually shown as active in any visible workbench pane starts it. Ordinary tab switching then hides/repositions the persistent iframe without unmounting it, while explicit Code-tab close destroys it and resets the bridge so reopening starts a fresh frame.
- Parent/workbench communication is versioned, exact-origin/source checked, and allowlisted to add-folder, open-file, and open-commit request shapes with acknowledgements.
- Direct `read`, `write`, `edit`, and actionable `apply_patch` tool paths remain plain text; after exact node/cwd/path resolution, an adjacent icon-only Code action may issue the open-file request. See [D-webui-tool-call-region](../units/webui-tool-timeline.md#d-webui-tool-call-region) for the interaction contract. Memory tools, nested descriptors, and ambiguous paths remain inert.
- New-tab mode carries initial target parameters; it does not control an already-open tab.

## Files, services, and terminals

- Master file/Git operations execute locally; remote operations require matching advertised `vscode-fs`/`vscode-git` versions.
- Optional `vscode-pty` owns remote PTY process state and emits fixed service events through the authenticated node connection.
- Terminal browser WebSockets attach to backend PTYs. Page reload detaches; explicit user close deletes.
- Terminal `code` helper uses a process-local random capability/socket and one Code-control terminal attachment; it has no browser/master credential.

## SCM and commit markers

- `foxwarm-scm` is read-only: status, individual/multi-diff, submodule transitions, and direct immutable commit details.
- Strict standalone model-authored commit markers render inert cards in WebUI; only a user click performs Git lookup/open.
- Commit resolution canonicalizes the Git top-level before persistent-workspace mutation and survives the resulting Code reload through extension state.

## Nested Foxwarm WebUI

- Code's Foxwarm sidebar embeds the normal session list/navigation leaf.
- Session, Agents, and Setup open deterministic read-only custom editors that embed strict leaf roots, not CSS-hidden full App instances.
- Fixed source/nonce messages open targets and report active target. An ordinary editor clears Foxwarm selection.
- Current authentication uses same-public-origin cookies. A cross-origin credential exchange for isolated wildcard webview origins is not implemented. The nonce-bound active-target bridge retains its singular selected target and also carries the deduplicated session IDs of every active Foxwarm Chat editor group for browser-local unread suppression/acknowledgement; that attention contract is canonical in [webui-session-list](../units/webui-session-list.md#design-decisions).

## Webview deployment

- Localhost uses hashed webview origins.
- Exposed production should use HTTPS plus a configured isolated wildcard origin.
- Same-origin capability fallback is functional but not origin-isolated; plain HTTP is not made secure by its narrow hash/service-worker compatibility patches.

## Compatibility

- Filesystem URI parser reads the earlier `foxwarm://node/<nodeId>/...` form; writers use current `node+<id>` authority.
- Generalized WebUI editor restore reads the older session-only extension state once.
- Missing optional workbench assets return an actionable 503 rather than a blank workbench.

## Design decisions

### D-code-official-workbench

Use official Code for the Web with browser extensions, not a Monaco clone or server-side Node extension host. Keep optional official workbench assets/caches separate from the ordinary WebUI bundle and source repository.

### D-code-real-path-uri

Represent node identity in URI authority and retain the real absolute POSIX path as URI path; do not invent opaque workspace-root IDs.

### D-code-persistent-workspace

Embedded Code uses one persistent multi-root workspace and an iframe that starts on first actual Code-tab visibility in the displayed workbench surface, not merely because a restored or logically active Code tab exists. Once started, ordinary tab switching or hiding the workbench preserves the iframe and background workbench state; explicit Code-tab close destroys the iframe and resets its bridge lifecycle so reopening creates a fresh frame. New folders/requests use a fixed bridge instead of reloading/replacing it.

### D-code-fixed-remote-services

Filesystem, Git, PTY, and helper behavior use authenticated fixed versioned services, not model tools or shell credentials.

### D-code-config-schema-assistance

Setup and Code reuse one public-safe build-time source for the Models and App Draft-07 schemas; they do not expose a schema endpoint or configuration values. Code bundles the pinned MIT Red Hat YAML Web extension from a SHA-256-verified Open VSX artifact and registers local schema content through its contributor API. Association is restricted to the exact normalized `foxwarm://node+master/...` URIs for the active app and models files returned by the authoritative fixed server response; remote nodes, arbitrary same filenames, and unrelated YAML do not match. The persistent Foxwarm workspace disables Red Hat telemetry, SchemaStore, Kubernetes CRD fetching, and extension recommendations by default without overwriting explicit values already stored in that workspace. A reviewed fail-closed preparation patch makes the telemetry library treat the effective disabled default as configured; all other vendor files remain unchanged. Diagnostics, hover, and completion are advisory: Setup keeps canonical backend validation, while a direct Code save can bypass those semantic validators. Missing optional YAML assets degrade to a clear extension-host log and do not disable Foxwarm filesystem commands.

### D-code-master-workspace-roots

Code commands for the Foxwarm app and data folders obtain `BASE_DIR` and the resolved `DATA_ROOT_DIR` from a fixed authenticated Code filesystem response. Both targets always use the master node, regardless of the current workspace, session node, or cwd. In the supported persistent multi-root workbench, commands append rather than replace workspace folders, compare normalized exact URIs for idempotence, reconcile a preexisting exact-root descriptor in place with its final stable label, await the ordinary workspace-folder change, and reveal the root in Explorer. When both runtime roots are the same path, they share one combined workspace folder instead of creating duplicate aliases. No reload-resume state or ownership protocol is used. A direct bare empty/single-folder Code launch may still add the root best-effort, but post-reload Explorer focus is not guaranteed and is outside this command contract.

### D-code-terminal-lifecycle

Page/extension reload detaches backend terminals; only explicit user close kills them. Matching terminals reattach after reload.

### D-code-read-only-scm

SCM and commit details support status/review/diff only. They do not add staging, commit, push, branch, credential, watcher, blame, or history-graph behavior.

### D-code-model-commit-marker

Only strict standalone model-authored markers outside code fences produce click-activated commit cards. Code opens canonical immutable details after the click.

## Canonical ownership

Dynamic public-path ownership is canonical in [D-webui-dynamic-base-path](../modules/webui.md#d-webui-dynamic-base-path).

## Open questions

- Scoped authentication for embedded leaf views on a separately configured isolated webview origin remains undesigned.
- Native Windows workspace path mapping, search providers, and filesystem watching remain out of scope.
