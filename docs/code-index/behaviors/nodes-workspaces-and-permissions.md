# Behavior: Nodes, workspaces, and permissions

For developers and Agents changing execution placement, filesystem access, or Node lifecycle. A Node names an execution environment; a Session selects one, and a Provider exposes or manages it. None of these facts alone grants permission, creates an exclusive workspace, or establishes an operating-system sandbox.

## Selection routes operations, not the whole Session

Session conversation and [turn ownership](messages-and-turns.md#which-boundary-am-i-observing) do not move to a remote Node when `currentNode` changes. Placement follows the resolved operation:

| Operation | Observable placement |
| --- | --- |
| Direct `read`, `write`, `edit`, `apply_patch`, `exec`, or `browse_*` | Uses the Session's selected Node. At `master`, uses the local handler; elsewhere, requires that exact Node's capability. |
| `call_tool` with `source=node` | Uses its explicit `nodeId`, or the current Node if omitted. An explicit other-Node call does not import the current Node's cwd. |
| Agent memory tools | Use the Agent's memory on Main, not an arbitrary `memory/` directory on the selected Node. |
| Session, Task, topology, and Provider lifecycle operations | Retain their operation-specific owners. Selecting a Node does not turn management tools into remote shell tools. |
| `send_file.node`, `image_write_to_file.node` | Select a file source or destination for a compound operation; delivery/image lookup still has its own owner. |
| File-backed ToolScript `node` | Selects where to read the script, not where its VM runs. Nested calls independently resolve placement and permissions. |
| Code and browser Terminal | Use their own explicit Node/path targets and fixed backend services, not implicit model-tool dispatch. |

The canonical Node-capability set is deliberately narrow. A builtin cannot become a Node tool just because it touches files or has a parameter named `node`. An unavailable Node or unsupported capability fails at that target; it never silently executes on Main. See [placement and compound operations](../threads/tool-dispatch-node-execution.md) and [canonical target resolution](../threads/tool-dispatch-authorization.md#d-dispatch-resolved-target).

### Two selection paths have different cwd behavior

- Model-tool `node({ action: "select", nodeId })` validates the target, commits it to the current Session, and **clears the previous cwd**. Subsequent environment calls use the new Node's default until a cwd is established. Failed selection in an ordinary model batch skips unstarted later calls; completed effects remain. ToolScript has its ordinary explicit control flow instead of that model-batch skip rule.
- The user `/node` command and administrator Chat Node picker retain the Session cwd. The picker commits only a confirmed exact-owner response, does not send a chat message or start a model turn, and keeps an unavailable current ID visible rather than substituting `master`.

Agent-bound isolation restricts selection independently. The model cannot use selection to escape the binding; administrator/user controls retain their existing validation. These differences are owned by [selection prerequisites](../threads/tool-dispatch-authorization.md#d-dispatch-node-selection-batch-prerequisite) and the [Chat Node picker](../units/webui-chat-composer.md#d-composer-session-node-picker).

## Paths belong to an environment and an operation

A useful file locator is **Node plus path**, with the relevant base directory when the path is relative. The same spelling on two Nodes need not refer to the same bytes. A Session cwd is neither file ownership nor an authorization boundary. Multiple Sessions may share a Node and directory; selection creates no lease or worktree.

| Path situation | Consequence |
| --- | --- |
| Native Main/CLI file tools | Relative paths use Session cwd, otherwise the target's Agent directory. Absolute and home-relative paths retain native meaning. |
| Native Agent-owned exec | Explicit `cwd` takes precedence over Session cwd, then the environment's default. Reported cwd synchronization supplies the later file/exec default; use explicit cwd for a known target rather than relying on a preceding parallel shell call. |
| Native Main/CLI Agent paths | A leading `$fw_agentdir` or `$fw_tmp` resolves on the target Node. Exec children receive the corresponding actual Agent paths; changing cwd does not change the Agent root. Other leading `$` path names are rejected; shell command text still follows shell expansion. |
| Primitive Provider paths | Ordinary paths are opaque to Main and interpreted by the Provider. Relative file/exec placement uses its supplied context/defaults; native Agent-root tokens are unsupported. |
| `copy_between_nodes` relative endpoints | Main/CLI legs are Agent-directory-relative; primitive Provider legs use that environment's default directory, not Session cwd. Each endpoint resolves separately. |
| `send_file` relative source | Main uses Session cwd then Agent directory. Remote transfer readers retain their own transfer defaults rather than inheriting an unrelated Main cwd. |

The differing transfer bases are implemented behavior, not a universal relative-path convention. Prefer explicit locators at cross-Node boundaries. [Attachment storage and file delivery](files-images-and-attachments.md#storage-does-not-follow-every-node-selection) have their own placement rather than following every selection. Successful native file-tool results retain their actual resolved Node/path for Code actions; older relative-path records must not be reinterpreted using today's cwd. Detailed rules remain in [native paths](../threads/tool-dispatch-node-execution.md#d-dispatch-native-agent-paths-and-code-targets), [transfer semantics](../threads/tool-dispatch-node-execution.md#d-dispatch-generic-node-transfer), and [file delivery](../units/src-file-delivery.md).

Updating an existing native file through overwrite, exact edit, or patch Update retains its existing permission bits. Configuration and Session-authority installers have separate replacement contracts; this native-file rule does not make ordinary updates atomic. File operations retain ordinary filesystem consequences: `write` protects existing files unless overwrite is explicit and creates missing parents only with `createDirs`; exact `edit` requires one match. Multi-file patches apply sequentially and may leave earlier operations applied when a later one fails. Cross-Node copy may leave a partial destination after failure. Shared semantics do not add transactions, rollback, or permission to overwrite. See [shared file semantics](../threads/tool-dispatch-node-execution.md#d-dispatch-shared-file-semantics).

## Authority has several independent boundaries

| Boundary | What it decides | What it does not establish |
| --- | --- | --- |
| Node environment | Available filesystem/process/browser capabilities and their actual effects. | Agent identity, tool authorization, or OS/network containment merely from its Node label. |
| Agent isolation | Current legacy Agent-level target/path/relationship restrictions, including its bound Node and Agent-scoped Main paths. | Exclusive Node ownership or virtualization. Memory inheritance is not permission inheritance. |
| Generic tool policy | Whether this caller may perform this resolved capability with these arguments, paths, and actual Node effects. | Bypass of structural checks, service availability, or the environment's own restrictions. |
| Entry identity | Authority granted to an authenticated inbound MCP or scoped WebUI caller. | A fabricated internal Agent or automatic permission for the runtime Agent in an accessible Session. |
| Administrator WebUI | Existing full-access instance administration and its fixed Code/Terminal routes. | A model tool-policy decision on behalf of a selected Session. |

The legacy isolation mode is deprecated but its current checks still apply until explicitly migrated. Generic policy can restrict non-isolated Agents too; an allow passes that layer only. Path checks cover existing static symlink prefixes but are not a race-proof OS sandbox. Actual container, filesystem, process, or network isolation depends on the environment supplied by its operator/Provider. See [permissions](../modules/tools-and-permissions.md), [policy evaluation](../threads/tool-dispatch-authorization.md#d-dispatch-generic-tool-authorization), and [entry identities](../units/src-access-config.md).

Restricted text ingress must classify commands consistently with the actual dispatcher: alternate supported whitespace or mention forms cannot grant management effects, and ordinary non-command text must remain ordinary input. This concerns the [scoped WebUI entry boundary](../modules/webui.md#d-webui-identity-session-scope), not administrator selected-Session authority. The concrete admission and command paths are in [WebUI](../units/src-channels-webui.md#behavior) and [Router ingress](../units/src-message-router.md#behavior-and-invariants).

### Discoverable is not necessarily invocable

Discovery, default schema injection, strict authorization, and execution are separate stages:

1. Discovery projects available capabilities through current policy and structural visibility. A definite denial is hidden; an argument-dependent possible allow may remain visible.
2. Invocation resolves the actual builtin, MCP server, or Node capability. `call_tool` and ToolScript do not substitute their wrapper identity for the concrete operation.
3. Strict authorization evaluates the actual arguments and affected endpoints. A multi-Node allow must cover every endpoint; a matching Node deny can stop the operation.
4. The target still validates its own paths, advertised capabilities, connection, and service requirements. A visible tool may therefore reject a particular request.

Conversely, omission from the default model schema does not mean removal: supported hidden tools may be found through discovery and invoked when authorized. A Node listed as connected may be protocol-incompatible or lack a requested capability. These are different failures, not reasons to fall back to Main. See [unified discovery](../modules/tools-and-permissions.md#d-tools-unified-discovery) and [resolved authorization](../threads/tool-dispatch-authorization.md).

## Lifecycle and platform differences are explicit

Inspect a Provider's advertised operations, parameter schemas, and retention description before create/ensure/destroy. Core routes lifecycle to the exact Provider; it does not prescribe that destroy deletes data, releases every external resource, or stops processes in every backend. Effectively isolated callers cannot create/ensure/destroy through this management surface even with an exact tool allow. Selection and inspect are not lifecycle creation.

Revoking an authenticated Node with `node_remove` is different again: it removes approval and disconnects the active runtime, but does not stop the client, destroy its environment, delete files, or rebind Sessions/Agents. Persisted selection can therefore name an unavailable Node. See [Node management](../modules/nodes.md).

| Environment or surface | Observable difference or current limit |
| --- | --- |
| Native Main and authenticated CLI Node | Share canonical file behavior, but paths, home, installed programs, OS permissions, and optional capabilities remain target-local. Native exec launches Bash on POSIX and PowerShell on Windows; command syntax is not translated. Windows native Agent environment variables are case-insensitive; POSIX variables are not. |
| Primitive executable Provider | Core derives file tools from read/read-write primitives and exec from optional process backends with same-Node logs. No resident custom tool or Code/PTY support is implied. Provider-qualified Node IDs remain intact across routing. |
| Shell HTTP Node | Exec-only, with bounded output samples and no persistent full-log/restart-reconciliation guarantee. |
| Code integration | Uses absolute POSIX URI paths; native Windows workspace mapping is not implemented. |

Execution interruption, background retention, and transport-specific completion limits belong to [execution and waiting](./execution-and-waiting.md), not to Node selection. Browser surface/resource lifetime belongs to [Workbench and Chat](workbench-and-chat.md), with service mechanics in [Code integration](../threads/code-integration.md).
