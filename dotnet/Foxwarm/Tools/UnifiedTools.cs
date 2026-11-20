using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal static partial class UnifiedTools
{
    internal static async Task<JsonObject> SearchAsync(
        ToolRegistry registry,
        JsonObject args,
        CancellationToken token,
        Func<string, string, string?, bool>? visible = null,
        Foxwarm.ToolScript.ToolScriptDataBudget? budget = null,
        SessionOwner? owner = null,
        Func<string, bool>? broadServerVisible = null
    )
    {
        ToolRegistry.Keys(args, ["query", "sources", "server", "nodeId", "limit", "includeSchema"]);
        var query = ToolRegistry.Text(args, "query") ?? "";
        var sources = args["sources"] switch
        {
            null => new[] { "builtin", "mcp", "node" },
            JsonArray array => array
                .Select(value => SessionWait.Text(value)?.Trim() ?? "")
                .Where(value => value.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            _ => new[] { ToolRegistry.Text(args, "sources")!.Trim() },
        };
        if (sources.Length == 0)
            sources = ["builtin", "mcp", "node"];
        if (sources.Any(source => source is not ("builtin" or "mcp" or "node")))
            throw new InvalidDataException(
                "Invalid sources. Supported sources: builtin, mcp, node."
            );
        // Text shows argument schemas only when asked; programs keep receiving them unless
        // they opt out.
        var schema = args["includeSchema"] is null
            ? budget is not null
            : args["includeSchema"]!.GetValue<bool>();
        var numeric = SessionWait.Number(args["limit"]);
        if (
            numeric is null
            && SessionWait.Text(args["limit"]) is string text
            && double.TryParse(
                text,
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out var parsed
            )
        )
            numeric = parsed;
        var limit =
            numeric is double number && double.IsFinite(number)
                ? (int)Math.Clamp(Math.Truncate(number), 1, 200)
                : 5;
        var currentNode = CurrentNode(owner);
        var external =
            owner?.Entry.WithState(state => ClaudeRuntimeState.IsExternal(state.AuthorityEnvelope))
            == true;
        var collected = new List<SearchTool>();
        var warnings = new List<string>();
        // Natively declared Node tools (read, write, edit, exec) run on the current Node. A Node
        // search of the current Node lists the ones it provides as declared tools, not again by
        // tool ID; a builtin search without it lists the declarations themselves.
        var declaredNode = DeclaredNodeTools(registry);
        var namedNode = ToolRegistry.Text(args, "nodeId");
        var searchesCurrentNode =
            sources.Contains("node")
            && (
                string.IsNullOrWhiteSpace(namedNode)
                || ToolRegistry.TargetNode(namedNode, currentNode) == currentNode
            );
        foreach (
            var entry in registry.Entries.Where(entry =>
                entry.Definition["name"]!.GetValue<string>() != "ctl"
            )
        )
        {
            var nodeTool = entry.Source == "node";
            if (
                nodeTool
                    ? !entry.DefaultInject || !sources.Contains("builtin") || searchesCurrentNode
                    : entry.Source != "builtin" || !sources.Contains("builtin")
            )
                continue;
            var definition = external
                ? ClaudeRuntimeToolSupport.Project(entry.Definition)
                : entry.Definition;
            var name = SessionWait.Text(definition["name"])!;
            var description = SessionWait.Text(definition["description"]) ?? "";
            if (
                visible is not null
                && !visible(entry.Source, name, nodeTool ? currentNode : null)
            )
                continue;
            var commands = nodeTool ? [] : CommandMatches(query, name).ToArray();
            if (commands.Length > 0 || !nodeTool && CtlRegistry.ForTarget("builtin", name).Any())
            {
                foreach (var (command, commandScore) in commands)
                    collected.Add(
                        new(
                            entry.Source,
                            name,
                            description,
                            definition["parameters"],
                            null,
                            !entry.DefaultInject,
                            commandScore,
                            Kind: SearchKinds.Command,
                            Command: command
                        )
                    );
                continue;
            }
            var score = Score(query, [name], [description]);
            if (score >= 0)
                collected.Add(
                    new(
                        entry.Source,
                        name,
                        description,
                        definition["parameters"],
                        nodeTool ? currentNode : null,
                        !entry.DefaultInject,
                        score,
                        // A builtin without a command or declaration is still listed by its
                        // tool ID; the registry coverage test keeps real builtins out of this.
                        Kind: entry.DefaultInject ? SearchKinds.Declared : SearchKinds.Tool
                    )
                );
        }
        if (sources.Contains("node"))
        {
            try
            {
                var nodeId = ToolRegistry.TargetNode(ToolRegistry.Text(args, "nodeId"), currentNode);
                await registry.RefreshNodeAsync(nodeId, token);
                foreach (var definition in registry.NodeDefinitions(nodeId).OfType<JsonObject>())
                {
                    var name = SessionWait.Text(definition["name"])!;
                    var declared =
                        nodeId == currentNode && declaredNode.TryGetValue(name, out var native)
                            ? external
                                ? ClaudeRuntimeToolSupport.Project(native)
                                : native
                            : null;
                    var shown = declared ?? definition;
                    var description = SessionWait.Text(shown["description"]) ?? "";
                    if (visible is not null && !visible("node", name, nodeId))
                        continue;
                    var score = Score(query, [name], [description, nodeId]);
                    if (score >= 0)
                        collected.Add(
                            new(
                                "node",
                                name,
                                description,
                                shown["parameters"],
                                nodeId,
                                declared is null,
                                score,
                                Kind: declared is null ? SearchKinds.Tool : SearchKinds.Declared
                            )
                        );
                }
            }
            catch (Exception error)
                when (error is InvalidDataException or InvalidOperationException or IOException)
            {
                warnings.Add(error.Message);
            }
        }
        if (sources.Contains("mcp"))
        {
            var filter = ToolRegistry.Text(args, "server")?.Trim();
            string[] servers;
            try
            {
                servers =
                    !string.IsNullOrEmpty(filter) ? new[] { filter }
                    : registry
                        .Mcp.Summaries()
                        .OfType<JsonObject>()
                        .Where(row => row["enabled"]!.GetValue<bool>())
                        .Select(row => SessionWait.Text(row["name"])!)
                        .ToArray();
            }
            catch (Exception)
            {
                warnings.Add("MCP server discovery failed; configuration is unavailable.");
                servers = [];
            }
            // Policy failures propagate rather than reading as unavailable configuration.
            if (string.IsNullOrEmpty(filter) && broadServerVisible is not null)
                servers = servers.Where(broadServerVisible).ToArray();
            var listed = await ListMcpAsync(
                registry,
                servers,
                string.IsNullOrEmpty(filter),
                owner,
                token
            );
            for (var index = 0; index < servers.Length; index++)
            {
                var server = servers[index];
                if (listed[index].Warning is string warning)
                {
                    warnings.Add(warning);
                    continue;
                }
                try
                {
                    foreach (var tool in listed[index].Tools!)
                    {
                        var name = SessionWait.Text(tool["name"]) ?? "unknown";
                        var description = SessionWait.Text(tool["description"]) ?? "";
                        if (visible is not null && !visible("mcp", name, server))
                            continue;
                        var score = Score(query, [name], [description, server]);
                        if (score >= 0)
                            collected.Add(
                                new(
                                    "mcp",
                                    name,
                                    description,
                                    tool["inputSchema"],
                                    server,
                                    true,
                                    score,
                                    tool["outputSchema"]
                                )
                            );
                    }
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    throw;
                }
                catch (ToolAuthorizationUnavailableException)
                {
                    throw;
                }
                catch (Exception error)
                {
                    warnings.Add("MCP server " + server + ": " + error.Message);
                }
            }
        }
        var sorted = Rank(collected).Take(limit).ToArray();
        var response = budget is null
            ? new JsonObject { ["output"] = Render(sorted, collected.Count, warnings, schema) }
            : new JsonObject();
        if (budget is not null)
        {
            var rows = new JsonArray();
            for (var index = 0; index < sorted.Length; index++)
            {
                var tool = sorted[index];
                budget.JsonValue(tool.Schema);
                var id =
                    tool.Source == "builtin"
                        ? "builtin:" + tool.Name
                        : tool.Source + ":" + tool.Scope + "/" + tool.Name;
                var row = new JsonObject
                {
                    ["toolId"] = id,
                    ["source"] = tool.Source,
                    ["name"] = tool.Name,
                    ["description"] = tool.Description,
                    ["hidden"] = tool.Hidden,
                };
                if (tool.Source == "node")
                    row["nodeId"] = tool.Scope;
                else if (tool.Source == "mcp")
                    row["server"] = tool.Scope;
                Describe(row, tool);
                if (schema && index < 10 && tool.Schema is not null)
                    row["inputSchema"] = tool.Schema.DeepClone();
                if (schema && index < 10 && tool.OutputSchema is not null)
                {
                    budget.JsonValue(tool.OutputSchema);
                    row["outputSchema"] = tool.OutputSchema.DeepClone();
                }
                budget.JsonValue(row);
                rows.Add(row);
            }
            response["tools"] = rows;
            if (warnings.Count > 0)
                response["warnings"] = new JsonArray(
                    warnings.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
                );
        }
        return response;
    }

    // Broad MCP discovery (no server filter) lists servers concurrently under one
    // shared deadline so a slow or hung server cannot hold the whole search; a
    // server that misses it is reported as a warning. A named server keeps the
    // ordinary per-request discovery timeout.
    internal const int BroadMcpConcurrency = 6;
    internal static readonly TimeSpan BroadMcpBudget = TimeSpan.FromSeconds(15);

    private static async Task<(IReadOnlyList<JsonObject>? Tools, string? Warning)[]> ListMcpAsync(
        ToolRegistry registry,
        string[] servers,
        bool broad,
        SessionOwner? owner,
        CancellationToken token
    )
    {
        var results = new (IReadOnlyList<JsonObject>? Tools, string? Warning)[servers.Length];
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        if (broad)
            deadline.CancelAfter(BroadMcpBudget);
        using var slots = new SemaphoreSlim(broad ? BroadMcpConcurrency : 1);
        await Task.WhenAll(
            servers.Select(
                async (server, index) =>
                {
                    try
                    {
                        await slots.WaitAsync(deadline.Token);
                        try
                        {
                            results[index] = (
                                await registry.Mcp.ListToolsAsync(
                                    server,
                                    deadline.Token,
                                    owner,
                                    owner?.McpGeneration
                                ),
                                null
                            );
                        }
                        finally
                        {
                            slots.Release();
                        }
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (OperationCanceledException) when (deadline.IsCancellationRequested)
                    {
                        results[index] = (
                            null,
                            $"MCP server {server}: tool discovery did not finish within the "
                                + $"{(int)BroadMcpBudget.TotalSeconds}-second budget for searching all servers; "
                                + "pass server to search it with the full discovery timeout."
                        );
                    }
                    catch (ToolAuthorizationUnavailableException)
                    {
                        throw;
                    }
                    catch (Exception error)
                    {
                        results[index] = (null, "MCP server " + server + ": " + error.Message);
                    }
                }
            )
        );
        return results;
    }

    internal static string CurrentNode(SessionOwner? owner) =>
        owner is null
            ? "master"
            : SessionWait.Text(owner.Entry.Snapshot().AuthorityEnvelope["currentNode"]) ?? "master";

    // The natively declared tools that run on the current Node, by name.
    internal static Dictionary<string, JsonObject> DeclaredNodeTools(ToolRegistry registry) =>
        registry
            .Entries.Where(entry => entry.Source == "node" && entry.DefaultInject)
            .ToDictionary(
                entry => entry.Definition["name"]!.GetValue<string>(),
                entry => entry.Definition,
                StringComparer.Ordinal
            );

    // How a search result names its tool for `tool call`: the tool ID when every part is a
    // plain identifier; otherwise --source/--name/--server or --node-id with ctl quoting. A
    // part with control or line-direction characters can't be shown as one readable token, so
    // it is passed as `@name` and its JSON value is shown after the descriptor.
    internal static string Descriptor(string source, string name, string? scope)
    {
        if (SafeIdentity(name) && (scope is null || SafeIdentity(scope)))
            return source == "builtin" ? "builtin:" + name : source + ":" + scope + "/" + name;
        var values = new List<string>();
        string Part(string key, string value)
        {
            if (Escape(value) == value)
                return CtlCommandText.Literal(value);
            values.Add(Quote(key) + ": " + Quote(value));
            return "@" + key;
        }
        var flags = "--source " + source + " --name " + Part("name", name);
        if (scope is not null)
            flags +=
                source == "mcp"
                    ? " --server " + Part("server", scope)
                    : " --node-id " + Part("nodeId", scope);
        return values.Count == 0 ? flags : flags + " with values {" + string.Join(", ", values) + "}";
    }

    private static bool SafeIdentity(string value) =>
        value.Length > 0
        && Regex.IsMatch(value, "^[A-Za-z0-9_.-]+$", RegexOptions.CultureInvariant);

    private static string Escape(string text)
    {
        var builder = new StringBuilder();
        foreach (var rune in text.EnumerateRunes())
        {
            var code = rune.Value;
            if (
                code <= 0x1f
                || code is >= 0x7f and <= 0x9f
                || code is 0x061c or 0x200e or 0x200f or 0x2028 or 0x2029
                || code is >= 0x202a and <= 0x202e
                || code is >= 0x2066 and <= 0x2069
            )
                builder.Append("\\u" + code.ToString("x4", CultureInfo.InvariantCulture));
            else
                builder.Append(rune.ToString());
        }
        return builder.ToString();
    }

    // A JSON string literal with control and line-direction characters escaped.
    private static string Quote(string text)
    {
        var builder = new StringBuilder("\"");
        foreach (var rune in text.EnumerateRunes())
        {
            var piece = rune.ToString();
            var escaped = Escape(piece);
            builder.Append(
                escaped != piece ? escaped
                : piece == "\\" ? "\\\\"
                : piece == "\"" ? "\\\""
                : piece
            );
        }
        return builder.Append('"').ToString();
    }

    private static string Comment(string text, int? max = null)
    {
        text = Regex
            .Replace(Escape(text), "\\s+", " ")
            .Trim()
            .Replace("*/", "*\\/", StringComparison.Ordinal);
        if (max is not int limit)
            return text;
        var runes = text.EnumerateRunes().ToArray();
        return runes.Length <= limit
            ? text
            : string.Concat(runes.Take(limit - 1).Select(rune => rune.ToString())) + "…";
    }
}
