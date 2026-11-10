using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm;

internal sealed class McpConfiguration(string root, string? configPath = null)
{
    private readonly SemaphoreSlim mutation = new(1, 1);
    private readonly object gate = new();
    private JsonObject? live;
    private bool closed;

    // Resolves `${secret:NAME}` in credential fields of definitions handed to connections.
    // Snapshot and summaries keep the reference text.
    internal Func<string, string?>? SecretLookup { get; set; }

    internal string FilePath => configPath ?? Path.Combine(root, "state", "mcp.json");

    private JsonObject Load()
    {
        lock (gate)
        {
            if (live is not null)
                return live;
            var file = configPath ?? Path.Combine(root, "state", "mcp.json");
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
        return ResolveSecrets(name, config);
    }

    // Only connection owners call Get; the resolved copy never reaches summaries or tools.
    private JsonObject ResolveSecrets(string name, JsonObject config)
    {
        var names = Foxwarm.Secrets.SecretReferences.ReferencedNames(config);
        if (names.Count == 0)
            return config;
        if (SecretLookup is not { } lookup)
            throw Foxwarm.Secrets.SecretUnavailableException.For("MCP server " + name, names);
        var missing = new List<string>();
        var resolved = Foxwarm.Secrets.SecretReferences.Resolve(
            config,
            Foxwarm.Secrets.SecretSinks.McpServer,
            "MCP server " + name,
            lookup,
            missing
        );
        if (missing.Count > 0)
            throw Foxwarm.Secrets.SecretUnavailableException.For("MCP server " + name, missing);
        return resolved;
    }

    // admit sees every server before and after the update, inside this lane, and may refuse it.
    internal async Task UpdateAsync(
        string name,
        JsonObject patch,
        bool enabledOnly,
        Action<JsonObject?, JsonObject>? published = null,
        Func<JsonObject, JsonObject, Task>? admit = null
    )
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
            if (admit is not null)
                await admit(Snapshot(), (JsonObject)next.DeepClone());
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
        new LinuxAtomicJsonFile(
            Path.GetDirectoryName(configPath ?? Path.Combine(root, "state", "mcp.json"))!,
            Path.GetFileName(configPath ?? "mcp.json"),
            privateFile: true
        ).WritePayload(new JsonObject { ["servers"] = servers.DeepClone() });
    }

    internal void Close()
    {
        lock (gate)
            closed = true;
    }

    internal static JsonObject Normalize(JsonObject raw, bool managed)
    {
        var config = (JsonObject)raw.DeepClone();
        Foxwarm.Secrets.SecretReferences.Validate(
            config,
            Foxwarm.Secrets.SecretSinks.McpServer,
            "MCP server"
        );
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
            if (
                config["oauth"] is not JsonObject oauth
                || oauth.Any(pair => pair.Key is not ("scope" or "clientId" or "clientSecret"))
            )
                throw new InvalidDataException(
                    "OAuth configuration accepts only scope and pre-registered client credentials."
                );
            var normalized = new JsonObject();
            foreach (var (key, value) in oauth)
            {
                var text = SessionWait.Text(value);
                if (text is null || text.Length > 8192 || text.IndexOfAny(['\r', '\n', '\0']) >= 0)
                    throw new InvalidDataException(
                        "OAuth fields must be bounded single-line strings."
                    );
                if (text.Length > 0)
                    normalized[key] = text;
            }
            if (normalized["clientSecret"] is not null && normalized["clientId"] is null)
                throw new InvalidDataException(
                    "A client secret requires a pre-registered client ID."
                );
            if (transport == "stdio")
                throw new InvalidDataException("OAuth is available only for HTTP MCP servers.");
            _ = McpOAuthHttp.Endpoint(SessionWait.Text(config["url"]));
            if (
                !string.IsNullOrEmpty(SessionWait.Text(config["token"]))
                || config["headers"] is JsonObject headers
                    && headers.Any(pair =>
                        pair.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase)
                    )
            )
                throw new InvalidDataException(
                    "Configure OAuth or static Authorization, not both."
                );
            config["oauth"] = normalized;
        }
        else
            config.Remove("oauth");
        return config;
    }

    internal string Redact(string message, params JsonObject[] captured)
    {
        var configs = Snapshot()
            .Select(pair => pair.Value)
            .OfType<JsonObject>()
            .Concat(captured)
            .ToArray();
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
                    .Select(SessionWait.Text)
            )
            .Where(value => !string.IsNullOrEmpty(value));
        var urlSecrets = configs.SelectMany(config => UrlSecrets(SessionWait.Text(config["url"])));
        var normalizedMessage = NormalizeUrlEscapes(message);
        return
            secrets.Any(secret => message.Contains(secret!, StringComparison.Ordinal))
            || urlSecrets.Any(secret =>
                normalizedMessage.Contains(NormalizeUrlEscapes(secret), StringComparison.Ordinal)
            )
            ? "MCP operation failed because the underlying error contained configured secret data."
            : message;
    }

    private static string NormalizeUrlEscapes(string value)
    {
        var normalized = new StringBuilder(value.Length);
        for (var i = 0; i < value.Length; i++)
        {
            if (
                value[i] == '%'
                && i + 2 < value.Length
                && Uri.IsHexDigit(value[i + 1])
                && Uri.IsHexDigit(value[i + 2])
            )
            {
                normalized.Append('%');
                normalized.Append(char.ToUpperInvariant(value[++i]));
                normalized.Append(char.ToUpperInvariant(value[++i]));
            }
            else
                normalized.Append(value[i]);
        }
        return normalized.ToString();
    }

    // The URL parts that server summaries redact: user info, each query value (or
    // bare query item) and the fragment, raw and unescaped. An unparseable URL is
    // treated as secret as a whole.
    private static IEnumerable<string> UrlSecrets(string? url)
    {
        if (string.IsNullOrEmpty(url))
            return [];
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return [url];
        var hash = url.IndexOf('#');
        var fragment = hash >= 0 ? url[(hash + 1)..] : "";
        var beforeFragment = hash >= 0 ? url[..hash] : url;
        var mark = beforeFragment.IndexOf('?');
        var query = mark >= 0 ? beforeFragment[(mark + 1)..] : "";
        // Uri.UserInfo normalizes escapes for unreserved characters, so also retain
        // the original authority spelling for diagnostics that quote the input URL.
        var start = url.IndexOf("://", StringComparison.Ordinal);
        var rawUserInfo = "";
        if (start >= 0)
        {
            start += 3;
            var end = url.IndexOfAny(['/', '\\', '?', '#'], start);
            if (end < 0)
                end = url.Length;
            if (end > start)
            {
                var at = url.LastIndexOf('@', end - 1, end - start);
                if (at >= start)
                    rawUserInfo = url[start..at];
            }
        }
        static IEnumerable<string> UserInfoParts(string userInfo)
        {
            var separator = userInfo.IndexOf(':');
            yield return userInfo;
            if (separator >= 0 && separator < userInfo.Length - 1)
                yield return userInfo[(separator + 1)..];
            else if (separator >= 0)
                yield return userInfo[..separator];
        }
        var parts = query
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(part => part.IndexOf('=') is var equals and > 0 ? part[(equals + 1)..] : part)
            .Concat(UserInfoParts(rawUserInfo))
            .Concat(UserInfoParts(uri.UserInfo))
            .Append(fragment)
            .Where(part => part.Length > 0)
            .ToArray();
        return parts.Concat(parts.Select(Uri.UnescapeDataString)).Distinct(StringComparer.Ordinal);
    }
}
