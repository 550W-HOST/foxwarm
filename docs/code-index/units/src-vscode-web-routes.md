# Unit: VS Code Web routes

Files: src/vscodeWebRoutes.ts, src/vscodeWebRoutes.test.ts

## Purpose

Registers the optional authenticated Code for the Web workbench, static/extension/webview bootstrap routes, persistent-workspace bridge bootstrap, and master/remote filesystem plus read-only Git APIs.

Cross-module behavior: [Code integration](../threads/code-integration.md).

## Export

- `registerVscodeWebRoutes(httpServer)` — register every Code route.

## Route groups

### Workbench and assets

- `GET /vscode-web` / trailing slash — workbench bootstrap or actionable non-cacheable 503 when required assets are absent.
- `/vscode-web/static/*` — prepared official workbench assets under normal WebUI authentication.
- `/vscode-web/extensions/foxwarm-{fs,terminal,scm,webui}/*` and optional `/vscode-web/extensions/redhat-vscode-yaml/*` — bundled browser-extension assets under normal authentication.
- `/vscode-web/webview/<process-capability>/...` — narrowly scoped official `pre/` webview bootstrap; capability URL is supplied only to an authenticated workbench.

Required official asset files are loaded from `FOXWARM_VSCODE_WEB_ASSET_DIR` or the ignored package asset directory. `FOXWARM_VSCODE_WEB_WEBVIEW_ORIGIN`, `FOXWARM_VSCODE_WEB_DEFAULT_FOLDER_URI`, and `FOXWARM_VSCODE_WEB_WORKSPACE_PATH` select current deployment behavior.

When no explicit default-folder URI is configured, a direct workbench launch derives its master URI from the canonical `BASE_DIR`. It does not probe installation-specific filesystem paths. The fixed workspace-roots response remains authoritative for app/data commands.

### Filesystem API

Authenticated routes under `/api/vscode-web/fs` implement stat, directory read, file read/write, directory create, delete, and rename against real absolute POSIX paths. File read/write cap is 50 MiB.

`GET /api/vscode-web/fs/workspace-roots` returns fixed versioned master app/data root descriptors plus exact active app/models file descriptors. It is non-cacheable and contains no configuration document or credential.

`master` executes locally. Other node IDs require an online node advertising compatible `vscode-fs`; absent/old/offline nodes return explicit service errors.

### Git API

Authenticated routes under `/api/vscode-web/git` provide:

- status via porcelain v2 and canonical Git top-level;
- immutable/working content for diff documents;
- commit metadata and rename-aware first-parent (or empty-tree root) file/stat diff for a direct hexadecimal commit ID.

Master Git uses argument-array process spawning. Remote status/content use `vscode-git` v1; commit details require v2. The routes are read-only and do not implement staging, commit, push, branches, credentials, or history graph.

## Workbench bootstrap

- Uses `foxwarm://node+<node-id>/<absolute-path>` folder URIs.
- Direct launches may open one folder; embedded and commit launches use a persistent `foxwarm.code-workspace`.
- The bootstrap installs fixed browser extensions as additional builtins.
- The persistent workspace supplies opt-out defaults for Red Hat telemetry, SchemaStore, Kubernetes CRD fetching, and extension recommendations while preserving explicit values already stored in that workspace.
- A versioned same-origin parent-source-checked request/ack bridge accepts only fixed add-folder/open-file/open-commit requests.
- Runtime URLs are derived from the actual browser path so reverse-proxy prefixes survive even when a stripping proxy does not provide `X-Forwarded-Prefix`.
- Missing individual assets are 404; missing required workbench assets produce the 503 setup page.

## Webview compatibility

- Localhost uses Code's hashed webview host shape.
- Production may provide an isolated wildcard origin.
- Same-origin fallback uses an unguessable process capability and distinct per-webview path; it disables the webview service worker to avoid same-origin content-routing conflicts.
- Plain HTTP on a non-loopback host uses a narrowly scoped parent-origin hash fallback for functionality but is not secure/origin-isolated. Exposed deployments should use HTTPS and an isolated wildcard origin.

## Dependencies

- `HttpServer` shared authentication/static routing.
- `nodesManager` and shared VS Code node-service definitions.
- Local filesystem and Git process APIs.
- Prepared optional workbench assets and bundled browser-extension directories.

## Design decisions

### D-code-routes-auth-boundary

Workbench, static, extension, filesystem, and Git routes use WebUI authentication. The unauthenticated webview route is restricted to one unguessable process capability and official bootstrap assets only.

## Canonical ownership

Remote service ownership: [D-code-fixed-remote-services](../threads/code-integration.md#d-code-fixed-remote-services). Git mutation boundary: [D-code-read-only-scm](../threads/code-integration.md#d-code-read-only-scm).
Master app/data workspace command ownership: [D-code-master-workspace-roots](../threads/code-integration.md#d-code-master-workspace-roots).
