# Unit: website site

Files: website/package.json, website/package-lock.json, website/wrangler.jsonc, website/astro.config.mjs, website/tsconfig.json, website/.gitignore, website/scripts/sync-assets.mjs, website/tests/site.test.mjs, website/public/robots.txt, website/src/content.config.ts, website/src/pages/index.astro, website/src/pages/zh/index.astro, website/src/pages/404.astro, website/src/components/Home.astro, website/src/components/HandsDiagram.astro, website/src/components/Screenshot.astro, website/src/components/Icon.astro, website/src/i18n/home.ts, website/src/i18n/home.en.ts, website/src/i18n/home.zh.ts, website/src/styles/home.css, website/src/styles/docs.css, website/src/styles/diagram.css, website/src/content/i18n/zh-CN.json, website/src/assets/foxwarm-wordmark-light.svg, website/src/assets/foxwarm-wordmark-dark.svg, website/src/content/docs/docs/index.mdx, website/src/content/docs/docs/installing.md, website/src/content/docs/docs/model-setup.md, website/src/content/docs/docs/model-options.md, website/src/content/docs/docs/history-search.md, website/src/content/docs/docs/mcp-inbound.md, website/src/content/docs/docs/agents-sessions-memory.md, website/src/content/docs/docs/tools-skills-mcp.md, website/src/content/docs/docs/nodes.md, website/src/content/docs/docs/channels.md, website/src/content/docs/docs/data-upgrades-backups.md, website/src/content/docs/docs/typescript-migration.md, website/src/content/docs/docs/faq.md, website/src/content/docs/docs/quick-start.md, website/src/content/docs/docs/how-it-works.mdx, website/src/content/docs/docs/delegation.md, website/src/content/docs/docs/timers.md, website/src/content/docs/docs/webui.md, website/src/content/docs/docs/access-control.md, website/src/content/docs/zh/docs/, .github/workflows/website.yml
Secondary files: README.md, install-foxwarm.sh, install-foxwarm.ps1, packages/webui/public/favicon.svg, packages/webui/public/favicon-32x32.png, packages/webui/public/favicon-128x128.png

## Purpose

Builds and validates the public Foxwarm project website and focused user documentation without entering the main runtime package graph.

## Behavior

- `astro.config.mjs` fixes the canonical origin at `https://foxwarm.net`, enables static output and sitemap generation, and configures Starlight routes, navigation, search, branding, edit links, and documentation CSS.
- The custom homepage is bilingual: `src/pages/index.astro` (English, `/`) and `src/pages/zh/index.astro` (Simplified Chinese, `/zh/`) both render `components/Home.astro` with copy from `src/i18n/home.{en,zh}.ts`; pages declare canonical and `hreflang` alternates for each other. Documentation links currently point to the English `/docs/`.
- Product imagery uses real WebUI screenshots of a demo installation with fictional project data, captured at 2x in light and dark variants and swapped by the page theme (`src/assets/screens/`, rendered by `Screenshot.astro` through `astro:assets` AVIF/WebP). Conceptual visuals that are not product UI — the brain/hands Node diagram and the group-chat channel example — are drawn in HTML/CSS and labeled as illustrations in their accessible names, so they are never presented as screenshots.
- Homepage facts (platforms, install prerequisites, feature claims) must match current user documentation; capabilities that require configuration are described as configurable rather than default behavior.
- `src/content/docs/docs/` owns English user guides, grouped in the Starlight sidebar as Get started (overview, quick start, install, model setup), Concepts (how it works, Agents/Sessions/memory, long conversations), Use (delegation, Nodes, Channels and group chats, tools/Skills/MCP, timers, WebUI), Control and security (access control incl. per-Agent rules, Node trees and credential-isolation configuration; inbound MCP) and Operate (data/backups, model options, TypeScript migration, FAQ). Existing slugs are kept stable. Detailed implementation references remain in the repository.
- Docs use Starlight i18n with English at the root locale and Simplified Chinese at `/zh/docs/`. Only core pages are translated under `src/content/docs/zh/docs/` (overview, quick start, install, model setup, how it works, channels); other `/zh/docs/` routes are Starlight fallbacks showing English with a notice from `src/content/i18n/zh-CN.json`. The homepage links each language to its docs locale and shares Starlight's `starlight-theme` storage key so the theme carries across.
- The docs palette and type in `docs.css` match the homepage; `HandsDiagram.astro` and its `diagram.css` are shared by the homepage and the how-it-works pages.
- The tools/Skills and inbound MCP guides navigate to the bundled access-control, agent-management, and mcp-management workflows. The inbound guide distinguishes separately permitted history reads from explicit online text replies; detailed reply setup remains in the MCP skill reference.
- `scripts/sync-assets.mjs` copies both repository-root installers and the existing WebUI favicon assets into ignored `website/public/` build inputs before development or production build.
- The test suite validates required routes, canonical URLs, indexability, local links/assets, installer byte parity and file identity, robots/sitemap output, Pagefind search output, and absence of unresolved installer-host placeholders.
- The Pages workflow uses immutable revisions of official checkout, Node setup, Pages artifact upload, and deploy actions. It installs the website with `npm ci`, runs the standalone check, and uploads `website/dist`. Pull requests are checked but only a successful `main` push or a manual run explicitly selected on `main` can deploy; permissions are job-scoped and deployment is serialized.

- `wrangler.jsonc` provides a separate Cloudflare Workers Static Assets preview target named `foxwarm-preview`, serving only `dist/` with the custom 404 page and version preview URLs. Workers Builds uses `website` as its root and `npm ci && npm run check` as its build command. Production-branch deployment uses `npx wrangler deploy`; non-production branches use `npx wrangler versions upload`. This target does not replace the canonical GitHub Pages deployment or configure its domain.

## Tests

From `website/`:

```bash
npm ci
npm run check
```

`npm run check` creates the static `dist/` output and runs `node:test` assertions against it. Browser sanity checks use the built preview for desktop/mobile layouts, both color modes, keyboard navigation, docs search presence, and horizontal overflow.

## Integration

README and the main installation guide address new C# users: prerequisites, installation, first model setup and ordinary controls. Commands target the normal public `main` branch. TypeScript-to-C# cutover details belong in the dedicated migration guide, reached by short links rather than repeated in the main entry. The data/update guide owns data-root selection, backups and platform update ordering; optional Vector native requirements belong beside search setup. User setup examples belong in the website guides; the Channels guide owns its starter configuration rather than linking back to README. README installation commands and documentation links use the canonical public domain. The PowerShell installer's header example uses the same URL, and both source installers check the WebUI build requirement (`^20.19.0 || >=22.12.0`) before cloning or installing dependencies. Source prerequisites and support limits link to [source Main entry](./source-main-entry.md); installer downloads remain generated copies, not a separate implementation. Canonical architecture and deployment ownership are recorded in [D-website-independent-static-site](../modules/website.md#d-website-independent-static-site).
