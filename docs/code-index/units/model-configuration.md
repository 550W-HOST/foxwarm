# Unit: Model configuration, concrete hosts, and routing

Files: `dotnet/Foxwarm/Models/AppConfigurationRules.cs`, `dotnet/Foxwarm/Models/ConfiguredModelRequests.cs`, `dotnet/Foxwarm/Models/EffectiveRequestSelection.cs`, `dotnet/Foxwarm/Models/HostModels.Resolve.cs`, `dotnet/Foxwarm/Models/HostModels.cs`, `dotnet/Foxwarm/Models/ModelAttemptFailure.cs`, `dotnet/Foxwarm/Models/ModelConfiguration.Form.cs`, `dotnet/Foxwarm/Models/ModelConfiguration.Install.cs`, `dotnet/Foxwarm/Models/ModelConfiguration.cs`, `dotnet/Foxwarm/Models/ModelRequestOwner.cs`, `dotnet/Foxwarm/Models/ModelRequestScope.cs`, `dotnet/Foxwarm/Models/ModelRouting.cs`, `dotnet/Foxwarm/Models/ModelRoutingFingerprint.cs`, `dotnet/Foxwarm/Models/SessionModelSettings.cs`, `dotnet/Foxwarm/Models/SetupProviderRequests.cs`

## Purpose

Captures model YAML, derives concrete and virtual hosts, selects failover targets, tracks request owner/scope, and validates setup/configuration forms before a request reaches a provider.

## Stable methods and callers

- `ModelConfiguration` loads/reloads data-root YAML and exposes provider/model limits and setup data.
- `HostModels` resolves configured concrete hosts and virtual aliases; `ConfiguredModelRequests` prepares a request owner and concrete client settings.
- `ModelRouting.Select/RecordFailure/Health` applies deterministic target order, cooldown, and attempt attribution; `ModelRoutingFingerprint` identifies routing prefixes.
- `ModelRequestOwner`, `ModelRequestScope`, and `ModelAttemptFailure` carry owner/attempt lifecycle into retries, streaming, journal, and Session messages.
- `SetupProviderRequests` and `AppConfigurationRules` validate WebUI setup fields without changing active Session authority.

Callers: `SessionChatService`, provider adapters, `SessionModelSettings`, `HttpServer` startup, and WebUI setup routes.

## Contract and side effects

Concrete `contextLimit`, `maxOutput`, and `providerImageOutputFormat` resolve in order from model override, concrete provider, root `defaults`, startup app `llm`, and built-ins (200000, 32768, and `webp`). Every supplied scope validates even when masked; root defaults allow only these fields, virtual providers forbid them, and virtual context is the minimum resolved leaf window. Unknown provider types are rejected during installation and concrete dispatch; existing OpenAI aliases and empty-type fallback remain supported. Routing fingerprints include effective output and image settings. Physical requests use the selected leaf's max output and input-image format, while provider `extraFields` retain their established wire override precedence.

Virtual selection resolves to a concrete provider before network I/O; failures are attributed to the selected attempt and can enter cooldown. Configuration validation rejects unsupported provider shapes early. Model/effort setters remain ordinary save-lane operations, without notices or actor attribution. At each normal authoritative attempt, after owner retry preparation and concrete routing, `SessionChatService` adopts concrete model, effective Node and normalized effort through `SessionSaveLane.AdoptEffectiveSelectionAsync`. Initial adoption is silent except a missing-model fallback warning. Canonical model/Node changes and changed missing keys create one timestamped settings notice; same-effective aliases, effort-only changes and unattempted away-and-back placement do not. Automatic failover retains its reason. Metadata and any notice share the existing canonical commit/publication boundary; failed preparation cannot become a provider-health failure.

Between eligible retries, an explicitly changed raw model recaptures the live configuration, route generation and effort pair, even for a same-leaf alias. An effort-only edit or ordinary configuration reload does not replace the captured pair. The existing six-physical-attempt loop retains its remaining budget, prompt-cache lineage and committed history; a recapture or newly appended adoption notice refreshes request-owned history and journal/stream identity before serialization. Compact, background-compact and low-level/detached requests have no normal adoption callback. Immutable history provenance and per-record journal preparation remain unchanged.

`ModelConfiguration.InstallAsync` serializes native `set_config` and WebUI whole-document/section saves in one lane. A section save reads the latest installed document inside that lane. Validated UTF-8 candidates retain their exact bytes, are installed through a private same-directory atomic replacement, and report committed durability failures separately from validation failures. Models publish the validated live catalog; app access publishes the shared live snapshot after persistence. Other app configuration remains startup-captured. Result fields distinguish applied models/tool rules/access, unavailable declared MCP or channel runtime work, post-publication connection cleanup failures, and changed startup settings that require restart. The [access unit](./dotnet-access-identities.md) owns the staged MCP outcome; restart is not claimed to enable an absent transport. Candidate validation failure leaves the active bytes/catalog unchanged.

## Tests

`dotnet/Foxwarm.Tests/Models/RoutingAttemptsTests.cs`; `ProcessRestartTests.cs`; `RetryPreparationTests.cs`; `EffectiveSelectionTests.cs`; `dotnet/Foxwarm.Tests/Channels/AppConfigurationRulesTests.cs`; `ModelConfigurationInstallationTests.cs`; setup/model configuration tests.
