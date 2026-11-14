using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

/// <summary>
/// One reported difference between a legacy isolated Agent and its generated local layer.
/// </summary>
internal sealed record IsolationMigrationNote(string Kind, string Subject, string Detail)
{
    internal JsonObject ToJson() =>
        new()
        {
            ["kind"] = Kind,
            ["subject"] = Subject,
            ["detail"] = Detail,
        };
}

internal sealed record IsolationMigrationPlan(
    JsonArray Rules,
    IReadOnlyList<IsolationMigrationNote> Notes,
    IReadOnlyList<string> Blockers
)
{
    internal string Digest => IsolationMigrationRules.Digest(Rules);
}

/// <summary>
/// Generates the Agent-local rule layer that replaces legacy Agent isolation for one Agent.
/// The layer is conservative: it allows the legacy default capabilities (bounded to the
/// bound Node, the Agent directory and direct Session relations), translates exact
/// <c>toolRules</c>, and ends with a deny for everything else. The global policy still
/// applies before it.
/// </summary>
internal static class IsolationMigrationRules
{
    /// <summary>
    /// Version of the generated layer, recorded in the migration marker. Version 2 limits
    /// <c>session</c> status to the current Session; version 1 (R1) relied on the legacy check.
    /// </summary>
    internal const int GeneratorVersion = 2;

    /// <summary>Rule ID prefix of the generated <c>session</c> status allows.</summary>
    internal const string SessionStatusRule = "isolation-session-status";

    /// <summary>
    /// SHA-256 of a layer's JSON, used to tell a stored layer from the one migration wrote.
    /// </summary>
    internal static string Digest(JsonArray rules) =>
        Convert
            .ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(rules.ToJsonString())))
            .ToLowerInvariant();

    /// <summary>
    /// SHA-256 of an Agent row's legacy isolation fence: <c>isolated</c>, <c>isolatedNode</c>
    /// and <c>toolRules</c> as stored. Older releases still write them.
    /// </summary>
    internal static string FenceDigest(JsonObject row) =>
        Digest(
            new JsonArray(
                row["isolated"]?.DeepClone(),
                row["isolatedNode"]?.DeepClone(),
                row["toolRules"]?.DeepClone()
            )
        );

    /// <summary>
    /// Whether a local layer, as the policy parses it, ends in an enabled deny without
    /// selectors, so it allows only what it lists. Throws <see cref="InvalidDataException"/>
    /// when the layer does not parse.
    /// </summary>
    internal static bool EndsInDeny(JsonArray? rules)
    {
        if (rules is null)
            return false;
        var normalized = AgentRulePolicy.Parse(rules).Value["rules"] as JsonArray;
        return normalized?.LastOrDefault() is JsonObject last
            && last["enabled"]?.GetValue<bool>() == true
            && last["action"]?.GetValue<string>() == "deny"
            && last["match"] is JsonObject { Count: 0 };
    }

    /// <summary>
    /// The layer installed when an Agent cannot be migrated safely: it denies every call of
    /// the Agent and of its creator descendants until an administrator replaces it.
    /// </summary>
    internal static JsonArray FailClosedRules() =>
        new(new JsonObject { ["id"] = "isolation-fail-closed", ["action"] = "deny" });

    /// <summary>
    /// Adds the current-Session limit to the <c>session</c> status allows of a version 1
    /// layer, leaving every other rule as it is. Returns the number of rules changed; an
    /// administrator may have removed or rewritten them, in which case nothing matches.
    /// </summary>
    internal static int LimitSessionStatusToSelf(JsonArray rules)
    {
        var changed = 0;
        foreach (var rule in rules.OfType<JsonObject>())
        {
            if (
                SessionWait.Text(rule["id"])
                    ?.StartsWith(SessionStatusRule, StringComparison.Ordinal) != true
                || SessionWait.Text(rule["action"]) != "allow"
                || rule["match"] is not JsonObject match
                || SessionWait.Text(match["tool"]?["source"]) != "builtin"
                || SessionWait.Text(match["tool"]?["name"]) != "session"
                || match["args"] is not JsonObject args
                || args.ContainsKey("sessionId")
            )
                continue;
            args["sessionId"] = new JsonObject
            {
                ["session"] = new JsonObject { ["self"] = true },
            };
            changed++;
        }
        return changed;
    }

    // Legacy structural denials an exact allow could never lift, plus `node` lifecycle and
    // selection, which isolated Sessions could not perform through model tools.
    private static readonly string[] StructuralBuiltins =
    [
        "create_agent",
        "list_agents",
        "set_agent_inherit",
        "set_agent_rules",
        "set_agent_isolated",
        "move_session",
        "create_session",
        "create_child_session",
        "delete_session",
        "view_session",
    ];

    private static readonly string[] MemoryTools =
    [
        "read_memory",
        "write_memory",
        "edit_memory",
        "delete_memory",
        "apply_patch_memory",
    ];

    private static readonly string[] LocalTools =
    [
        "image_crop",
        "wait",
        "ask_user",
        "cancel_transfer",
        "submit_compact_plan",
        "search_tools",
        "run_script",
        "start_toolscript_run",
        "continue_script",
        "list_toolscript_runs",
        "get_toolscript_run",
        "cancel_toolscript_run",
    ];

    // Builtins whose legacy default the baseline already expresses, including its
    // handler-local argument limits. An exact allow for them adds nothing.
    private static readonly HashSet<string> BaselineBuiltins = new(StringComparer.Ordinal)
    {
        "apply_patch_memory",
        "read_memory",
        "write_memory",
        "edit_memory",
        "delete_memory",
        "skill",
        "image_crop",
        "copy_between_nodes",
        "cancel_transfer",
        "get_archived_messages",
        "get_archived_blocks",
        "recall",
        "session",
        "send_to_session",
        "wait",
        "ask_user",
        "submit_compact_plan",
        "search_tools",
        "create_timer",
        "list_timers",
        "update_timer",
        "delete_timer",
        "run_script",
        "start_toolscript_run",
        "continue_script",
        "list_toolscript_runs",
        "get_toolscript_run",
        "cancel_toolscript_run",
    };

    // Delivery builtins: allowed by default only from the bound Node; an exact allow
    // extends them to master within the Agent directory.
    private static readonly HashSet<string> DeliveryBuiltins = new(StringComparer.Ordinal)
    {
        "send_file",
        "image_write_to_file",
    };

    // Builtins whose Main path facts must stay inside the Agent directory when translated.
    private static readonly HashSet<string> MainPathBuiltins = new(StringComparer.Ordinal)
    {
        "node_create_auth_token",
        "node_bootstrap_info",
        "set_config",
    };

    internal static IsolationMigrationPlan Generate(
        string agent,
        AgentIsolation isolation,
        bool retainedMainLayout
    )
    {
        var rules = new JsonArray();
        var notes = new List<IsolationMigrationNote>();
        var blockers = new List<string>();
        if (!isolation.Isolated)
            blockers.Add("Agent is not isolated.");
        if (retainedMainLayout)
            blockers.Add(
                "An isolated main Agent in the retained shared-workspace layout excludes nested Agent directories, which a local layer cannot express. Review it manually."
            );
        var node = isolation.RecordedNode;
        if (node == "master")
            blockers.Add(
                "The recorded isolation Node is master, which no supported setter records. A Node rule for it would grant every master path; correct the binding first."
            );
        var counters = new Dictionary<string, int>(StringComparer.Ordinal);

        void Add(string purpose, JsonObject? match, string action = "allow")
        {
            var id = "isolation-" + purpose;
            if (counters.TryGetValue(purpose, out var count))
            {
                counters[purpose] = count + 1;
                id += "-" + (count + 1);
            }
            else
                counters[purpose] = 1;
            var rule = new JsonObject { ["id"] = id, ["action"] = action };
            if (match is not null)
                rule["match"] = match;
            rules.Add(rule);
        }

        static JsonObject Builtin(JsonNode name) =>
            new()
            {
                ["tool"] = new JsonObject { ["source"] = "builtin", ["name"] = name },
            };

        static JsonArray Names(IEnumerable<string> names) =>
            new(names.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray());

        static JsonObject Within(string root, JsonNode? arg = null)
        {
            var path = new JsonObject { ["allWithin"] = root };
            if (arg is not null)
                path["arg"] = arg;
            return path;
        }

        static JsonObject Absent() => new() { ["exists"] = false };

        static JsonObject Session(string key, JsonNode value) =>
            new() { ["session"] = new JsonObject { [key] = value } };

        static JsonObject Self() => Session("self", true);

        // 1. Exact denies keep winning over every generated allow.
        var exactAllows = new List<JsonObject>();
        foreach (var rule in isolation.Rules.OfType<JsonObject>())
        {
            var source = SessionWait.Text(rule["source"])!;
            var tool = SessionWait.Text(rule["tool"])!;
            var subject = Subject(rule);
            if (SessionWait.Text(rule["effect"]) == "allow")
            {
                exactAllows.Add(rule);
                continue;
            }
            var match = new JsonObject
            {
                ["tool"] = new JsonObject { ["source"] = source, ["name"] = tool },
            };
            if (source == "node")
                match["targetNode"] = SessionWait.Text(rule["node"]);
            if (source == "mcp")
                match["tool"]!["server"] = SessionWait.Text(rule["server"]);
            Add("exact-deny", match, "deny");
            notes.Add(new("translated", subject, "Exact deny kept before every allow."));
        }

        // 2. Structural denials stay explicit so later reviewed allows cannot silently lift them.
        // Timer creation targets reuse create_session policy, and a new-Session timer in the
        // Agent's own Agent was allowed, so that one creation target stays open.
        var ownSessions = Builtin("create_session");
        ownSessions["args"] = new JsonObject
        {
            ["agentName"] = new JsonObject { ["agent"] = new JsonObject { ["sameAgent"] = true } },
        };
        Add("own-agent-sessions", ownSessions);
        Add("structural", Builtin(Names(StructuralBuiltins)), "deny");
        Add(
            "master-exec",
            new JsonObject
            {
                ["tool"] = new JsonObject { ["source"] = "node", ["name"] = "exec" },
                ["targetNode"] = "master",
            },
            "deny"
        );
        var lifecycle = Builtin("node");
        lifecycle["args"] = new JsonObject
        {
            ["action"] = Names(["select", "create", "ensure", "destroy"]),
        };
        Add("node-lifecycle", lifecycle, "deny");

        // 3. Baseline: the legacy defaults with their handler-local limits.
        if (node is not null)
            Add(
                "node",
                new JsonObject
                {
                    ["tool"] = new JsonObject { ["source"] = "node" },
                    ["targetNode"] = node,
                }
            );
        Add(
            "master-files",
            new JsonObject
            {
                ["tool"] = new JsonObject
                {
                    ["source"] = "node",
                    ["name"] = Names(["read", "write", "edit"]),
                },
                ["targetNode"] = "master",
                ["path"] = Within("${agent.dir}"),
            }
        );
        var memory = Builtin(Names(MemoryTools));
        memory["path"] = Within("${agent.memoryDir}");
        Add("memory", memory);

        var nodes = node is null ? new[] { "master" } : ["master", node];
        foreach (var sourceNode in nodes)
        foreach (var targetNode in nodes)
        {
            var copy = Builtin("copy_between_nodes");
            copy["args"] = new JsonObject
            {
                ["sourceNode"] = sourceNode,
                ["targetNode"] = targetNode,
            };
            var mainArgs = new List<string>();
            if (sourceNode == "master")
                mainArgs.Add("sourcePath");
            if (targetNode == "master")
                mainArgs.Add("targetPath");
            if (mainArgs.Count > 0)
                copy["path"] = Within("${agent.dir}", Names(mainArgs));
            Add("copy", copy);
        }
        void Delivery(string tool, string fileNode)
        {
            var rule = Builtin(tool);
            rule["targetNode"] = fileNode;
            if (tool == "send_file")
                rule["args"] = new JsonObject
                {
                    ["sessionId"] = Self(),
                    ["channelTargetId"] = Absent(),
                };
            if (fileNode == "master")
                rule["path"] = Within("${agent.dir}", "filePath");
            Add(tool == "send_file" ? "send-file" : "save-image", rule);
        }
        if (node is not null)
            foreach (var tool in DeliveryBuiltins.Order(StringComparer.Ordinal))
                Delivery(tool, node);

        var relation = Builtin("send_to_session");
        relation["args"] = new JsonObject
        {
            ["sessionId"] = Session("relation", Names(["parent", "child"])),
        };
        Add("send-relation", relation);
        var selfSend = Builtin("send_to_session");
        selfSend["args"] = new JsonObject { ["sessionId"] = Self() };
        Add("send-self", selfSend);
        var archives = Builtin(Names(["get_archived_messages", "get_archived_blocks"]));
        archives["args"] = new JsonObject { ["sessionId"] = Session("sameAgent", true) };
        Add("archives", archives);
        var recall = Builtin("recall");
        recall["args"] = new JsonObject
        {
            ["vector_query"] = Absent(),
            ["sessionId"] = Session("sameAgent", true),
        };
        Add("recall-exact", recall);
        foreach (var agentName in new JsonNode[] { Absent(), agent })
        {
            // An omitted Session resolves to the caller only with scope current-session.
            var vector = Builtin("recall");
            vector["args"] = new JsonObject
            {
                ["vector_query"] = new JsonObject { ["exists"] = true },
                ["sessionId"] = Self(),
                ["agentName"] = agentName.DeepClone(),
            };
            Add("recall-vector", vector);
            var skill = Builtin("skill");
            skill["args"] = new JsonObject
            {
                ["action"] = Names(["list", "load"]),
                ["agentName"] = agentName.DeepClone(),
            };
            Add("skill", skill);
        }
        // Status of the current Session only.
        foreach (var action in new JsonNode[] { Absent(), "status" })
        {
            var status = Builtin("session");
            status["args"] = new JsonObject
            {
                ["action"] = action.DeepClone(),
                ["sessionId"] = Self(),
            };
            Add("session-status", status);
        }

        var timerReads = Builtin(Names(["list_timers", "delete_timer"]));
        timerReads["args"] = new JsonObject { ["sessionId"] = Self() };
        Add("timer-read-delete", timerReads);
        foreach (var newSession in new JsonNode[] { Absent(), false })
        {
            var create = Builtin("create_timer");
            create["args"] = new JsonObject
            {
                ["sessionId"] = Self(),
                ["newSession"] = newSession.DeepClone(),
                ["agentName"] = Absent(),
                ["sessionPrefix"] = Absent(),
            };
            Add("timer-create", create);
        }
        foreach (var agentName in new JsonNode[] { Absent(), agent })
        {
            var create = Builtin("create_timer");
            create["args"] = new JsonObject
            {
                ["sessionId"] = Self(),
                ["newSession"] = true,
                ["agentName"] = agentName.DeepClone(),
            };
            Add("timer-create-new", create);
        }
        // An update may omit newSession to keep the stored mode; the creation target of a
        // new-Session timer is checked separately against create_session policy.
        foreach (var newSession in new JsonNode[] { Absent(), false })
        {
            var update = Builtin("update_timer");
            update["args"] = new JsonObject
            {
                ["sessionId"] = Self(),
                ["newSession"] = newSession.DeepClone(),
                ["agentName"] = Absent(),
            };
            Add("timer-update", update);
        }
        foreach (var newSession in new JsonNode[] { Absent(), true })
        {
            var update = Builtin("update_timer");
            update["args"] = new JsonObject
            {
                ["sessionId"] = Self(),
                ["newSession"] = newSession.DeepClone(),
                ["agentName"] = agent,
            };
            Add("timer-update-new", update);
        }
        Add("local-tools", Builtin(Names(LocalTools)));

        // 4. Exact allows that add a capability beyond the baseline.
        foreach (var rule in exactAllows)
        {
            var source = SessionWait.Text(rule["source"])!;
            var tool = SessionWait.Text(rule["tool"])!;
            var subject = Subject(rule);
            if (source == "mcp")
            {
                Add(
                    "exact-allow",
                    new JsonObject
                    {
                        ["tool"] = new JsonObject
                        {
                            ["source"] = "mcp",
                            ["server"] = SessionWait.Text(rule["server"]),
                            ["name"] = tool,
                        },
                    }
                );
                notes.Add(new("translated", subject, "Exact MCP allow kept."));
                continue;
            }
            if (source == "node")
            {
                var target = SessionWait.Text(rule["node"])!;
                if (target == "master" && tool == "exec")
                    notes.Add(
                        new("dropped", subject, "Master exec was never allowed while isolated.")
                    );
                else if (target == "master" && tool is "read" or "write" or "edit")
                    notes.Add(
                        new(
                            "covered",
                            subject,
                            "The baseline allows it within the Agent directory, as before."
                        )
                    );
                else if (target != (node ?? "master"))
                    notes.Add(
                        new(
                            "dropped",
                            subject,
                            "Legacy isolation ran Node tools only on the bound Node, so this allow never took effect."
                        )
                    );
                else if (node is not null)
                    notes.Add(new("covered", subject, "The baseline already allows it."));
                else
                {
                    Add(
                        "exact-allow",
                        new JsonObject
                        {
                            ["tool"] = new JsonObject { ["source"] = "node", ["name"] = tool },
                            ["targetNode"] = "master",
                        }
                    );
                    notes.Add(new("translated", subject, "Exact master Node allow kept."));
                }
                continue;
            }
            if (StructuralBuiltins.Contains(tool))
                notes.Add(
                    new(
                        "dropped",
                        subject,
                        "Isolated Agents could never use this capability, even with an exact allow."
                    )
                );
            else if (tool == "session")
                notes.Add(
                    new(
                        "narrowed",
                        subject,
                        "Legacy isolation let an exact allow use every session action; the layer allows status only."
                    )
                );
            else if (BaselineBuiltins.Contains(tool))
                notes.Add(new("covered", subject, "The baseline already allows it."));
            else if (tool == "node")
            {
                // Lifecycle and selection stay denied; action matching is exact, so allow
                // the read-only actions by name rather than relying on the deny alone.
                var inspect = Builtin("node");
                inspect["args"] = new JsonObject { ["action"] = Names(["list", "inspect"]) };
                Add("exact-allow", inspect);
                notes.Add(
                    new(
                        "narrowed",
                        subject,
                        "Exact allow kept for the list and inspect actions only."
                    )
                );
            }
            else if (DeliveryBuiltins.Contains(tool))
            {
                Delivery(tool, "master");
                notes.Add(
                    new(
                        "translated",
                        subject,
                        "Exact allow kept for master, limited to the Agent directory and the current Session."
                    )
                );
            }
            else if (tool == "send_to_channel")
                notes.Add(
                    new(
                        "dropped",
                        subject,
                        "Direct channel sends are not allowed after migration; replies and own-Session file delivery remain."
                    )
                );
            else
            {
                var match = Builtin(tool);
                if (MainPathBuiltins.Contains(tool))
                    match["path"] = Within("${agent.dir}");
                Add("exact-allow", match);
                notes.Add(
                    new(
                        "translated",
                        subject,
                        MainPathBuiltins.Contains(tool)
                            ? "Exact allow kept, limited to Main paths in the Agent directory."
                            : "Exact allow kept."
                    )
                );
            }
        }

        // 5. Everything else stays denied in this layer.
        Add("deny-other", null, "deny");

        if (node is not null)
            notes.Add(
                new(
                    "widened",
                    "node:master/read,write,edit",
                    "Direct master file tools are allowed within the Agent directory; legacy isolation allowed them there only for ToolScript sources and transfers."
                )
            );
        notes.Add(
            new(
                "narrowed",
                "send_to_channel",
                "Direct channel sends, including to the Session's own attachments, are denied."
            )
        );
        notes.Add(
            new(
                "narrowed",
                "recall",
                "Semantic search must target the current Session (scope current-session); a broader scope is denied instead of being narrowed."
            )
        );
        notes.Add(
            new(
                "widened",
                "read_memory,write_memory,edit_memory,delete_memory",
                "Allowed within the Agent's memory directory, matching apply_patch_memory."
            )
        );
        notes.Add(
            new(
                "narrowed",
                "session",
                "Status of the current Session only; listing and other actions are denied."
            )
        );
        notes.Add(
            new(
                "widened",
                "builtin:create_session",
                "New Sessions may be created only in this Agent, as new-Session timers already required."
            )
        );
        if (rules.Count > 256)
            blockers.Add($"The generated layer has {rules.Count} rules; the limit is 256.");
        else
            // The generated layer must be a valid local layer; fail here, not at evaluation time.
            _ = AgentRulePolicy.Parse(rules);
        return new(rules, notes, blockers);
    }

    private static string Subject(JsonObject rule)
    {
        var source = SessionWait.Text(rule["source"]);
        var tool = SessionWait.Text(rule["tool"]);
        return source switch
        {
            "node" => $"node:{SessionWait.Text(rule["node"])}/{tool}",
            "mcp" => $"mcp:{SessionWait.Text(rule["server"])}/{tool}",
            _ => $"builtin:{tool}",
        };
    }
}
