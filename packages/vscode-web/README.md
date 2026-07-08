# Foxwarm VS Code Web Spike

This package is the start of a production-shaped integration for official VS Code for the Web.
It is intentionally separate from `packages/webui` so the VS Code workbench and extension-host assets do not enter the main Foxwarm WebUI bundle.

## Current spike scope

- Dedicated authenticated route: `/vscode-web`.
- Dedicated authenticated filesystem API prefix: `/api/vscode-web/fs`.
- Browser web extension: `foxwarm-fs`, served from `/vscode-web/extensions/foxwarm-fs/`.
- Optional official VS Code Web static assets served from `/vscode-web/static/` when prepared.
- URI shape: `foxwarm://node/<nodeId>/<absolute-path>`.
  - `node` is the namespace/type layer.
  - `<nodeId>` is currently only `master` on the backend.
  - The remaining URI path is the real absolute filesystem path.

Example workspace folder URI:

```text
foxwarm://node/master/home/ldmbot/git/foxwarm/
```

## Authentication

All VS Code Web routes use the same token mechanism as the main WebUI:

- `Cookie: foxwarm_token=<token>` / legacy `alphabot_token=<token>`
- or `Authorization: Bearer <token>`

The browser extension uses same-origin `fetch(..., { credentials: 'include' })`, so the normal WebUI login cookie is sent to `/api/vscode-web/fs/*`. Do not expose the filesystem API without this auth layer.

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

When the required static files exist (`out/vs/loader.js`, `out/vs/workbench/workbench.web.main.css`, `out/vs/workbench/workbench.web.main.js`), `/vscode-web` emits a VS Code Web workbench bootstrap that includes `foxwarm-fs` as an additional browser builtin extension and opens the requested `folderUri` query parameter, defaulting to the example URI above.

## Not in scope yet

- Committing VS Code Web static assets.
- Terminal integration.
- File/text search providers.
- File watching.
- Remote node filesystem implementation.

## Validation commands

```sh
npm --prefix packages/shared run build
npx tsc --noEmit
npm --prefix packages/vscode-web/foxwarm-fs test
node --test lib/vscodeWebRoutes.test.js
```
