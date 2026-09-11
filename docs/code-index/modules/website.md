# Module: project website

## Responsibility

Owns the static public project homepage, user documentation, root installer download artifacts, and GitHub Pages build/deployment workflow. The website is an independent Astro/Starlight package under `website/`; it is not part of the Foxwarm runtime build or a hosted Foxwarm API/WebUI instance.

## Units

- [website site](../units/website-site.md) — Astro configuration, homepage, Starlight content, styling, copied public assets, validation, and Pages workflow.

## Public interfaces

- `https://foxwarm.550w.host/` — project homepage.
- `/docs/` — English user documentation.
- `/install-foxwarm.sh` and `/install-foxwarm.ps1` — byte-exact build copies of the repository-root installers.
- `npm ci`, `npm run build`, and `npm run check` from `website/` — standalone dependency, production-build, and validation boundaries.

## Invariants

- Website dependencies and Node requirements remain confined to `website/`; normal Foxwarm runtime install/build commands do not install or build the site.
- The site describes public `main` behavior and links to deeper repository references instead of publishing the full mixed-purpose `docs/` tree.
- The domain serves only static project content and downloads; it does not claim to host user Agents, WebUI, APIs, credentials, or runtime data.
- Installer output is copied from the root scripts during the site build and validated byte-for-byte.
- Pull requests may build and check the site but cannot deploy it. Production deployment consumes the Actions artifact only from public `main`; no branch-output commit or push credential is used.

## Design decisions

### D-website-independent-static-site

[2026-09-11] The public homepage and user documentation use one independent Astro/Starlight package deployed as a static GitHub Pages artifact at the custom-domain root. A custom homepage owns product orientation while Starlight owns `/docs/`; concise user guides are canonical website content, with links to deeper repository references. Installer files remain canonical at repository root and are copied byte-exact into the site output. This keeps website tooling out of runtime dependency/build requirements, avoids a committed `gh-pages` build branch, and prevents the documentation host from being confused with a hosted Foxwarm service.

## Integration notes

GitHub repository Pages settings and custom-domain configuration are external administrative prerequisites. The workflow assumes Pages is configured for GitHub Actions and does not attempt to create or administer the Pages site.
