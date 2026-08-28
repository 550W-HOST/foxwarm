# Thread: node communication

## Overview

This thread owns the authenticated remote transport contract among the master [nodes module](../modules/nodes.md), full [CLI node](../modules/cli-node.md), and lightweight [browser node](../modules/browser-node.md). The authenticated WebSocket transport is one implementation behind the generic Node provider boundary; it is not the definition of every Node.

## Pairing and authentication

1. A new client connects to `/node_ws` in pairing mode and sends `pair_request` with its supported core Node-protocol range.
2. The master creates a pending record; an operator lists and approves/rejects it.
3. The approved client claims `nodeId` plus plaintext `authToken` once and stores it locally.
4. The master persists only the token hash.
5. The client reconnects in authenticated mode and sends `node_register` with the same core protocol range, tool definitions, and optional versioned service capabilities.
6. The master negotiates the newest intersecting core protocol generation before registering the live connection in `nodesManager`. A missing range is legacy generation 1.
7. A compatible Node becomes ready. An authenticated incompatible Node stays connected in an `upgrade-required` quarantine for heartbeat and diagnostics, but advertises no executable tools/services and cannot be selected or dispatched.

## Model-tool flow

1. Main's generic Node registry resolves the exact selected Node to the authenticated remote provider after current-node/isolation permission evaluation.
2. Master dispatch sends `tool_call` with call/session IDs.
3. CLI node resolves shared `nodeTools` and optionally asks its TUI interceptor.
4. Browser node resolves only its advertised `browser_*` handlers and applies extension tab policy.
5. `tool_call_response` or `tool_call_error` resolves the master request. Current nodes write canonical structured image fields. The master applies the isolated old-node result reader described in [D-node-thread-tool-result-compatibility](#d-node-thread-tool-result-compatibility) only at this remote response ingress.

The browser extension's `browser_*` tools and shared Puppeteer `browse_*` tools are distinct current surfaces.

## File transfer and backend services

- CLI node supports bidirectional whole-file transfer as one base64 payload plus SHA-256 metadata in a JSON request/response. Browser node does not implement file transfer.
- Nodes may advertise fixed versioned backend services separately from model tools.
- Code filesystem/Git use correlated `node_service_request` responses.
- Optional remote PTY lifecycle uses requests; latency-sensitive input/resize/helper acknowledgements use `node_service_command`; output/exit/helper-open use `node_service_event`.
- Backend service calls do not pass through model-tool approval and reject absent/old capability versions instead of falling back to master paths.
- Terminal `code` helper uses node-local capability IPC and existing authenticated transports; it receives no master/browser credential and targets one explicit Code-capable terminal attachment.

## Session events

CLI node's local loopback trigger and other authenticated node senders use `session_event`. Master permits delivery only when the target session currently selects that node or belongs to an isolated agent bound to it. The authenticated connection's node ID, not a payload claim, is the authorization input.

Remote background exec completion is a narrower protocol exception, not a generic session-event grant. Master assigns the exec ID and a signed capability scoped to the authenticated node, source session, and exec before dispatch. The CLI node persists both with the running entry, submits one deterministic completion event through correlated request/ACK transport, and retains the entry for retry until Master durably accepts it. Master derives authorization from the signed start-time grant rather than mutable `currentNode`. The deterministic mailbox identity suppresses an exact retry while its row remains retained; the exact Session owner separately bounds its authoritative receipt field to the newest 32 accepted IDs.

## Heartbeat

- Master and CLI node both send WebSocket protocol ping frames every 30 seconds and require liveness within 10 seconds.
- Browser WebSocket automatically answers master's protocol ping.
- The browser extension also sends JSON `ping` and expects JSON `pong`; the master currently has no matching handler. This known mismatch can force extension reconnects and is not documented as a working symmetric heartbeat.

## Approved-node administration

- Remove deletes the approved hash, invalidates an unclaimed handoff, and closes the online runtime.
- Move preserves approved metadata/hash under a new ID and closes the old runtime. The client must update/restart or re-pair because no protocol rewrites local credentials.

## Tool-result compatibility

- Current CLI and browser-extension screenshot writers emit `inlineData` with `mimeType`; they never write text markers or source-specific base64 fields.
- `src/nodes/legacyToolResultCompatibility.ts` is the one read-old boundary for remote node results. It recognizes prior `{image, encoding, format}`, `{screenshot, mimeType}`, `__IMAGE__`, and `__SCREENSHOT__` wire shapes and converts them to the current structured form before generic tool-result processing.
- The generic image pipeline does not recognize those old node shapes. Identical text from master tools or MCP remains ordinary tool output.
- The compatibility file, its test, and its single `NodesManager.handleToolResponse` call form one deletable unit. They can be removed together after supported nodes and extensions have all upgraded to structured writers.

## Bootstrap and setup

The master serves current launch scripts, compose, PowerShell, and a minimal dynamic source archive. The `skills/node-setup/SKILL.md` source skill is the single operator-facing pairing/bootstrap workflow. Agent-isolated worker creation begins only after an approved node is online.

## Units

- [src-nodes-manager](../units/src-nodes-manager.md)
- [src-node-providers](../units/src-node-providers.md)
- [src-nodes-misc](../units/src-nodes-misc.md)
- [src-nodes-registry](../units/src-nodes-registry.md)
- [CLI node client](../units/cli-node-client.md)
- [CLI node proxy](../units/cli-node-master-proxy.md)
- [CLI node TUI](../units/cli-node-tui.md)
- [browser node extension](../units/browser-node-extension.md)
- [shared node tools](../units/shared-node-tools.md)
- [shared Node protocol](../units/shared-node-protocol.md)
- [terminal router](../units/src-terminal-router.md)

## Design decisions

### D-node-thread-tool-service-split

Model tools are agent-callable and may pass client approval. Backend services are fixed capability-versioned protocols for trusted master features.

Generic Node/provider ownership is canonical in [D-dispatch-generic-node-providers](./tool-dispatch.md#d-dispatch-generic-node-providers).

### D-node-thread-authenticated-identity

Master authorization binds to the authenticated WebSocket node identity. Node IDs in event/tool payloads are data, not authority.

### D-node-thread-core-protocol-compatibility

[2026-08-28] Authentication establishes Node identity but does not imply execution compatibility. Current Master and official Nodes implement the bounded core range 1-2 and choose the newest intersection, so current peers use generation 2 while a missing offer or response is legacy generation 1 and remains executable during either Node-first or Master-first rolling upgrades. Explicit malformed metadata still rejects, and a disjoint range leaves the authenticated transport connected and visible as `upgrade-required` while every tool, file, backend-service, selection, and session-event path fails before remote dispatch with `NODE_PROTOCOL_INCOMPATIBLE`. Compatibility is transport-wide because request IDs, result envelopes, execution IDs, session events, and service framing are one coupled contract; per-tool and backend-service versions remain subordinate capability metadata.

Generation 1 uses the official pre-generation-2 transport/completion contract. Persistent exec is its only current compatibility bridge: Master first sends the ordinary one-hyphen petname, falls back to a newly allocated `exec_<petname>` only after the exact legacy pre-start validation error `Persistent exec ID is invalid.`, and retries a legacy allocation only after the exact pre-start duplicate message for that attempted ID. Structured collision retry remains the generation-2 contract. Timeouts, transport ambiguity, generic errors, and any response that could follow process start never retry. Each actual exec, capability, ACK, mailbox event, receipt, recovery record, timeout result, and returned ID therefore uses one exact successful identity without an alias.

### D-node-thread-remote-exec-completion

Remote exec completion uses an acknowledged, retryable, start-authorized protocol. The authenticated socket identity and a Master-signed capability bind one node, source session, and exec ID; changing `currentNode` after start does not revoke that completion route. Master acknowledges only after the deterministic external event is durably accepted. The deterministic external event ID is the mailbox intent identity, so an exact retained mailbox row suppresses its retry before or after application. The exact Session owner also retains the newest 32 accepted IDs, guaranteeing suppression after mailbox cleanup while an ID remains in that authoritative field. Eviction from Session receipts does not promise that an older retry will be re-admitted because its exact mailbox row may still exist. Generic node-originated session events retain the ordinary current-node or isolated-agent ownership rule.

### D-node-thread-rename

Approved-node rename is registry move plus disconnect, not live protocol migration; local client credentials remain an operator concern.

### D-node-thread-helper-ipc

The terminal helper has only local capability IPC. Path resolution and remote routing stay inside trusted node/master processes and one Code control owner.

### D-node-thread-tool-result-compatibility

Official node and browser-extension tool writers use the current structured `inlineData` / `inlineDataItems` result fields with camel-case `mimeType`. Old source-specific image payloads are read only by one pure compatibility adapter at the master remote-node response ingress. Generic tool processing accepts only the current structured fields. Keep the adapter isolated so deleting its file, tests, and one ingress call is the complete migration from read-old/write-new compatibility to a strict current-node requirement.

## Open questions

- Should the master add a JSON ping/pong compatibility message for browser clients, or should the extension remove its client-side JSON wait and rely on server protocol heartbeat plus normal socket close/error signals?
- Should a future API intentionally unify extension `browser_*` and shared `browse_*` tools, and if so which persisted/tool-schema compatibility contract is required?
