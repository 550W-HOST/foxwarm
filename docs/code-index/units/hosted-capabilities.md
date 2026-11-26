# Unit: Runtime capability profile (hosted runtime without master)

Files: `dotnet/Foxwarm/RuntimeCapabilities.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedCapabilityProfileTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedStartupTests.Capabilities.cs`, `dotnet/Foxwarm.Tests/Sessions/FrameworkPromptProfileTests.cs`
Secondary files: `dotnet/Foxwarm/Hosted/HostedEntry.cs`, `dotnet/Foxwarm/MainHost.cs`, `dotnet/Foxwarm/MainLog.cs`, `dotnet/Foxwarm/HttpServer.cs`, `dotnet/Foxwarm/Sessions/SessionManager.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Nodes.cs`, `dotnet/Foxwarm/Sessions/SessionManager.NodeFiles.cs`, `dotnet/Foxwarm/Sessions/SessionManager.NodeLifecycle.cs`, `dotnet/Foxwarm/Sessions/SessionManager.AgentOps.cs`, `dotnet/Foxwarm/Sessions/SessionManager.ChannelFiles.cs`, `dotnet/Foxwarm/Sessions/SessionManager.ChannelFilePaths.cs`, `dotnet/Foxwarm/Sessions/SessionObservation.cs`, `dotnet/Foxwarm/Sessions/AgentMemory.cs`, `dotnet/Foxwarm/Memory/ConditionalMemory.cs`, `dotnet/Foxwarm/Tools/ToolRegistry.cs`, `dotnet/Foxwarm/Tools/LocalExecManager.cs`, `dotnet/Foxwarm/Skills.cs`, `dotnet/Foxwarm/McpConfiguration.cs`, `dotnet/Foxwarm/Nodes/NodeConnectionHub.cs`, `dotnet/Foxwarm/Nodes/NodeProviderRegistry.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiUploadedFiles.cs`, `dotnet/Foxwarm/MessageRouter.Weixin.cs`, `templates/agents/00_SYSTEM.md`

## Purpose

A hosted replica has no `master` Node: nothing on the replica's container is an execution environment for tools. This unit owns the capability profile that says which Main-local features a runtime has, and how each feature behaves when it's absent. File mode has every feature and its behavior doesn't change.

The hosted entry and lease are in [hosted runtime](./hosted-runtime.md); the deployment/tenant configuration split, which refuses settings of absent features, is in [hosted configuration](./hosted-config.md#d-hosted-config-split).

## D-capability-profile

**Approved plan, track CP (2026-11-26).**

- **Shape.** `RuntimeCapabilities` is a record fixed when the runtime is built: `MasterNode`, `MainTerminalsAndCode`, `StdioMcp`, `ClaudeRuntime`, `ExecutableProviders`. `File` has all of them; `Hosted` has only executable Providers. `MainHost.CreateAsync` and `SessionManager` take it as a parameter, and null is `File`. `HostedEntry` passes `Hosted`.
- **One refusal text.** A master-targeted call fails with `Node is not available: master` (`RuntimeCapabilities.MasterUnavailable`), the same text as for any unknown Node. It fails at resolution, before authorization effects, approvals or file access.
- **Request-prefix stability.** Default tool declarations (`ModelDefinitions`, the runtime declarations and the registry's) are byte-identical across profiles for the same configuration. Only the Main browser tools differ, and they are never default-injected.

## D-capability-without-master

What each surface does when `MasterNode` is false.

- **Node list and status.** `master` isn't listed as a Node or a Provider. An unset Session's current Node, which file mode reads as `master`, is reported as none (`currentNode: null`, `connected: false`) by `node list`, `node status` and the Session status.
- **Resolution** (`ToolRegistry.ResolveAsync`) refuses every master target: `node:master/*` tools; builtin Node effects naming master (exec, file tools, copies with a master end, file delivery, skill copy); `run_script` with a master script source; `set_config`, `node_bootstrap_info` and `node_create_auth_token` with a `filePath`; `explain_tool_authorization` with a `policyFilePath`. `node select master` and `NodeDefinitions("master")` refuse the same way. The SessionManager master file branches call `RequireMasterNode` as the last guard.
- **Secret moves.** `add_secret` with `fromConfig` is refused: no tool reads the tenant's configuration documents, so nothing could authorize a move. Approval plans have no configuration read checks. The fallback "follows the caller's unrestricted master exec" stays a pure policy computation: a default allow still allows, and a master deny still denies.
- **Session placement** (`SessionManager.StartingNode`). An explicit or inherited Node is kept. The Agent's or installation's default is kept only when it is a Node of the forest or `<provider>/<name>` of a configured Provider; anything else, `master` included, leaves the Session without a Node. File mode keeps today's order ending at `master`. A kept Provider default the Provider doesn't list fails at first use as in file mode. A Session without a Node follows the prompt's instruction: `ctl node list` shows the forest's and Providers' Nodes, `ctl node select` takes a listed one, and a Provider Node not yet listed is first created through the Provider's lifecycle (`node create`/`ensure`).
- **Main-local tools.** The Main browser tools aren't registered; `LocalExecManager` refuses launches without a Node backend; the terminal registry and Code workbench aren't built, so `GET /api/terminals` returns an empty unsupported list and the Code routes don't exist. Code downloads naming master fail as unsupported.
- **Tool output spill.** A large result is shortened in place instead of being spooled to the Agent folder.
- **Memory and skills.** `ctl memory` (read, write, edit, delete, patch, including `--agent`) works on the Agent folders under `FOXWARM_AGENTS_DIR` without a Node; it never involved one. `ctl skill list`, `load`, resources and `run` work; `skill load` shows no master path. `foxwarm-maintenance` is hidden from the catalog, `load` and `run`: its whole content is file-mode operations.
- **Framework prompt.** The `master-node` condition ([conditional memory](./conditional-memory.md)) selects the hosted copy in `templates/agents/00_SYSTEM.md`; the file-mode render is unchanged. `<memory_file>` blocks carry no `path=`, and the `--- DIRECTORIES ---` / `agent_folder` block is omitted.
- **Received files.** Nothing is written to the Agent folder's `.temp/channel-files`. A received image reaches the model inline only. Any other file is replaced by a text notice naming it, its type and size as not kept, so the loss is visible to the model and through it to the sender. A WebUI upload of a non-image is refused with an error naming the file.
- **MCP.** Stdio servers are refused on update and on load, with a validation error naming the server (`McpConfiguration.StdioAvailable`). HTTP and SSE servers are unchanged.
- **Claude Code runtime.** Creating a Session with it, and an external turn on it, are refused.
- **Vector** is off whenever the Archive isn't the SQLite store; the Activity index already keeps only direct records off SQLite.
- **Weixin.** Status and login output omit the configuration file path line.
- **Logs.** `MainLog` also writes every recorded line to stdout as one JSON line (`level`, `time`, `pid`, `hostname`, `msg`) instead of forwarding raw console output. The file log under the scratch directory stays, and is what the WebUI Logs view reads.

## D-capability-scratch-guard

**Approved plan §12 (scratch guard).** A replica's `FOXWARM_SCRATCH_DIR` may hold only `state/logs`, `state/provider-image-cache`, `foxwarm-uploads` and `.temp`. `HostedStartupTests.ScratchOutsideAllowlist` names everything else; the hosted turn scenario fails if anything is left there after a turn, a memory write and a Node-less exec.

## P1 limitations

- No Agent docs: `docs/` and other Agent-folder files beyond memory and skills can't be read or written by any tool.
- Received non-image files aren't kept; non-image WebUI uploads are refused.
- No configuration secret moves, no `set_config` or policy explanation from a candidate file, and no Node token or bootstrap files; administrators pair Nodes through the WebUI.
- No stdio MCP, Claude Code runtime, Main terminals, Code workbench, Main browser or Vector.

## Open Questions

- **Bundled skills in hosted mode (P2).** P1 changes only `foxwarm-maintenance`. The others still describe file-mode facts by skill: `about-foxwarm` (`state/*.yaml`, Nodes paired with master); `access-control` (the policy file and its master candidate workflow, the master-exec secret fallback); `agent-management` (channel files on master, the `master` placement fallback, the channel-assistant template's master read rule); `mcp-management` (the stdio example); `node-setup` (token files on master, master-side commands, the development workflow's master ends); `timer-automation` (a master script example); `webui-markers` (the master commit example); `asr-service` (`state/config.yaml` instead of the deployment key). Whether to condition, split or hide each is undecided.

## Tests

- **`HostedCapabilityProfileTests`** runs the hosted profile over file stores: master absent from `node list`, `ctl node list` and status; every master-targeted call refused with no file, Node registry or marker effect; no Main browser tools and no spool; stdio MCP refused on update and load while HTTP is kept; placement with no default, `master`, an unknown Node, an unknown Provider, a Provider Node and a resident Node; byte-identical default declarations against the file profile; skills, memory (own and another Agent) and the prompt; received files; the Claude runtime refusal. A file-profile case checks that master paths, `foxwarm-maintenance` and the file prompt remain.
- **`HostedStartupTests.AHostedTurnUsesMemoryWithoutMasterAndLeavesNothingDurableInScratch`** runs one model turn in the hosted runtime (`HostedEntry.BuildRuntimeAsync`): `ctl node list` without master, `write_memory` into `FOXWARM_AGENTS_DIR`, a refused exec; no terminals or Code routes; no Main-local path in the model request; then the scratch guard.
- **`FrameworkPromptProfileTests`** checks both renders of the bundled template.
