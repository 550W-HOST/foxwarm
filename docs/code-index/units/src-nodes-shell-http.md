# Unit: src-nodes-shell-http

Files: src/nodes/shellHttp.ts, src/nodes/shellHttp.test.ts, templates/node/run-shell.sh
Secondary files: src/nodes/manager.ts, src/nodes/providerRegistry.ts, src/nodes/httpRoutes.ts, src/nodes/bootstrapInfo.ts, src/llm.ts, docs/node-client.md, skills/node-setup/SKILL.md

## Purpose

Adds an exec-only authenticated remote Node without Node.js, JSON parsing, or WebSocket dependencies on the client. Main retains Node identity, tool routing, execution identity, and Session completion authority. The HTTP transport is process-local, not a durable task queue or crash-recovery system.

## Key exports

- `SHELL_EXEC_CAPABILITY` — the Shell Node's approved POSIX command/cwd/timeout capability, including bounded-output and completion behavior.
- `registerShellNodeHttpRoutes(server)` — installs authenticated register/poll/report routes and returns a teardown callback for the owned runtimes/timer.

## Function Index

| Function | Description |
|----------|-------------|
| `body(req, limit)` | Reads a bounded application/octet-stream body without parsing client JSON. |
| `outputText(sample, total, exitCode)` | Formats retained head/tail bytes, binary hex samples, truncation, exit code, and total byte count. |
| `Runtime.dispatch(request)` | Captures a Main-issued exact exec context and queues a bounded command script once. |
| `Runtime.cancel(callId)` | Removes an unclaimed timed-out command; a delivered command is never retried. |
| `Runtime.poll(res)` / `flush()` | Maintains one 25-second long poll per connection and removes a task before handing it out. |
| `Runtime.disconnect(reason)` | Closes this connection's poll/queue without removing a replacement runtime. |
| `authenticate(req, res)` | Rechecks the existing approved Node hash for every request. |
| `collect()` | Continuously drains the client's FIFO in at-most-4096-byte blocks, retaining fixed head/tail samples and counting all bytes. |
| `run_job()` / `report()` | Owns each command's independent foreground wait and background transition, retries only reports, and removes finished transient state without blocking task polling. |

## Behavior and boundaries

- `POST /node/shell/register` accepts a real absolute startup cwd. Node ID is a fixed header; the existing per-node token is an Authorization bearer, not a query parameter. The returned random connection ID fences polling/replacement, not Node authentication.
- `GET /node/shell/poll` returns either protocol-marked 204 or a protocol-marked 200 command body with task/exec/timeout headers and a precise content type. The shell client does not execute errors, HTML, unmarked responses, or malformed task IDs. URL construction preserves an explicitly supplied deployment prefix; curl retains normal TLS verification.
- `POST /node/shell/report` correlates the authenticated Node, task and connection to Main's saved original Session/exec/capability. The client cannot choose the target Session or fabricate completion authorization. Task report transitions are serialized. A finished foreground task resolves the ordinary tool call; a background notice activates the exact reserved exec identity before returning its ID. Background completion uses the existing signed Session event/ACK boundary, and admission failures return 503 rather than success.
- The manager holds a real `HttpExecTransport` beside, not disguised as, its existing WebSocket transport. The authenticated remote provider exposes only `exec` and returns startup cwd directly for ordinary Node selection. No filesystem, PTY, backend service, external-owner, or exec-result API is advertised. Main/CLI schemas remain unchanged; normal chat uses this selected Node's actual exec capability in the direct exec schema.
- Each Node has at most 32 unfinished Main tasks and 32 transient finished task receipts. Queued commands are removed on call timeout or disconnect. Already delivered commands are never requeued, even when delivery or results become uncertain. A stale HTTP expiry/disconnect or WebSocket close cannot remove a newer runtime.
- The client checks every program it actually needs and never installs packages. Its main loop keeps polling while independent per-job wrappers wait or report; it has no extra client-side concurrency cap. Main's unfinished-task bound applies to dispatch, and each job's output files remain bounded. It uses POSIX sh, curl and basic utilities, with no node/python/jq/third-party JSON parser. BusyBox builds can omit utilities; startup dependency checks remain authoritative.
- Output files are bounded while the command is producing bytes: each collector reads a 4 KiB chunk, stores a 4 KiB head and tail, and uses at most 8 KiB for any intermediate sample file. It drains every byte instead of closing the producer's pipe. Outputs below 8 KiB do not duplicate overlapping samples. Empty/no-newline/binary output is supported; full logs are never retained.
- The foreground wait uses integer-second polling and rounds a fractional timeout upward. The initial background response is an exec ID/continuation notice; the retained sample and total byte count arrive with completion. Cwd is safely shell-quoted and resolved relative to the startup directory, without creating Agent storage or carrying `cd` into later calls.
- Poll activity controls a 90-second online boundary. Commands are not killed by Node disconnect, script shutdown, or the 24-hour completion/report expiry. Running FIFO/collector state is kept until the command exits; finished report state is then cleaned. Loss of process-local Main dispatch context after restart is an unknown outcome, never an automatic replay. There is no persisted outbox or restart continuation.

## Tests

The focused E2E uses a fresh temporary Main data directory, a script downloaded from the real HTTP bootstrap route, ordinary provider dispatch, real shell/curl, and a restricted BusyBox-only utility PATH when BusyBox is available. It checks default/relative cwd, exit codes, empty/overlapping/binary samples, 4 MiB continuous output with observed bounded intermediate files, error-page rejection, path-prefix routing, exact wait liveness and original-Session background admission, response-loss retries with one side effect and one event, credential rejection/revocation, stale HTTP replacement callbacks, and a real superseded WebSocket close. An ordinary adjacent-exec batch also runs two 35-second foreground commands concurrently while four 95-second background jobs run, preserving both real 62-second call deadlines and polling activity across the real 90-second online boundary. It does not validate a physical router or every curl/BusyBox build.

## Canonical decision

See [D-node-thread-shell-http](../threads/node-communication.md#d-node-thread-shell-http).
