# Unit: webui-demo

Files: packages/webui/vite.demo.config.ts, packages/webui/demo/tsconfig.json, packages/webui/demo/src/entry.ts, packages/webui/demo/src/install.ts, packages/webui/demo/src/mock.ts, packages/webui/demo/scripts/generate.mjs, packages/webui/demo/scripts/main-host.mjs, packages/webui/demo/scripts/scripted-model.mjs, packages/webui/demo/scripts/matrix-stub.mjs, packages/webui/demo/scripts/gallery-script.mjs, packages/webui/demo/scripts/workspace.mjs, packages/webui/demo/scripts/record.mjs, packages/webui/demo/scripts/sanitize.mjs, packages/webui/demo/fixtures/snapshot.json, packages/webui/demo/fixtures/showcase/, packages/webui/test/webuiDemo.e2e.mjs
Secondary files: packages/webui/vite.config.ts, packages/webui/index.html, website/scripts/build-demo.mjs, website/package.json, website/astro.config.mjs, website/public/robots.txt, .github/workflows/website.yml

## Purpose

Builds a static, read-only copy of the real WebUI that the project website serves at `/demo/`. The unchanged WebUI application runs against a browser-side stand-in for the server that replays responses recorded from a real Main. It shows a fictional project's Sessions and a gallery of message, tool and timeline types without a server.

## Key contracts

- **The production WebUI bundle is unaffected.** The demo is a separate Vite build (`vite.demo.config.ts`) that merges the normal configuration and writes to its own output directory (`dist-demo/` by default, or `FOXWARM_DEMO_OUT_DIR`). It adds one module script before the unchanged `/src/main.tsx` entry and a `noindex, nofollow` robots meta tag. No WebUI source checks for demo mode.
- **Replayed data is recorded, not hand-written.** `fixtures/snapshot.json` holds HTTP responses and realtime frames captured from a disposable Main that ran the scripted gallery. Persisted inputs (`fixtures/showcase/`) use the canonical installation layout (`state/sessions`, catalog/archive/task SQLite stores, `agents.json`, `channels.json`, `nodes.json`, Agent memory files), so the generator exercises the real loaders.
- **Read-only.** GET requests and read-only list POSTs (`session-list/by-id`, `descendant-activity`, `children`, recorded `session-sequence`/`group-pages`) are answered from the snapshot. Every other request returns `403 {code:'DEMO_READ_ONLY'}` and shows a transient "Demo mode — read-only" notice; `window.alert` shows the same notice. Browser-local state (theme, Timeline mode, layout, drafts) works normally.
- **Deployment-relative.** All interception is keyed on `location.pathname + '/api'`, matching `API_BASE_PATH`, so the demo works under `/demo/` or any other prefix.
- **Public-safe snapshot.** `sanitize.mjs` maps generator paths to `/app/test`, the workspace to `/app/test/work/tidepool`, provider and Matrix URLs/keys to `example.*` placeholders, shifts generation-time timestamps to a fixed date, and fails if the snapshot still contains the generator token, temporary paths, the checkout path, the home directory or user name. Showcase fixtures use the neutral model ID `demo/demo-model`.

## Browser stand-in

- `entry.ts` fetches the snapshot (a separate hashed asset, loaded once) with top-level await, so the WebUI entry runs only after the shims are installed. Token sign-in is skipped because `GET /auth/session` answers `{role:'admin'}`.
- `mock.ts` indexes recorded GETs by path plus sorted query. History tails, continuous-history pages (`beforeSeq`/`afterSeq` sliced from the full recorded page), sidebar requests with an unrecorded `focusSessionId`, Session search (filtered client-side over recorded rows) and per-Session state have computed fallbacks. Unknown GETs return 404 with a `[Foxwarm demo]` console warning.
- `install.ts` replaces `fetch` for same-origin API/download URLs, replaces `WebSocket` for `…/api/webui/stream` with a socket that answers `set-subscriptions` with `subscriptions-accepted`, list rows, each Session's recorded `session-state` / `tool-call-snapshot` / `model-stream-snapshot` frames and `subscriptions-applied` (Logs subscriptions get `logs-error`; terminal sockets fail), and rewrites `img`/`source` `src` values that name recorded blobs or downloads to object URLs.
- `installClock` offsets `Date` to the recording time so running durations, "waiting" labels and relative dates read as they did when recorded.

## Generator

`node packages/webui/demo/scripts/generate.mjs` (needs a built Main, `DOTNET_ROOT`, and a Chromium for `FOXWARM_E2E_CHROMIUM`/`FOXWARM_CHROMIUM`):

1. Copies `fixtures/showcase` into a temporary data root, creates a fictional Git workspace (`workspace.mjs`), and starts a scripted OpenAI Responses-compatible model (`scripted-model.mjs`), a minimal Matrix homeserver (`matrix-stub.mjs`) and Main with `--installation-root` at the checkout so it serves the built WebUI.
2. `gallery-script.mjs` creates the `gallery` and `gallery-peer` Agents and drives each gallery Session through the real runtime: Markdown/math/Mermaid, reasoning and commentary, foreground/background `exec` and completion, file tools and patches, images and `send_file`, skills, `search_tools`/`call_tool`, ToolScript, a firing timer, Tasks, child Sessions, `send_to_session` and `wait`, model-written compaction and `recall`, tool errors, a failed model request, a stopped turn, `ask_user` answered and open, a Matrix message with its sender, an oversized Agent memory warning, a commit marker, and a running command with queued input. The running Session is recorded first, before its command finishes.
3. `record.mjs` subscribes to every Session over the realtime socket, reads per-Session HTTP data directly, then crawls the real WebUI in a headless browser through every Session and System surface, capturing every GET it makes.
4. The sanitized result is written to `fixtures/snapshot.json`. `--keep` retains the data root; `--serve` keeps Main running for inspection.

Regenerate after changes to the gallery script, showcase fixtures, or WebUI requests/responses that the snapshot must answer. The demo e2e test fails on any unrecorded request.

## Website integration

`website/scripts/build-demo.mjs` runs from the website `prebuild` script. It installs `packages/webui` dependencies with `npm ci` when they are absent, builds the demo into ignored `website/public/demo/`, and Astro copies it to `dist/demo/`. Shared sources' package imports (such as `js-yaml`) fall back to the WebUI or website installs when the repository root has no install. `robots.txt` disallows `/demo/`, the sitemap excludes it, and no site page links to it.

## Tests

- `packages/webui/test/webuiDemo.e2e.mjs` builds the demo (or uses `FOXWARM_DEMO_DIST`), serves it under `/demo/` from a plain static server, checks the noindex meta, that showcase Sessions are listed before the gallery, that every Session renders in Conversation, Grouped and Detailed modes with no failed, error or unrecorded request, and that sending a message is refused with the read-only notice.
- `website/tests/site.test.mjs` checks that `dist/demo/index.html` exists and is noindex, that `robots.txt` disallows `/demo/`, and that the sitemap and site pages do not reference it.
