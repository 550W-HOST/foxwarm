# Thread: secret references and redaction

Stored credentials, where Main resolves them, and where known values are masked across tools, Sessions, model requests, MCP, channels and logs. Implementation detail (store format, matcher, Setup routes, tests) is in the [secrets unit](../units/dotnet-secrets.md).

## Contract

Credentials that Main uses on the user's behalf are stored once, encrypted, and referenced from configuration as `${secret:NAME}`. Only Main-owned consumers resolve references, at the moment they build a provider request, channel connection, MCP connection or ASR proxy. No route, tool or log returns a stored value. A model-initiated configuration change that would send a stored value somewhere it is not sent today carries a `secrets` authorization fact: a policy rule naming those secrets decides it, and otherwise it needs the caller's authorization for unrestricted `exec` on master, which can already read the store and its key ([secret destination facts](#secret-destination-facts)).

Agents manage the store add-only: `add_secret` stores a value under a new name from the call, a file or configuration literals, and `list_secrets` shows names, owners, uses and availability. Neither returns a value, and replacing, deleting or revealing values stays in Setup. A secret an Agent adds from a value or a file is owned by that Agent and needs no policy grant for it ([Agent self-management](#agent-self-management)).

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

## Secret destination facts

`set_config` (targets `models` and `config`) and `mcp_config` report which stored secrets a change would send to a new destination. Each Main-owned consumer contributes routes, read the way that consumer reads its configuration: a destination, the field that carries the value and the secret name. A route in the result that is absent today makes its secret a fact.

| Consumer | Destination | Fields carrying the secret |
| --- | --- | --- |
| Model provider, per concrete leaf as the catalog resolves it | provider protocol (`providerType`) and effective base URL: own `baseUrl`, else `llm.<family>BaseUrl`, else the built-in family endpoint | effective `apiKey` (own, else `llm.<family>ApiKey`) and merged `extraHeaders` values |
| Text-redaction detector, per leaf | resolved `textRedaction.endpoint` | resolved `textRedaction.apiKey` |
| ASR proxy | `asrService.url` | `asrService.key` |
| Channel | channel type and its configured server: Matrix `homeserver`, Weixin `baseUrl`, WeWork `aibot.websocket.url` (for `aibot.websocket.secret`); Telegram and QQ Bot use fixed service hosts | credential fields; WeWork `webhookUrl` is its own destination, and WeWork `token`/`encodingAESKey` only verify inbound callbacks |
| MCP HTTP server | transport and `url` | `token`, `headers`, a reference in `url`, `oauth.clientSecret` (sent to the authorization server discovered from the URL) |
| MCP stdio server | `command`, `args`, `cwd` and `env` together, since they decide which code receives the values | `env`, `args` |

The `llm` keys reach providers only through the catalog. Existing routes are those under both the app settings the running catalog captured and the saved app file, which takes effect on restart, and a models candidate is resolved under both, so a pending `llm` base URL cannot later be adopted without a fact. As a result, model lists, `contextLimit`, feature flags, timeouts, descriptions, enablement, renamed entries, removals and another entry that reuses an existing destination and key produce no fact; changing a destination, adding or moving a reference, or an entry that newly inherits a destination does. A candidate the catalog cannot resolve counts every reference in it; installation rejects it anyway.

Policy decides these facts like any other ([tool authorization](../units/tool-authorization.md#secret-facts)): the first rule with a `secrets` selector that matches decides them; otherwise secrets the caller's Agent owns are allowed, and any other secret follows the caller's authorization for an unrestricted `exec` on master. Legacy isolation grants only owned secrets. The call's assessment computes the facts from the current configuration, so explanations and approval requests show them; each installer authorizes again inside its serialized lane with the exact change it installs, and an approval covers only the same facts.

## Agent self-management

The store records an owner for each name: an Agent, or the instance. Names written by Setup, entries written before ownership existed and owners this version does not recognize belong to the instance. Setup shows Agent owners.

`add_secret` creates a name that has no current value; an existing name is refused whoever owns it, so an Agent can never replace a value it did not add. A name whose values were all deleted can be created again and takes the new owner. Exactly one source is given:

- `value`: the credential as a call argument. The assistant row carrying the call is committed before the call runs, so the value stays raw in that row, the Archive and the request journal. Once stored it is a known value: later rows and request copies are masked, and an exposure is recorded with the point `tool-call`. The calling Agent owns the secret.
- `filePath`: a file on the caller's current Node, read by Main after the caller's own `read` of it is allowed (UTF-8, at most 64 KiB, one trailing line break and a leading byte order mark removed). With `deleteFile` the caller's own `edit` deletion of it must also be allowed, and the file is deleted after the value is stored; a failed deletion is reported beside the stored result. The calling Agent owns the secret.
- `fromConfig`: one or more credential sink fields (`SecretSinks`) in the models file, the app file or MCP servers that hold the same literal. The literal is stored under the new name, owned by the instance, and each field is replaced by `${secret:NAME}`. The destination is unchanged, so a move adds no fact of its own. Because the caller files a value it has not seen under a name it chooses, and `secrets` rules grant by name, a move requires the caller's `read` of each source file on master. YAML scalars are replaced in place inside the configuration installer's lane, keeping every other byte, comment and the byte order mark; values reached through anchors, aliases or merge keys, block scalars and fields that already hold a reference are refused. MCP fields are replaced through `McpConfiguration.UpdateAsync`, which refuses a server that changed since the move read it. The store is written before the fields; a field that changed in the meantime keeps its literal and is listed in `notMoved`.

Adding a value under a name that configuration already references lets those consumers send it, so that name is a secret fact of the call; it has no owner yet, so ownership cannot grant it. A new unreferenced name carries no fact. Referencing channels restart after an add.

`list_secrets` returns every stored or referenced name with its description, whether it has a value, its owner, its usages (the Setup usage scan) and, for names with a value, `usable`: the caller's policy decision for the secret part of an `exec` at its current Node carrying that name, including legacy isolation. Whether a particular command may run is decided separately.

A tool-approval record, its summary and the live approval view show `add_secret`'s `value` as `(hidden)`, because the value is not yet known to the redactor. Argument summaries in tool rows and ToolScript subcall records never include the value. Deleting an Agent hands its secrets to the instance before its directory is removed, so a later Agent with the same name does not inherit them; deletion is refused while the store cannot record that. Foxwarm has no Agent rename.

## Model-facing restrictions

- Writer tools (`write`, `edit`, `apply_patch`, `write_memory`, `edit_memory`, `apply_patch_memory`, `mcp_config`) and `set_config` candidates reject a marker whose label belongs to a currently masked value, because writing it back would replace the real value. Text that only mentions the marker format stays writable.
- `add_secret` never replaces an existing name, and no model-facing tool returns, replaces or deletes a stored value.
- `set_config` and `mcp_config` changes with [secret destination facts](#secret-destination-facts) need the caller's policy to allow them. An Agent that policy does not restrict may make them; an Agent without unrestricted master `exec` (for example one using the restricted-worker or channel-assistant template, or a legacy isolated Agent) is refused unless a `secrets` rule grants the names. Literal credentials stay accepted and become redactor sources. The installer's independent webhook-identity check still applies to `set_config`.
- Master `exec` drops inherited environment variables whose value exactly equals a known value.
- `node_bootstrap_info` writes the pairing token to a new owner-only file and returns `PAIRING_TOKEN` in its place.

## Design decisions

### D-secrets-store-references-redaction

**Selected secret-store design; approved by the user on 2026-11-08.** Main owns an encrypted write-only store keyed by an instance key file at `<data root>/keys/secrets.key` (0600, generated on first start; the data root is the installation root when no data directory pointer is configured). Configuration refers to values as `${secret:NAME}`, resolved only at Main-owned allowlisted sinks. A central irreversible redactor runs at tool output, Session history and state, model and embedding requests and logs, with markers `[[FW_SECRET:<name>]]`; values shorter than 12 characters are accepted with a visible not-redactable warning, and retired values stay redacted for 90 days. Setup can replace values but never reveal them. Access identity tokens and the instance token stay outside the store but feed the redactor; configuration literals feed it only when credential-shaped. Reasoning content is never rewritten. Exposure events are shown only in Setup.

**Revised by the user on 2026-11-10: secret destinations follow the caller's policy.** This replaces the 2026-11-08 rule that model-initiated secret use needs an explicit `secrets` grant even under `defaultAction: allow`, and the hard-coded refusals that stood in for it. The store exists so a user can let an Agent operate with credentials that neither of them wants in context; Agents that policy does not restrict are not presumed to redirect secrets deliberately, and a caller with unrestricted master `exec` can already read the store and its key. A change that decides where a stored secret is sent is therefore a `secrets` fact. A rule with a `secrets` selector decides it first: an allow covers it only when it names every secret, a deny matches any. Otherwise the caller's own authorization for an unrestricted `exec` on master decides, through the same global, Agent-local and legacy-isolation layers: the first rule for `exec` on master that does not depend on the command or working directory, else the default; allow allows, ask asks, deny refuses. Rules scoped to commands or directories are skipped, because a command or directory restriction still leaves other commands that can read the store, and a scoped allow is not unrestricted. An installation without rules allows everything; the restricted templates, legacy isolated Agents and Agents denied `exec` on master by a rule independent of the command are refused unless a `secrets` rule grants the names.

**Agent self-management, decided by the user on 2026-11-10.** Agents add secrets but never read, replace or delete them. `add_secret` creates new names only, from a call value, a readable file on the caller's Node, or configuration literals moved into the store; filling a referenced but missing name counts as use of that name. A secret added from a value or a file (and, later, from a secret question answered by the user) is owned by the calling Agent; a moved configuration literal belongs to the instance, and so do a deleted Agent's secrets. A secret the caller's Agent owns needs no allow rule, while a `secrets` deny or ask still applies to it; `secrets: {owned: true}` selects owned secrets. `list_secrets` shows names, descriptions, owners, usages and whether the caller may use each at its current Node, never values.

Reversible text redaction records only counts, labels, timings and failure kinds with the request journal; the sent-version view reads the detection cache (in memory or [persisted](../units/model-text-redaction-persistence.md)) for one message of a Session the viewer can open ([observability](../units/model-text-redaction-observability.md)).

## Open work

- A Vector child process (`dbWorkers`) indexes text already masked in history, but its own embedding requests are not passed through the redactor.
- Planned next: a secret question for `ask_user`, answered in the WebUI and written to the store without entering the conversation, and `exec.secretEnv`, which passes stored secrets as environment variables on master, executable Providers and CLI Nodes.
- The read-only Archive scan and opt-in non-dumpable Main are later phases.
- Provider responses are stored as received in the request journal and raw diagnostics; requests are masked.
