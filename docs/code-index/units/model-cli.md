# Unit: Public model/archive CLI frontends

Files: `scripts/foxwarm.js`, `scripts/model.js`, `scripts/model.test.js`, `scripts/archive.js`, `scripts/archive.test.js`
Secondary/integration references: `package.json`, `package-lock.json`, `README.md`, [Core delivery and one-shot backend](./core-delivery-cli.md).

## Purpose and exports

The installable `foxwarm` bin is a thin JavaScript frontend over existing C# configuration/model/journal/Archive owners. It does not load TypeScript backend libraries or run Main. Independent Multica remains a JavaScript client.

- `run(argv, streams?)` is the root dispatcher. No arguments/help show usage; version reads the root package version; unknown commands return usage exit 2.
- `runModelCli(argv, options?)` parses options, handles help without Core/configuration, and forwards parsed metadata plus optional raw prompt stdin through `runCoreCli`. `main` maps usage errors to 2 and operational launch failures to 1.
- Model `parseArgs` retains strict long/short model/prompt/system/list/json/timeout/help options, list aliases and positive finite seconds-to-milliseconds conversion. Missing values, unknown flags and positional arguments fail before backend launch.
- Archive `parseArgs` requires `export-jsonl --output/-o DIR` and resolves output from caller cwd. `runArchiveCli` validates first, then forwards one archive operation. `ArchiveCliUsageError` preserves root-dispatch exit 2.

## Backend and build integration

`runCoreCli` and `CliCommands` own the child operation, native request behavior, stdout/exit contracts and captured settings; see [the canonical Core CLI contract](./core-delivery-cli.md#cli-behavior). The obsolete production-runtime loaders and in-frontend provider invocation are removed rather than retained as fallbacks. The frontend does not parse flags a second time in C#.

Root `npm run build` prepares Core plus the retained TypeScript reference/default-launcher lane. Help/version/flag usage paths remain independent of Core/configuration. Complete build/publish resources and prerequisites are owned by [Core delivery](./core-delivery-cli.md#build-and-resource-boundary); this phase does not switch default service/TUI launchers or package `main`.

## Tests and consumers

`scripts/model.test.js` drives the real public child against controlled Responses and nonstream Anthropic providers, including canonical settings, stdin/system/default/virtual/list behavior, timeout/retry, output/exit distinctions, and tool-free `purpose:cli` journaling without a Session/Main or TypeScript fallback. `scripts/archive.test.js` covers parser/output-path/frontend forwarding; `CliArchiveMigrationTests.cs` exercises actual public export artifacts and real Source compatibility consumers. Multica's existing HTTP/JSONL callers retain their independent tests.

The standalone Code Index generator invokes the public model command rather than maintaining its own provider/configuration implementation.
