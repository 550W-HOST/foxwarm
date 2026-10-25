# Unit: example-linux-ssh-provider

Files: skills/node-setup/examples/linux-ssh/provider.py, skills/node-setup/examples/linux-ssh/target.py, skills/node-setup/examples/linux-ssh/README.md
Secondary files: scripts/test/loopbackSshFixture.cjs, scripts/test/diagnose-loopback-ssh.cjs, packages/webui/test/experimentHostProviderSsh.e2e.mjs, src/nodes/linuxSshProvider.test.ts, src/nodes/providerExecRestartTestFixture.ts, docs/executable-node-provider-protocol.md

## Purpose

An optional independently runnable reference implementation of the generic executable-provider protocol for existing Linux machines. The protocol is its only Core integration surface: there are no imports from private Core modules, SSH routing branches, SSH dependencies in Core, SSH-specific model tools or `type:ssh` configuration.

## Functions and responsibilities

| Function or component | Responsibility |
|---|---|
| `provider.py.main()` | Read private connection configuration and one public request envelope; describe/list configured machines or route exact Node primitives |
| `provider.py.remote()` | Standard noninteractive OpenSSH invocation, strict host verification, target helper transport and owned-child cleanup on request termination |
| `target.py.filesystem()` | Linux-native parent/stat/ranged read/readdir/whole write/recursive mkdir/remove over target paths and captured cwd |
| `target.py.start()` | Create a private UUID execution directory, preserve command data, launch a detached supervisor and return an actual target log/cwd receipt |
| `target.py.run_command()` | Run Bash independently of the request connection, retain raw merged output and atomically publish actual exit/cwd state |
| `target.py.identity()` / `poll()` | Match Linux boot/start identity rather than reused PID alone; read completion, observe running cwd or explicitly report lost records/process |
| `loopbackSshFixture.cjs` | Shared owned loopback sshd with generated keys, exact trusted-host file and verified owned-PID cleanup; no host service/configuration changes |
| `linuxSshProvider.test.ts` / `experimentHostProviderSsh.e2e.mjs` | Source and ordinary C# Main public-protocol interoperability over the shared real SSH fixture |
| `providerExecRestartTestFixture.ts` | Separate short-lived Core process for start or persisted-reference recovery |

## Contract and limits

- Configure as ordinary `type:executable`, using `python3 provider.py --config <private JSON>`. Connection targets, SSH arguments, account permissions, target cwd and state directory belong solely to this adapter.
- The adapter and adjacent target helper are bundled resources of `node-setup`; their basic execution needs no source checkout. Local optional administrator prerequisites are Python 3 and OpenSSH. Targets require Python 3, Bash and Linux `/proc`, not Foxwarm, pairing or a CLI daemon. Standard SSH identity/configuration and explicitly configured agent sockets are supported; Core's child-environment allowlist is not bypassed.
- The adapter enforces noninteractive authentication and strict host verification. Unknown/changed keys fail; production examples contain placeholders only. It never disables host checking for tests.
- Nodes are existing machines, advertised as remote with read-write filesystem and exec. List probes connectivity/default cwd; describe declares an empty lifecycle. There is no fictitious create/ensure/destroy operation.
- Commands use the SSH account's real filesystem and network authority. Configured cwd is not a jail. No VM, OS or network sandbox is claimed.
- File bytes use base64 and target-native byte offsets. Core retains canonical edits, patch semantics, formatting and permission checks. Raw logs are target files, not Main cache paths.
- Each start has a UUID reference and independent target execution directory. The supervisor and command survive SSH/adapter request exit. Poll distinguishes transient transport failure from explicit lost state and validates kernel process identity before reporting running.
- Status/logs remain until administrator cleanup. Core's existing tracking expiration does not remove target records or stop the command. Missing launch acknowledgement remains unknown and must not be automatically replayed.
- No Code/PTY/browser support is implied. Standard cross-Node copy uses the adapter's bounded filesystem primitives. Provider lifecycle is optional, and the example does not change selection/cwd policy or manage Agent/worktree resources.

## Validation

The opt-in Linux SSH test starts only its owned loopback sshd using temporary host/client keys, authorized keys, config, port and target data. It uses exact host-key trust, proves rejection after trust is removed and proves cancellation reaps an owned SSH child blocked in a target file read. The owned daemon uses PAM account/session processing with password and keyboard-interactive authentication disabled, keeping generated-key login under platform account policy instead of OpenSSH's non-PAM locked-account precheck. StrictModes and exact host trust remain enabled. Its captured daemon diagnostics are bounded and included only when initial native discovery fails. The existing host SSH service, account state and existing Node credentials/deployments are not changed.

It covers generic discovery/inspection, absent lifecycle, canonical write/edit/patch/read, exact binary bytes, 12 MiB bounded binary transfer round trips, real nonzero command exit, original shell EOF/newline behavior, quoted/Unicode/whitespace-bearing target cwd and exact-owner synchronization, background survival/completion, bounded large logs and reattachment across two actual Core process exits without another start. The environment is local real SSH transport, not an isolation demonstration. Controlled generic subprocess fixtures separately cover uncertain start, hard owner loss, transient/slow queries, lost state, missing configuration, denied authority and unavailable output.

The C# Main qualification uses the packaged public adapter and adjacent helper without source-tree imports. It exercises ordinary model/native ToolScript callers, structured discovery with empty lifecycle, explicit unsupported operations, canonical files, bounded binary transfer, target cwd/raw logs and the exact provider reference across an actual Main exit/restart. The target directory count and single effect confirm no repeated start. Removing exact host trust makes discovery offline and prevents command submission.
