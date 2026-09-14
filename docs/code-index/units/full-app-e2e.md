# Unit: full-application E2E

Files: test/app-e2e/run-app-e2e.mjs, test/app-e2e/mock-provider.mjs, test/app-e2e/core.e2e.mjs
Secondary files: packages/webui/test/lazyTimelineRestore.e2e.mjs, packages/webui/test/scrollState.e2e.mjs, packages/webui/test/sessionHeader.e2e.mjs, packages/webui/test/sessionListDrag.e2e.mjs, packages/webui/test/sessionListLiveRefresh.e2e.mjs, packages/webui/test/systemTabs.e2e.mjs

## Purpose

Owns deterministic end-to-end coverage through a real compiled Foxwarm server, built WebUI, browser, Session queue/tool/persistence paths, and authenticated transports while replacing only the external model network boundary.

## Behavior

- Creates one owned artifact/data root, synthetic token, minimal Agent memory, disabled Vector/workers/external channels, seeded Session authority, and loopback ephemeral application/provider ports.
- Starts `lib/index.js` in an owned process group and waits for an authenticated readiness route.
- Serves small expected OpenAI Responses SSE and Chat Completions SSE exchanges. Unknown requests fail immediately; requests and protocol selection remain observable without writing prompts, credentials, or request bodies to logs.
- Exercises browser send and incremental rendering through one canonical commit/reload, sequential safe write/read tools, Stop of a held stream followed by a later new turn, accepted empty output text without retry, and a Chat Completions streaming tool turn.
- Runs the six former developer-runtime browser files against only the generated Session set. Their mutations and cleanup cannot select or alter an existing installation.
- Applies finite child deadlines and exact process-group teardown. Failures retain provider/application/test logs, browser console, and screenshots below the owned run directory.

## Boundaries

The provider is a scripted protocol peer, not a generic mocking framework or alternate application service. SessionManager, MessageRouter, tool dispatch, JSON authority, catalog migration, HTTP authentication, WebUI realtime, and Chromium rendering remain production implementations. WebSocket-specific model transport and fork/compact/BTW/attachment expansion are deferred follow-up scenarios; existing transport unit tests remain in the routine unit baseline.