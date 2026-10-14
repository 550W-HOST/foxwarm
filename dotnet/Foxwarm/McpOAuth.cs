using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

// Grants belong to this instance/server, not to an SDK transport or a Session owner.
internal sealed partial class McpOAuthService
{
    internal const string CallbackPath = "/api/mcp/oauth/callback";
    internal const string ClientPath = "/api/mcp/oauth/client.json";
    private readonly object gate = new();
    private readonly LinuxAtomicJsonFile store;
    private readonly string? publicBaseUrl;
    private readonly Func<string, JsonObject> getServer;
    private readonly Action<string> closeConnections;
    private readonly CancellationToken shutdown;
    private JsonObject? grants;
    private readonly Dictionary<string, long> epochs = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Flow> flows = new(StringComparer.Ordinal);
    private readonly HashSet<string> starting = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Renewal> refreshing = new(StringComparer.Ordinal);
    private readonly HashSet<Task> renewals = [];
    private readonly AsyncLocal<Operation?> operation = new();

    private sealed record Flow(string Server, JsonObject Config, long Epoch, long CreatedAt,
        string State, string Verifier, JsonObject Grant);
    private sealed record Renewal(long Epoch, TaskCompletionSource<JsonObject> Completion);
    private sealed class Operation
    {
        internal readonly HashSet<string> Values = new(StringComparer.Ordinal);
        internal bool Active = true;
    }

    internal McpOAuthService(string root, string? publicBaseUrl, Func<string, JsonObject> getServer,
        Action<string> closeConnections, CancellationToken shutdown,
        Action<AtomicJsonWriteStage>? writeStage = null)
    {
        store = new(root, "state/mcp-oauth.json", writeStage, privateFile: true);
        this.publicBaseUrl = publicBaseUrl;
        this.getServer = getServer;
        this.closeConnections = closeConnections;
        this.shutdown = shutdown;
    }

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private static string? Text(JsonNode? value) => SessionWait.Text(value);
    private static JsonObject Copy(JsonObject value) => (JsonObject)value.DeepClone();
    private static McpOAuthException Error(string code, string message) => new(code, message);
    internal static McpOAuthException SafeError(Exception error) => error as McpOAuthException
        ?? (error is AuthorityCommittedException
            ? Error("storage", "Authorization was saved, but final durability could not be confirmed. Check the instance data directory.")
            : Error("authorization", "OAuth could not be completed. Check the server connection and authorization settings."));

    internal string PublicUrl(string suffix)
    {
        if (string.IsNullOrEmpty(publicBaseUrl))
            throw Error("public-url", "Set url in Config to the public instance URL, then restart before authorizing.");
        try
        {
            var baseUri = McpOAuthHttp.Endpoint(publicBaseUrl);
            if (baseUri.Query.Length > 0)
                throw new UriFormatException();
            return baseUri.GetLeftPart(UriPartial.Path).TrimEnd('/') + suffix;
        }
        catch
        {
            throw Error("public-url", "Set url to an HTTPS public instance URL, then restart. Localhost HTTP is supported for development.");
        }
    }

    internal JsonObject ClientMetadata() => new()
    {
        ["client_id"] = PublicUrl(ClientPath),
        ["client_name"] = "Foxwarm",
        ["redirect_uris"] = new JsonArray(PublicUrl(CallbackPath)),
        ["grant_types"] = new JsonArray("authorization_code", "refresh_token"),
        ["response_types"] = new JsonArray("code"),
        ["token_endpoint_auth_method"] = "none",
        ["application_type"] = "web",
    };

    private JsonObject Load()
    {
        if (grants is not null)
            return grants;
        try
        {
            var raw = File.Exists(store.FilePath) ? JsonNode.Parse(File.ReadAllText(store.FilePath)) as JsonObject
                : new JsonObject { ["version"] = 1, ["servers"] = new JsonObject() };
            if (SessionWait.Number(raw?["version"]) != 1 || raw?["servers"] is not JsonObject servers)
                throw new InvalidDataException();
            grants = Copy(servers);
            return grants;
        }
        catch
        {
            throw Error("storage", "Authorization storage is unavailable. Check the instance data directory.");
        }
    }

    // All mutation/publication is under gate; a post-rename failure still publishes committed authority.
    private void Save(string name, JsonObject? grant)
    {
        var next = Copy(Load());
        if (grant is null)
            next.Remove(name);
        else
            next[name] = grant.DeepClone();
        try
        {
            store.WritePayload(new JsonObject { ["version"] = 1, ["servers"] = next.DeepClone() });
            grants = next;
        }
        catch (AuthorityCommittedException)
        {
            grants = next;
            throw;
        }
        catch
        {
            throw Error("storage", "Authorization could not be saved. Check the instance data directory.");
        }
    }

    private long Epoch(string name) => epochs.GetValueOrDefault(name);
    private static JsonObject Settings(JsonObject config)
    {
        var settings = new JsonObject();
        foreach (var key in new[] { "scope", "clientId" })
            if (config["oauth"]?[key] is not null)
                settings[key] = config["oauth"]![key]!.DeepClone();
        return settings;
    }
    private bool Matches(JsonObject? grant, JsonObject config) => grant is not null && config["oauth"] is JsonObject
        && Text(grant["serverUrl"]) == Text(config["url"])
        && Text(grant["publicBaseUrl"]) == publicBaseUrl
        && JsonNode.DeepEquals(grant["settings"], Settings(config));

    private void Current(string name, JsonObject config, long epoch)
    {
        JsonObject latest;
        try { latest = getServer(name); }
        catch { throw Error("changed", "The MCP authorization settings changed. Start authorization again."); }
        if (Epoch(name) != epoch || latest["enable"]?.GetValue<bool>() == false
            || latest["oauth"] is not JsonObject || Text(latest["url"]) != Text(config["url"])
            || !JsonNode.DeepEquals(latest["oauth"], config["oauth"]))
            throw Error("changed", "The MCP authorization settings changed. Start authorization again.");
        shutdown.ThrowIfCancellationRequested();
    }

    private void Prune()
    {
        foreach (var (state, flow) in flows.ToArray())
            if (Now - flow.CreatedAt > 10 * 60_000)
                flows.Remove(state);
    }
    private void ClearFlows(string name)
    {
        foreach (var (state, flow) in flows.ToArray())
            if (flow.Server == name)
                flows.Remove(state);
    }

    internal JsonObject Status(string name, JsonObject config)
    {
        lock (gate)
        {
            Prune();
            var candidate = Load()[name] as JsonObject;
            var grant = Matches(candidate, config) ? candidate : null;
            var pending = flows.Values.Any(flow => flow.Server == name);
            var state = pending ? "authorizing"
                : grant?["error"] is not null || grant?["requiredScope"] is not null ? "needs-authorization"
                : grant?["tokens"] is not JsonObject ? "not-authorized"
                : SessionWait.Number(grant["expiresAt"]) is { } expires && expires <= Now && grant["tokens"]?["refresh_token"] is null ? "expired"
                : "authorized";
            var result = new JsonObject { ["state"] = state,
                ["hasClientSecret"] = config["oauth"]?["clientSecret"] is not null };
            var scope = UnionScopes(Text(config["oauth"]?["scope"]), Text(grant?["requiredScope"]));
            if (scope is not null) result["requestedScope"] = scope;
            if (grant?["tokens"]?["scope"] is not null) result["grantedScope"] = grant["tokens"]!["scope"]!.DeepClone();
            foreach (var key in new[] { "expiresAt", "error" })
                if (grant?[key] is not null) result[key] = grant[key]!.DeepClone();
            if (config["oauth"]?["clientId"] is not null) result["clientId"] = config["oauth"]!["clientId"]!.DeepClone();
            return result;
        }
    }

    internal void ConfigurationChanged(string name, bool clearGrant)
    {
        try
        {
            lock (gate)
            {
                epochs[name] = Epoch(name) + 1;
                ClearFlows(name);
                if (clearGrant) Save(name, null);
            }
        }
        finally { closeConnections(name); }
    }

    internal void Disconnect(string name)
    {
        try
        {
            lock (gate)
            {
                epochs[name] = Epoch(name) + 1;
                ClearFlows(name);
                var grant = Load()[name] as JsonObject;
                if (grant is not null)
                {
                    var next = Copy(grant);
                    foreach (var key in new[] { "tokens", "expiresAt", "requiredScope", "error" }) next.Remove(key);
                    Save(name, next);
                }
            }
        }
        finally { closeConnections(name); }
    }

    private static string? SafeScope(string? scope) => scope is not null && scope.Length <= 8192 && scope.IndexOfAny(['\r', '\n', '\0']) < 0 ? scope : null;
    private static string? UnionScopes(params string?[] scopes)
    {
        var combined = string.Join(" ", scopes.Where(value => value is not null)
            .SelectMany(value => value!.Split(' ', StringSplitOptions.RemoveEmptyEntries)).Distinct(StringComparer.Ordinal));
        return combined.Length > 0 ? combined : null;
    }

    internal string[] Credentials()
    {
        lock (gate)
        {
            var values = Load().SelectMany(pair => pair.Value is JsonObject grant
                ? new[] { Text(grant["tokens"]?["access_token"]), Text(grant["tokens"]?["refresh_token"]), Text(grant["clientInformation"]?["client_secret"]) }
                : []).Where(value => !string.IsNullOrEmpty(value)).Select(value => value!).ToList();
            if (operation.Value is { } active)
                lock (active)
                    if (active.Active) values.AddRange(active.Values);
            return values.Distinct(StringComparer.Ordinal).ToArray();
        }
    }

    private void Remember(params string?[] values)
    {
        if (operation.Value is not { } active) return;
        lock (active)
            if (active.Active)
                foreach (var value in values)
                    if (!string.IsNullOrEmpty(value)) active.Values.Add(value);
    }

    internal static bool ContainsCredential(JsonNode? value, string[] secrets)
    {
        var pending = new Stack<JsonNode?>();
        pending.Push(value);
        while (pending.TryPop(out var item))
        {
            if (item is JsonValue scalar && scalar.TryGetValue<string>(out var text)
                && secrets.Any(secret => text.Contains(secret, StringComparison.Ordinal))) return true;
            if (item is JsonArray array)
                foreach (var child in array) pending.Push(child);
            if (item is JsonObject obj)
            {
                var mime = Text(obj["mimeType"]);
                var media = Text(obj["type"]) is "image" or "audio" || mime?.StartsWith("image/") == true || mime?.StartsWith("audio/") == true;
                foreach (var (key, child) in obj)
                {
                    if (media && key is "data" or "blob") continue;
                    if (secrets.Any(secret => key.Contains(secret, StringComparison.Ordinal))) return true;
                    pending.Push(child);
                }
            }
        }
        return false;
    }

    internal async Task<T> GuardAsync<T>(JsonObject config, Func<Task<T>> run)
    {
        var active = new Operation();
        var previous = operation.Value;
        operation.Value = active;
        Remember(Text(config["oauth"]?["clientSecret"]));
        Remember(Credentials());
        try
        {
            var result = await run();
            var value = result switch
            {
                JsonNode node => node,
                IReadOnlyList<JsonObject> list => new JsonArray(list.Select(item => (JsonNode?)item.DeepClone()).ToArray()),
                _ => null,
            };
            if (ContainsCredential(value, Credentials()))
                throw Error("output", "The MCP operation may have completed, but its output contained OAuth credentials and was withheld. Do not retry automatically.");
            return result;
        }
        catch (Exception error)
        {
            if (Credentials().Any(secret => error.Message.Contains(secret, StringComparison.Ordinal)))
                throw Error("output", "The MCP operation failed with private credential data. Its outcome may be unknown; do not retry automatically.");
            throw;
        }
        finally
        {
            lock (active) { active.Active = false; active.Values.Clear(); }
            operation.Value = previous;
        }
    }
}
