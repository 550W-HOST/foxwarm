# Unit: webui-node-onboarding

Files: packages/webui/src/components/NodeOnboardingModal.tsx, packages/webui/test/nodeOnboarding.e2e.mjs
Secondary files: packages/webui/src/components/NodesView.tsx, src/channels/webuiNodeOnboarding.ts

## Purpose

Provides friendly, explicitly invoked Node setup and pending approval inside the independent Nodes page. The canonical onboarding contract is [D-node-thread-onboarding-options](../threads/node-communication.md#d-node-thread-onboarding-options).

## Exports and function index

- `useNodePendingApprovals(enabled)` — owns one visibility-aware five-second pending refresh, cancellation/publication fencing, exact total, and bounded page navigation. Explicit refresh replaces an in-flight request; ordinary timer ticks do not overlap. Empty out-of-range pages return to the last available page.
- `NodeOnboardingModal` — mounted-only setup method/address/name controls, pairing/token mode selection, generated commands and explicit creation, copy action and pending approval. Escape/backdrop/close unmount it; focus is confined and restored.
- `post(path, body)` — modal-owned authenticated request with no-store caching and abort on unmount.
- `updateCommands()` — explicit address/name/directory regeneration; default address gives config precedence, later user input is an override.
- `createNode()` — explicit, non-retried creation returning a per-node credential and direct-auth commands for all methods; selecting a method or authentication mode never creates trust.
- `approve(request)` — explicit pending approval, inline errors and Node/pending refresh after acceptance or stale state.

## Behavior and integration

- Linux CLI, interactive CLI, Shell, Docker and Windows are ordinary method choices. Systemd and manual Compose are optional method-specific controls. Non-Shell methods default to pairing approval and offer pre-created token mode; Shell always uses direct authentication.
- The modal requests setup credentials only on open, explicit creation or explicit command update. Pending polling and ordinary Node status responses contain no credentials. All setup state remains within this mounted component; close aborts requests and discards it, without browser storage or token-bearing URLs/logs.
- An unset configured address uses browser origin plus the deployment prefix derived from the existing API base. The server validates but never fetches that address. A created identity and its original address/name remain bound until close. Switching to pairing exposes independent editable drafts; switching back restores the bound identity, never a stale draft paired with its token. Directory edits invalidate Linux commands until explicit update; this submits the mounted credential for pure command regeneration without recovery, creation or rotation. Setup controls are disabled during an action to keep its result bound to the submitted inputs; close stays available.
- The Nodes surface owns the hook only while visible or the modal is open. Hidden documents pause dispatch and abort current requests; view unmount cancels timers and rejects late publication. No global poll or realtime topic is added.
- The directory refresh is reused after actions. Architecture Session topology and Agent management remain separate.

## Tests

The browser fixture uses React 18, production theme/CSS, actual Chromium, real authenticated HTTP routes and a fresh temporary Main registry/catalog. It covers independent Nodes rendering and Architecture summary navigation, deployment-prefix fallback, explicit literal address override/copy, true pending total refresh without credential reload, hidden-page pause, stale approval recovery, explicit Shell and full-CLI creation, all pairing/token methods and variants, copied commands, duplicate and failed creation, directory regeneration without identity changes, switching between edited pairing drafts and a bound token, and reopening without retained credentials. A delayed accepted creation response is discarded on close without retrying or revoking that identity. It verifies no setup token enters storage or request URLs. Screenshots use only synthetic fixture data. No deployed Node, credential or shared runtime is used.
