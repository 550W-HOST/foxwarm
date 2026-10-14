# Unit: External Shell HTTP exec transport

Files: `dotnet/Foxwarm/Nodes/NodeConnectionHub.Shell.cs`, `dotnet/Foxwarm/Nodes/NodeConnectionHub.ShellReports.cs`
Secondary files: `dotnet/Foxwarm/Nodes/NodeConnectionHub.cs`, `dotnet/Foxwarm/Nodes/NodeConnectionHub.Exec.cs`, `dotnet/Foxwarm/Nodes/NodeRoutes.cs`, `dotnet/Foxwarm/Nodes/NodeBootstrap.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Nodes.cs`, `dotnet/Foxwarm/Foxwarm.csproj`, `dotnet/Foxwarm.Tests/Tools/ShellHttpTests.cs`, `dotnet/Foxwarm.Tests/Tools/ShellHttpTests.Lifecycle.cs`, `dotnet/Foxwarm.Tests/Tools/ShellHttpTests.Posix.cs`, `dotnet/Foxwarm.Tests/Tools/ShellHttpTests.Timeout.cs`, `packages/webui/test/experimentHostShellHttp.e2e.mjs`, `templates/node/run-shell.sh`

## Purpose and contract owner

Connects the existing exec-only POSIX sh/curl client to the .NET host using its real HTTP protocol. This is an external Node transport, not environment provisioning. The canonical transport/output decision is [D-node-thread-shell-http](../threads/node-communication.md#d-node-thread-shell-http); current .NET integration is mapped in [Remote Node compatibility](../threads/remote-node-compatibility.md#net-external-node-integration).

## Stable symbols and callers

| Symbol | Responsibility |
| --- | --- |
| `NodeConnectionHub.RegisterShellRoutes` | Installs independently credential-authenticated register, long-poll and report routes; starts process-local expiry collection. |
| `PublishShell` | Revalidates and durably touches the approved credential inside the existing identity publication/revocation lock, then replaces the exact predecessor transport. |
| `ShellRuntime.Dispatch` / `Poll` / `Cancel` / `Disconnect` | Captures the actual Main invocation/claim, resolves POSIX cwd, queues one bounded command, removes it before handoff, and removes only unclaimed commands on cancellation/disconnect. |
| `CollectShell` | Retires only the exact expired published connection and removes expired transient task contexts. |
| `ReportShell` | Serializes task transitions, activates the exact reservation, settles foreground results, or calls existing strict Session completion admission before ACK. |
| `ShellFullText` / `ShellOutput` | Projects bounded text/binary samples, client-reported duration and total byte counts; provides exact programmatic text only when the sample is the complete valid text. |
| `ShellDefaultCwd` | Supplies startup cwd to real Node selection without executing a synthetic tool. |

The shared hub connection record contains either a real WebSocket or a Shell HTTP runtime. Ordinary Node discovery/selection/replacement/removal use that same identity map. Shell advertises only its POSIX `exec` capability and background-registration feature. File transfer, Code, PTY and external-owner capabilities are absent and fail at their existing capability boundaries without Main fallback. Main/CLI exec definitions remain separate and unchanged.

`NodeBootstrap` packages and serves the unchanged `run-shell.sh` template through the actual public bootstrap route. Administrator `create-shell` uses the ordinary direct approved credential and returns its setup command only to that operation. Deployment-prefix addresses are preserved. Shell requests carry the credential in Authorization and Node identity in a header; administrator authentication cannot substitute for Node authentication.

## Implementation limits

Polling waits at most 25 seconds; polling activity controls the 90-second online boundary. Main limits each Node to 32 unfinished tasks and 32 finished transient report receipts, with a 24-hour dispatch-context retention limit. The signed completion grant and bounded durable receipt field remain owned by the existing remote-exec authority and exact Session save lane, not a second ledger. Reports cannot supply a Session or grant. Report retry never redispatches a command.

The optional official `X-Foxwarm-Elapsed-Seconds` metadata is measured by the client from process start to finish (or foreground handoff), independent of dispatch/report latency. Integer zero renders `<1s`, positive safe integer seconds render approximate duration with `~`, and absent/invalid legacy metadata renders `unknown`. Reports retain their measured value across retries; Main adds no estimator or programmatic timing field.

The original source Session/Agent, exec identity and grant are captured before dispatch. Background activation and completion retain that owner across Node selection and Session moves. A delivered command stays uncertain after disconnect; no transport expiry or host shutdown kills it. Restart does not reconstruct dispatch context or replay commands. The unchanged client owns independent jobs, bounded 4 KiB head/tail collection and continuous output draining.

## Qualification

`ShellHttpTests` uses owned real HTTP/WebSocket hosts, actual Main-issued claims and owner save lanes. Its system `/bin/sh` case downloads the real bootstrap script and tests missing-utility startup refusal without installation. Its unclaimed-command test observes the real 62-second call deadline without shortening the protocol. It covers independent credentials, publication/revocation serialization, precommit/committed persistence failures, HTTP/WS successor fencing, report transition concurrency, strict-save retry, task/receipt bounds, body/metadata validation, incomplete native data and absent file/service capabilities.

`ShellHttpTests.Duration.cs` covers legacy/invalid/zero/positive metadata and exact background owner/receipt behavior. `experimentHostNodeConsumers.e2e.mjs` downloads the unchanged official client and qualifies short, seconds-long and background timing against the real host.

`experimentHostShellHttp.e2e.mjs` downloads the actual bootstrap script, uses real sh/curl with a restricted BusyBox utility PATH when available, and schema-checks both ordinary model requests and the actual effectful native Monty exec arguments. It checks prefixed routes, rejected error/HTML/unmarked responses, cwd/exit/empty/no-newline/overlapping/binary samples, fractional timeout rounding, 4 MiB continuous output with observed bounded intermediate files, exact background waits across selection/move, strict-save and lost-response retries with one effect/receipt, delivered tasks across HTTP replacement, restart uncertainty and credential revocation. Four 95-second jobs run alongside two concurrent 35-second foreground calls while polling stays alive across the real 90-second boundary; a separately idle HTTP registration expires. It does not qualify physical routers, every BusyBox/curl build or a 24-hour wall-clock run.
