# Unit: shared-code-helper-ipc

Files: packages/shared/src/codeHelperIpc.ts, packages/shared/src/codeHelperIpc.test.ts

## Purpose

Implements the transport-neutral terminal-scoped `code` helper protocol shared by master and CLI-node PTY runtimes. It generates a local helper executable, authenticates requests with per-terminal capabilities over a process-local socket, resolves paths on the terminal's node, and delegates only fixed open-file/add-folder requests to the runtime transport adapter.

## Key Exports

- `CodeHelperIpcServer` — owns the local Unix socket/named-pipe endpoint, generated helper wrapper, terminal capabilities, request parsing, local stat/path resolution, and response framing
- `CodeHelperOpenRequest` — fixed `addFolder` or `openFile` request, with optional one-based line/column
- `CodeHelperControlResult` — success/error acknowledgement returned to the helper process

## Behavior

- `registerTerminal(terminalId)` starts the IPC server lazily, generates a random 32-byte capability, and returns environment variables that prepend a runtime-generated `code` wrapper to that terminal's PATH.
- The helper sends one newline-delimited version-1 JSON request containing capability, cwd, and argv. It never receives master/WebUI/node credentials or browser URLs.
- Relative paths are resolved and `stat`ed in the local runtime. Existing directories become `addFolder`; files become `openFile`. `--add` and `--goto file:line[:column]` are supported, along with ignored `--reuse-window` compatibility. Unsupported options, multiple/missing/nonexistent paths, and Windows workspace paths fail clearly.
- POSIX uses a mode-0600 Unix socket and executable shell wrapper. A Windows named-pipe/wrapper shape exists, but request execution rejects until Foxwarm Windows URI/path mapping is defined.
- The server binds capability to terminal id internally; the helper cannot claim another terminal or node. Callers supply the transport callback that reaches the current Code control owner and returns its acknowledgement.
- The generated helper module must remain a real external file in CLI bundles so `__filename` points to `packages/shared/dist/codeHelperIpc.js`; otherwise the wrapper would accidentally execute the CLI client bundle entry point.
- Because that real file is shipped in the node source archive without `packages/shared/node_modules`, its runtime dependency closure uses only Node built-ins. Filesystem operations use `fs`/`fs.promises` rather than `fs-extra`, so prebuilt bare-metal/TUI bundles start in a clean directory without hidden host dependencies.

## Tests

- Real local helper subprocess tests cover file/folder/goto resolution, acknowledgements, missing paths, and expired terminal capability.
- The bare-metal `run.sh` regression test builds the real allowlisted source archive with all node_modules excluded, serves it from a temporary `/node/source.tar.gz`, and starts the actual prebuilt client bundle from a clean install root.

## Design Decisions

- [2026-07-14] Do not emulate desktop VS Code's full IPC backend or expose WebUI/node tokens to shells. Generate a terminal-local helper and capability, resolve paths on the executing node, and relay only fixed open-file/add-folder operations to one attached Code browser.
- [2026-07-14] The first helper accepts one existing POSIX path at a time plus `--add`, `--goto`, and `--reuse-window`; extension install/new window/wait/multiple-path/full desktop CLI behavior remains out of scope.
