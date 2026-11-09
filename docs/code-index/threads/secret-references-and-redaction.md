# Thread: secret references and redaction

Stored credentials, where Main resolves them, and where known values are masked across tools, Sessions, model requests, MCP, channels and logs. Implementation detail (store format, matcher, Setup routes, tests) is in the [secrets unit](../units/dotnet-secrets.md).

## Contract

Credentials that Main uses on the user's behalf are stored once, encrypted, and referenced from configuration as `${secret:NAME}`. Only Main-owned consumers resolve references, at the moment they build a provider request, channel connection, MCP connection or ASR proxy. No route, tool or log returns a stored value, and model-initiated configuration writes cannot choose where a stored value is sent.

Masking is accident protection for known values and their common encodings. It does not stop code that deliberately transforms a value, and it does not make a non-isolated master `exec` a security boundary. The guarantees are the write-only store, Main-side resolution and the model-facing restrictions below.

## References and failure

`SecretSinks` declares where references are allowed: provider `apiKey` and `extraHeaders` values (and the legacy `models.*` layout); `textRedaction.apiKey` in models `defaults`, providers and model entries (`models` or the singular `model` list, which also applies to model-level `extraHeaders`), sent only as the text-detection service's Bearer credential; `llm.*ApiKey`, `asrService.key` and channel credential fields; MCP `token`, `headers`, `env`, `args`, `url` and `oauth.clientSecret`. A reference anywhere else is a validation error.

A missing or unavailable value fails only the consumer that uses it:

- A model provider with a missing name, including one inheriting a referenced legacy `llm` key, fails with `ModelPreparationException` before any provider contact. Other providers stay usable.
- Channels, MCP servers and the ASR proxy report a safe message that names the secret and points to Setup.
- A locked store is handled the same way. The store is locked when the key file is missing, unreadable or foreign, or when `state/secrets.json` cannot be read, is malformed or was written by a newer version. Main startup, literal-key providers and ASR registration do not fail, and nothing overwrites a store it cannot read. Restoring the key or the store file takes effect without a restart; a catalog resolved while locked is rebuilt on the next request.

Changing a secret restarts referencing channels. MCP connections whose resolved configuration changed are replaced on next use. The ASR proxy resolves at construction and needs a restart.

MCP OAuth compares and uses resolved settings throughout. A grant records the configured URL, which may hold a reference, and never a configured client secret; the client secret is read from configuration at each token request.

## Known values

The redactor masks the store's current values and values retired within 90 days, plus credential-shaped literals from configuration:

- Credential fields (`apiKey`, `token`, channel credentials, `oauth.clientSecret`) count as a whole.
- Header values count only under credential-like header names: `Authorization`, `Proxy-Authorization`, `Cookie`, and names containing `key`, `token`, `secret`, `auth`, `password` or `signature` (ASCII case-insensitive). The credential after an authorization scheme (`Bearer <token>`) counts too. Ordinary header values such as `Accept` or `HTTP-Referer` are never masked.
- URL fields count only user info and query values under credential-like parameter names.
- MCP `env` entries count only under credential-like variable names.
- MCP `args` count only in credential-shaped forms: `Name: value` with a credential-like name, `--name=value`, or `--name value` where the option name is credential-like.
- Access identity tokens (including webhook verification secrets), the instance token, the Node event capability secret, the Node pairing token and MCP OAuth tokens also feed the redactor without entering the store. Access identity tokens are inbound credentials, not sinks: a reference there is a validation error.

Values shorter than 12 characters are neither masked nor treated as known anywhere, including the master `exec` environment drop.

## Redaction points

Matches become `[[FW_SECRET:<label>]]`, where the label is the secret name or a configuration path. Masking is irreversible.

| Point | Owner | Coverage |
| --- | --- | --- |
| R1 tool results | `ToolRegistry.ExecuteAsync`, after dispatch and before programmatic/output-guard handling | Builtin, MCP, Node, Provider and ToolScript-nested results. |
| R2 Session state | `SessionSaveLane`: queue admission (message, parts and open fields; external input is framed and neutralized by its producer first, so masking always sees the neutralized text), question-record mutations (including tool approval records in `meta.questions.approvals`), and `RedactStagedHistory` for every lane commit that stages new or replaced history rows | Canonical appends of every origin, the retry notice, compaction and pruning. Rows absent from the pre-operation history are masked once outside the state gate; the same masked rows are persisted, published to hot state, written to the Archive and announced. History writers do not mask individually. |
| R3 model requests | `ModelRequestOwner`, stage S after request defaults and before the journal manifest and `PrepareRequest` | Instructions, tool definitions and history copies; the Claude runtime prompt file and stdin input; in-process embedding input. Reversible [text redaction](../units/model-text-redaction.md) runs later, in `CreatePreparedService`, sees only masked text and leaves markers intact. |
| R4 logs | `MainLog` capture | Each write is masked before the console sees it, and each complete file line is masked again. |

Reasoning is never rewritten: thinking parts, provider reasoning metadata and legacy thinking blocks stay byte-identical so replay keeps working. A known value found there is recorded as an exposure when the row enters history; model requests do not record it again. Two kinds of message or part `__meta` are content and are masked: the user's structured question answer (`questionAnswer`) and the approval decision shown on a tool result (`approval`, which carries the approver's note).

## Model-facing restrictions

- Writer tools (`write`, `edit`, `apply_patch`, `write_memory`, `edit_memory`, `apply_patch_memory`, `mcp_config`) and `set_config` candidates reject a marker whose label belongs to a currently masked value, because writing it back would replace the real value. Text that only mentions the marker format stays writable.
- Until tool policy can grant secret use explicitly, `set_config` cannot change the effective detector endpoint, `apiKey` source or enablement of any existing concrete leaf whose `textRedaction.apiKey` references a secret before or after the edit, since an inherited endpoint decides where the detector key goes. A new or renamed leaf may only resolve a referenced key with an endpoint that key is already paired with. Leaves are enumerated and resolved by the catalog itself ([text redaction](../units/model-text-redaction.md#configuration-and-external-service)). It also cannot change a provider, channel, `llm` or `asrService` entry that references a secret (before or after the change, including a provider that inherits a referenced legacy key). It also cannot change `llm.openaiBaseUrl` or `llm.anthropicBaseUrl` while a secret-using provider of that family has no own `baseUrl`, since its requests and secret would follow the new URL. These checks run on the candidate before the installer's independent webhook-identity check; either one refuses the whole candidate.
- `mcp_config` cannot add references or change a referencing server beyond `enable`, `description` and `timeoutSeconds`. It still accepts literal credentials, which become redactor sources.
- Master `exec` drops inherited environment variables whose value exactly equals a known value.
- `node_bootstrap_info` writes the pairing token to a new owner-only file and returns `PAIRING_TOKEN` in its place.

## Design decisions

### D-secrets-store-references-redaction

**Selected secret-store design; approved by the user on 2026-11-08.** Main owns an encrypted write-only store keyed by an instance key file at `<data root>/keys/secrets.key` (0600, generated on first start; the data root is the installation root when no data directory pointer is configured). Configuration refers to values as `${secret:NAME}`, resolved only at Main-owned allowlisted sinks. A central irreversible redactor runs at tool output, Session history and state, model and embedding requests and logs, with markers `[[FW_SECRET:<name>]]`; values shorter than 12 characters are accepted with a visible not-redactable warning, and retired values stay redacted for 90 days. Setup can replace values but never reveal them. Model-initiated secret use requires an explicit `secrets` policy grant even when the default action allows; until that exists, model-facing configuration tools cannot add references, edit referencing entries or change base URLs those entries inherit. Access identity tokens and the instance token stay outside the store but feed the redactor; configuration literals feed it only when credential-shaped. Reasoning content is never rewritten. Exposure events are shown only in Setup.

Reversible text redaction records only counts, labels, timings and failure kinds with the request journal; the sent-version view reads the in-memory cache for one message of a Session the viewer can open ([observability](../units/model-text-redaction-observability.md)).

## Open work

- A Vector child process (`dbWorkers`) indexes text already masked in history, but its own embedding requests are not passed through the redactor.
- Remote Node and Provider injection, the `secrets` policy facts and the Agent-owned exception, the read-only Archive scan and opt-in non-dumpable Main are later phases.
- Provider responses are stored as received in the request journal and raw diagnostics; requests are masked.
