# Unit: website site

Files: website/package.json, website/package-lock.json, website/astro.config.mjs, website/tsconfig.json, website/.gitignore, website/scripts/sync-assets.mjs, website/tests/site.test.mjs, website/public/robots.txt, website/src/content.config.ts, website/src/pages/index.astro, website/src/pages/404.astro, website/src/styles/home.css, website/src/styles/docs.css, website/src/assets/foxwarm-wordmark-light.svg, website/src/assets/foxwarm-wordmark-dark.svg, website/src/content/docs/docs/index.mdx, website/src/content/docs/docs/installing.md, website/src/content/docs/docs/model-setup.md, website/src/content/docs/docs/agents-sessions-memory.md, website/src/content/docs/docs/tools-skills-mcp.md, website/src/content/docs/docs/nodes.md, website/src/content/docs/docs/channels.md, website/src/content/docs/docs/data-upgrades-backups.md, website/src/content/docs/docs/faq.md, .github/workflows/website.yml
Secondary files: README.md, install-foxwarm.sh, install-foxwarm.ps1, packages/webui/public/favicon.svg, packages/webui/public/favicon-32x32.png, packages/webui/public/favicon-128x128.png

## Purpose

Builds and validates the public Foxwarm project website and focused user documentation without entering the main runtime package graph.

## Behavior

- `astro.config.mjs` fixes the canonical origin at `https://foxwarm.550w.host`, enables static output and sitemap generation, and configures Starlight routes, navigation, search, branding, edit links, and documentation CSS.
- `src/pages/index.astro` provides a custom accessible homepage with install/docs/source entry points, restrained light/dark styling, and a clearly labeled system illustration rather than a simulated product screenshot.
- `src/content/docs/docs/` owns nine initial user pages: documentation index, install, model setup, concepts/memory, tools/Skills/MCP, Nodes, Channels, data/upgrades/backups, and FAQ.
- `scripts/sync-assets.mjs` copies both repository-root installers and the existing WebUI favicon assets into ignored `website/public/` build inputs before development or production build.
- The test suite validates required routes, canonical URLs, indexability, local links/assets, installer byte parity and file identity, robots/sitemap output, Pagefind search output, and absence of unresolved installer-host placeholders.
- The Pages workflow uses immutable revisions of official checkout, Node setup, Pages artifact upload, and deploy actions. It installs the website with `npm ci`, runs the standalone check, and uploads `website/dist`. Pull requests are checked but only a successful `main` push or a manual run explicitly selected on `main` can deploy; permissions are job-scoped and deployment is serialized.

## Tests

From `website/`:

```bash
npm ci
npm run check
```

`npm run check` creates the static `dist/` output and runs `node:test` assertions against it. Browser sanity checks use the built preview for desktop/mobile layouts, both color modes, keyboard navigation, docs search presence, and horizontal overflow.

## Integration

README installation commands and documentation links use the canonical public domain. The PowerShell installer's header example uses the same URL, but installer behavior remains unchanged. Canonical architecture and deployment ownership are recorded in [D-website-independent-static-site](../modules/website.md#d-website-independent-static-site).
