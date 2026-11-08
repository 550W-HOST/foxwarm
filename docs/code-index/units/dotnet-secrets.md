# Unit: .NET secret store, references and redaction

Files: `dotnet/Foxwarm/Secrets/InstanceKeys.cs`, `dotnet/Foxwarm/Secrets/SecretStore.cs`, `dotnet/Foxwarm/Secrets/SecretReferences.cs`, `dotnet/Foxwarm/Secrets/SecretRedactor.cs`, `dotnet/Foxwarm/Secrets/SecretMessageRedaction.cs`, `dotnet/Foxwarm/Secrets/SecretRequestStage.cs`, `dotnet/Foxwarm/Secrets/SecretExposures.cs`, `dotnet/Foxwarm/Secrets/InstanceSecrets.cs`, `dotnet/Foxwarm/Secrets/SecretConfigurationChanges.cs`, `dotnet/Foxwarm/Models/ModelConfiguration.Secrets.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Secrets.cs`, `packages/webui/src/components/SecretsPanel.tsx`
Secondary files: `dotnet/Foxwarm/Models/ModelRequestOwner.cs`, `dotnet/Foxwarm/Models/HostModels.cs`, `dotnet/Foxwarm/Models/SetupProviderRequests.cs`, `dotnet/Foxwarm/Tools/ToolRegistry.cs`, `dotnet/Foxwarm/Sessions/Turns/LocalSessionTurnHost.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Wait.cs`, `dotnet/Foxwarm/Sessions/SessionManager.cs`, `dotnet/Foxwarm/Sessions/External/ClaudeSessionDriver.cs`, `dotnet/Foxwarm/Vector/VectorRuntime.cs`, `dotnet/Foxwarm/MainLog.cs`, `dotnet/Foxwarm/McpConfiguration.cs`, `dotnet/Foxwarm/Channels/ManagedChannels.cs`, `dotnet/Foxwarm/Asr/AsrProxy.cs`, `dotnet/Foxwarm/Tools/LocalExecManager.Native.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Nodes.cs`

## Purpose and contract

Credentials that Main uses on the user's behalf are stored once, encrypted, and referenced from configuration as `${secret:NAME}`. Only Main-owned consumers resolve references, at the moment they build a provider request, channel connection, MCP connection or ASR proxy. No route, tool or log returns a stored value. A central redactor masks known values before they enter Session history, model or embedding requests, tool results and Main logs.

Masking is accident protection for known values and their common encodings. It does not stop code that deliberately transforms a value (for example a shell command that reverses or splits it), and it does not make a non-isolated master `exec` a security boundary. The guarantees are the write-only store, Main-side resolution and the policy restrictions below.

## Store and key

`InstanceKeys` owns `<data root>/keys/secrets.key`: a versioned JSON document with a key ID and 32 random bytes, created once at Main start in an owner-only directory (0700) and file (0600) through a temporary file and a no-overwrite move. Purpose keys are derived with HKDF-SHA256 (`foxwarm/<purpose>/v1`); `secret-store` encrypts the store and `text-redaction-placeholder` is reserved for reversible text redaction. The key directory is outside `state/` so state backups and Git-backed copies do not carry it; restores must carry the key separately. When `state/secrets.json` exists and the key file does not, Main never creates a replacement key: the store stays locked, references fail closed with a safe message, and Setup shows the locked state.

`SecretStore` keeps `state/secrets.json` (owner-only, atomic writes). Each name has a description and versions; each version is AES-256-GCM sealed with AAD `name\0version\0keyId`. Names are 1-64 lowercase letters, digits, `.`, `_` or `-`. Values are at most 64 KiB without NUL. Replacing or deleting a value retires the current version; retired values stay in the redactor for 90 days and are then pruned. Values shorter than 12 characters are accepted and resolved but are not redactable, and Setup says so. `Generation` changes on every mutation; the model catalog cache, MCP pooled-connection comparison and the redactor rebuild from it.

## References and sinks

`SecretSinks` declares where references are allowed and how a literal in that field is treated:

- Models: `providers.*.apiKey`, `providers.*.extraHeaders.*`, per-model `extraHeaders.*`, and the legacy `models.*` equivalents.
- App: `llm.openaiApiKey`, `llm.anthropicApiKey`, `asrService.key`, and channel credential fields (`botToken`, `accessToken`, `token`, `clientSecret`, `encodingAESKey`, `webhookUrl`, `aibot.websocket.secret`).
- MCP servers: `token`, `headers.*`, `env.*`, `args[]`, `url`, `oauth.clientSecret`.

Validation rejects a reference anywhere else and malformed names. Resolution works on a copy; a missing name resolves to empty text and is reported per consumer. The model catalog records missing names per provider, including an inherited legacy `llm` key, so only that provider fails (`ModelPreparationException`, before any provider contact). Channels, MCP servers and the ASR proxy report `SecretUnavailableException` messages that name the secret and point to Setup. Setup's model list and connection test resolve references in the unsaved draft the same way.

Changing a secret restarts running channels that reference it and retries enabled referencing channels that are not running. MCP connections whose resolved configuration changed are replaced on next use. The ASR proxy resolves at construction and needs a restart.

## Redaction points

`InstanceSecrets` builds one `SecretRedactor` from the store's current and retained values plus literal sources: model and app credential fields (labelled with their configuration path, for example `models.openai.apiKey` or `config.channels.tg.botToken`), access identity tokens, the instance token, the Node event capability secret, the Node pairing token and MCP static credentials and OAuth tokens. URL fields contribute only userinfo, query and fragment parts; environment entries count only for credential-like names; arguments are not literal sources. Sources are re-read at most every five seconds, immediately after configuration installation, or when the store generation changes; a change also schedules a background rebuild, because log lines and canonical appends use the last built matcher and never rebuild it themselves. Other readers wait for an in-progress rebuild instead of masking with an older matcher.

The matcher covers raw text, JSON string escapes, upper/lower percent-encoding, upper/lower hex and the stable core of base64/base64url at every byte alignment, using leftmost-longest matching. Matches become `[[FW_SECRET:<label>]]`, where the label is the secret name or configuration path. Masking is irreversible.

| Point | Owner | Notes |
| --- | --- | --- |
| R1 tool results | `ToolRegistry.ExecuteAsync`, after dispatch and before programmatic/output-guard handling | Source `tool-output`. |
| R2 history | `SessionSaveLane` queue admission (`input`) and `LocalSessionTurnHost.PrepareCanonicalAppend` (`history`) | Covers user input, timers, background exec completion and every canonical append. The append path uses the last built matcher because it runs under the Session state gate. |
| R3 model requests | `ModelRequestOwner`, stage S after request defaults and before the journal manifest and `PrepareRequest` | Instructions, tool definitions and history copies; changed rows lose their stored origin. Also the Claude runtime prompt file and stdin input, and in-process embedding input. |
| R4 logs | `MainLog` capture, per complete line, for file and console | Uses the last built matcher and never rebuilds under the console lock. |

Reasoning is never rewritten. Thinking parts, provider reasoning metadata (signatures, encrypted or redacted thinking, thinking summaries, Responses reasoning items) and legacy thinking/reasoning content blocks stay byte-identical so replay keeps working; a known value found there is recorded as an exposure with a `-reasoning` source suffix. `inlineData` and `inlineDataRef` parts are skipped.

`SecretExposures` records label, count, first/last time, last redaction point and last Session ID in `state/secret-exposures.json` (debounced, at most 512 labels). Content is never recorded. Setup shows these as rotation hints and can dismiss them.

## Model-facing restrictions

Writer tools (`write`, `edit`, `apply_patch`, `mcp_config`) and `set_config` candidates reject input containing a marker whose label belongs to a currently masked value, because writing it back would replace the real value. Text that only mentions the marker format, or labels that are not masked, stays writable. Until tool policy can grant secret use explicitly, `set_config` cannot change a provider, channel, `llm` or `asrService` entry that references a secret (before or after the change, including a provider that inherits a referenced legacy key), and `mcp_config` cannot add references or change a referencing server beyond `enable`, `description` and `timeoutSeconds`. `mcp_config` still accepts literal credentials; they become redactor sources.

Master `exec` inherits Main's environment except TMUX variables and any variable whose value exactly equals a known value. `node_bootstrap_info` writes the pairing token to a new owner-only file at the required absolute `filePath` on master and returns instructions with `PAIRING_TOKEN` in its place; the path is an authorization fact like `node_create_auth_token`.

## Setup

`/api/setup/secrets` (administrator-only like all Setup routes) lists metadata, usages by provider/channel/setting/MCP server, referenced-but-missing names, exposures, the lock state and the key file path. `PUT /api/setup/secrets/{name}` sets a value and/or description, `DELETE` retires the current value, `POST .../forget-retired` drops retained values and `POST /api/setup/secrets/exposures/clear` dismisses one exposure label. Responses never contain values. The WebUI Secrets tab offers add/replace/describe/delete, prefill for missing names and exposure dismissal; value inputs are password fields cleared after save.

## Tests

`SecretStoreTests` covers key/file modes, encryption at rest, reopen with the same key, locked behaviour for a missing or foreign key without key replacement, retention and pruning, short values and exposure persistence without content. `SecretReferenceTests` covers sink resolution and validation, literal sources and the marker guard. `SecretRedactionTests` covers encodings, leftmost-longest and copy-on-write matching, byte-identical reasoning with exposure reporting, and request-stage masking of instructions, tools and history copies. `SecretHostTests` runs real Sessions against a loopback provider: the provider key resolves into the Authorization header while user input and `read` output reach history and both requests only as markers; a missing provider secret fails the turn without provider contact; model-initiated configuration writes cannot redirect referencing entries. `SecretSetupRouteTests` exercises the Setup routes on a real Main host and the owner-only `node_bootstrap_info` file. `IndependentProcessEnvironmentTests` covers the master exec environment drop. The Setup tab is covered by `packages/webui/test/setupModels.e2e.mjs`.

## Limits and open work

- A Vector child process (`dbWorkers`) indexes text that was already masked at history admission, but its own embedding requests are not passed through the redactor.
- Remote Node environments and Provider `execEnv` injection, the `secrets` policy facts and the Agent-owned exception, the read-only Archive scan for previously stored values, and opt-in non-dumpable Main are later phases.
- A reversible text-redaction stage, if added, runs after stage S, so it only sees masked text.

## Design decisions

### D-secrets-store-references-redaction

**Selected secret-store design; approved by the user on 2026-11-08.** Main owns an encrypted write-only store keyed by an instance key file at `<data root>/keys/secrets.key` (0600, generated on first start; the data root is the installation root when no data directory pointer is configured). Configuration refers to values as `${secret:NAME}`, resolved only at Main-owned allowlisted sinks. A central irreversible redactor runs at tool output, history admission, model and embedding requests and logs, with markers `[[FW_SECRET:<name>]]`; values shorter than 12 characters are accepted with a visible not-redactable warning, and retired values stay redacted for 90 days. Setup can replace values but never reveal them. Model-initiated secret use requires an explicit `secrets` policy grant even when the default action allows; until that exists, model-facing configuration tools cannot add references or edit referencing entries. Access identity tokens and the instance token stay outside the store but feed the redactor. Reasoning content is never rewritten. Exposure events are shown only in Setup.
