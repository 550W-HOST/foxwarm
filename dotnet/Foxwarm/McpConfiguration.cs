using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm;

internal sealed class McpConfiguration(string root)
{
    private readonly SemaphoreSlim mutation = new(1, 1);
    private readonly object gate = new();
    private JsonObject? live;
    private bool closed;

    private JsonObject Load()
    {
        lock (gate)
        {
            if (live is not null)
                return live;
            var file = Path.Combine(root, "state", "mcp.json");
            var payload = File.Exists(file)
                ? JsonNode.Parse(File.ReadAllText(file)) as JsonObject
                    ?? throw new InvalidDataException("Invalid MCP config payload.")
                : new JsonObject();
            var servers = payload["servers"] as JsonObject ?? new JsonObject();
            var loaded = new JsonObject();
            foreach (var (name, value) in servers)
                loaded[name] = Normalize(
                    value as JsonObject
                        ?? throw new InvalidDataException("Invalid MCP server config."),
                    managed: false
                );
            live = loaded;
            return live;
        }
    }

    internal JsonObject Snapshot()
    {
        lock (gate)
            return (JsonObject)Load().DeepClone();
    }

    internal JsonObject Get(string? name)
    {
        var servers = Snapshot();
        if (name is null)
            name = servers.ContainsKey("default") ? "default" : servers.FirstOrDefault().Key;
        if (string.IsNullOrEmpty(name) || servers[name] is not JsonObject config)
            throw new InvalidDataException("MCP server not configured: " + (name ?? "default"));
        if (
            config["enable"] is JsonValue enabled
            && enabled.TryGetValue<bool>(out var flag)
            && !flag
        )
            throw new InvalidDataException($"MCP server \"{name}\" is disabled.");
        return config;
    }

    internal async Task UpdateAsync(string name, JsonObject patch, bool enabledOnly,
        Action<JsonObject?, JsonObject>? published = null)
    {
        await mutation.WaitAsync();
        try
        {
            lock (gate)
                if (closed)
                    throw new InvalidOperationException("MCP configuration is shutting down.");
            var next = Snapshot();
            var previous = next[name] is JsonObject old ? (JsonObject)old.DeepClone() : null;
            if (enabledOnly && next[name] is null)
                throw new InvalidDataException("MCP server not found: " + name);
            var merged = next[name] as JsonObject ?? new JsonObject();
            foreach (var (key, value) in patch)
                merged[key] = value?.DeepClone();
            next[name] = Normalize(merged, managed: true);
            try
            {
                Persist(next);
            }
            catch (AuthorityCommittedException)
            {
                lock (gate)
                    live = next;
                published?.Invoke(previous, next[name]!.AsObject());
                throw;
            }
            lock (gate)
                live = next;
            published?.Invoke(previous, next[name]!.AsObject());
        }
        finally
        {
            mutation.Release();
        }
    }

    private void Persist(JsonObject servers)
    {
        new LinuxAtomicJsonFile(root, "state/mcp.json", privateFile: true)
            .WritePayload(new JsonObject { ["servers"] = servers.DeepClone() });
    }

    internal void Close()
    {
        lock (gate)
            closed = true;
    }

    internal static JsonObject Normalize(JsonObject raw, bool managed)
    {
        var config = (JsonObject)raw.DeepClone();
        foreach (
            var key in new[]
            {
                "url",
                "command",
                "cwd",
                "stderr",
                "token",
                "description",
                "transport",
                "type",
            }
        )
            if (config[key] is not null)
                _ = ToolRegistry.Text(config, key);
        if (
            config["args"] is not null
            && (
                config["args"] is not JsonArray array
                || array.Any(value => SessionWait.Text(value) is null)
            )
        )
            throw new InvalidDataException("MCP args must be a string array.");
        foreach (var key in new[] { "env", "headers" })
            if (
                config[key] is not null
                && (
                    config[key] is not JsonObject map
                    || map.Any(pair => SessionWait.Text(pair.Value) is null)
                )
            )
                throw new InvalidDataException("MCP " + key + " must contain string values.");
        if (
            config.ContainsKey("enable")
            && (config["enable"] is not JsonValue enabled || !enabled.TryGetValue<bool>(out _))
        )
            throw new InvalidDataException("MCP enable must be boolean.");
        if (config["timeoutSeconds"] is not null)
        {
            var timeout = SessionWait.Number(config["timeoutSeconds"]);
            if (
                timeout is null
                || !double.IsFinite(timeout.Value)
                || timeout != 0 && (timeout < 1 || timeout > 3600)
            )
                throw new InvalidDataException(
                    "MCP timeoutSeconds must be 0 to clear or between 1 and 3600."
                );
            if (timeout == 0)
                config.Remove("timeoutSeconds");
        }
        var transport =
            SessionWait.Text(config["transport"]) ?? SessionWait.Text(config["type"]) ?? "auto";
        if (transport is not ("auto" or "stdio" or "streamable-http" or "sse"))
            throw new InvalidDataException("Unsupported MCP transport: " + transport);
        config["transport"] = transport;
        config.Remove("type");
        if (
            config["stderr"] is not null
            && SessionWait.Text(config["stderr"]) is not ("inherit" or "pipe" or "ignore")
        )
            throw new InvalidDataException("MCP stderr must be inherit, pipe, or ignore.");
        if (
            managed
            && transport == "stdio"
            && string.IsNullOrEmpty(SessionWait.Text(config["command"]))
        )
            throw new InvalidDataException("MCP stdio requires command.");
        if (
            managed
            && transport != "stdio"
            && string.IsNullOrEmpty(SessionWait.Text(config["url"]))
        )
            throw new InvalidDataException("MCP HTTP transport requires url.");
        if (config["oauth"] is not null)
        {
            if (config["oauth"] is not JsonObject oauth
                || oauth.Any(pair => pair.Key is not ("scope" or "clientId" or "clientSecret")))
                throw new InvalidDataException("OAuth configuration accepts only scope and pre-registered client credentials.");
            var normalized = new JsonObject();
            foreach (var (key, value) in oauth)
            {
                var text = SessionWait.Text(value);
                if (text is null || text.Length > 8192 || text.IndexOfAny(['\r', '\n', '\0']) >= 0)
                    throw new InvalidDataException("OAuth fields must be bounded single-line strings.");
                if (text.Length > 0)
                    normalized[key] = text;
            }
            if (normalized["clientSecret"] is not null && normalized["clientId"] is null)
                throw new InvalidDataException("A client secret requires a pre-registered client ID.");
            if (transport == "stdio")
                throw new InvalidDataException("OAuth is available only for HTTP MCP servers.");
            _ = McpOAuthHttp.Endpoint(SessionWait.Text(config["url"]));
            if (!string.IsNullOrEmpty(SessionWait.Text(config["token"]))
                || config["headers"] is JsonObject headers && headers.Any(pair => pair.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidDataException("Configure OAuth or static Authorization, not both.");
            config["oauth"] = normalized;
        }
        else
            config.Remove("oauth");
        return config;
    }

    internal string Redact(string message, params JsonObject[] captured)
    {
        var configs = Snapshot().Select(pair => pair.Value).OfType<JsonObject>().Concat(captured);
        var secrets = configs
            .SelectMany(config =>
                new[] { config["token"], config["oauth"]?["clientSecret"] }
                    .Concat(config["args"] is JsonArray args ? args : [])
                    .Concat(config["env"] is JsonObject env ? env.Select(pair => pair.Value) : [])
                    .Concat(
                        config["headers"] is JsonObject headers
                            ? headers.Select(pair => pair.Value)
                            : []
                    )
            )
            .Select(SessionWait.Text)
            .Where(value => !string.IsNullOrEmpty(value));
        return secrets.Any(secret => message.Contains(secret!, StringComparison.Ordinal))
            ? "MCP operation failed because the underlying error contained configured secret data."
            : message;
    }
}
