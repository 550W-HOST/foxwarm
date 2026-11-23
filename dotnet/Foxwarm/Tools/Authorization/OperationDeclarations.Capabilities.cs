namespace Foxwarm.Tools;

// The capability table of the operation catalog (docs/code-index/units/tool-operation-catalog.md).
// Value expressions are evaluated by OperationPlan.Value; conditions by OperationPlan.Holds.
internal static partial class OperationDeclarations
{
    private static readonly string[] Path = ["node=each.node", "path=each.path"];

    private static OperationTemplate SecretUse(string when = "secrets") =>
        OpEachIf(when, "secrets", "secret.use", "secret=each");

    private static OperationDeclaration Simple(string id, OperationTemplate operation) =>
        Declare(id, [Call(operation)], [Primary()]);

    internal static readonly IReadOnlyList<OperationDeclaration> Capabilities =
    [
        // Node environment capabilities.
        Declare(
            "node:read",
            [Call(OpEach("path:filePath", "env.read", Path))],
            [Primary()]
        ),
        Declare(
            "node:write",
            [Call(OpEach("path:filePath", "env.write", Path))],
            [Primary()]
        ),
        Declare(
            "node:edit",
            [
                // One write per patch Add, Update or Delete header.
                new("patch", null, [OpEach("path:apply_patch", "env.write", Path)], "arg:apply_patch"),
                Call(OpEach("path:filePath", "env.write", Path)),
            ],
            [
                Primary(),
                Sub(
                    "legacy-source-read",
                    "node:read",
                    "full read of the file for a batch or replace-all edit on a Node without patch support",
                    "legacy-node"
                ),
            ]
        ),
        Declare(
            "node:exec",
            [Call(Op("env.exec", "node=exec-node", "path=path?:cwd"), SecretUse())],
            [Primary()]
        ),
        Declare("node:browser_", [Call(Op("env.browser", "node=exec-node"))], [Primary()]) with
        {
            Prefix = true,
        },
        Declare(
            "node:*",
            [Call(Op("env.tool", "node=exec-node", "nodeTool=tool"))],
            [Primary()]
        ) with
        {
            Opaque = true,
        },
        Declare("mcp:*", [Call(Op("mcp.call", "mcp=server-tool"))], [Primary()]) with
        {
            Opaque = true,
        },
        // ToolScript and the ctl front end.
        Declare(
            "builtin:run_script",
            [
                new("file", null, [OpEach("path:filePath", "env.read", Path)], "file-source"),
                SelfBranch("inline", null, "inline code runs in the caller's own script VM"),
            ],
            [
                Primary(),
                Sub(
                    "source-read",
                    "node:read",
                    "read of the script source file on its Node",
                    "file-source"
                ) with { PathArg = "filePath" },
                Nested("each call_tool or ctl() call under its own gate"),
                ModelRequest(),
            ]
        ),
        Declare(
            "builtin:start_toolscript_run",
            [
                new("file", null, [OpEach("path:filePath", "env.read", Path)], "file-source"),
                SelfBranch("inline", null, "inline code runs in the caller's own script VM"),
            ],
            [
                Primary(),
                Sub(
                    "source-read",
                    "node:read",
                    "read of the script source file on its Node",
                    "file-source"
                ) with { PathArg = "filePath" },
                Nested("each call_tool or ctl() call under its own gate"),
                ModelRequest(),
            ]
        ),
        Declare(
            "builtin:continue_script",
            [SelfBranch("call", null, "continues a run owned by the caller")],
            [Primary(), Nested("each call_tool or ctl() call under its own gate"), ModelRequest()]
        ),
        Declare(
            "builtin:list_toolscript_runs",
            [SelfBranch("call", null, "lists runs owned by the caller")],
            [Primary()]
        ),
        Declare(
            "builtin:get_toolscript_run",
            [SelfBranch("call", null, "reads a run owned by the caller")],
            [Primary()]
        ),
        Declare(
            "builtin:cancel_toolscript_run",
            [SelfBranch("call", null, "cancels a run owned by the caller")],
            [Primary()]
        ),
        Declare(
            "builtin:exec_list",
            [SelfBranch("call", null, "lists background commands owned by the caller")],
            [Primary()]
        ),
        Declare(
            "builtin:exec_stop",
            [SelfBranch("call", null, "stops a background command owned by the caller")],
            [Primary()]
        ),
        Declare(
            "builtin:cancel_transfer",
            [SelfBranch("call", null, "cancels a transfer owned by the caller")],
            [Primary()]
        ),
        Declare(
            "builtin:wait",
            [SelfBranch("call", null, "waits within the caller's own turn")],
            [Primary()]
        ),
        Declare(
            "builtin:image_crop",
            [SelfBranch("call", null, "crops an image of the caller's own history")],
            [Primary()]
        ),
        Declare(
            "builtin:submit_compact_plan",
            [SelfBranch("call", null, "compacts the caller's own context")],
            [
                Primary(),
                Sub(
                    "plan-read",
                    "node:read",
                    "read of the plan file named by argsFilePath on the current Node",
                    "arg:argsFilePath"
                ) with { PathArg = "argsFilePath" },
                Sub(
                    "plan-save",
                    "node:write",
                    "save of an invalid plan to a repair file on the current Node",
                    "invalid-plan"
                ),
                Sub(
                    "plan-repair",
                    "node:edit",
                    "edit of that repair file on the current Node",
                    "invalid-plan"
                ),
            ]
        ),
        Declare("builtin:ctl", [], []) with { FrontEnd = "resolves to the target capability" },
        // Communication and Sessions.
        Declare(
            "builtin:ask_user",
            [
                Call(
                    Op("user.ask", "with.secret=has-secret-questions"),
                    OpEach("secret-questions", "secret.manage", "secret=each"),
                    SecretUse()
                ),
            ],
            [Primary()],
            "answer-time storage of secret answers, after the invocation and without its scope"
        ),
        Simple("builtin:send_to_session", Op("session.send", "targetSession=target-session")),
        Declare(
            "builtin:create_child_session",
            [
                Call(
                    Op(
                        "session.create",
                        "targetAgent=agent-or-caller",
                        "node=child-node",
                        "parent=caller",
                        "targetSession=prospective-child",
                        "with.kind==child",
                        "with.placement=placement",
                        "with.runtime=creation-runtime",
                        "with.fork=arg?:fork??false"
                    ),
                    OpIf(
                        "arg:taskId",
                        "task.assign",
                        "task=arg:taskId",
                        "targetSession=prospective-child"
                    )
                ),
            ],
            [Primary()],
            "initial message",
            "fork",
            "final child ID bound after allocation"
        ),
        Declare(
            "builtin:create_session",
            [
                Call(
                    Op(
                        "session.create",
                        "targetAgent=arg:agentName",
                        "node=session-node",
                        "parent=arg?:parentSessionId",
                        "targetSession=prospective-session",
                        "with.kind==session",
                        "with.placement=placement",
                        "with.runtime=creation-runtime"
                    )
                ),
            ],
            [
                Primary(),
                Sub(
                    "prompt-file-read",
                    "node:read",
                    "read of each selected prompt file on master",
                    "arg:systemPromptFiles"
                ),
            ]
        ),
        Declare(
            "builtin:task",
            [
                Branch(
                    "create",
                    "create",
                    Op("task.create", "with.assigned=has:ownerSessionId"),
                    OpIf("arg:ownerSessionId", "task.assign", "targetSession=arg:ownerSessionId")
                ),
                Branch("list", "list", Op("task.list", "with.scope=arg?:scope??current-session")),
                Branch("get", "get", Op("task.read", "task=arg:taskId")),
                Branch(
                    "claim",
                    "claim",
                    Op("task.assign", "task=arg:taskId", "targetSession=caller")
                ),
                Branch(
                    "assign",
                    "assign",
                    Op("task.assign", "task=arg:taskId", "targetSession=arg?:ownerSessionId")
                ),
                Branch("update", "update", Op("task.update", "task=arg:taskId")),
                Branch("complete", "complete", Op("task.complete", "task=arg:taskId")),
                Branch("cancel", "cancel", Op("task.cancel", "task=arg:taskId")),
            ],
            [Primary()],
            "Task notifications"
        ),
        Declare(
            "builtin:session",
            [
                Branch("status", "status", Op("session.view", "targetSession=target-session")),
                Branch("list", "list", Op("session.list", "with.scope=session-scope")),
                Branch(
                    "rename",
                    "update-display-name",
                    Op("session.control", "targetSession=target-session", "with.change==rename")
                ),
                Branch(
                    "set-parent",
                    "update-parent",
                    Op(
                        "session.manage",
                        "targetSession=target-session",
                        "parent=arg?:parentSessionId",
                        "with.change==reparent"
                    )
                ),
            ],
            [Primary()]
        ) with
        {
            Normalize = ActionNormalization.SessionTrimLower,
            DefaultAction = "status",
        },
        Simple("builtin:view_session", Op("session.view", "targetSession=target-session")),
        Control("stop_session", "stop"),
        Control("compact_session", "compact"),
        Control("refresh_session_snapshot", "snapshot"),
        Control("set_session_model", "settings"),
        Control("set_session_child_model", "settings"),
        Control("set_session_compact_threshold", "settings"),
        Declare(
            "builtin:move_session",
            [
                Call(
                    Op(
                        "session.manage",
                        "targetSession=target-session",
                        "targetAgent=move-agent",
                        "with.change==move"
                    ),
                    OpIf("arg:createAgent", "agent.create", "targetAgent=arg:newAgentName"),
                    // A new Agent may start with a copy of the moved Session's Agent memory.
                    OpIf("move-memory", "env.read", "node==master", "path=move-memory-source") with
                    {
                        Tree = true,
                    },
                    OpIf("move-memory", "env.write", "node==master", "path=move-memory-target") with
                    {
                        Tree = true,
                    }
                ),
            ],
            [Primary()]
        ),
        Simple(
            "builtin:delete_session",
            Op("session.manage", "targetSession=target-session", "with.change==delete")
        ),
        Declare(
            "builtin:recall",
            [
                new(
                    "agent-search",
                    null,
                    [Op("history.search", "targetAgent=caller-agent")],
                    "agent-scope"
                ),
                Call(
                    Op("history.read", "targetSession=target-session", "with.mode=recall-mode")
                ),
            ],
            [Primary()]
        ),
        Simple(
            "builtin:get_archived_messages",
            Op("history.read", "targetSession=target-session", "with.mode==exact")
        ),
        Simple(
            "builtin:get_archived_blocks",
            Op("history.read", "targetSession=target-session", "with.mode==exact")
        ),
        // Agents.
        Simple("builtin:list_agents", Op("agent.list")),
        Declare(
            "builtin:skill",
            [
                Branch("list", "list", Op("agent.view", "targetAgent=skill-agent")),
                Branch("load", "load", Op("agent.view", "targetAgent=skill-agent")),
            ],
            [Primary()]
        ) with
        {
            Normalize = ActionNormalization.TrimLower,
        },
        Declare(
            "builtin:create_agent",
            [
                Call(
                    Op("agent.create", "targetAgent=arg:agentName"),
                    OpIf("inherited:inherit", "agent.view", "targetAgent=inherited:inherit"),
                    OpIf(
                        "agent-main-created",
                        "session.create",
                        "targetAgent=arg:agentName",
                        "node=agent-main-node",
                        "targetSession=agent-main-session",
                        "with.kind==session",
                        "with.placement==inherited",
                        "with.runtime==foxwarm"
                    ),
                    OpIf(
                        "source-exists",
                        "session.view",
                        "targetSession=arg:sourceSessionId"
                    ),
                    OpIf(
                        "source-missing",
                        "session.create",
                        "targetAgent=source-agent",
                        "node=source-node",
                        "targetSession=source-session",
                        "with.kind==source",
                        "with.placement==inherited",
                        "with.runtime==foxwarm"
                    ),
                    OpIf("arg:inheritMemory", "env.read", "node==master", "path=memory-source") with
                    {
                        Tree = true,
                    },
                    OpIf("arg:inheritMemory", "env.write", "node==master", "path=memory-target") with
                    {
                        Tree = true,
                    },
                    OpIf(
                        "arg:convertSession",
                        "session.manage",
                        "targetSession=creation-source",
                        "targetAgent=arg:agentName",
                        "with.change==move"
                    )
                ),
            ],
            [Primary()]
        ),
        Simple(
            "builtin:set_agent_rules",
            Op("agent.manage", "targetAgent=arg:agentName", "with.change==rules")
        ),
        Declare(
            "builtin:set_agent_inherit",
            [
                Call(
                    Op("agent.manage", "targetAgent=arg:agentName", "with.change==inherit"),
                    OpIf(
                        "inherited:inheritAgentName",
                        "agent.view",
                        "targetAgent=inherited:inheritAgentName"
                    )
                ),
            ],
            [Primary()],
            "snapshot refresh of the target Agent and inheriting Agents"
        ),
        // Nodes and files.
        Declare(
            "builtin:node",
            [
                Branch("list", "list", Op("node.list")),
                Branch("inspect", "inspect", Op("node.view", "node=node-target")),
                Branch("select", "select", Op("node.select", "node=node-target")),
                // `node status` views the caller's current Node: the Session's, or an inbound
                // connection's selected Node.
                Branch("status", "status", Op("node.view", "node=status-node")),
                Branch(
                    "create",
                    "create",
                    Op("node.lifecycle", "node=provider-node", "with.action==create")
                ),
                Branch(
                    "ensure",
                    "ensure",
                    Op("node.lifecycle", "node=provider-node", "with.action==ensure")
                ),
                Branch(
                    "destroy",
                    "destroy",
                    Op("node.lifecycle", "node=node-target", "with.action==destroy")
                ),
            ],
            [
                Primary(),
                Sub(
                    "default-cwd",
                    "node:get_default_cwd",
                    "default working directory probe of the selected Node",
                    "default-cwd-probe",
                    optional: true
                ),
                Retained(
                    "lifecycle-final",
                    "same",
                    "check of the final Node identity at the lifecycle effect",
                    "action:create|ensure|destroy"
                ),
            ]
        ) with
        {
            Normalize = ActionNormalization.TrimLower,
        },
        Declare(
            "builtin:copy_between_nodes",
            [
                Call(
                    OpEach("path:sourcePath", "env.read", Path) with { Tree = true },
                    OpEach("path:targetPath", "env.write", Path) with { Tree = true }
                ),
            ],
            [Primary(), Retained("transfer", "same", "recheck by the detached transfer")]
        ),
        Declare(
            "builtin:node_create_auth_token",
            [
                Call(
                    Op("node.trust", "node=node-target?", "with.action==credential"),
                    OpEach("path:filePath", "env.write", Path)
                ),
            ],
            [Primary()]
        ),
        Declare(
            "builtin:node_bootstrap_info",
            [
                Call(
                    Op("node.trust", "with.action==credential"),
                    OpEach("path:filePath", "env.write", Path)
                ),
            ],
            [Primary()]
        ),
        Simple("builtin:node_pair_list", Op("node.trust", "with.action==pending")),
        Simple(
            "builtin:node_pair_approve",
            Op("node.trust", "node=pairing-node", "with.action==approve")
        ),
        Declare(
            "builtin:node_remove",
            [Call(OpEach("members", "node.trust", "node=each", "with.action==revoke"))],
            [
                Primary(),
                Retained(
                    "member",
                    "same",
                    "per-member removal check"
                ),
            ]
        ),
        Memory("read_memory", "env.read"),
        Memory("write_memory", "env.write"),
        Memory("edit_memory", "env.write"),
        Memory("delete_memory", "env.write"),
        Memory("apply_patch_memory", "env.write"),
        Declare(
            "builtin:send_file",
            [
                Call(
                    OpEach("path:filePath", "env.read", Path),
                    OpIf("channel", "channel.send", "channel=file-channel"),
                    OpIf("!channel", "session.deliver", "targetSession=target-session")
                ),
            ],
            [Primary()],
            "staging"
        ),
        Declare(
            "builtin:image_write_to_file",
            [Call(OpEach("path:filePath", "env.write", Path))],
            [Primary()]
        ),
        Simple("builtin:generate_image", Op("image.generate")),
        Declare(
            "builtin:artifact",
            [
                Branch("prepare", "prepare", OpEach("path:filePath", "env.read", Path)),
                Branch("publish", "publish", OpEach("path:filePath", "env.read", Path)),
                SelfBranch("get", "get", "reads an artifact the caller's Session created"),
            ],
            [
                Primary(),
                Sub(
                    "source-read",
                    "node:read",
                    "read of the artifact source file on its Node",
                    "file-action"
                ) with { PathArg = "filePath" },
            ]
        ),
        Simple("builtin:send_to_channel", Op("channel.send", "channel=channel-target")),
        // Timers.
        Timer("create_timer", "create"),
        Timer("update_timer", "update"),
        Simple(
            "builtin:delete_timer",
            Op("timer.manage", "targetSession=timer-owner", "with.change==delete")
        ),
        Simple(
            "builtin:list_timers",
            Op("timer.manage", "targetSession=timer-owner", "with.change==list")
        ),
        // Configuration, secrets and MCP.
        Declare(
            "builtin:set_config",
            [Call(Op("config.write", "with.target=arg:target"), SecretUse())],
            [
                Primary(),
                Sub("candidate-read", "node:read", "read of the candidate file on master") with
                {
                    PathArg = "filePath",
                },
                Retained(
                    "install",
                    "same",
                    "recheck of the installed bytes and their secrets in the configuration lane"
                ),
            ]
        ),
        Declare(
            "builtin:explain_tool_authorization",
            [
                Call(
                    Op("config.read", "with.target==tool-rules"),
                    OpEach("probe-sessions", "session.view", "targetSession=each")
                ),
            ],
            [
                Primary(),
                Sub("policy-read", "node:read", "read of the active policy file on master"),
                Sub(
                    "candidate-read",
                    "node:read",
                    "read of the candidate policy file on master",
                    "arg:policyFilePath"
                ) with { PathArg = "policyFilePath" },
                Sub(
                    "probe-view",
                    "builtin:view_session",
                    "view of each probed Session other than the caller's own"
                ),
            ]
        ),
        Declare(
            "builtin:add_secret",
            [
                Call(
                    Op("secret.manage", "secret=secret-name"),
                    SecretUse(),
                    OpEachIf("arg:fromConfig", "from-config-files", "config.write", "with.target=each"),
                    OpEachIf("arg:fromConfig", "from-config-servers", "mcp.manage", "mcp=each")
                ),
            ],
            [
                Primary(),
                Sub(
                    "file-read",
                    "node:read",
                    "read of filePath on the current Node",
                    "arg:filePath"
                ) with { PathArg = "filePath" },
                Sub(
                    "config-read",
                    "node:read",
                    "read of each configuration file holding the fromConfig value, on master",
                    "arg:fromConfig"
                ),
                Sub(
                    "delete-file",
                    "node:edit",
                    "delete patch of filePath on the current Node",
                    "arg:deleteFile"
                ),
                Retained(
                    "store",
                    "same",
                    "recheck before the secret is stored"
                ),
            ]
        ),
        Declare(
            "builtin:list_secrets",
            [Call(Op("secret.list"))],
            [Primary()]
        ),
        Simple("builtin:list_mcp_servers", Op("mcp.list")),
        Declare(
            "builtin:mcp_config",
            [Call(Op("mcp.manage", "mcp=mcp-config-name"), SecretUse())],
            [
                Primary(),
                Retained(
                    "install",
                    "same",
                    "recheck of the MCP configuration and its secrets in its lane"
                ),
            ]
        ),
        Declare(
            "builtin:mcp_notifications",
            [
                Branch(
                    "start",
                    "start",
                    Op("mcp.subscribe", "mcp=arg:server", "with.action==start")
                ),
                Branch("stop", "stop", Op("mcp.subscribe", "mcp=arg:server", "with.action==stop")),
                Branch(
                    "status",
                    "status",
                    Op("mcp.subscribe", "mcp=arg:server", "with.action==status")
                ),
            ],
            [
                Primary(),
                Retained(
                    "reception",
                    "builtin:mcp_notifications",
                    "reception recheck (as action start) for each received notification",
                    "action:start"
                ),
            ]
        ),
    ];

    // Obligations every capability can incur: they depend on the result, not on the call.
    internal static readonly IReadOnlyList<ObligationTemplate> Common =
    [
        Sub(
            "output-spill",
            "node:read",
            "read and write checks of the file that receives an oversized result"
        ),
    ];

    // A ToolScript model request: model.request of the resolved model, assessed as the slice's
    // own invocation in its own approval scope.
    private static ObligationTemplate ModelRequest() =>
        Retained(
            "model-request",
            "same",
            "model.request of each request_model_without_context call, assessed as this invocation",
            "model-request"
        );

    private static OperationDeclaration Control(string name, string change) =>
        Simple(
            "builtin:" + name,
            Op("session.control", "targetSession=target-session", "with.change==" + change)
        );

    private static OperationDeclaration Memory(string name, string op) =>
        Declare(
            "builtin:" + name,
            [Call(OpEach("path:*", op, Path))],
            [Primary()]
        );

    // A new-Session timer's creation target: create_timer knows it from its arguments; update
    // checks the persisted candidate row it builds, so the probe is listed for every update.
    private static OperationDeclaration Timer(string name, string change) =>
        Declare(
            "builtin:" + name,
            [
                Call(
                    Op(
                        "timer.manage",
                        "targetSession=timer-owner",
                        "with.change==" + change,
                        "with.kind=timer-kind"
                    )
                ),
            ],
            [
                Primary(),
                Probe(
                    "creation-target",
                    "builtin:create_session",
                    "create_session creation target of a new-Session timer",
                    change == "create" ? "arg:newSession" : null
                ),
            ]
        );
}
