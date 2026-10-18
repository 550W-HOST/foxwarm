# Linux SSH executable Node provider

This independently runnable reference adapter exposes existing Linux machines through the [generic executable-provider protocol](../../../docs/executable-node-provider-protocol.md). It is optional example code, not a Core SSH backend. Core has no SSH-specific configuration type, routing branch, dependency or model tool.

The local adapter requires Python 3 and OpenSSH. Each target requires Python 3, Bash and Linux `/proc`. It does not require the Foxwarm CLI, pairing credentials or a resident Foxwarm daemon. Commands run as the configured SSH account with that account's filesystem and network permissions. **This is not an OS, VM or network sandbox.**

## Private configuration

Save connection configuration outside the repository. For example:

```json
{
  "nodes": [
    {
      "id": "build-linux",
      "label": "Linux build machine",
      "target": "build-account@host.example",
      "cwd": "~/work",
      "stateDir": "~/.local/state/foxwarm-ssh-provider",
      "sshArgs": ["-F", "/path/to/private/ssh_config"]
    }
  ]
}
```

`target` and `id` are required. Label defaults to ID; cwd defaults to the target home directory; the state directory defaults to the value shown. `sshArgs` is an optional array of fixed OpenSSH arguments. These are administrator inputs, never model-controlled command fragments.

Configure authentication and trusted host keys through normal OpenSSH configuration, identity files, certificates, `known_hosts` and, when needed, an explicitly configured `IdentityAgent` socket. Core's provider child environment is intentionally allowlisted; do not assume that Main's `SSH_AUTH_SOCK` or all its environment variables are forwarded. `IdentityAgent` in `ssh_config` or `-oIdentityAgent=/path/to/agent.sock` selects a local agent explicitly.

The adapter enforces `BatchMode=yes` and `StrictHostKeyChecking=yes`. Enroll the correct target host key before use; an unknown or changed key fails closed. Do not disable host verification to make a connection or test pass. Interactive passwords and passphrase prompts are not supported by the one-shot transport.

## Foxwarm configuration

Add a normal executable provider to private startup configuration:

```yaml
nodeProviders:
  linux-machines:
    type: executable
    command: python3
    args:
      - /path/to/foxwarm/examples/providers/linux-ssh/provider.py
      - --config
      - /path/to/private/linux-machines.json
    timeoutSeconds: 30
```

The example contains placeholders only. Keep real destinations, identities, private keys and configuration out of public source. Restart the configured Foxwarm instance through its normal administrator-controlled workflow after changing startup provider configuration; the adapter does not change an existing deployment itself.

The adapter can also be run directly for a single protocol request:

```sh
printf '%s' '{"protocol":"foxwarm-node-provider","providerId":"linux-machines","requestId":"example-request","operation":"describe"}' |
  python3 examples/providers/linux-ssh/provider.py --config /path/to/private/linux-machines.json
```

The configured provider identity is supplied by the request envelope; the adapter echoes it. `describe` reports no lifecycle actions. `list` checks each configured connection/default directory and advertises ready or offline state. A connection is not machine provisioning: this adapter deliberately does not implement create, ensure, inspect-machine or destroy.

## Agent use

Ordinary file and exec tools remain unchanged:

```text
node(action="list")
node(action="inspect", providerId="linux-machines")
node(action="select", nodeId="build-linux")
read(filePath="README.md")
exec(command="printf 'hello from Linux\n'", timeout=5)
```

Programmatic Node listing includes structured `nodes` and `providers`. The same Node appears in the WebUI directory and Session picker. File/exec capability does not imply Code, terminal, browser or cross-Node copy support. Selection routes execution; it does not create an Agent, assign work, reserve a machine or grant isolation.

File paths, home expansion, relative cwd, symlinks and file permissions use the target Linux namespace. Core applies edit and patch semantics over the adapter's basic filesystem operations. The reference does not restrict an SSH account to the configured cwd; configure a genuinely restricted account or independent containment if that is required.

## Command lifetime and retained data

Start creates a UUID-named execution directory on the target, containing a command script, a detached Python supervisor, merged raw output, process identity, cwd and completion status. The supervisor and Bash command survive the initiating SSH and adapter processes exiting. Poll uses that UUID plus Linux process-start identity and boot identity rather than treating a reused PID as the same execution.

Core persists the provider reference in its existing exec registry. Foreground timeout or Stop ends waiting, not the command. Background completion and wait use Core's existing tracking path. A fresh Core process can query the same target records without starting the command again. Lost records or a missing original process produce `lost`, not a successful exit. Query connection failures are errors and retain tracking.

Output and status remain in `stateDir` until an administrator removes them. There is no automatic machine cleanup, log-retention daemon, transaction or exactly-once launch promise. Core's normal 24-hour notification-tracking expiration does not delete target artifacts or stop commands. Removing active records can lose tracking; remove them only according to your own retention policy. One `stateDir` belongs to one configured target execution namespace, not a shared directory across unrelated machines.

A lost start acknowledgement may mean the target command was submitted. Do not automatically repeat a command after an unknown start outcome. Inspect the adapter's target records through the SSH account instead.

## Tests

`src/nodes/linuxSshProvider.test.ts` is an opt-in integration fixture:

```sh
npm run build
FOXWARM_SSH_TEST=1 node --test lib/nodes/linuxSshProvider.test.js
```

It requires local `ssh`, `ssh-keygen`, `/usr/sbin/sshd`, and noninteractive `sudo` permission to start and stop its own dedicated sshd. It generates fresh client/host keys and an exact trusted-host file, binds only loopback on a disposable port, and cleans up the owned daemon and temporary files. It does not modify the machine's existing SSH service, hosts, Nodes or credentials. Use your normal resource-limited test runner when required by the development environment.

The fixture exercises real SSH transport and separately launched adapter processes, canonical file edits and patches, exact binary bytes, nonzero command exit, whitespace-bearing cwd, bounded large output, command survival after requests exit, completion delivery reattachment across two actual Core processes, unknown-host rejection and cancellation cleanup of an owned blocked SSH request. It is a local SSH fixture, not evidence of VM or network isolation. Generic controlled process fixtures separately exercise uncertain starts, transient/slow polls, lost execution, missing providers, permission fences and unavailable logs.
