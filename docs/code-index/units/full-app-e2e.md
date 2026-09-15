# Unit: full-application E2E

Files: test/app-e2e/run-app-e2e.mjs, test/app-e2e/mock-provider.mjs, test/app-e2e/core.e2e.mjs
Secondary files: packages/webui/test/lazyTimelineRestore.e2e.mjs, packages/webui/test/scrollState.e2e.mjs, packages/webui/test/sessionHeader.e2e.mjs, packages/webui/test/sessionListDrag.e2e.mjs, packages/webui/test/sessionListLiveRefresh.e2e.mjs, packages/webui/test/systemTabs.e2e.mjs

## Purpose

Owns deterministic end-to-end coverage through a real compiled Foxwarm server, built WebUI, browser, Session queue/tool/persistence paths, and authenticated transports while replacing only the external model network boundary.

## Behavior

- Creates one owned artifact/data root, synthetic token, minimal Agent memory, disabled Vector/workers/external channels, seeded Session authority, and loopback ephemeral application/provider ports.
- Starts `lib/index.js` in an owned process group and waits for an authenticated readiness route.
- Serves small expected OpenAI Responses SSE, Chat Completions SSE, and Responses WebSocket exchanges. Exact sequence/count validation rejects extra, reordered, invalid, or missing requests; requests and protocol selection remain observable without writing prompts, credentials, or request bodies to logs.
- Exercises browser send and control-released incremental rendering through one canonical commit/reload, structurally paired safe write/read tools, provider-observed Stop termination followed by a later new turn, accepted empty output text without retry, and a Chat Completions streaming tool turn.
- Covers Responses WebSocket same-socket suffix reuse, forced-close full replay, ordinary Session fork isolation, synchronous versus real background compact planning, BTW request scope, and stable persisted prompt-cache identity with purpose-specific provider keys.
- Uploads owned text and image files plus an opaque long-paste block through the real composer, verifies provider-visible serialization and canonical references, and checks accepted draft clearing and reload.
- Runs the six former developer-runtime browser files against only the generated Session set. Their mutations and cleanup cannot select or alter an existing installation.
- Applies finite child deadlines and idempotent bounded cleanup for the exact owned current test, application, diagnostic browser, and provider on success, startup failure, timeout, SIGINT, or SIGTERM. Startup checks cancellation between allocations, and an awaited provider, log, application, or diagnostic-browser allocation that completes after cancellation is disposed before later work. Cancellation does not launch the next test or a diagnostic browser. Failures retain provider/application/test logs, browser console, and screenshots below the owned run directory.

## Boundaries

The provider is a scripted protocol peer, not a generic mocking framework or alternate application service. SessionManager, MessageRouter, tool dispatch, JSON authority, catalog migration, HTTP authentication, WebUI realtime, and Chromium rendering remain production implementations. Existing transport and plan-validation unit tests remain in the routine unit baseline.