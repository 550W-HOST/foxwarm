# Thread: Remote Node and Worker compatibility

## Producer to consumer paths

```text
CLI/browser/Android/sandbox Node
  -> shared protocol + pairing/auth + capability negotiation
  -> authenticated transport/proxy/service framing
  -> Node-local file/exec/tab/device/worktree operation
  -> correlated result/event/ack
  -> current TypeScript Main or package consumer
```

These remain real repository components, but are not shown as a .NET `SessionOwner` child chain: the current .NET host has local file/exec/terminal/MCP implementations and compatibility adapters without a blanket claim that remote Node/Worker runtimes are wired into .NET Main.

## Pairing and capability boundary

CLI pairing sends `pair_request`; approved credentials reconnect authenticated and send `node_register` with the core protocol range, tool definitions, and optional versioned services. Current CLI/Main peers negotiate the newest intersecting core range (1–3); absent range is legacy generation 1. An authenticated but incompatible peer remains in upgrade-required quarantine for heartbeat/diagnostics and advertises no executable tools/services. Authentication alone does not establish capability compatibility.

Model tools and backend services remain separate: `tool_call`/result paths can pass client approval, while `node_service_request`, `node_service_command`, and `node_service_event` are fixed capability-versioned trusted services. File transfer is a CLI whole-file base64-plus-SHA-256 boundary; browser Node does not gain file transfer by protocol similarity. PTY input/resize/helper acknowledgements use command framing; output/exit/helper-open use event framing. Missing/old service capability rejects instead of falling back to Master.

## Identity, external ownership, and completion

Main authorization binds to authenticated socket Node identity; payload `nodeId` is data, not authority. The negotiated-v3 CLI may advertise `externalToolOwner:1`; disjoint external calls carry an explicit external identity/context and are rejected before effect when malformed or mixed with Session/Agent fields. They do not fabricate an Agent, Session, filesystem sandbox, or Main fallback.

Remote background exec completion is a narrower acknowledged protocol exception. Main reserves the generated exec identity before dispatch and signs a capability scoped to authenticated Node, source Session, and exact exec. The CLI persists the record and submits one deterministic completion event through correlated request/ACK transport; rejection, disconnect, missing ACK, or transport ambiguity retain an unexpired record for retry. Tracking-only records expire strictly after 24 hours without killing the process, deleting artifacts, or emitting a late completion event. Main restart does not reconstruct result authority. Session rename validates current canonical/alias ownership; deletion fences matching transient state.

## Tool-result and transport compatibility

Current CLI/browser writers use structured image result fields; any old source-specific image shapes belong only in a read-old adapter at remote response ingress, never in generic image processing or new writers. Browser extension `browser_*` tools and shared Puppeteer `browse_*` tools remain distinct. Heartbeat is asymmetric where current clients require it: protocol ping/pong is the transport liveness contract, while an extension JSON ping/pong mismatch remains a compatibility gap rather than a documented working path.

## Current gaps

Remote Node topology and Worker ownership remain migration work. Root package start/build still targets TypeScript Main (`lib/index.js`); `.NET Program.cs` is an experiment/host entry with explicit environment requirements, not a switched root launcher. Vector admission/search is not a current .NET capability.

## Canonical units and tests

- [Shared Node protocol](../units/shared-node-protocol.md)
- [Shared persistent exec](../units/shared-persistent-exec.md)
- [CLI Node](../units/cli-node-client.md)
- [Browser Node](../units/browser-node-extension.md)
- [Android Node](../units/shared-and-nodes-android-node.md)
- [Sandbox Node](../units/src-docker-worktree-provider.md)
- [Tools/permissions](./tools-permissions-and-exec.md)
- shared protocol, CLI compatibility, browser protocol/tool-result, Android auth, and sandbox worktree tests.
