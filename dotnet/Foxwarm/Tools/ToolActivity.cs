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

    // Node tools whose arguments have a known-key description below; other Node tools, like MCP
    // tools, are described by their arguments.
    private static readonly HashSet<string> CanonicalNodeTools = ["read", "write", "edit", "exec"];

    // The summary a call states for itself, shown as its activity text (live caption, Session
    // list, session view and recall previews). The target's own summary comes first: that of
    // Node `exec` or builtin `run_script`, also when a ctl or call_tool call routes to one, as a
    // direct call of that tool shows it. Otherwise a ctl call's own `summary`, which is display
    // metadata only. MCP tools of the same name and calls without either have none.
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
            (source, target, targetArgs) = (described?.Source, described?.Name, described?.Args);
        }
        else
        {
            return null;
        }
        if (
            targetArgs is not null
            && (source == "node" && target == "exec" || source == "builtin" && target == "run_script")
            && Stated(targetArgs["summary"]) is { } own
        )
            return own;
        return name == "ctl" ? Stated(args["summary"]) : null;
    }

    private static string? Stated(JsonNode? value) =>
        SessionWait.Text(value) is { } summary && !string.IsNullOrWhiteSpace(summary)
            ? SingleLine(summary)
            : null;

    internal static string SingleLine(string text, int limit = 200) =>
        ContextPreviewRenderer.Clip(Regex.Replace(text, @"\s+", " ").Trim(), limit);

    // The name and summary an activity preview shows for a call, named like the WebUI timeline
    // tag (ProgressName). The fixed arguments a ctl command path already states, such as
    // `action: list` of `session list`, are left out of the summary.
    internal static (string Name, string Summary) Preview(string name, JsonObject args)
    {
        var label = ProgressName(name, args);
        return (label, Describe(name, args, label));
    }

    internal static string Summary(string name, JsonObject args) => Describe(name, args, null);

    // A call's stated summary (CaptionSummary); otherwise exec's command or run_script's file,
    // the known-key description of a builtin or canonical Node tool, and the one-line arguments
    // of an MCP or other Node tool. A ctl or call_tool target without a known key is also
    // described by its one-line arguments.
    private static string Describe(string name, JsonObject args, string? label)
    {
        if (CaptionSummary(name, args) is { } stated)
            return stated;
        var unwrapped = name is "ctl" or "call_tool";
        var (target, targetArgs) = Target(name, args);
        var source =
            name == "ctl" ? CtlParser.Describe(args)?.Source
            : name == "call_tool" ? CtlParser.DescribeCall(args)?.Source
            : null;
        if (
            label is not null
            && name == "ctl"
            && label != target
            && CtlParser.CommandFor(target, targetArgs)?.Fixed is { Count: > 0 } fixedArgs
        )
        {
            targetArgs = (JsonObject)targetArgs.DeepClone();
            foreach (var key in fixedArgs.Select(pair => pair.Key))
                targetArgs.Remove(key);
        }
        if (name == "ctl" && target == "ctl" && targetArgs.ContainsKey("summary"))
        {
            // Help, search or an unparsable command: its own blank summary isn't an argument.
            targetArgs = (JsonObject)targetArgs.DeepClone();
            targetArgs.Remove("summary");
        }
        string? Value(string key) => SessionWait.Text(targetArgs[key]);
        if (target is "exec" or "run_script" && source != "mcp")
            return SingleLine(Value(target == "exec" ? "command" : "filePath") ?? "");
        if (unwrapped && (source == "mcp" || source == "node" && !CanonicalNodeTools.Contains(target)))
            return Inline(targetArgs);
        var action = Value("action");
        var known = new[]
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
        var text = SingleLine(
            string.Join(
                " · ",
                new[] { action, known }.Where(value => !string.IsNullOrWhiteSpace(value))
            )
        );
        return text.Length == 0 && unwrapped ? Inline(targetArgs) : text;
    }

    // The one-line argument layout of the WebUI card header.
    private static string Inline(JsonObject args) =>
        SingleLine(ToolResponseFormatting.FormatArguments(args, singleLine: true));
}
