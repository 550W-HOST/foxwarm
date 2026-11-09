# Unit: example-container-provider

Files: skills/node-setup/examples/container/provider.py, skills/node-setup/examples/container/README.md, skills/node-setup/examples/container/Containerfile, skills/node-setup/examples/container/profiles.example.json
Secondary files: skills/node-setup/examples/linux-ssh/target.py, skills/node-setup/tests/test_container_provider.py, skills/node-setup/tests/fake_container_engine.py, packages/webui/test/mainHostProviderContainer.e2e.mjs, .github/workflows/container-provider.yml, docs/executable-node-provider-protocol.md

## Purpose

An optional reference executable Provider that creates disposable Docker or Podman containers, one per Node, from administrator-defined profiles. It is Foxwarm's public answer to "run delegated or untrusted work in a disposable environment" without a Core change: it uses the generic executable-provider protocol unchanged, like the [Linux SSH reference](./example-linux-ssh-provider.md). Core has no container-specific configuration type, routing branch, dependency or model tool.

## Key decisions

- **Models choose only a profile name.** Lifecycle parameters are a closed schema with one required `profile` enum built from the private configuration. Images, users, limits and runtimes are administrator inputs, never model-controlled arguments. Rationale: the model-facing surface stays a choice among reviewed environments rather than a container-engine API.
- **No network option.** Every container runs with `--network none`; a `network` profile field is rejected. Networked profiles are out of scope for the shipped reference.
- **Fixed hardening.** `--cap-drop ALL`, `--security-opt no-new-privileges`, `--init`, `--restart no` and `--pull never` are always applied. The writable layer holds the workspace and command records; there are no volumes, so `destroy` (`rm -f -v`) removes everything.
- **Labels are the inventory.** `net.foxwarm.provider`, `node`, `profile`, `workdir`, `image`, `services`, plus `agent` and `source-session` from the lifecycle request. Container names are `foxwarm-<sha256(providerId)[:8]>-<localNodeId>`, so two Providers can share one engine. The adapter keeps no state of its own. Labels carry no installation identity, so installations sharing one engine account must use distinct Provider IDs (documented, not enforced).
- **Explicit release only.** No idle timeout, lease or automatic removal. The coordinator destroys a Node through the `node` tool, normally via the development workflow's `release` phase.
- **Engine access is host authority.** The adapter runs as the Main server's account with the configured engine CLI (`engine` argv prefix, optional `engineEnv` because Core forwards only its provider environment allowlist). Mounting the host engine socket into the Main server's container is unsupported, and the official Main server image has no engine CLI. Linux Docker and Podman, preferably rootless, are the intended targets; real-engine behaviour is checked only by the opt-in smoke test and its manually started workflow. Docker Desktop has not been checked.

## Function index

| Function | Responsibility |
|---|---|
| `load_config()` / `validate_profile()` | Strict private JSON: `engine`, `engineEnv`, `maxNodes` (1–100, default 20) and `profiles` with `image`, `description`, `user`, `workdir`, `cpus`, `memory`, `pids`, `runtime`, `services`; unknown fields rejected |
| `describe()` | Label, description, lifecycle `create`/`ensure`/`inspect`/`destroy`, shared profile-only schema, lifecycle text and data retention; needs no engine |
| `inventory()` | Label-filtered `ps -a -q`, then `inspect`, retried once when a container disappears between the calls; engine failure is an error, never an empty inventory |
| `descriptor()` | `kind: sandbox`, `type: container`; running→ready, dead→error, otherwise offline; `defaultCwd` from the workdir label; Code/Terminal services only for `services` profiles |
| `create()` | Pre-check absent ID and `maxNodes`; `run` with fixed flags and profile limits; remove leftovers on failure; probe with `requireExec` and remove the container when the image cannot run commands |
| `ensure()` | Requires an ID; refuses a different profile; starts a stopped container or unpauses a paused one; creates a missing one |
| `inspect()` / `destroy()` | Profile, image, state and `network: none` details; idempotent removal, including a failed `rm` because another caller removed the container first |
| `target()` / `primitive()` | Send the shared Linux target helper through `<engine> exec -i <name> python3 -c`, with the container working directory and `/var/tmp/foxwarm-provider` as state directory; a poll for a removed container, or one whose processes ended because it stopped (any state except running, paused or restarting), reports `lost` |
| `connect()` | Relay the service channel to `foxwarm-node --stdio` in the container, turning its ready line (at most 64 KiB, newline-terminated, like Core's handshake limit) into the confirmation; stdin EOF ends the channel |

## Contract and limits

- Node IDs passed to the adapter are local IDs using letters, digits, `.`, `_` and `-` (Core also allows `:`, which container names do not). `create` without an ID generates `c-<12 hex>`.
- File and exec primitives reuse `linux-ssh/target.py` unchanged in protocol: the same ranged filesystem operations, detached supervisor, UUID execution records and Linux process identity. Records live inside the container; stopping or removing it ends its commands, which polls then report as `lost`.
- Output, logs and status files are written inside the container and can be forged by its workload; coordinators verify deliverables independently.
- The image needs Linux, `python3`, `/bin/bash` and a working directory writable by the container user. `requireExec` in the shared probe checks the writable working/state directories and Bash at creation.
- Code/Terminal requires a native CLI Node with `--stdio` in the image; the example `Containerfile`'s optional `with-code` stage adds a local CLI archive from the build context. These are administrator WebUI services, not model tools.
- Disk use is not limited by the adapter. Containers share the host kernel; profiles may name another OCI runtime (for example gVisor or Kata) when that matters.
- Node-ID reuse is a policy hazard for `node: {current: true}` rules, so the README and development workflow require a fresh ID per assignment.

## Validation

`test_container_provider.py` runs the adapter against `fake_container_engine.py`, a minimal engine CLI stand-in whose containers are directories and whose `exec` runs the requested command locally. It covers describe without an engine, configuration rejection, fixed flags and labels, profile-only parameters and safe IDs, cleanup after failed creation and failed image probes, ensure start/unpause/profile refusal, `maxNodes`, Provider separation on one engine, files and commands through the shared helper, `lost` after a stop or destroy but not while paused, destroy after a concurrent removal, unreachable engines, the service-channel relay until EOF, a refused unbounded ready line and an installed-skill copy.

`mainHostProviderContainer.e2e.mjs` is a manual smoke test (`FOXWARM_TEST_CONTAINER_ENGINE`, `FOXWARM_TEST_CONTAINER_IMAGE`, optional `FOXWARM_TEST_CONTAINER_CODE_IMAGE`) through a real C# Main server and a real engine: discovery, rejected extra parameters, create with `NetworkMode: none`, canonical files and patches, a binary round trip, commands that see only loopback (`ENETUNREACH` for a public address) and no capabilities, the exact command reference across a Main server restart, loss reporting after a container stop and `ensure`, a terminal on a Code profile through `connect`, and destroy. It passes `XDG_RUNTIME_DIR` to the engine through `engineEnv` when set, as rootless Podman needs, and removes only containers labelled with its own Provider ID.

`.github/workflows/container-provider.yml` runs it only on manual dispatch: one job builds the static CLI Node from the same commit, then a matrix runs the smoke test with the runner's Docker and with rootless Podman (a lingering user manager supplies the runtime directory and delegated cgroup controllers), building both example image targets with that CLI archive. It uses no repository secrets.
