# Unit: External Node file consumers

Files: `dotnet/Foxwarm/Nodes/NodeConnectionHub.Files.cs`, `dotnet/Foxwarm/Sessions/SessionManager.NodeFiles.cs`

## Purpose

Connects whole-file transfer to actual copy, remote ToolScript source, image export/delivery, and administrator attachment ingress. The existing Node connection owns remote filesystem effects; Session history, Archive, canonical images, the Monty interpreter, and authenticated WebUI delivery remain Main-owned.

## Stable symbols and callers

- `NodeConnectionHub.ReadFileAsync` and `WriteFileAsync` send the official CLI `file_read_request`/`file_write_request` envelopes with the real Session and Agent. `HandleFileReply` settles only the corresponding response type and exact authenticated connection/transfer ID; replacement, removal, disconnect and shutdown fail that connection's pending transfers.
- `ReadNodeFileAsync`/`WriteNodeFileAsync` connect actual whole-file reads/writes to the existing Main filesystem implementation or remote transfer. Main uses regular-file/handle checks, native path resolution and atomic no-overwrite publication. Remote namespaces are never canonicalized by Main.
- `CopyBetweenNodesAsync` implements one read followed by one write. Relative paths use the Agent directory independently on each endpoint, not Session cwd.
- `SessionToolExecutor.ToolScript` loads remote `filePath` from the invocation's captured selected Node and cwd; the complete source is materialized under the existing source budget and strict UTF-8 decoding, not reconstructed from an ordinary read preview. Execution and continuation stay in the existing Main-owned Monty host; nested tools use their current real owner and ordinary dispatch.
- `SessionManager.ExportImageAsync` resolves only the sender's current history or effective Archive and canonical image store, then writes the target Node once. `SendFileAsync` reads remote bytes into unique Main delivery staging and uses the existing attached-channel checks and authenticated download route. Delivery failure does not delete an exported remote image or report successful delivery.
- `WebUiUploadedFiles.PrepareAsync` transfers staged attachments to an isolated Agent's bound Node and records the actual destination/Node in descriptors and partial saved-file results. Non-isolated uploads retain Main storage even when their Session selects a remote execution Node. Administrator ingress is not a model-tool invocation.

## Authorization and path contract

Copy/image/send use their real builtin identities, not additional ordinary `node:read`/`node:write` grants. Copy supplies independent source and target path facts before read and again before write: Main resolves from the caller's Agent directory and remote paths remain unresolved. Isolated copy permits Main own-Agent paths and the bound/current Node, but neither unrelated Nodes nor other Main directories. File builtin targeting preserves Main path and attached-destination restrictions. Remote ToolScript source alone retains the established concrete Node read authorization. Administrator attachment ingress uses the actual target owner and staging/path checks, not a fabricated model caller.

## Transport and failure contract

Whole transfers support files up to 50 MiB. The receive-frame ceiling accommodates base64 of that limit plus 1 MiB of envelope/path metadata, without unbounded transport allocation. Path metadata accepts up to 128 KiB of UTF-8, including extended remote Windows namespaces. Reads validate decoded size and the existing wire SHA-256 before use; write receipts validate size/SHA-256 against the bytes sent. No local staging/report hashes or secondary verification protocol are introduced. Source materialization is charged before base64 decoding rather than trusting a peer-reported size.

The CLI transfer write contract creates missing parents and defaults to no overwrite. This is separate from ordinary `write.createDirs`. Cancellation, timeout, disconnect and uncertain writes are never replayed; an already-started effect may remain. Unavailable Nodes/capabilities never fall back to Main. The existing post-write image partial result retains `fileWritten` and the actual path. A successful upload or file delivery does not commit a model turn or create destination Session history.

Code/PTY services, Shell HTTP, environment Providers, Worker ownership and external-owner execution are not connected by this unit.

## Tests

`dotnet/Foxwarm.Tests/Tools/NodeFileTransferTests.cs` uses real authenticated sockets for response type/connection correlation, SHA-256 rejection, cancellation/disconnect without replay, size/source-budget admission, endpoint authorization and Main Agent-relative/no-overwrite behavior. `packages/webui/test/experimentHostNodeFiles.e2e.mjs` uses two unchanged official CLI clients with different process defaults, Agent roots and Session cwd; schema-checked native model calls, full-source native Monty, 50 MiB reads/writes, binary/Unicode copies, image/crop/export/delivery, original picker and tool-row downloads, authenticated blob/download routes, partial failures, Stop/disconnect, canonical pairs and Archive equality. Physical Android and Windows devices remain qualification limits.
