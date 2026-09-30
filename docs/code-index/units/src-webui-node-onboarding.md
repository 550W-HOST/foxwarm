# Unit: src-webui-node-onboarding

Files: src/channels/webuiNodeOnboarding.ts, src/channels/webuiNodeOnboarding.test.ts
Secondary files: src/channels/webuiChannel.ts, src/nodes/bootstrapInfo.ts, src/nodes/registry.ts

## Purpose

Registers focused Main-authenticated WebUI Node setup/approval actions without adding pairing identities, protocols or token recovery. Canonical contract: [D-node-thread-onboarding-options](../threads/node-communication.md#d-node-thread-onboarding-options).

## Export and function index

- `registerWebUiNodeOnboardingRoutes(server)` — installs the four onboarding routes through ordinary `HttpServer.addRoute` authentication, with no-store responses.
- `objectBody(req)` / `stringField(value, fallback, name, max)` — validate small expected request fields without returning request credentials in errors.
- `commandInput(req)` — chooses an explicit address override, otherwise configured public URL or caller's browser fallback; reuses public URL validation, validates name/directory and never fetches the address.

## API and authority

| Route | Observable behavior |
|---|---|
| `POST /api/nodes/onboarding/commands` | Uses the shared pure command generator, resolving configured/default/explicit addresses and returning modal-owned setup commands. Only this setup request includes the shared pairing credential. |
| `GET /api/nodes/onboarding/pending` | Filters out approved offline handoffs, reports the real remaining total and at most 50 allowlisted metadata rows, with offset continuation. No tokens, hashes or capability bodies leave this list. |
| `POST /api/nodes/onboarding/approve` | Explicitly approves an unapproved request through the existing registry. Returns only Node ID and live delivery status. Missing/stale/already-approved/name-conflict state is 409; invalid names are 400. |
| `POST /api/nodes/onboarding/create-shell` | Explicitly reserves a new approved ID, rejecting online/approved/reserved conflicts, and returns the direct-auth command once after the existing hash persistence. It does not register an online Node or create pending state. |

All routes retain ordinary authenticated Main cookie/Bearer authorization. Credentials do not enter ordinary `/nodes` or pending metadata responses, URLs or route logs. Shared bootstrap credentials are read only for the commands action; per-node credentials appear only in the explicit create response. No creation retry, receipt platform or server fetch of user-provided URLs is introduced.

The registry checks the same unapproved pending entry immediately before trust mutation after asynchronous allocation. Two concurrent browser approvals therefore cannot turn the same request into two identities; already approved offline credentials remain claimable through the existing Node protocol.

## Integration and tests

`WebUIChannel` registers this helper only with WebUI enabled. The [modal](./webui-node-onboarding.md) owns command responses and explicit actions; ordinary Node summaries remain unchanged. CLI help and external bootstrap information share `buildNodeBootstrapCommands` without adding model-tool parameters.

The route fixture uses a temporary Main data/config directory and real authenticated HTTP, registry persistence, pending approval and credential verification. It checks config precedence/user override, invalid URLs, no implicit create, 50-row bounds with exact totals, offline-approved exclusion, concurrent/stale approval, explicit Shell create/conflicts/hash authentication, no-store and secret-free summaries. Separate browser coverage exercises the same routes from the actual React component.
