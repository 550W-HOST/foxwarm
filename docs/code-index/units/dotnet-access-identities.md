# Unit: .NET shared access identities and scoped WebUI

Files: `dotnet/Foxwarm/AccessConfiguration.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiAccess.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiSessionImages.cs`
Secondary files: `dotnet/Foxwarm/HttpServer.cs`, `dotnet/Foxwarm/MainHost.cs`, `dotnet/Foxwarm/Models/AppConfigurationRules.cs`, `dotnet/Foxwarm/Models/ModelConfiguration.Install.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiRealtime.cs`

## Purpose and source contract

Implements the shared [access identity decision](./src-access-config.md#d-config-shared-access-identities) and [Session scope contract](../modules/webui.md#d-webui-identity-session-scope) at the .NET Main boundary. A scoped browser identity is not an administrator or an internal Session principal. The built original React entry mounts `WebUiIdentityApp`, not an administrator workbench leaf.

The empty MCP surface is validated and persisted by the same snapshot owner. Normal Main registers the [ordinary inbound MCP service](./dotnet-inbound-mcp.md), and successful live installation reports `access.surfaces.mcp` applied, including first/last identity activation without restart. When no HTTP runtime was started, a newly declared MCP surface is saved but reported not applied and requiring restart. Inbound MCP remains separate from browser/admin authority and outbound administrator OAuth routes.

## Producer and authority map

| Source producer/caller | .NET owner and consumer |
| --- | --- |
| `accessConfig.ts`, `setupConfig.ts`, startup `config.ts` | `AccessConfiguration.Normalize`, `AppConfigurationRules`, `ModelConfiguration.Access`: one Main live immutable snapshot, no token store, issuer or watcher. |
| `configInstaller.ts`, Setup and `set_config` | Existing serialized `ModelConfiguration.InstallAsync`: validate before replacement, preserve raw bytes, publish access after successful persistence, then invoke all transport fences before awaiting cleanup. |
| `httpServer.ts` and WebUI verifier | `HttpServer`: instance Bearer/raw or derived administrator cookie remains full authority; configured WebUI Bearer/cookie grants only the explicit browser route allowlist. |
| `webuiSessionScope.ts`, catalog aliases/membership | `WebUiAccess.Canonical`, `Allows`, `Project`: exact bindings resolve committed aliases; Agent scopes enumerate actual current membership, including unprefixed main-Agent identities. Missing and ambiguous bindings deny. |
| `webuiChannel.ts` request tracking, scope checks, uploads | `WebUiRequest`, `WebUIChannel` partials, `WebUiUploadedFiles`: captured identity values, post-await checks, identity/Session-owned staging, final pre-admission assertion through the existing save lane. |
| `webuiRealtime.ts`, Session SSE | `WebUiRealtime`, compatibility SSE and tracked HTTP contexts: scope checks before payload writes, selective credential/scope revocation and stale canonical-stream fencing. |
| Session blob/reference and download routes | `WebUiSessionImages`, image store and existing `WebUiDownloadSignatures`: active or committed effective Archive references, Session route grants, existing byte/MIME/HEAD/prefix delivery. |

## Validation and live installation

`Normalize` validates the complete map: at most 64 bounded identity IDs; distinct bounded Bearer tokens; nonempty explicit surfaces; empty `mcp` object only; nonempty distinct WebUI Session bindings with only exact IDs or `<agent>/*` patterns. Unknown nested keys and invalid values yield secret-free errors. HTTP-enabled Main reserves the instance token before Session startup. Supported saves check both reserved active-token reuse and the current existing administrator token file before touching the active YAML, including headless hosts and token-file changes since startup. Save-time reads share the startup file reader and its UTF-8/trim semantics, but never create a missing token.

`AccessConfiguration.ApplyAsync` publishes the normalized snapshot, synchronously invokes every listener and then awaits all cleanup. WebUI comparison uses token and WebUI bindings only. An MCP-only edit or another identity's change does not revoke unrelated browser work. Cleanup failure reports `access.identities` applied plus `access.connections` not applied; it does not claim rollback. Unrelated startup settings remain startup-owned and channel results retain their existing unsupported-runtime reporting.

## Browser boundary and retained effects

`WebUiAccess.BrowserRoute` is an explicit allowlist: auth introspection, restricted Session list, active/continuous history, Session WS/SSE, Session-bound uploads, text ingress and referenced Session image reads/grant issuance. All other management endpoints remain administrator-only, including Code capability issuance, Setup, Nodes, model/cwd controls, debug/state/context expansion, tasks and lifecycle commands. Existing independent Node, Code resource and OAuth callback paths retain their original authorities.

Auth introspection projects current canonical IDs and role features. Scoped `/api/sessions` exposes only ID, display name and busy state. History removes only the persistent prompt snapshot, using existing safe chat/tool/queue projections rather than broad tool-result redaction. Session-state DTOs retain Source's browser presentation fields, not mutable owner authority.

Captured browser requests compare live token/WebUI bindings and current catalog resolution at supported post-await payload/effect boundaries. Credential/scope changes abort only affected tracked HTTP/WS/SSE work. Canonical stream bindings are fenced when a move changes their resolution or Agent membership. WS rejects catalog/log subscriptions and inaccessible or unresolved Session subscriptions before loading state.

Scoped input accepts text parts only and rejects leading slash commands, including mention-prefixed forms. All supplied uploads are checked for identity/Session ownership before preparation; checks recur after asynchronous reads and before file/router effects. The final queue assertion executes in the ordinary ordered save lane after image preparation and before hot admission. Administrator selected-Session commands, `controlRequestId` and ordinary best-effort input semantics remain unchanged.

Temporary scoped uploads carry process-local identity/Session authority. Revocation discards affected staging ownership and removes those temporary files, while preserving unrelated or still-valid owners. A file already saved in its Agent/Node destination or input already admitted is not rolled back. Partial upload failures report actual saved files.

Session blob reads and issuance require live scope plus an active-history reference, or a sequence-proven effective Archive reference no later than the committed frontier. Continuous image URLs carry the archive sequence. An already-issued valid Session/global/path signature remains an independent resource capability through its original expiry or instance-token rotation; ordinary identity revocation does not revoke it. Signature namespaces include the route Session ID. Invalid signatures do not veto valid ordinary credentials, and signing does not authorize management or additional issuance.

## Tests

`WebUiAccessTests` covers whole-map validation, secret-safe errors, raw persistence/publication order, failed-save nonpublication, all-listener fencing, configuration-only MCP staging and post-publication cleanup outcomes, selective surface changes, upload ownership and independent grant namespaces/lifetime. Existing startup, upload, download, realtime, history and owner tests remain the administrator/regression boundary.

`packages/webui/test/experimentHostScopedAccess.e2e.mjs` uses a disposable normal .NET host, real Setup and model `set_config`, original administrator/restricted React roots, distinct scoped users, exact/Agent scopes and moves, active/effective Archive images and signed GET/HEAD, denied management/forged input, held HTTP/WS/SSE/upload/input work, and truthful already-admitted/saved effects. It uses only synthetic credentials and caller-owned data.
