using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// One `tool search` result. A builtin that has commands is listed as those commands (Kind
// command, one result per command); a natively declared tool as itself (Kind declared); MCP
// and Node tools, which are called through `tool call`, by their tool ID (Kind tool).
internal sealed record SearchTool(
    string Source,
    string Name,
    string Description,
    JsonNode? Schema,
    string? Scope,
    bool Hidden,
    int Score,
    JsonNode? OutputSchema = null,
    string Kind = SearchKinds.Tool,
    CtlCommand? Command = null
);

internal static class SearchKinds
{
    internal const string Command = "command";
    internal const string Declared = "declared";
    internal const string Tool = "tool";
}

internal static partial class UnifiedTools
{
    [GeneratedRegex("[\\p{L}\\p{N}]+", RegexOptions.CultureInvariant)]
    private static partial Regex WordRun();

    [GeneratedRegex("(?<=[\\p{Ll}\\p{N}])(?=\\p{Lu})", RegexOptions.CultureInvariant)]
    private static partial Regex CamelBoundary();

    internal const int NameWeight = 3;

    // The whole words of a name or text, lower-cased: runs of letters and digits, so `_`, `-`,
    // `/`, `.` and other punctuation separate words, also split where camelCase turns
    // upper-case. A trailing plural s is dropped on both sides of a comparison, so `nodes`
    // matches `node`.
    internal static IEnumerable<string> Words(string text)
    {
        foreach (Match run in WordRun().Matches(text))
            foreach (var part in CamelBoundary().Split(run.Value))
                if (part.Length > 0)
                    yield return Fold(part.ToLowerInvariant());
    }

    private static string Fold(string word) =>
        word.Length > 3 && word.EndsWith('s') && !word.EndsWith("ss", StringComparison.Ordinal)
            ? word[..^1]
            : word;

    // Whole-word match score: each distinct query word counts once, NameWeight when it is a
    // word of a name and 1 when it is only a word of a description. Matching every query word
    // and matching a whole name rank higher among equal counts. -1 when no word matches; 0 for
    // an empty query, which lists everything.
    internal static int Score(
        string query,
        IReadOnlyList<string> names,
        IReadOnlyList<string> descriptions
    )
    {
        var terms = Words(query).Distinct(StringComparer.Ordinal).ToArray();
        if (terms.Length == 0)
            return 0;
        var nameWords = names.SelectMany(Words).ToHashSet(StringComparer.Ordinal);
        var textWords = descriptions.SelectMany(Words).ToHashSet(StringComparer.Ordinal);
        var inName = terms.Count(nameWords.Contains);
        var inText = terms.Count(term => !nameWords.Contains(term) && textWords.Contains(term));
        if (inName + inText == 0)
            return -1;
        var phrase = string.Join(' ', terms);
        return (inName * NameWeight + inText) * 100
            + (inName + inText == terms.Length ? 50 : 0)
            + (names.Any(name => string.Join(' ', Words(name)) == phrase) ? 25 : 0);
    }

    // The command form of a builtin's results for one ingress, ranked by the query; empty when
    // the builtin has no command there.
    internal static IEnumerable<(CtlCommand Command, int Score)> CommandMatches(
        string query,
        string builtin,
        string ingress = CtlRegistry.Ingress
    )
    {
        foreach (var command in CtlRegistry.ForTarget("builtin", builtin, ingress))
        {
            var score = Score(
                query,
                [
                    command.Path,
                    builtin,
                    .. command.Aliases.Select(alias => command.Noun + " " + alias),
                ],
                [command.Summary, command.Help ?? ""]
            );
            if (score >= 0)
                yield return (command, score);
        }
    }

    // The first sentence of a description's first line, on one line, escaped and bounded.
    internal static string Summary(string description)
    {
        var text = description.Trim();
        var newline = text.IndexOfAny(['\n', '\r']);
        if (newline >= 0)
            text = text[..newline];
        var sentence = Regex.Match(text, "^.*?[.!?](?=\\s+\\p{Lu}|\\s*$)", RegexOptions.CultureInvariant);
        if (sentence.Success)
            text = sentence.Value;
        text = Regex.Replace(Escape(text), "\\s+", " ").Trim();
        var runes = text.EnumerateRunes().ToArray();
        return runes.Length <= 200
            ? text
            : string.Concat(runes.Take(199).Select(rune => rune.ToString())) + "…";
    }

    // One result line. A command is its usage synopsis and summary, a declared tool its name,
    // and an MCP or Node tool its tool ID, with its argument type on a second line when asked.
    internal static string Line(SearchTool tool, bool schema, string ingress = CtlRegistry.Ingress)
    {
        switch (tool.Kind)
        {
            case SearchKinds.Command:
                return CtlHelp.Synopsis(tool.Command!, compact: true, ingress)
                    + " — "
                    + tool.Command!.Summary;
            case SearchKinds.Declared:
                return tool.Name + " (declared tool)" + Dash(Summary(tool.Description));
            default:
                return Descriptor(tool.Source, tool.Name, tool.Scope)
                    + Dash(Summary(tool.Description))
                    + (schema ? "\n    args: " + SchemaType(tool.Schema, 0) : "");
        }
    }

    private static string Dash(string summary) => summary.Length == 0 ? "" : " — " + summary;

    private static string Render(
        SearchTool[] tools,
        int total,
        IReadOnlyList<string> warnings,
        bool schema,
        string ingress = CtlRegistry.Ingress,
        int budget = 27_800
    )
    {
        var lines = new List<string>();
        var shown = new List<SearchTool>();
        var omitted = 0;
        for (var index = 0; index < tools.Length; index++)
        {
            var line = Line(tools[index], schema && index < 10, ingress);
            if (lines.Sum(item => item.Length + 1) + line.Length > budget)
            {
                omitted++;
                continue;
            }
            lines.Add(line);
            shown.Add(tools[index]);
        }
        var builder = new StringBuilder(
            total == 0
                ? "No matching commands or tools."
                : $"Showing {lines.Count} of {total} match(es)."
        );
        if (lines.Count > 0)
            builder.Append("\n\n").Append(string.Join('\n', lines)).Append('\n');
        if (omitted > 0)
            builder.Append($"\n{omitted} more result(s) did not fit in the output.");
        if (shown.Any(tool => tool.Kind == SearchKinds.Command))
            builder.Append("\nAdd --help to a command for its arguments.");
        if (shown.Any(tool => tool.Kind == SearchKinds.Declared))
            builder.Append("\nCall declared tools directly, not through ctl.");
        if (shown.Any(tool => tool.Kind == SearchKinds.Tool))
            builder.Append(
                "\nCall a tool with `tool call <tool-id> --args @args` and its arguments in values.args; `tool call <tool-id> --help` shows its arguments."
            );
        if (total > tools.Length)
            builder.Append("\nRaise --limit or narrow the query or --source to see more.");
        foreach (var warning in warnings)
        {
            var line = "\nWarning: " + Comment(warning, 500);
            if (builder.Length + line.Length > budget + 4_000)
                break;
            builder.Append(line);
        }
        return builder.ToString().TrimEnd();
    }

    // The external (inbound MCP) text for `tool search`, with the same lines as the model's
    // within the smaller text budget of an inbound result; the structured result lists every
    // returned tool.
    internal static string RenderExternal(
        IReadOnlyList<SearchTool> tools,
        int total,
        IReadOnlyList<string> warnings,
        bool schema
    ) => Render([.. tools], total, warnings, schema, "external", budget: 4_000);

    // Structured fields a program can use to present or run a result: its kind, one-line
    // summary and, for a command, the command path and usage synopsis.
    internal static void Describe(JsonObject row, SearchTool tool, string ingress = CtlRegistry.Ingress)
    {
        row["kind"] = tool.Kind;
        if (tool.Command is { } command)
        {
            row["command"] = command.Path;
            row["usage"] = CtlHelp.Synopsis(command, compact: true, ingress);
            row["summary"] = command.Summary;
        }
        else
            row["summary"] = Summary(tool.Description);
    }

    // `tool call <tool-id> --help` for a tool called through `tool call`: its description and
    // arguments.
    internal static string ToolHelp(
        string source,
        string name,
        string? scope,
        string description,
        JsonNode? schema,
        JsonNode? outputSchema
    )
    {
        var builder = new StringBuilder("Tool: " + Descriptor(source, name, scope) + "\n");
        var text = string.Join(
            '\n',
            description.Trim().Replace("\r\n", "\n").Split('\n').Select(line => Escape(line.TrimEnd()))
        );
        if (text.Length > 0)
            builder.Append('\n').Append(text).Append('\n');
        builder.Append('\n').Append(Arguments(schema));
        if (outputSchema is not null)
            builder.Append("\nResult: ").Append(SchemaType(outputSchema, 0)).Append('\n');
        builder.Append(
            "\nCall it with `tool call <tool-id> --args @args` and its arguments in values.args."
        );
        var help = builder.ToString();
        return help.Length <= CtlHelp.MaxLength
            ? help
            : help[..(CtlHelp.MaxLength - 60)].TrimEnd() + "\n… Help shortened.";
    }

    // One argument per line with its type, whether it is required, and its description; a
    // schema that isn't a plain object of properties is shown as one type.
    private static string Arguments(JsonNode? schema)
    {
        if (
            schema is not JsonObject root
            || UnsupportedKeywords.Any(root.ContainsKey)
            || root["properties"] is not JsonObject properties
        )
            return schema is null
                ? "Arguments: none.\n"
                : "Arguments: " + SchemaType(schema, 0) + "\n";
        if (properties.Count == 0)
            return "Arguments: none.\n";
        var required = (root["required"] as JsonArray ?? [])
            .Select(value => SessionWait.Text(value))
            .OfType<string>()
            .ToHashSet(StringComparer.Ordinal);
        var builder = new StringBuilder("Arguments (one JSON object):\n");
        foreach (var (key, property) in properties)
        {
            builder
                .Append("  ")
                .Append(Escape(key))
                .Append(": ")
                .Append(SchemaType(property, 1));
            if (required.Contains(key))
                builder.Append(" (required)");
            builder.Append('\n');
            if (SessionWait.Text(property?["description"]) is { Length: > 0 } help)
                builder
                    .Append("      ")
                    .Append(Regex.Replace(Escape(help), "\\s+", " ").Trim())
                    .Append('\n');
        }
        return builder.ToString();
    }

    // `tool call <tool-id> --help` for the model: the tool's description and arguments, or the
    // commands or declaration that run a builtin. Null when the caller can't see the tool.
    internal static async Task<JsonObject?> ToolHelpAsync(
        ToolRegistry registry,
        CtlDescription target,
        CancellationToken token,
        Func<string, string, string?, bool>? visible = null,
        Foxwarm.ToolScript.ToolScriptDataBudget? budget = null,
        SessionOwner? owner = null
    )
    {
        var currentNode = CurrentNode(owner);
        JsonObject? definition = null;
        string? scope = null;
        switch (target.Source)
        {
            case "builtin":
            {
                var entry = registry.Entries.FirstOrDefault(entry =>
                    entry.Source == "builtin"
                    && entry.Definition["name"]!.GetValue<string>() == target.Name
                    && target.Name != "ctl"
                );
                if (entry is null || visible is not null && !visible("builtin", target.Name, null))
                    return null;
                var commands = CtlRegistry.ForTarget("builtin", target.Name).ToArray();
                if (commands.Length > 0)
                    return Help(
                        "Run it with "
                            + (commands.Length == 1 ? "this command" : "these commands")
                            + ":\n\n"
                            + string.Join(
                                '\n',
                                commands.Select(command =>
                                    Line(
                                        new(
                                            "builtin",
                                            target.Name,
                                            "",
                                            null,
                                            null,
                                            false,
                                            0,
                                            Kind: SearchKinds.Command,
                                            Command: command
                                        ),
                                        false
                                    )
                                )
                            )
                            + "\n\nAdd --help to a command for its arguments."
                    );
                if (entry.DefaultInject)
                    return Help(Declared(target.Name));
                definition = entry.Definition;
                break;
            }
            case "node":
            {
                scope = ToolRegistry.TargetNode(target.Node, currentNode);
                await registry.RefreshNodeAsync(scope, token);
                definition = registry
                    .NodeDefinitions(scope)
                    .OfType<JsonObject>()
                    .FirstOrDefault(item => SessionWait.Text(item["name"]) == target.Name);
                // A declared tool the current Node provides is described by its declaration.
                if (
                    definition is not null
                    && scope == currentNode
                    && DeclaredNodeTools(registry).ContainsKey(target.Name)
                )
                    return visible is not null && !visible("node", target.Name, scope)
                        ? null
                        : Help(Declared(target.Name));
                break;
            }
            case "mcp":
            {
                if (string.IsNullOrEmpty(target.Server))
                    return null;
                scope = target.Server;
                definition = (
                    await registry.Mcp.ListToolsAsync(scope, token, owner, owner?.McpGeneration)
                ).FirstOrDefault(item => SessionWait.Text(item["name"]) == target.Name);
                break;
            }
        }
        if (definition is null || visible is not null && !visible(target.Source, target.Name, scope))
            return null;
        var schema = definition["inputSchema"] ?? definition["parameters"];
        var description = SessionWait.Text(definition["description"]) ?? "";
        var result = new JsonObject
        {
            ["output"] = ToolHelp(
                target.Source,
                target.Name,
                scope,
                description,
                schema,
                definition["outputSchema"]
            ),
        };
        if (budget is not null)
        {
            var tool = new JsonObject
            {
                ["toolId"] = target.Source + ":" + (scope is null ? "" : scope + "/") + target.Name,
                ["source"] = target.Source,
                ["name"] = target.Name,
                ["description"] = description,
            };
            if (scope is not null)
                tool[target.Source == "mcp" ? "server" : "nodeId"] = scope;
            if (schema is not null)
                tool["inputSchema"] = schema.DeepClone();
            if (definition["outputSchema"] is { } output)
                tool["outputSchema"] = output.DeepClone();
            budget.JsonValue(tool);
            result["tool"] = tool;
        }
        return result;

        static JsonObject Help(string text) => new() { ["output"] = text };

        static string Declared(string name) =>
            $"{name} is a declared tool; call it directly, not through ctl.";
    }

    // The ordering of results: best score first, then by source, scope and the name shown.
    internal static IOrderedEnumerable<SearchTool> Rank(IEnumerable<SearchTool> tools)
    {
        var comparer = StringComparer.Create(CultureInfo.GetCultureInfo("en-US"), false);
        return tools
            .OrderByDescending(tool => tool.Score)
            .ThenBy(tool => tool.Source, comparer)
            .ThenBy(tool => tool.Scope ?? "", comparer)
            .ThenBy(tool => tool.Command?.Path ?? tool.Name, comparer);
    }
}
