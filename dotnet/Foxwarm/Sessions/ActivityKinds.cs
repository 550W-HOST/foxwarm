using System.Text;

namespace Foxwarm.Sessions;

/// <summary>
/// Presentation classification of tool effects, applied when activity is read so it can change
/// without rebuilding the index. It reads canonical tool identities only; MCP annotations are
/// untrusted hints and are never consulted.
/// </summary>
internal static class ActivityKinds
{
    internal static readonly string[] All =
    [
        "exec",
        "files",
        "communicate",
        "sessions",
        "tasks",
        "nodes",
        "config",
        "timers",
        "browser",
        "mcp",
        "script",
        "other",
        "read",
        "internal",
    ];

    // Kinds that never change anything outside the call itself. "Changes" hides them; script
    // containers are hidden too because each of their calls has its own row.
    internal static readonly HashSet<string> Quiet = new(
        ["read", "internal", "script"],
        StringComparer.Ordinal
    );

    private sealed record Rule(
        string Kind,
        string? Source,
        string[] Names,
        string[]? Actions = null,
        bool Prefix = false
    );

    private static readonly string[] ReadActions = ["list", "inspect", "status", "get"];

    // First match wins.
    private static readonly Rule[] Rules =
    [
        new("mcp", "mcp", []),
        new("exec", null, ["exec", "terminal_open", "terminal_send", "terminal_close"]),
        new("read", null, ["node", "task", "session"], ReadActions),
        new(
            "read",
            null,
            [
                "read",
                "read_memory",
                "search_tools",
                "recall",
                "skill",
                "image_crop",
                "list_agents",
                "list_mcp_servers",
                "list_toolscript_runs",
                "get_toolscript_run",
                "explain_tool_authorization",
                "list_secrets",
                "browser_tabs",
                "browser_read",
                "browser_screenshot",
                "terminal_read",
                "web_search",
                "node_pair_list",
                "node_bootstrap_info",
            ]
        ),
        new(
            "internal",
            null,
            [
                "wait",
                "compact_session",
                "submit_compact_plan",
                "refresh_session_snapshot",
                "artifact",
            ]
        ),
        new(
            "files",
            null,
            [
                "write",
                "edit",
                "image_write_to_file",
                "copy_between_nodes",
                "write_memory",
                "edit_memory",
                "delete_memory",
                "apply_patch_memory",
            ]
        ),
        new("communicate", null, ["send_to_session", "send_to_channel", "send_file", "ask_user"]),
        new(
            "sessions",
            null,
            [
                "session",
                "create_child_session",
                "create_session",
                "delete_session",
                "move_session",
                "stop_session",
                "create_agent",
            ]
        ),
        new("tasks", null, ["task"]),
        new("nodes", null, ["node", "node_remove", "node_pair_approve", "node_create_auth_token"]),
        new("timers", null, ["create_timer", "update_timer", "delete_timer", "timer"]),
        new(
            "config",
            null,
            [
                "set_config",
                "add_secret",
                "set_agent_inherit",
                "set_agent_isolated",
                "set_agent_rules",
                "mcp_config",
                "set_session_child_model",
                "set_session_compact_threshold",
            ]
        ),
        new(
            "script",
            null,
            ["run_script", "start_toolscript_run", "continue_script", "cancel_toolscript_run"]
        ),
        new("browser", null, ["browser_"], Prefix: true),
    ];

    internal static string Of(string? source, string tool, string? action)
    {
        foreach (var rule in Rules)
        {
            if (rule.Source is not null && rule.Source != source)
                continue;
            if (rule.Source is null && source == "mcp")
                continue;
            if (
                rule.Names.Length > 0
                && !rule.Names.Any(name =>
                    rule.Prefix ? tool.StartsWith(name, StringComparison.Ordinal) : tool == name
                )
            )
                continue;
            if (rule.Actions is not null && (action is null || !rule.Actions.Contains(action)))
                continue;
            return rule.Kind;
        }
        return "other";
    }

    private static string Literal(string value) =>
        "'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    /// <summary>The same classification as a SQL expression over the index columns.</summary>
    internal static readonly string Sql = BuildSql();

    private static string BuildSql()
    {
        var builder = new StringBuilder("CASE");
        foreach (var rule in Rules)
        {
            var conditions = new List<string>();
            conditions.Add(
                rule.Source is null
                    ? "coalesce(source,'')<>'mcp'"
                    : $"source={Literal(rule.Source)}"
            );
            if (rule.Names.Length > 0)
                conditions.Add(
                    rule.Prefix
                        ? "("
                            + string.Join(
                                " OR ",
                                rule.Names.Select(name =>
                                    $"substr(tool,1,{name.Length})={Literal(name)}"
                                )
                            )
                            + ")"
                        : $"tool IN ({string.Join(',', rule.Names.Select(Literal))})"
                );
            if (rule.Actions is not null)
                conditions.Add($"action IN ({string.Join(',', rule.Actions.Select(Literal))})");
            builder
                .Append(" WHEN ")
                .Append(string.Join(" AND ", conditions))
                .Append(" THEN ")
                .Append(Literal(rule.Kind));
        }
        return builder.Append(" ELSE 'other' END").ToString();
    }
}
