# Foxwarm VS Code Web Spike

This package is the start of a production-shaped integration for official VS Code for the Web.
It is intentionally separate from `packages/webui` so the VS Code workbench and extension-host assets do not enter the main Foxwarm WebUI bundle.

## Current spike scope

- Dedicated authenticated route placeholder: `/vscode-web`.
- Dedicated filesystem API prefix: `/api/vscode-web/fs`.
- Browser web extension: `foxwarm-fs`, served from `/vscode-web/extensions/foxwarm-fs/`.
- URI shape: `foxwarm://node/<nodeId>/<absolute-path>`.
  - `node` is the namespace/type layer.
  - `<nodeId>` is currently only `master` on the backend.
  - The remaining URI path is the real absolute filesystem path.

Example workspace folder URI:

```text
foxwarm://node/master/home/ldmbot/git/foxwarm/
```

## Not in scope yet

- Vendoring or building the official VS Code Web static workbench assets.
- Terminal integration.
- File/text search providers.
- File watching.
- Remote node filesystem implementation.

## Intended next step

Use a pinned official VS Code Web static build (or `@vscode/test-web` during development) and include `foxwarm-fs` as an additional browser builtin extension. The workbench host should open a folder URI using the shape above.
