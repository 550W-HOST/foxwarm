# Docker worktree Node provider

The `docker-worktree` startup provider runs the shared Foxwarm file capabilities inside a provider-owned Linux container for one already-existing Git worktree or checkout. Node remains the selectable execution identity; the provider is internal routing and lifecycle authority.

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

The container runs as the Foxwarm host uid/gid with an immutable image root, bounded scratch space/resources, no published ports, no Docker socket, all Linux capabilities dropped, and `no-new-privileges`. Only the exact worktree is writable. The exact `.git` marker plus Git administrative and common directories are over-mounted read-only, including linked-worktree marker files and standalone `.git` directories, so `status` and `diff` work but marker rewrites and commits/ref/object mutations do not.

Phase 4A advertises only `read`, `write`, `edit`, and `apply_patch`. It intentionally has no `exec`, browser, PTY, Code, fixed-service, or copy capability. Shared inline-image results are preserved. `contentRef` is not transferable to this Node and is rejected with a direct instruction to provide literal content.

Destroy removes only the provider-owned container and registration. Worktree bytes and changes, Git metadata, and provider state/log directories remain. Docker isolation is not a VM-grade security guarantee, and configured bridge networking permits worktree data to leave through ordinary egress.

All container-behavior and security-authoritative startup settings, canonical state authority, allowed roots, and runtime uid/gid are fingerprinted. A runtime created under stale settings is listed unavailable and cannot execute capabilities; inspect reports stale identity without worktree-content evaluation, while exact destroy remains available. A same-provider runtime under a different full identity fails closed and is not crash-gap cleanup. Container names include a digest of the complete provider ID, exact Node ID, and config fingerprint, so readable-prefix and punctuation normalization cannot collide. Exact names and labels allow bounded cleanup after an ambiguous Docker start or a crash before state persistence without adopting unknown containers. Provider state is canonicalized and must not overlap the worktree, `.git` marker, or Git administration paths. Paths containing Docker `--mount` comma delimiters or control characters are rejected.

Main-side Git inspection independently validates standalone or registered linked-worktree marker/admin/backlink/commondir relationships. It reports only HEAD and branch identity; it never evaluates dirty state or worktree file content. Exact Git/worktree environment disables system/global config, fsmonitor, hooks, external diff, pagers, optional locks, and submodule recursion, and does not refresh the index or invoke attribute-selected filters. A forged pointer to an unrelated repository is rejected before Docker effect.

Destroy first durably commits a provider-private exact intent, then removes the corroborated container, then durably removes the Node and intent. State replacement fsyncs the temporary file, rename, and containing directory and cleans temporary artifacts. List/create/ensure/destroy recover an already-confirmed pending intent by retrying exact removal or finalizing an already-absent container; mismatched identity remains untouched. Cancellation is propagated to Docker calls and waits for the direct launcher child to close before returning.

Docker command stdin errors are contained until direct-child close. Serialized helper input is rejected before spawn when it exceeds the fixed 8 MiB provider envelope.
