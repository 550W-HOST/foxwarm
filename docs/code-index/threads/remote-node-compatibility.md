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

These remain real repository components. The .NET host now connects the external Node tool/exec and authenticated Session-event paths below, while the broader Source protocol remains a compatibility reference rather than a blanket runtime-support claim.

## .NET external Node integration

```text
Administrator onboarding / Node pairing
  -> ApprovedNodeRegistry + independent Node credentials
  -> /node_ws or /node/shell/* -> NodeConnectionHub (authenticated capability snapshot)
  -> SessionOwner + SessionSaveLane Node selection
  -> ToolRegistry + concrete authorization
  -> advertised Node tool/exec -> exact-connection reply
  -> exact exec grant / current placement -> durable Session event admission + ACK
  -> existing JSON / image / ToolScript result pipeline
```

The [external Node unit](../units/external-nodes.md) owns the concrete trust/connection symbols. The `.NET` stage connects persistent approved credentials, pending approval/rejection/offline claim/one-hour expiry, administrator onboarding/list/inspect/rename/remove, packaged setup assets, credential-authenticated registration, incompatible quarantine, replacement fencing, browser JSON heartbeat, current/explicit-target ordinary tools, and request-time placement context. Agent binding is existing Agent metadata, not a new principal, Session or worker platform.

Credential revalidation/durable Touch and connection publication share the hub lifecycle lock with administrator removal and rename. Revocation persists before retiring the connection; a precommit failure leaves it usable, while a committed durability failure retires it and still reports the failure. Completed removal or rename cannot be followed by publication under the old credential identity.

Explicit tool/command selection commits `currentNode` and clears `cwd` through the real owner save lane. The authenticated composer instead retains cwd using the same lane; its catalog/topology directory, locked Agent binding and original-App consumers are mapped by [the WebUI contract unit](../units/dotnet-webui-core.md). Agent binding is a separate metadata operation: a nonempty binding updates each Session's `currentNode` through that lane without clearing cwd; clearing isolation preserves selection and cwd, and rule-only updates do not change placement. A normal non-isolated model caller can bind its own Agent during its active turn. Existing isolated-caller restrictions and owner deletion/move admission fences remain in force; activity alone does not prohibit binding. Failure or cancellation of explicit selection fences every remaining unstarted model-batch call, including neutral wrappers and later selections. Node/cwd capture preserves remote namespaces and the existing Main-local unset-cwd invocation semantics. Offline Nodes do not block Main-owned history/status/deletion, and remote effects never fall back to Main. Peer results cannot create Main control receipts or path/cwd authority. Concrete remote file-tool sidecars may supply bounded display-only resolved paths, stamped with the captured execution Node for Code actions; unknown relative tool paths remain inert.

The [remote exec unit](../units/remote-exec.md) connects foreground/background exec, Source-compatible signed start-time authority, strict bounded completion receipts/ACK, exact active waits and advertised Stop/Run queued handshakes. Rename/delete, disconnect/removal, restart and shutdown use the existing owner lifecycle; restart does not reconstruct active execution authority or resend commands. Named model-created Sessions, children, forks and timer-created Sessions preserve applicable source/captured or bound placement, including offline Main-owned admission. The [file consumers unit](../units/external-node-files.md) connects 50 MiB whole-file transfer/copy, remote ToolScript source, image export/delivery and bound-Agent attachment ingress. Code/PTY consumers now connect through the [fixed service transport](../units/external-node-services.md), preserving existing Master-local routes and official browser extensions. The [Shell HTTP transport](../units/external-shell-http.md) now connects the unchanged exec-only POSIX sh/curl client through the same Node identity and completion boundaries. Negotiating protocol 3 alone does not expose external-owner or Worker behavior. Ordinary inline native ToolScript calls are connected. Official CLI and Chrome MV3 extension qualification uses real owned host/client processes; the exec/Session-event phase uses the unchanged official CLI and actual .NET save lanes, plus focused protocol peers for legacy and fault cases; physical Android hardware remains unqualified.

The following sections describe the broader Source/package contracts, not additional current `.NET` capabilities.

## Pairing and capability boundary

CLI pairing sends `pair_request`; approved credentials reconnect authenticated and send `node_register` with the core protocol range, tool definitions, and optional versioned services. Current CLI/Main peers negotiate the newest intersecting core range (1–3); absent range is legacy generation 1. An authenticated but incompatible peer remains in upgrade-required quarantine for heartbeat/diagnostics and advertises no executable tools/services. Authentication alone does not establish capability compatibility.

Model tools and backend services remain separate: `tool_call`/result paths can pass client approval, while `node_service_request`, `node_service_command`, and `node_service_event` are fixed capability-versioned trusted services. File transfer is a CLI whole-file base64-plus-SHA-256 boundary; browser Node does not gain file transfer by protocol similarity. PTY input/resize/helper acknowledgements use command framing; output/exit/helper-open use event framing. Missing/old service capability rejects instead of falling back to Master.

## Identity, external ownership, and completion

Main authorization binds to authenticated socket Node identity; payload `nodeId` is data, not authority. The negotiated-v3 CLI may advertise `externalToolOwner:1`; disjoint external calls carry an explicit external identity/context and are rejected before effect when malformed or mixed with Session/Agent fields. They do not fabricate an Agent, Session, filesystem sandbox, or Main fallback.

Remote background exec completion is a narrower acknowledged protocol exception. Main reserves the generated exec identity before dispatch and signs a capability scoped to authenticated Node, source Session, and exact exec. The CLI persists the record and submits one deterministic completion event through correlated request/ACK transport; rejection, disconnect, missing ACK, or transport ambiguity retain an unexpired record for retry. Tracking-only records expire strictly after 24 hours without killing the process, deleting artifacts, or emitting a late completion event. Main restart does not reconstruct result authority. Session rename validates current canonical/alias ownership; deletion fences matching transient state.

## Tool-result and transport compatibility

Current CLI/browser writers use structured image result fields; any old source-specific image shapes belong only in a read-old adapter at remote response ingress, never in generic image processing or new writers. Browser extension `browser_*` tools and shared Puppeteer `browse_*` tools remain distinct. The .NET transport supports both socket ping/pong liveness and the official extension's JSON ping/pong. The extension path is qualified without changing its client.

## Current gaps

Worker ownership remains migration work; connected ordinary tools, exec/completion, whole-file consumers and fixed Code/PTY services do not establish those capabilities. Root package start/build still targets TypeScript Main (`lib/index.js`); `.NET Program.cs` is an experiment/host entry with explicit environment requirements, not a switched root launcher. Vector admission/search is not a current .NET capability.

## Canonical units and tests

- [External Node trust and ordinary tools](../units/external-nodes.md)
- [Shared Node protocol](../units/shared-node-protocol.md)
- [Shared persistent exec](../units/shared-persistent-exec.md)
- [CLI Node](../units/cli-node-client.md)
- [Browser Node](../units/browser-node-extension.md)
- [Android Node](../units/shared-and-nodes-android-node.md)
- [Sandbox Node](../units/src-docker-worktree-provider.md)
- [Tools/permissions](./tools-permissions-and-exec.md)
- shared protocol, CLI compatibility, browser protocol/tool-result, Android auth, and sandbox worktree tests.
