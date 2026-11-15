using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// Display-only projection. Original arguments remain the execution and search authority.
internal static class ToolActivity
{
    // The name channel progress shows for a call, like the WebUI timeline tag: a ctl command's
    // path (`memory edit`), or for `tool call` and call_tool the tool it names; help, search
    // and unparsable ctl calls stay `ctl`.
    internal static string ProgressName(string? name, JsonNode? args) =>
        string.IsNullOrEmpty(name) ? "tool"
        : name == "ctl" ? args is JsonObject command ? CtlParser.DisplayName(command) : name
        : args is JsonObject values ? Target(name, values).Name
        : name;

    internal static (string Name, JsonObject Args) Target(string name, JsonObject args)
    {
        if (name == "ctl")
            return CtlParser.Describe(args) is { } described
                ? (described.Name, described.Args)
                : (name, args);
        if (name != "call_tool")
            return (name, args);
        var id = SessionWait.Text(args["toolId"]);
        var target = SessionWait.Text(args["name"]);
        if (id is not null)
        {
            var separator =
                id.StartsWith("builtin:", StringComparison.Ordinal) ? id.IndexOf(':')
                : id.StartsWith("mcp:", StringComparison.Ordinal) ? id.IndexOf('/')
                : id.LastIndexOf('/');
            if (separator >= 0)
                target = id[(separator + 1)..];
        }
        if (string.IsNullOrWhiteSpace(target))
            return (name, args);
        var inner = args["args"] as JsonObject;
        if (inner is null && SessionWait.Text(args["argsJson"]) is { } json)
        {
            try
            {
                inner = JsonNode.Parse(json) as JsonObject;
            }
            catch (System.Text.Json.JsonException) { }
        }
        return (target, inner ?? new JsonObject());
    }

    // The live activity summary of a call: the explicit summary of Node `exec` or builtin
    // `run_script`, also when a ctl or call_tool call routes to one. MCP tools of the same name,
    // calls without a summary and other tools have none.
    internal static string? CaptionSummary(string? name, JsonObject args)
    {
        string? source;
        string? target;
        JsonObject? targetArgs;
        if (name == "exec")
        {
            (source, target, targetArgs) = ("node", name, args);
        }
        else if (name == "run_script")
        {
            (source, target, targetArgs) = ("builtin", name, args);
        }
        else if (name is "ctl" or "call_tool")
        {
            var described = name == "ctl" ? CtlParser.Describe(args) : CtlParser.DescribeCall(args);
            if (described is null)
                return null;
            (source, target, targetArgs) = (described.Source, described.Name, described.Args);
        }
        else
        {
            return null;
        }
        if (!(source == "node" && target == "exec" || source == "builtin" && target == "run_script"))
            return null;
        var summary = SessionWait.Text(targetArgs["summary"]);
        return string.IsNullOrWhiteSpace(summary) ? null : SingleLine(summary);
    }

    internal static string SingleLine(string text, int limit = 200) =>
        ContextPreviewRenderer.Clip(Regex.Replace(text, @"\s+", " ").Trim(), limit);

    internal static string Summary(string name, JsonObject args)
    {
        (name, args) = Target(name, args);
        string? Value(string key) => SessionWait.Text(args[key]);
        if (name is "exec" or "run_script")
        {
            if (Value("summary") is { } summary && !string.IsNullOrWhiteSpace(summary))
                return SingleLine(summary);
            return SingleLine(Value(name == "exec" ? "command" : "filePath") ?? "");
        }
        var action = Value("action");
        var target = new[]
        {
            "filePath",
            "title",
            "target",
            "query",
            "text_query",
            "vector_query",
            "sessionId",
            "nodeId",
            "skillName",
            "taskId",
            "url",
            "reason",
        }
            .Select(Value)
            .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
        return SingleLine(
            string.Join(
                " · ",
                new[] { action, target }.Where(value => !string.IsNullOrWhiteSpace(value))
            )
        );
    }
}
