# Module: project website

## Responsibility

Owns the static public project homepage, user documentation, root installer download artifacts, and GitHub Pages build/deployment workflow. The website is an independent Astro/Starlight package under `website/`; it is not part of the Foxwarm runtime build or a hosted Foxwarm API/WebUI instance.

## Units

- [Native CLI distribution](../units/native-cli-distribution.md) — independent protocol-keyed static downloads and release workflow.
- [website site](../units/website-site.md) — Astro configuration, homepage, Starlight content, styling, copied public assets, validation, and Pages workflow.

## Public interfaces

- `https://foxwarm.net/` — project homepage.
- `/docs/` — English user documentation with the standard Starlight article layout and navigation sidebar.
- `/install-foxwarm.sh` and `/install-foxwarm.ps1` — byte-exact build copies of the repository-root installers.
- `/demo/` — unindexed static [WebUI demo](../units/webui-demo.md) replaying recorded data; it has no server and accepts no writes. The homepage links to it, including `/demo/#session/<id>` links that open one recorded Session ([D-website-public-demo](#d-website-public-demo)).
- `npm ci`, `npm run build`, and `npm run check` from `website/` — standalone dependency, production-build, and validation boundaries.

## Invariants

- Website dependencies and Node requirements remain confined to `website/`, plus the existing `packages/webui` lockfile used only to build the `/demo/` bundle; normal Foxwarm runtime install/build commands do not install or build the site.
- The site describes public `main` behavior and links to deeper repository references instead of publishing the full mixed-purpose `docs/` tree.
- The domain serves only static project content and downloads; it does not claim to host user Agents, WebUI, APIs, credentials, or runtime data. The `/demo/` WebUI is a read-only replay of fictional recorded data, not a hosted instance; site pages may link to it, but the demo itself stays excluded from search indexing.
- Installer output is copied from the root scripts during the site build and validated byte-for-byte.
- Pull requests may build and check the site but cannot deploy it. Production deployment consumes the Actions artifact only from public `main`; no branch-output commit or push credential is used.

## Design decisions

### D-website-independent-static-site

**Derived delivery design; the separate static website/build proposal was approved.** It serves public documentation/downloads without coupling them to a running instance API. Root installer sources and real download consumers constrain published copies; framework/version pins and CI artifact transport are implementation choices, not deployment authority for an installation.

[2026-09-11] The public homepage and user documentation use one independent Astro/Starlight package deployed as a static GitHub Pages artifact at the custom-domain root. A custom homepage owns product orientation while Starlight owns `/docs/`; concise user guides are canonical website content, with links to deeper repository references. Installer files remain canonical at repository root and are copied byte-exact into the site output. This keeps website tooling out of runtime dependency/build requirements, avoids a committed `gh-pages` build branch, and prevents the documentation host from being confused with a hosted Foxwarm service.

### D-website-public-demo

**User decisions (user, 2026-11-15).** The `/demo/` WebUI replay is public and reachable from the homepage. It stays out of search results because it replays fictional data and should not look like a hosted instance. The exclusion is the `noindex, nofollow` robots meta on every demo page plus no sitemap entry; `robots.txt` does not disallow `/demo/`. A crawler that is barred from fetching a page never reads its `noindex`, and once indexed pages link to the demo, a disallowed URL can still be listed without content, so crawling stays allowed and `noindex` does the excluding. Indexed pages may link to the demo. These decisions replace the earlier rules that no site page links to the demo and that `robots.txt` disallows it.

[2026-11-15] The homepage navigation opens `/demo/`. The hero caption opens the Session shown in the hero screenshot, with one sentence saying the demo is a recorded, read-only workspace whose sessions and tool calls can be opened but nothing runs live. Feature sections whose subject has a recorded showcase Session (compaction and recall, Nodes, delegation) add an "Open in the demo" link through the WebUI's inbound `#session/<id>` route. The channel section has none: the recording has no Session attached to a group chat, and the gallery's single channel message does not show its chat context in the timeline. Session links must name Sessions in the recorded snapshot, so regenerating the fixture with different Session IDs requires updating the links.

## Integration notes

GitHub repository Pages settings, custom-domain configuration, Cloudflare proxy/download routing, and old-domain redirects preserving paths and queries are external administrative prerequisites. The canonical domain is `foxwarm.net`; Pages remains the documentation origin and the independent downloads Worker owns only `/downloads/*`. The workflow assumes Pages is configured for GitHub Actions and does not attempt to create or administer the Pages site.
