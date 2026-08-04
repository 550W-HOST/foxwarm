# Module: infrastructure

## Responsibility

Infrastructure owns process bootstrap, HTTP/WebSocket hosting, configuration, shared runtime types and utilities, skills, timers, terminal routing, packaging, and developer-facing command entry points. It provides stable services used by feature modules without owning their domain behavior.

Optional local/child service placement and its shared RPC boundary are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md).

Speech recognition is integrated as an external service boundary: Foxwarm sends audio plus optional context and receives text. Service credentials and deployment topology are runtime configuration, never code-index content.

## Key units

- [src-index](../units/src-index.md) — application bootstrap and subsystem wiring.
- [src-rpc](../units/src-rpc.md) — typed local/child service contracts, cloning, lifecycle, cancellation, and events.
- [src-session-worker-runtime](../units/src-session-worker-runtime.md) — per-session process supervision and durable ownership/mailbox foundation.
- [src-http-server](../units/src-http-server.md) — authenticated HTTP and WebSocket server.
- [src-config](../units/src-config.md) — YAML configuration loading, validation, paths, and migrations.
- [src-misc](../units/src-misc.md) — logging, retries, ASR client, JSON arguments, and node transfer helpers.
- [src-types](../units/src-types.md) — shared runtime interfaces.
- [src-utils](../units/src-utils.md) — durable JSON, time, prompt wrappers, message formatting, and Unicode helpers.
- [src-skills](../units/src-skills.md) — layered skill discovery and loading.
- [src-timers](../units/src-timers.md) — persisted one-shot and recurring timers.
- [src-terminal-manager](../units/src-terminal-manager.md) — local PTY lifecycle.
- [src-terminal-router](../units/src-terminal-router.md) — browser terminal routing across master and capable nodes.
- [quality-scripts](../units/quality-scripts.md) — baseline TypeScript quality checks.
- [model-cli](../units/model-cli.md) — one-shot CLI over the production LLM stack.
- [multica-bridge-cli](../units/multica-bridge-cli.md) — local Qwen-JSONL bridge from Multica tasks to Foxwarm sessions.
- [code-index-generators](../units/code-index-generators.md) — first-draft index generators.

## Public interfaces

- `HttpServer` route and WebSocket registration.
- Configuration readers, validators, model resolution, and path helpers.
- Shared `Message`, `Session`, tool, stream, and channel types.
- `DiskJsonData` durable JSON persistence.
- Skill discovery and document loading.
- Timer create, update, list, and delete APIs.
- Local/remote terminal creation, attachment, input, resize, and close APIs.
- `foxwarm model` one-shot model command.
- `foxwarm-multica` local Multica custom-runtime bridge.
- `npm run quality:unused` baseline check.

## Invariants

- HTTP routes require authentication unless a route explicitly opts out.
- Durable JSON writes use a temporary file, file sync, atomic rename, and directory sync; stores choose backup rotation explicitly.
- Configuration writes pass the same validation used by runtime readers.
- Skill resolution is deterministic: agent-local, inherited-agent, then global; the first same-name match wins.
- One-shot timers are removed after firing; recurring timers remain scheduled and persist their last trigger time.
- Browser terminal output is bounded and terminal resources are cleaned up on exit.
- Model configuration resolution applies provider defaults before model-specific overrides.
- The one-shot model CLI reuses production configuration and provider request code rather than implementing a second protocol stack.
- Packaged runtimes include bundled skills and the shared/CLI-node artifacts required by bootstrap features.

## Compatibility

- Selected environment variables may override the data root or specific config paths. They do not migrate a `.env` file into YAML; current precedence and compatibility readers are documented in [src-config](../units/src-config.md#path-resolution).
- User-owned runtime data and prompt files are not overwritten merely because packaged templates changed.
- Readers may accept persisted legacy shapes when a current migration documents them; new writes use the current canonical shape.

## Design decisions

### D-infrastructure-external-data

Program code and mutable user data have separate ownership. Installations may place data outside the checkout, and runtime path resolution must consistently honor the selected data root.

### D-infrastructure-template-ownership

Templates initialize user-owned files once. Package upgrades do not silently replace initialized configuration or prompt files.

### D-infrastructure-bundled-skills

Bundled skills are program assets. They ship with source and runtime images rather than being copied into the mutable data directory.

### D-infrastructure-production-model-cli

Shell automation uses the production `requestLlmOnce` stack through `foxwarm model`, preserving provider routing, retries, compression, sanitization, and parsing behavior.

### D-infrastructure-quality-baseline

The baseline unused-code gate uses TypeScript `--noEmit` checks without adding a linter dependency. Broader linting, dependency analysis, and unused-export checks remain separate work.

## Open questions

- Desktop packaging and graphical installation remain separate product work and are not part of the server/runtime contract described here.
