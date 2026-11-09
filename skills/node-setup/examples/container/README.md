# Container executable Node provider

This reference adapter creates disposable Linux containers through Docker or Podman and exposes each container as a Foxwarm Node. It uses the optional [generic executable-provider protocol](https://github.com/550W-HOST/foxwarm/blob/main/docs/executable-node-provider-protocol.md) unchanged. Core has no container-specific configuration type, routing branch or model tool; this is optional example code that administrators register deliberately.

Supported engines are rootless Podman and Docker on Linux. Docker Desktop on macOS and Windows is best effort. The adapter needs Python 3 and the engine CLI on the Main host; nothing is installed by loading this skill.

`provider.py` runs the same target helper as the [Linux SSH adapter](../linux-ssh/README.md) (`../linux-ssh/target.py`), sent through `<engine> exec` instead of SSH. Use the installed `node-setup` skill directory or copy the whole skill, not only this directory.

## What it provides

- **One container per Node.** `create` and `ensure` start a container from an administrator-defined profile; `destroy` removes it with everything written inside it. `inspect` reports the profile, image and state.
- **Models choose only a profile name.** Images, users, resource limits and every security setting come from the private profile file. Lifecycle requests carry no other parameters.
- **No network.** Every container runs with `--network none`. The adapter has no network option.
- **Fixed hardening.** `--cap-drop ALL`, `--security-opt no-new-privileges`, `--init`, `--restart no` and `--pull never` are always applied.
- **No state of its own.** Container labels (`net.foxwarm.provider`, `net.foxwarm.node`, `net.foxwarm.profile` and a few more) are the inventory. Container names start with `foxwarm-` followed by a digest of the Provider ID; leave that prefix to this adapter.
- **Command records survive** the request process and Main restarts, like the SSH adapter's, and live in the container at `/var/tmp/foxwarm-provider`. A container that stops ends its commands; after it is removed, polls report `lost`.
- **Optional Code and Terminal** for profiles with `"services": true`, served by the native CLI Node's `foxwarm-node --stdio` mode inside the container.

Cleanup is always an explicit `destroy`. There is no idle timeout, lease or automatic removal; the [development workflow](../../references/development-workflow.md) shows the coordinator's release step.

## Image

The image needs Linux, `python3`, `/bin/bash`, `/proc`, and a working directory that the container user can write. [`Containerfile`](Containerfile) is an example: a Debian base with Git and a non-root `worker` user owning `/workspace`, plus an optional `with-code` stage that adds the native CLI for Code and Terminal.

Build images yourself and reference them by local name, image ID or registry digest. The adapter never pulls, so a profile always runs the image you prepared. `create` checks the requirements and removes the container again if they are not met.

## Private configuration

Keep the profile file outside the repository. [`profiles.example.json`](profiles.example.json) shows the shape:

| Field | Meaning |
|---|---|
| `engine` | Required. Fixed argument prefix for the engine CLI, for example `["podman"]` or `["docker"]`. |
| `engineEnv` | Optional variables for the engine CLI, for example `XDG_RUNTIME_DIR`, `CONTAINER_HOST` or `DOCKER_HOST`. Core passes providers only a small allowlist of its own environment, so set engine connection variables here. |
| `maxNodes` | Optional limit on containers for this Provider, 1–100, default 20. |
| `profiles` | Required. Profile names map to profiles. |

Each profile accepts:

| Field | Meaning |
|---|---|
| `image` | Required local image name, ID or digest. |
| `description` | Optional one-line text appended to the profile choice that models see, for example `2 CPUs, 4 GB memory, no network.` |
| `user` | Optional `uid:gid` or user name; defaults to the image's user. Prefer a non-root user. |
| `workdir` | Optional absolute working directory, default `/workspace`. It becomes the Node's default directory. |
| `cpus`, `memory`, `pids` | Optional limits passed as `--cpus`, `--memory` and `--pids-limit`. Rootless engines need cgroup v2 controller delegation for these; omit a limit the host cannot enforce. |
| `runtime` | Optional OCI runtime such as `runsc` (gVisor) or `kata`, if installed. |
| `services` | Optional `true` to offer Code and Terminal; the image must provide `foxwarm-node` on `PATH`. |

Unknown fields are rejected, including `network`.

## Foxwarm configuration

```yaml
nodeProviders:
  sandbox:
    type: executable
    command: python3
    args:
      - /absolute/installed-skill/examples/container/provider.py
      - --config
      - /path/to/private/sandbox-profiles.json
    timeoutSeconds: 60
    # parentNode: an existing Node, when delegated coordinators should create containers under its grant
```

Restart Main through your normal administrator workflow after changing startup configuration. A single request can be tried directly:

```sh
printf '%s' '{"protocol":"foxwarm-node-provider","providerId":"sandbox","requestId":"try","operation":"list"}' |
  python3 /absolute/installed-skill/examples/container/provider.py --config /path/to/private/sandbox-profiles.json
```

An unreachable engine returns an error, never an empty inventory.

## Agent use

```text
node(action="inspect", providerId="sandbox")
node(action="ensure", providerId="sandbox", nodeId="sandbox/task-1234", parameters={"profile": "offline"})
create_child_session(agentName="worker", node="sandbox/task-1234", taskId="task_1234", ...)
node(action="destroy", nodeId="sandbox/task-1234", confirmation="destroy node sandbox/task-1234")
```

Create and ensure don't select the Node or assign work. Give each assignment a fresh Node ID, for example one named after the assignment, and never reuse one: authorization rules that follow a Session's current Node compare IDs, so a reused ID would reach the new container from an old Session. The [agent-management](../../../agent-management/SKILL.md) restricted-worker template shows the rules for a worker Agent.

Node IDs use letters, digits, dots, underscores and hyphens. `ensure` needs an explicit ID; `create` generates one when it is omitted. `ensure` starts a stopped container but never changes its profile.

## Security notes

- **Containers share the host kernel.** Namespaces, cgroups and seccomp contain ordinary mistakes and misuse, not kernel exploits. Use a `runtime` such as gVisor or Kata, or a virtual machine, when that matters.
- **Engine access is host-level authority.** The adapter runs as Main's account. Rootful Docker access is equivalent to root on the host; prefer rootless Podman or rootless Docker, or point `engineEnv` at a dedicated remote engine. Mounting the host's Docker socket into Main's own container is not supported. Never mount an engine socket into a sandbox.
- **Everything inside is untrusted.** Command output, logs and status files are written inside the container, so its workload can forge them. Verify deliverables, for example by checking a Git bundle and rerunning tests, before relying on them.
- **No network does not mean no data.** Files you copy into a container are visible to anything running there.
- **Disk use is not limited** by the adapter. Container writable layers grow until `destroy`; set storage quotas in the engine if needed.

## Code and Terminal

For a `services` profile, `list` declares `vscode-fs`, `vscode-git` and `vscode-pty`, and `connect` relays `<engine> exec -i <container> foxwarm-node --stdio`. The CLI needs no pairing, token or network in this mode. Closing the channel closes the CLI's input, which ends it and its terminals; terminals do not survive Main restarts. These services are for administrators in the web interface; they are not model tools.

## Tests (source checkout only)

`../../tests/test_container_provider.py` runs the adapter against `../../tests/fake_container_engine.py`, a minimal engine stand-in, and needs no real engine. `packages/webui/test/mainHostProviderContainer.e2e.mjs` is an opt-in qualification through a real C# Main server and a real engine:

```sh
FOXWARM_TEST_CONTAINER_ENGINE=podman FOXWARM_TEST_CONTAINER_IMAGE=localhost/foxwarm-sandbox:latest \
  node packages/webui/test/mainHostProviderContainer.e2e.mjs
```

It requires a built Main, a running engine and a locally built image from `Containerfile`. It creates and removes only containers labelled with its own Provider ID.
