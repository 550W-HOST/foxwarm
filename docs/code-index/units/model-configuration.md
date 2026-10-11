# Unit: Model configuration, concrete hosts, and routing

Files: `dotnet/Foxwarm/Models/AppConfigurationRules.cs`, `dotnet/Foxwarm/Models/ConfiguredModelRequests.cs`, `dotnet/Foxwarm/Models/HostModels.Resolve.cs`, `dotnet/Foxwarm/Models/HostModels.cs`, `dotnet/Foxwarm/Models/ModelAttemptFailure.cs`, `dotnet/Foxwarm/Models/ModelConfiguration.Form.cs`, `dotnet/Foxwarm/Models/ModelConfiguration.Install.cs`, `dotnet/Foxwarm/Models/ModelConfiguration.cs`, `dotnet/Foxwarm/Models/ModelRequestOwner.cs`, `dotnet/Foxwarm/Models/ModelRequestScope.cs`, `dotnet/Foxwarm/Models/ModelRouting.cs`, `dotnet/Foxwarm/Models/ModelRoutingFingerprint.cs`, `dotnet/Foxwarm/Models/SessionModelSettings.cs`, `dotnet/Foxwarm/Models/SetupProviderRequests.cs`

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

Virtual selection resolves to a concrete provider before network I/O; failures are attributed to the selected attempt and can enter cooldown. Configuration validation rejects unsupported provider shapes early. Model/effort updates are staged by Session save-lane settings operations and do not become a provider request until the next turn.

`ModelConfiguration.InstallAsync` serializes native `set_config` and WebUI whole-document/section saves in one lane. A section save reads the latest installed document inside that lane. Validated UTF-8 candidates retain their exact bytes, are installed through a private same-directory atomic replacement, and report committed durability failures separately from validation failures. Models publish the validated live catalog; app configuration remains startup-captured. Result fields distinguish applied models/tool rules, unsupported access/channel runtime work, and changed startup settings that require restart. Candidate validation failure leaves the active bytes/catalog unchanged.

## Tests

`dotnet/Foxwarm.Tests/Models/RoutingAttemptsTests.cs`; `ProcessRestartTests.cs`; `RetryPreparationTests.cs`; `dotnet/Foxwarm.Tests/Channels/AppConfigurationRulesTests.cs`; `ModelConfigurationInstallationTests.cs`; setup/model configuration tests.
