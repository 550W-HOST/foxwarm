# Unit: model-cli

Files: scripts/foxwarm.js, scripts/model.js, scripts/model.test.js, scripts/archive.js, scripts/archive.test.js, scripts/storage.js, scripts/storage.test.js, scripts/test-postgres-journal.sh
Secondary files: package.json, package-lock.json, README.md

## Purpose

Provides the installable `foxwarm` command, its `model` subcommand for one-shot LLM requests, its backend-neutral `archive export-jsonl` compatibility exporter, and explicit Journal storage copy tooling. Commands are thin adapters over compiled production modules so provider/storage behavior does not drift from the server.

## Key Exports

- package `bin.foxwarm` — maps installed package execution to `scripts/foxwarm.js`
- `run(argv, streams?)` — top-level CLI dispatcher
- `runModelCli(argv, options?)` — parses one-shot model options, loads production runtime modules, and prints text/JSON output
- `parseArgs(argv)` — strict model-subcommand option parser
- `loadProductionRuntime()` — loads `lib/config.js` and `lib/llm.js` after selecting CLI-safe logging
- `CliUsageError` — distinguishes usage failures (exit 2) from runtime/provider failures (exit 1)
- `runArchiveCli(argv, options?)` — completes the SQLite migration and exports session plus LLM archives as JSONL
- `runStorageCli(argv, options?)` — requires a quiesced-source acknowledgement and copies one SQLite Journal into an empty configured PostgreSQL Journal, then closes the CLI pool

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `printHelp(stream)` | foxwarm.js ~6 | Writes top-level CLI help |
| `run(argv, streams)` | foxwarm.js ~20 | Dispatches version/help/model commands without spawning a child |
| `requireValue(argv, index, option)` | model.js ~10 | Requires a non-option value after a value-taking flag |
| `parseArgs(argv)` | model.js ~18 | Strictly parses model/prompt/system/list/json/timeout/help options |
| `printHelp(stream)` | model.js ~65 | Writes model-subcommand help |
| `loadProductionRuntime()` | model.js ~88 | Resolves compiled config/LLM modules and enables synchronous file logging |
| `readStdin(stream)` | model.js ~113 | Reads a piped UTF-8 prompt or returns empty for TTY input |
| `writeModelList(config, stream)` | model.js ~125 | Displays resolved model keys without API keys |
| `runModelCli(argv, options)` | model.js ~138 | Validates model/prompt, calls `requestLlmOnce`, and emits text or JSON |
| `main(argv)` | model.js ~182 | Converts thrown usage/runtime errors into CLI exit codes |
| `runArchiveCli(argv, options)` | archive.js | Exports both SQLite-authoritative archive domains to an explicit output directory |

## Dependencies

- Compiled `lib/config.js` — canonical model path/schema/default resolution
- Compiled `lib/llm.js` — canonical `requestLlmOnce` provider request implementation
- `src/common.ts` — honors `FOXWARM_SYNC_FILE_LOG=1` so a short-lived CLI can log synchronously and exit cleanly
- Node built-ins (`crypto`, `fs`, `path`, streams/process)

## Behavior

- Requires `npm run build` output before live model requests; help/version parsing does not require the build.
- Installed or linked packages expose `foxwarm`; source checkouts can call `node scripts/foxwarm.js` directly.
- Unknown flags, positional arguments, missing option values, invalid timeouts, unknown model keys, absent prompts, and empty model responses fail instead of silently falling back.
- The selected model is validated using `loadModelsConfig`; requests go through `requestLlmOnce` with no tools and a fresh prompt-cache key.
- CLI requests use request-journal purpose `cli`; they are reconstructable even though no session history exists.
- Model listing and request forwarding accept virtual keys without reimplementing their routing; result JSON continues to report the concrete `modelId`. Canonical contract: [model routing](../threads/model-routing.md).
- The CLI suppresses console logs and selects synchronous file logging before importing the production runtime. This keeps stdout machine-readable and avoids pino worker shutdown hangs.
- The top-level dispatcher runs handlers in-process. Model, archive, and storage commands close the Journal store before completion.
- `foxwarm storage journal copy-sqlite-to-postgres --sqlite <path> --source-quiesced` never overwrites a nonempty target and leaves the SQLite source untouched.

## Tests

`scripts/model.test.js` covers strict parsing, stdin, concrete/virtual model validation and listing, empty responses, top-level dispatch, and a built end-to-end mock HTTP test proving `providerType: openai` uses the production `/responses` route and streaming request format. `scripts/archive.test.js` covers migration-before-export dispatch and output routing.

## Integration

- The standalone code-index generator invokes this command instead of implementing provider/config logic.
- README model configuration documentation includes build, source-checkout, and installed-bin usage.
