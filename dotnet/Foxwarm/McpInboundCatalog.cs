using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm;

internal sealed class McpInboundCatalog
{
    private readonly McpClient mcp;
    internal Foxwarm.Channels.ChannelRegistry ChannelRegistry { get; }
    private readonly NodeConnectionHub nodes;
    private readonly McpExternalAuthorization authorization;
    private readonly McpInboundSessions sessions;
    private readonly McpInboundNodes externalNodes;
    private static readonly JsonArray wrappers = LoadWrappers();

    internal McpInboundCatalog(SessionManager manager)
    {
        mcp = manager.OutboundMcp;
        ChannelRegistry = manager.ChannelRegistry;
        nodes = manager.Nodes;
        authorization = new(manager.Authorization, manager.ToolWorkspace);
        sessions = new(new SessionRuntime(manager), authorization);
        externalNodes = new(nodes, authorization);
    }

    private static JsonArray LoadWrappers()
    {
        using var stream = typeof(McpInboundCatalog).Assembly.GetManifestResourceStream(
            "Foxwarm.McpInboundTools.json"
        )!;
        using var reader = new StreamReader(stream);
        return JsonNode.Parse(reader.ReadToEnd())!.AsArray();
    }

    internal JsonArray Tools(McpExternalContext context)
    {
        context.Require();
        return (JsonArray)wrappers.DeepClone();
    }

    internal async Task ReleaseAsync(McpExternalContext context, string[] usedNodes)
    {
        await Task.WhenAll(
            nodes.ReleaseExternalAsync(context, usedNodes),
            mcp.ReleaseExternalAsync(context)
        );
    }

    internal static JsonObject Error(string text) =>
        new()
        {
            ["isError"] = true,
            ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }),
        };

    internal static JsonObject Result(JsonNode? value)
    {
        if (value is JsonObject obj && obj["content"] is JsonArray)
            return obj;
        var result = new JsonObject
        {
            ["content"] = new JsonArray(
                new JsonObject
                {
                    ["type"] = "text",
                    ["text"] = value is null
                        ? "null"
                        : SessionWait.Text(value) ?? value.ToJsonString(),
                }
            ),
        };
        if (value is JsonObject structured)
            result["structuredContent"] = structured.DeepClone();
        return result;
    }

    private static void Keys(JsonObject args, params string[] keys)
    {
        if (args.Any(pair => !keys.Contains(pair.Key, StringComparer.Ordinal)))
            throw new McpInboundSafeException("Invalid tool arguments.");
    }

    private static string? Text(JsonObject args, string key, bool required = false)
    {
        if (!args.ContainsKey(key) && !required)
            return null;
        return SessionWait.Text(args[key])
            ?? throw new McpInboundSafeException("Invalid tool arguments.");
    }

    private static int? Integer(JsonObject args, string key, int minimum, int maximum)
    {
        if (!args.ContainsKey(key))
            return null;
        var number = SessionWait.Number(args[key]);
        if (
            number is null
            || !double.IsFinite(number.Value)
            || number != Math.Truncate(number.Value)
            || number < minimum
            || number > maximum
        )
            throw new McpInboundSafeException("Invalid tool arguments.");
        return (int)number.Value;
    }

    private static long? Offset(JsonObject args, bool nonnegative)
    {
        if (!args.ContainsKey("start"))
            return null;
        var number = SessionWait.Number(args["start"]);
        if (
            number is null
            || !double.IsFinite(number.Value)
            || number != Math.Truncate(number.Value)
            || Math.Abs(number.Value) > 9007199254740991
            || nonnegative && number < 0
        )
            throw new McpInboundSafeException("Invalid Session action arguments.");
        return (long)number.Value;
    }

    private static bool? Boolean(JsonObject args, string key)
    {
        if (!args.ContainsKey(key))
            return null;
        return args[key] is JsonValue scalar && scalar.TryGetValue<bool>(out var flag)
            ? flag
            : throw new McpInboundSafeException("Invalid tool arguments.");
    }

    internal async Task<JsonObject> CallAsync(
        McpExternalContext context,
        string name,
        JsonObject args,
        CancellationToken token
    )
    {
        try
        {
            context.Require();
            JsonNode? result;
            switch (name)
            {
                case "foxwarm_discover":
                    return await DiscoverAsync(context, args, token);
                case "foxwarm_call":
                    return await CallConcreteAsync(context, args, token);
                case "foxwarm_node":
                    Keys(args, "action", "nodeId");
                    var action = Text(args, "action", true)!;
                    if (action is not ("list" or "status" or "select"))
                        throw new McpInboundSafeException("Invalid Node action arguments.");
                    result = await externalNodes.ActionAsync(
                        context,
                        action,
                        Text(args, "nodeId"),
                        token
                    );
                    break;
                case "foxwarm_exec_result":
                    Keys(args, "execId", "limit");
                    var id = Text(args, "execId");
                    if (id == "")
                        throw new McpInboundSafeException("Invalid execution result arguments.");
                    result = await externalNodes.ResultAsync(
                        context,
                        id,
                        Integer(args, "limit", 1, 20) ?? 5,
                        token
                    );
                    break;
                case "foxwarm_session":
                    result = await SessionAsync(context, args, token);
                    break;
                default:
                    return Error("Tool is not available.");
            }
            context.Require();
            return Result(result);
        }
        catch (McpInboundSafeException error)
        {
            return Error(error.Message);
        }
        catch (ToolAuthorizationUnavailableException)
        {
            return Error("Tool policy is unavailable; operation failed closed.");
        }
        catch (OperationCanceledException)
        {
            return Error(
                "Tool call was cancelled; its outcome may be unknown. Do not retry automatically."
            );
        }
        catch
        {
            return Error(
                "Tool operation failed; its outcome may be unknown. Do not retry automatically."
            );
        }
    }

    private async Task<JsonObject> SessionAsync(
        McpExternalContext context,
        JsonObject args,
        CancellationToken token
    )
    {
        var action = Text(args, "action", true);
        if (action == "list")
        {
            Keys(args, "action", "start", "count");
            return await sessions.ListAsync(
                context,
                Offset(args, true) ?? 0,
                Integer(args, "count", 1, 50) ?? 20,
                token
            );
        }
        if (action == "read")
        {
            Keys(
                args,
                "action",
                "sessionId",
                "start",
                "before",
                "count",
                "historyVersion",
                "parts",
                "previewLength",
                "contentFilter",
                "includeRegex",
                "excludeRegex",
                "toolDetail"
            );
            return await sessions.ReadAsync(context, Text(args, "sessionId", true)!, args, token);
        }
        if (action != "send")
            throw new McpInboundSafeException("Invalid Session action arguments.");
        Keys(args, "action", "sessionId", "message", "allowReply", "reply");
        var allowReply = Boolean(args, "allowReply");
        var legacy = Boolean(args, "reply");
        if (allowReply is not null && legacy is not null && allowReply != legacy)
            throw new McpInboundSafeException(
                "allowReply and legacy reply must agree when both are provided."
            );
        return await sessions.SendAsync(
            context,
            Text(args, "sessionId", true)!,
            Text(args, "message", true)!,
            allowReply ?? legacy ?? false,
            token
        );
    }

    private async Task<JsonObject> CallConcreteAsync(
        McpExternalContext context,
        JsonObject args,
        CancellationToken token
    )
    {
        Keys(args, "toolId", "args");
        var id = Text(args, "toolId", true)!;
        var callArgs = !args.ContainsKey("args")
            ? new JsonObject()
            : args["args"] as JsonObject
                ?? throw new McpInboundSafeException("Invalid tool call arguments.");
        if (id is "builtin:node_pair_list" or "builtin:node_pair_approve")
            return Result(await PairAsync(context, id[8..], callArgs, token));
        var colon = id.IndexOf(':');
        var slash = id.IndexOf('/', colon + 1);
        if (colon <= 0 || slash <= colon + 1 || slash == id.Length - 1)
            throw new McpInboundSafeException("Invalid tool ID.");
        var source = id[..colon];
        var scope = id[(colon + 1)..slash];
        var name = id[(slash + 1)..];
        if (source == "mcp")
            return await mcp.CallExternalAsync(
                context,
                authorization,
                scope,
                name,
                callArgs,
                token
            );
        if (source == "node")
            return Result(await externalNodes.CallAsync(context, scope, name, callArgs, token));
        throw new McpInboundSafeException("Tool source is not available on this inbound endpoint.");
    }

    private async Task<JsonNode?> PairAsync(
        McpExternalContext context,
        string name,
        JsonObject args,
        CancellationToken token
    )
    {
        Keys(args, name == "node_pair_list" ? [] : ["pendingId", "nodeId"]);
        if (name == "node_pair_approve")
        {
            if (
                Text(args, "pendingId", true) is not { Length: > 0 } pending
                || string.IsNullOrWhiteSpace(pending)
                || Encoding.UTF8.GetByteCount(pending) > 256
                || args.ContainsKey("nodeId")
                    && (
                        Text(args, "nodeId") is not { Length: > 0 } node
                        || string.IsNullOrWhiteSpace(node)
                        || Encoding.UTF8.GetByteCount(node) > 128
                    )
            )
                throw new McpInboundSafeException("Invalid pairing arguments.");
        }
        var permission = authorization.Request(context, "builtin", name, args);
        await authorization.RequireAsync(context, permission, token);
        if (name == "node_pair_list")
            return new JsonObject { ["requests"] = nodes.ListPending() };
        var result = await nodes.ApproveAsync(
            Text(args, "pendingId", true)!,
            Text(args, "nodeId"),
            () =>
            {
                token.ThrowIfCancellationRequested();
                authorization.Require(context, permission);
            }
        );
        result.Remove("authToken");
        return result;
    }

    private async Task<JsonObject> DiscoverAsync(
        McpExternalContext context,
        JsonObject args,
        CancellationToken token
    )
    {
        Keys(args, "query", "sources", "nodeId", "server", "limit", "includeSchema");
        var query = Text(args, "query") ?? "";
        var nodeFilter = Text(args, "nodeId");
        var serverFilter = Text(args, "server");
        var limit = Integer(args, "limit", 1, 50) ?? 5;
        var includeSchema = Boolean(args, "includeSchema") ?? true;
        var sources = new[] { "mcp", "node", "builtin" };
        if (args.ContainsKey("sources"))
        {
            if (
                args["sources"] is not JsonArray list
                || list.Any(value => SessionWait.Text(value) is not ("mcp" or "node" or "builtin"))
            )
                throw new McpInboundSafeException("Invalid discovery arguments.");
            sources = list.Select(value => SessionWait.Text(value)!).ToArray();
            if (sources.Distinct().Count() != sources.Length)
                throw new McpInboundSafeException("Invalid discovery arguments.");
        }
        var collected =
            new List<(int Score, string Source, string Scope, string Name, JsonObject Tool)>();
        var totalKnown = true;
        void Add(string source, string scope, JsonObject tool)
        {
            var name = SessionWait.Text(tool["name"])!;
            var description = SessionWait.Text(tool["description"]) ?? "";
            var score = UnifiedTools.Score(query, name, description, scope);
            if (score < 0)
                return;
            var row = new JsonObject
            {
                ["toolId"] = source + ":" + (source == "builtin" ? "" : scope + "/") + name,
                ["source"] = source,
                ["name"] = name,
                ["description"] = description,
            };
            if (source != "builtin")
                row[source == "node" ? "nodeId" : "server"] = scope;
            if (includeSchema)
            {
                row["inputSchema"] = (tool["inputSchema"] ?? tool["parameters"])?.DeepClone();
                if (source == "mcp" && tool["annotations"] is not null)
                    row["annotations"] = tool["annotations"]!.DeepClone();
            }
            collected.Add((score, source, scope, name, row));
        }
        if (sources.Contains("builtin"))
            foreach (
                var definition in NodeToolDefinitions
                    .All()
                    .OfType<JsonObject>()
                    .Where(tool =>
                        SessionWait.Text(tool["name"]) is "node_pair_list" or "node_pair_approve"
                    )
            )
            {
                var name = SessionWait.Text(definition["name"])!;
                if (
                    authorization.Visible(
                        context,
                        authorization.Request(context, "builtin", name, new())
                    )
                )
                    Add("builtin", "", definition);
            }
        if (sources.Contains("mcp"))
            foreach (
                var server in mcp.ExternalServers()
                    .Where(server => string.IsNullOrEmpty(serverFilter) || server == serverFilter)
            )
            {
                token.ThrowIfCancellationRequested();
                try
                {
                    foreach (
                        var tool in await mcp.ListExternalToolsAsync(
                            context,
                            authorization,
                            server,
                            token
                        )
                    )
                        Add("mcp", server, tool);
                }
                catch (ToolAuthorizationUnavailableException)
                {
                    throw;
                }
                catch
                {
                    context.Require();
                    totalKnown = false;
                }
            }
        if (sources.Contains("node"))
            foreach (
                var tool in externalNodes
                    .Tools(context)
                    .Where(tool =>
                        string.IsNullOrEmpty(nodeFilter)
                        || SessionWait.Text(tool["nodeId"]) == nodeFilter
                    )
            )
                Add("node", SessionWait.Text(tool["nodeId"])!, tool);
        var comparer = StringComparer.Create(CultureInfo.GetCultureInfo("en-US"), false);
        var sorted = collected
            .OrderByDescending(item => item.Score)
            .ThenBy(item => item.Source, comparer)
            .ThenBy(item => item.Scope, comparer)
            .ThenBy(item => item.Name, comparer)
            .Take(limit);
        var tools = new JsonArray();
        var size = 256;
        var schemaOmitted = false;
        foreach (var item in sorted)
        {
            var tool = item.Tool;
            var cost = Encoding.UTF8.GetByteCount(tool.ToJsonString());
            if (cost + size > 512 * 1024 && includeSchema)
            {
                tool.Remove("inputSchema");
                tool.Remove("annotations");
                tool["schemaOmitted"] = true;
                schemaOmitted = true;
                cost = Encoding.UTF8.GetByteCount(tool.ToJsonString());
            }
            if (cost + size > 512 * 1024)
                break;
            tools.Add(tool);
            size += cost;
        }
        context.Require();
        var truncated = tools.Count < collected.Count;
        return new JsonObject
        {
            ["content"] = new JsonArray(
                new JsonObject
                {
                    ["type"] = "text",
                    ["text"] =
                        $"Showing {tools.Count} of {collected.Count} matching available tools{(totalKnown ? "" : " from reachable servers")}{(truncated ? " (truncated)" : "")}.",
                }
            ),
            ["structuredContent"] = new JsonObject
            {
                ["tools"] = tools,
                ["returned"] = tools.Count,
                ["total"] = collected.Count,
                ["totalKnown"] = totalKnown,
                ["truncated"] = truncated,
                ["schemaOmitted"] = schemaOmitted,
            },
        };
    }
}
