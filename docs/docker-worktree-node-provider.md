# Docker worktree Node provider

The `docker-worktree` startup provider runs canonical Foxwarm file and persistent `exec` capabilities inside a provider-owned Linux container for one already-existing Git worktree or checkout. Node remains the selectable execution identity; the provider is internal routing and lifecycle authority.

```yaml
nodeProviders:
  local-dev-containers:
    type: docker-worktree
    command: sudo
    args: [-n, docker]
    image: foxwarm-sandbox-node-runtime:local
    allowedWorktreeRoots:
      - /srv/foxwarm-worktrees
    networkModes: [none, bridge]
```

Build the example helper image from the repository root after `npm run build`:

```text
docker build -f packages/sandbox-node-runtime/Dockerfile -t foxwarm-sandbox-node-runtime:local .
```

Lifecycle `create` and `ensure` require an exact Node ID plus `parameters.worktreePath`; `parameters.networkMode` may select only a configured mode and defaults to `none`. The provider never creates, deletes, moves, clones, commits, or cleans a Git worktree.

The container runs as the Foxwarm host uid/gid with an immutable image root, bounded scratch space/resources, no published ports, no Docker socket, all Linux capabilities dropped, and `no-new-privileges`. Only the exact worktree and one exact provider-private generation artifact directory are writable. The exact `.git` marker plus Git administrative and common directories are over-mounted read-only, including linked-worktree marker files and standalone `.git` directories, so marker rewrites and commits/ref/object mutations are unavailable.

The provider advertises canonical `read`, `write`, `edit`, `apply_patch`, and `exec`. File mutation remains worktree-only; `read` may also open exact retained execution logs/artifacts by their canonical absolute paths. Shared inline-image results are preserved. `contentRef` is not transferable to this Node and is rejected with a direct instruction to provide literal content. Browser, PTY, Code, fixed-service, and copy capabilities remain absent.

`exec` reuses the shared persistent manager and output formatter. The manager writes scripts, registry, logs, status, and cwd files only in the exact generation artifact directory, then launches its generated Bash script through the configured fixed Docker launcher with `shell:false`. The container receives only `TERM` and the manager's `FOXWARM_EXEC_*` values; Main environment, Session authority, Docker credentials, and the Docker socket are not passed into it. Foreground output, timeout clamping, timeout-to-background notices, bounded excerpts, exit reporting, cwd notices, and retrying background completion use canonical Foxwarm behavior. Completion enters the exact source Session through Main's authoritative system-event path, including startup reconciliation after Main restarts.

Core explicitly awaits provider initialization after Session catalog/ingress startup and before Node execution becomes available; startup errors fail readiness instead of being swallowed. The persisted exec record includes the exact generated script path. After restart, liveness and cwd reconciliation use that script's exact process lineage from `docker top`, not the former launcher PID, so launcher death or host PID reuse cannot decide container-command truth. If `docker top` fails, an exact running-only container query distinguishes absent/stopped/exited containers (terminal) from an exact still-running container (retry/fail closed). Core shutdown first fences Node execution, then closes provider reconcile runtimes while Session ingress is still available.

Docker's launcher process is the managed host child; container descendants are not claimed as host descendants. Timeout cwd inspection is best-effort through bounded `docker top` plus the matching container process lineage, while finished commands publish their exact cwd artifact. The timeout process view truthfully reports the Docker launcher boundary instead of presenting container children as host descendants. Destroy kills the exact container and moves a busy generation into bounded private retired state until its registry is empty and completion has been delivered or its foreground caller has finalized. Registry-idle notification schedules exact retired cleanup for both foreground and background paths. Restart initializes active, destroy-intent, and retired generations. Recreating the same Node ID creates a new generation immediately; the old one is completion-only and non-callable. Idle retired runtimes are shut down and removed so repeated recreate does not accumulate timers.

Provider state is written as version 3. The earlier Phase 4B version 2 shape that already contains generation artifacts remains readable and is rewritten as version 3 on the next locked provider mutation.

This boundary is intended primarily to prevent accidental interference and mis-operation. It is not presented as resistance to a deliberately malicious command with access to its own writable worktree/artifact mount.

Destroy removes only the provider-owned container and registration. Worktree bytes and changes, Git metadata, and exact generation execution artifacts remain. Docker isolation is not a VM-grade security guarantee, and configured bridge networking permits worktree data to leave through ordinary egress.

All container-behavior and security-authoritative startup settings, canonical state authority, allowed roots, and runtime uid/gid are fingerprinted. A runtime created under stale settings is listed unavailable and cannot execute capabilities; inspect reports stale identity without worktree-content evaluation, while exact destroy remains available. A same-provider runtime under a different full identity fails closed and is not crash-gap cleanup. Container names include a digest of the complete provider ID, exact Node ID, and config fingerprint, so readable-prefix and punctuation normalization cannot collide. Exact names and labels allow bounded cleanup after an ambiguous Docker start or a crash before state persistence without adopting unknown containers. Provider state is canonicalized and must not overlap the worktree, `.git` marker, or Git administration paths. Paths containing Docker `--mount` comma delimiters or control characters are rejected.

Main-side Git inspection independently validates standalone or registered linked-worktree marker/admin/backlink/commondir relationships. It reports only HEAD and branch identity; it never evaluates dirty state or worktree file content. Exact Git/worktree environment disables system/global config, fsmonitor, hooks, external diff, pagers, optional locks, and submodule recursion, and does not refresh the index or invoke attribute-selected filters. A forged pointer to an unrelated repository is rejected before Docker effect.

## Temporary isolated worker workflow

Use the bundled `isolated-worker` skill when a non-isolated coordinator should ensure one of these Nodes and bind a temporary isolated agent/session to it. The skill accepts an exact configured provider ID, exact Node ID, exact existing worktree path, and optional `networkMode` (`none` by default; `bridge` only explicitly).

Dry run is mutation-free. It parses Node rows only before the exact `Lifecycle providers:` section and provider/action rows only after it, failing closed on malformed or ambiguous structure. It verifies that the provider advertises `ensure`; if the Node already exists, it performs read-only inspect and validates the exact provider, ready `sandbox` / `docker-worktree` descriptor, canonical default cwd, worktree evidence, and network mode. If absent, dry run reports the planned ensure truthfully without creating the Node.

Apply mode calls provider-neutral ensure, then read-only inspect, and only after exact validation creates the isolated agent, parent-linked session, and complete worker handoff. The workflow remains fail-fast and non-transactional. Post-error accounting separates a raw exact requested-Node descriptor from full provider/worktree/network validation and reports presence as `present` or `unknown`; unknown yields a possible Node survivor rather than false absence. It never creates a Git worktree, auto-destroys a Node, deletes an agent, or treats agent binding as Node ownership. Preflight absence followed by presence after ensure does not prove creation or ownership because another coordinator may race between those observations and no lease exists. Cleanup therefore retains provider-backed Nodes by default and returns no destroy descriptor solely from preflight absence; explicit destroy requires separate inspection plus independent operator/workflow confirmation that the Node is disposable.

Destroy first durably commits a provider-private exact intent, then removes the corroborated container, then durably removes the Node and intent. State replacement fsyncs the temporary file, rename, and containing directory and cleans temporary artifacts. List/create/ensure/destroy recover an already-confirmed pending intent by retrying exact removal or finalizing an already-absent container; mismatched identity remains untouched. Cancellation is propagated to Docker calls and waits for the direct launcher child to close before returning.

Docker command stdin errors are contained until direct-child close. Serialized helper input is rejected before spawn when it exceeds the fixed 8 MiB provider envelope.
