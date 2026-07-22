# Thread: node communication

## Overview

This thread owns the connection/dispatch contract among the master [nodes module](../modules/nodes.md), full [CLI node](../modules/cli-node.md), and lightweight [browser node](../modules/browser-node.md).

## Pairing and authentication

1. A new client connects to `/node_ws` in pairing mode and sends `pair_request`.
2. The master creates a pending record; an operator lists and approves/rejects it.
3. The approved client claims `nodeId` plus plaintext `authToken` once and stores it locally.
4. The master persists only the token hash.
5. The client reconnects in authenticated mode and sends `node_register` with tool definitions and optional versioned service capabilities.
6. The master registers the live connection in `nodesManager`.

## Model-tool flow

1. A session selects an online node through current-node/isolation permission evaluation.
2. Master dispatch sends `tool_call` with call/session IDs.
3. CLI node resolves shared `nodeTools` and optionally asks its TUI interceptor.
4. Browser node resolves only its advertised `browser_*` handlers and applies extension tab policy.
5. `tool_call_response` or `tool_call_error` resolves the master request.

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

## Heartbeat

- Master and CLI node both send WebSocket protocol ping frames every 30 seconds and require liveness within 10 seconds.
- Browser WebSocket automatically answers master's protocol ping.
- The browser extension also sends JSON `ping` and expects JSON `pong`; the master currently has no matching handler. This known mismatch can force extension reconnects and is not documented as a working symmetric heartbeat.

## Approved-node administration

- Remove deletes the approved hash, invalidates an unclaimed handoff, and closes the online runtime.
- Move preserves approved metadata/hash under a new ID and closes the old runtime. The client must update/restart or re-pair because no protocol rewrites local credentials.

## Bootstrap and setup

The master serves current launch scripts, compose, PowerShell, and a minimal dynamic source archive. The `skills/node-setup/SKILL.md` source skill is the single operator-facing pairing/bootstrap workflow. Agent-isolated worker creation begins only after an approved node is online.

## Units

- [src-nodes-manager](../units/src-nodes-manager.md)
- [src-nodes-misc](../units/src-nodes-misc.md)
- [src-nodes-registry](../units/src-nodes-registry.md)
- [CLI node client](../units/cli-node-client.md)
- [CLI node proxy](../units/cli-node-master-proxy.md)
- [CLI node TUI](../units/cli-node-tui.md)
- [browser node extension](../units/browser-node-extension.md)
- [shared node tools](../units/shared-node-tools.md)
- [terminal router](../units/src-terminal-router.md)

## Design decisions

### D-node-thread-tool-service-split

Model tools are agent-callable and may pass client approval. Backend services are fixed capability-versioned protocols for trusted master features.

### D-node-thread-authenticated-identity

Master authorization binds to the authenticated WebSocket node identity. Node IDs in event/tool payloads are data, not authority.

### D-node-thread-rename

Approved-node rename is registry move plus disconnect, not live protocol migration; local client credentials remain an operator concern.

### D-node-thread-helper-ipc

The terminal helper has only local capability IPC. Path resolution and remote routing stay inside trusted node/master processes and one Code control owner.

## Open questions

- Should the master add a JSON ping/pong compatibility message for browser clients, or should the extension remove its client-side JSON wait and rely on server protocol heartbeat plus normal socket close/error signals?
- Should a future API intentionally unify extension `browser_*` and shared `browse_*` tools, and if so which persisted/tool-schema compatibility contract is required?
