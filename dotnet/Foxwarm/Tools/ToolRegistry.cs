using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed record ResolvedTool(string InvocationName, string Source, string Name, JsonObject Args, string? Server = null, string ExecutionNode = "master");
internal sealed record RegisteredTool(JsonObject Definition, string Source, bool DefaultInject, Func<SessionToolExecutor, JsonObject, CancellationToken, Task<JsonObject>> Execute);

internal sealed class ToolRegistry(Foxwarm.McpClient mcp, Func<SessionOwner, string> workspace)
{
    private readonly Dictionary<string, RegisteredTool> entries = new(StringComparer.Ordinal);
    internal Foxwarm.McpClient Mcp => mcp;
    internal IEnumerable<RegisteredTool> Entries => entries.Values;
    internal void Register(JsonObject definition, string source, bool inject, Func<SessionToolExecutor, JsonObject, CancellationToken, Task<JsonObject>> handler)
    {
        var name = SessionWait.Text(definition["name"]) ?? throw new InvalidDataException("Tool definition requires a name.");
        entries.Add(name, new((JsonObject)definition.DeepClone(), source, inject, handler));
    }
    internal JsonArray ModelDefinitions() => new(entries.Values.Where(entry => entry.DefaultInject).Select(entry => (JsonNode?)ToolCallControls.ForModel(entry.Definition)).ToArray());
    internal ResolvedTool Resolve(string invocation, JsonObject args)
    {
        if (invocation != "call_tool")
        {
            if (!entries.TryGetValue(invocation, out var direct)) throw new InvalidDataException("Unknown tool: " + invocation);
            return new(invocation, direct.Source, invocation, (JsonObject)args.DeepClone());
        }
        Keys(args, ["toolId", "source", "name", "server", "nodeId", "args", "argsJson"]);
        var source = Text(args, "source")?.Trim(); var name = Text(args, "name"); var server = Text(args, "server"); var node = Text(args, "nodeId");
        if (Text(args, "toolId") is string id && id.Length > 0)
        {
            if (id.StartsWith("builtin:", StringComparison.Ordinal)) { source = "builtin"; name = id[8..].Trim(); }
            else if (id.StartsWith("node:", StringComparison.Ordinal) || id.StartsWith("mcp:", StringComparison.Ordinal))
            {
                source = id[..id.IndexOf(':')]; var rest = id[(source.Length + 1)..]; var slash = rest.IndexOf('/');
                if (slash <= 0 || slash == rest.Length - 1) throw new InvalidDataException("Invalid toolId: " + id);
                name = rest[(slash + 1)..]; if (source == "mcp") server = rest[..slash]; else node = rest[..slash];
            }
            else throw new InvalidDataException("Unsupported toolId source: " + id);
        }
        if (source is not ("builtin" or "node" or "mcp") || string.IsNullOrEmpty(name)) throw new InvalidDataException("call_tool requires either toolId or a valid source and tool name.");
        var targetArgs = ObjectArg(args, "args", "argsJson", required: true)!;
        if (source == "mcp")
        {
            if (string.IsNullOrEmpty(server)) throw new InvalidDataException("MCP calls require an explicit server.");
            return new(invocation, source, name, targetArgs, server);
        }
        if (name == "call_tool") throw new InvalidDataException("Tool `call_tool` is a dispatcher/container, not a concrete builtin capability.");
        if (!entries.TryGetValue(name, out var registration)) throw new InvalidDataException("Unknown tool: " + name);
        if (registration.Source != source) throw new InvalidDataException($"Tool `{name}` is a {registration.Source} capability, not {source}.");
        if (source == "node") LocalNode(node);
        else if (node is not null) throw new InvalidDataException("Builtin tools do not support Node selection.");
        return new(invocation, source, name, targetArgs);
    }
    internal async Task<JsonObject> ExecuteAsync(ResolvedTool resolved, SessionToolExecutor owner, CancellationToken cancellationToken)
    {
        await owner.AuthorizeAsync(resolved, cancellationToken);
        var result = resolved.Source == "mcp"
            ? await mcp.CallAsync(resolved.Server!, resolved.Name, resolved.Args, cancellationToken)
            : await entries[resolved.Name].Execute(owner, resolved.Args, cancellationToken);
        return await ToolOutputGuard.GuardAsync(result, workspace(owner.Hosted), owner.CurrentCallId);
    }
    internal static void LocalNode(string? node)
    {
        if (node is null || string.IsNullOrWhiteSpace(node) || node.Trim().Equals("current", StringComparison.OrdinalIgnoreCase) || node.Trim() == "master") return;
        throw new InvalidDataException("Node is not available: " + node);
    }
    internal static void Keys(JsonObject args, IEnumerable<string> allowed)
    { if (args.Any(pair => !allowed.Contains(pair.Key, StringComparer.Ordinal))) throw new InvalidDataException("Unsupported tool argument."); }
    internal static string? Text(JsonObject args, string key) => args[key] is null ? null : SessionWait.Text(args[key]) ?? throw new InvalidDataException(key + " must be a string.");
    internal static JsonObject? ObjectArg(JsonObject args, string key, string fallback, bool required = false)
    {
        if (args[key] is JsonObject primary) return (JsonObject)primary.DeepClone();
        if (args.ContainsKey(fallback))
        {
            var value = JsonNode.Parse(Text(args, fallback) ?? throw new InvalidDataException(fallback + " must be a JSON object string."));
            return value is JsonObject obj ? obj : throw new InvalidDataException(fallback + " must parse as a JSON object.");
        }
        if (args.ContainsKey(key) || required) throw new InvalidDataException(key + " must be a JSON object, or provide " + fallback + ".");
        return null;
    }
}
