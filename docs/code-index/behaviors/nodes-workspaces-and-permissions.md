# Behavior: Nodes, workspaces, and permissions

For developers and Agents changing execution placement, filesystem access, or Node lifecycle. A Node names an execution environment; a Session selects one, and a Provider exposes or manages it. None of these facts alone grants permission, creates an exclusive workspace, or establishes an operating-system sandbox.

## Selection routes operations, not the whole Session

**Governing placement constraint; directly selected.** A Node is an execution environment for supported capabilities, not a replacement Session owner or a permission identity. Provider composition and authenticated transports implement that distinction while Session history/control stay with their exact owner.

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

**Governing interpretation constraint with real caller compatibility.** Resolve paths in the environment and base directory promised by the particular operation. The shared path/file primitives implement those meanings; a selected Node or convenient host filesystem API must not reinterpret another endpoint's path.

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

**Governing constraints with distinct bases.** Direct product decisions keep administrator operation targets separate from scoped identities and internal tool policy; authenticated transports and retained access data independently constrain who can act. Node selection, Agent inheritance and process placement are not grants of authority. Designs below must evaluate their actual caller and effect rather than invent a universal principal rule.

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

The [programmatic consumer](automation-and-scheduled-work.md#what-does-the-program-consume-and-what-does-the-model-receive) can receive structured discovery descriptors in addition to readable output; this does not widen invocation authority. Conversely, omission from the default model schema does not mean removal: supported hidden tools may be found through discovery and invoked when authorized. A Node listed as connected may be protocol-incompatible or lack a requested capability. These are different failures, not reasons to fall back to Main. See [unified discovery](../modules/tools-and-permissions.md#d-tools-unified-discovery) and [resolved authorization](../threads/tool-dispatch-authorization.md).

## Node authorization forests

**User goal:** granting a Node can cover its authorization subtree. **Approved derived design:** Main owns explicit parent relationships, independently of physical hosting. **Review-selected behavior (2026-10-30, subject to user revision):** the global and Agent-local selectors, concrete delegation checks, root-admission compatibility, deletion rules and configurable defaults below implement that goal.

Native approved records store `parentNode` in `state/nodes.json`. Executable Nodes use the administrator's startup-only `nodeProviders.<id>.parentNode`; lifecycle options, provider descriptors and authenticated client registration cannot choose or replace it. Roots have no parent, and `master` has no implicit children. Existing native relationships can be changed through the administrator Node parent endpoint; executable relationships change with provider configuration at startup. Model tools cannot reparent existing identities. An edge describes delegated tool scope, not a claim that one machine hosts, controls or isolates another. Initial provider discovery collects the advertised identities before validating and admitting their parent topology, so configuration key order does not require a preparatory administrator list. Genuinely missing parents and cycles are refused.

Bare Node IDs and literal `*` patterns match the target or any matching ancestor, in both global and Agent layers. `{exact: ID}` (or an exact-ID list) matches only the endpoint itself. `{current:true}` remains the exact initiating Session's selected Node, and `{provider: ID}` remains the endpoint's exact provider namespace. Ordered first-match and the original initiator's facts are unchanged. An allow for a multi-endpoint operation must cover every endpoint in that one rule; deny needs any endpoint. Separate allows are not combined. Known offline ancestors remain valid; missing ancestors, cycles and malformed parent metadata fail closed. Discovery keeps its conservative argument-dependent projection; visibility does not grant execution. Read-only provider inspection can finish while another lifecycle operation holds metadata admission, but unadmitted identities expose no executable tools and cannot supply file or exec effects. Already-admitted endpoints remain usable under their current policy.

Creating credentials with `node_create_auth_token(parentNode:P)` authorizes that concrete operation against P before a file or identity is created, retaining independent Main credential-path authorization. Executable create and fresh explicit-ID ensure authorize the concrete lifecycle action against the configured parent before provider effects. Ordinary read/exec permission does not grant delegation. A createdBy-bearing internal caller needs a parent for a new identity and must supply an explicit ensure ID; existing-identity ensure is authorized against that identity and preserves its parent. Explicit-ID ensure resolves existing-versus-fresh inventory facts before its first decisive policy check; callers do not need a prior list operation. Top-level Agents retain root creation by omission. They also retain omitted-ID ensure: opaque provider parameters cannot establish its Node-subtree target before effects, so only the existing non-subtree policy checks can be applied in advance. Core inventories returned identities and does not treat an existing result as a fresh child. Ordinary inbound MCP retains its separate external-only entry restrictions; it does not acquire executable lifecycle access or internal Agent authority. Its root pairing path remains supported; delegated internal callers instead use private credentials with a parent.

Descendants block ordinary native revocation and executable destroy. Native `node_remove(cascade:true)` freezes the complete subtree in the registry mutation lane and authorizes a concrete removal for every member under the unchanged caller. One denial means no revocations or disconnects. A subtree containing executable-provider Nodes is rejected: credential revocation and provider environment destruction have different effects. Precommit failures preserve connections; committed revocation failures still disconnect and report the durability failure. External effects are not rolled back or automatically replayed.

A parent name remains reserved while referenced, without permanent used-parent tombstones. Unclaimed pairings cannot be parents; expiry/rejection therefore cannot orphan descendants. Native rename requires detached, descendant-free identities. Provider disappearance or configuration removal preserves referenced identities and their ancestry as offline metadata; unreferenced absent provider records are pruned. `nodeTree.maxDepth` defaults to 16 (root depth zero), and `nodeTree.maxChildren` defaults to 256 (direct children). Both are nonnegative configuration integers and admission limits; lowering them does not invalidate unchanged existing edges. Incoming Node history, message and event access stays exact selected/bound Node plus the existing per-exec completion capability. Legacy isolation remains independent.

### Upgrade implications

Without parent edges, existing Node selector matches are unchanged. Adding the first edge can make an earlier parent allow shadow a later child deny; a parent deny can likewise cover new descendants. Review rule order and use `{exact: ...}` for intended self-only grants. No policy intention is inferred or automatically rewritten. Older Main binaries that ignore parent metadata are unsafe readers of an installation using these relationships; deployment/downgrade needs an explicit compatible-version/state decision, not a shared new/old-state promise.

Mechanism and entry points: [native trust and registry](../units/external-nodes.md), [executable providers](../units/dotnet-node-providers.md), and [policy facts](../units/tool-authorization.md#policy-selectors-and-authoritative-facts).

## Lifecycle and platform differences are explicit

Inspect a Provider's advertised operations, parameter schemas, and retention description before create/ensure/destroy. Core routes lifecycle to the exact Provider; it does not prescribe that destroy deletes data, releases every external resource, or stops processes in every backend. Effectively isolated callers cannot create/ensure/destroy through this management surface even with an exact tool allow. Selection and inspect are not lifecycle creation.

Revoking an authenticated Node with `node_remove` is different again: it removes approval and disconnects the active runtime, but does not stop the client, destroy its environment, delete files, or rebind Sessions/Agents. Persisted selection can therefore name an unavailable Node. See [Node management](../modules/nodes.md).

| Environment or surface | Observable difference or current limit |
| --- | --- |
| Native Main and authenticated CLI Node | Share canonical file behavior, but paths, home, installed programs, OS permissions, and optional capabilities remain target-local. Native exec launches Bash on POSIX and PowerShell on Windows; command syntax is not translated. Windows native Agent environment variables are case-insensitive; POSIX variables are not. |
| Primitive executable Provider | Core derives file tools from read/read-write primitives and exec from optional process backends with same-Node logs. No resident custom tool or Code/PTY support is implied. Provider-qualified Node IDs remain intact across routing. |
| Shell HTTP Node | Exec-only, with bounded output samples and no persistent full-log/restart-reconciliation guarantee. |
| Code integration | Uses slash-based URI paths. Managed Windows Main maps absolute native drives to `/C:/...` (and the drive root `/C:`) at the Code boundary; native Session/tool paths stay native. UNC/device mapping is unsupported. See [Code URI mapping](../threads/code-integration.md#d-code-real-path-uri). |

Execution interruption, background retention, and transport-specific completion limits belong to [execution and waiting](./execution-and-waiting.md), not to Node selection. Browser surface/resource lifetime belongs to [Workbench and Chat](workbench-and-chat.md), with service mechanics in [Code integration](../threads/code-integration.md).
