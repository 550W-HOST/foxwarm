# Unit: src-docker-worktree-provider

Files: src/nodes/dockerWorktreeProvider.ts, src/nodes/dockerWorktreeProvider.test.ts, packages/sandbox-node-runtime/src/invoke.ts, packages/sandbox-node-runtime/src/worktreeFileOperations.ts, packages/sandbox-node-runtime/src/worktreeFileOperations.test.ts, packages/sandbox-node-runtime/package.json, packages/sandbox-node-runtime/tsconfig.json, packages/sandbox-node-runtime/Dockerfile
Secondary files: src/config.ts, packages/shared/src/configSchemas.ts, src/nodes/providers.ts, docs/docker-worktree-node-provider.md

## Purpose

Implements the first resident concrete sandbox-kind provider: one provider-owned Linux Docker container for one already-existing allowlisted Git worktree or checkout. The provider owns exact lifecycle state and Docker identity while a tiny target-local helper reuses canonical shared file tools inside the container.

## Key exports

- `DockerWorktreeNodeProvider` — list/lookup/default-cwd, create/ensure/inspect/destroy, and complete file-capability invocation.
- `DockerCommandRunner` / `NativeDockerCommandRunner` — bounded injectable Docker CLI boundary supporting fixed launchers such as `sudo -n docker`.
- `createWorktreeFileOperations` / `assertWorktreePath` — target-local root and symlink policy composed with shared file tools.

## Behavior

- Startup configuration fixes the Docker launcher arguments, image, allowed worktree roots, allowed network modes, state location/default, and resource limits. Lifecycle parameters may contain only `worktreePath` and an allowed `networkMode`; create/ensure require an exact Node ID.
- The host independently validates a standalone repository or registered linked worktree marker/admin/backlink/commondir relationship and sanitized `git worktree list`, rejects Docker mount delimiter/control characters, then records canonical worktree, marker type/path, Git administrative/common paths, image/network/container identity, uid/gid, creation metadata, and the complete state-location/container-behavior fingerprint in a bounded durable state file. Provider state is authority; Docker inspect must corroborate ID, full-identity digest name, labels, image, network, and user.
- One Node owns one canonical worktree. Ensure is idempotent only when immutable worktree/Git/image/network identity matches.
- Containers are non-root numeric-host-user processes with init, read-only image root, no published ports, no Docker socket, all capabilities dropped, no-new-privileges, bounded memory/CPU/PIDs, and tmpfs scratch. The exact worktree is writable; its exact `.git` marker and Git administrative/common paths are over-mounted read-only, including linked marker files and standalone `.git` directories. Canonical provider state may not overlap any mounted worktree/Git authority path.
- The descriptor advertises only `read`, `write`, `edit`, and `apply_patch`. The helper invokes shared implementations with target-local file operations and returns their canonical inline-image shape. It rejects traversal, absolute paths outside the worktree, every existing symlink component, unsafe create paths, invalid cwd, unsupported capabilities, and `contentRef`.
- Inspect reports bounded worktree HEAD/branch identity plus container/network status and explicit containment, read-only-Git, and missing-capability limitations. It does not evaluate dirty state or worktree file content. Destroy removes only the corroborated provider-owned container and registration; worktree bytes/changes, Git metadata, and provider state/log directories remain.
- Main-side Git evidence uses fixed `GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE`, disables system/global config, fsmonitor, hooks, external diff, pagers, optional locks, and submodule recursion, and preserves the index. It reads only registration plus HEAD/symbolic-ref identity, never status/worktree content, so attribute-selected clean/process filters cannot run. Forged pointers to unrelated repositories are rejected before Docker effect.
- Stale startup fingerprints, including canonical state authority and runtime uid/gid, list unavailable and fence default-cwd/capability execution. A same-provider runtime under another full identity fails closed and is never crash-gap cleanup. Inspect corroborates the old runtime and reports stale configuration without worktree-content evaluation; destroy can still remove the exact old runtime. Names include a digest of complete provider ID, exact Node ID, and config hash; exact labels support cleanup, not adoption, after ambiguous start or pre-state crash gaps.
- Destroy durably writes an exact private intent before Docker effect, then durably finalizes removal. File and directory fsync plus temporary cleanup make replacement suitable for recovery. List/create/ensure/destroy retry exact pending removal or finalize an already-absent exact runtime; mismatches remain pending and untouched.
- Abort signals fence queued effects, terminate bounded Docker launcher children, wait for their close, and trigger exact orphan reconciliation for ambiguous starts. Linux, Docker, image, helper, state, and identity failures fail closed and never fall back to master.

## Tests

Deterministic fake-Docker tests cover lifecycle identity, full-ID name collisions, security/resource arguments, mount-path delimiter rejection, stale config fencing, exact ambiguous-start/crash-gap cleanup, durable destroy-intent failure/recovery, linked and standalone read-only Git markers, state overlap, cancellation timing, one-worktree ownership, exact ensure, file dispatch, missing exec, inspect, retained destroy, denied roots/networks, and mismatched labels. Target-local tests cover safe creation plus traversal and symlink rejection without a Docker daemon.

## Integration

- `src/nodes/providers.ts` selects this resident provider for normalized `type: docker-worktree` config while retaining executable-provider behavior.
- Generic authorization, topology, selection, lifecycle confirmation, and no-fallback behavior remain in `src/nodeExecutionService.ts` and `NodeProviderRegistry`.
- Canonical contract: [D-dispatch-docker-worktree-provider](../threads/tool-dispatch.md#d-dispatch-docker-worktree-provider).
