using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// Display-only projection. Original arguments remain the execution and search authority.
internal static class ToolActivity
{
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
