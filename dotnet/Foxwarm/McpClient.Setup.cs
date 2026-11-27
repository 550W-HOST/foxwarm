using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using ModelContextProtocol.Protocol;

namespace Foxwarm;

// Setup > MCP: last observed connection outcomes, an administrator connection check, and whole
// server replacement or removal with literal credentials kept out of the browser.
internal sealed partial class McpClient
{
    // The last connection outcome of a server, from a Session's discovery or a Setup check.
    // Process memory only; a committed change of the server forgets it.
    private sealed record Observation(long At, bool Ok, string? Error, int? ToolCount);

    private readonly object observationGate = new();
    private readonly Dictionary<string, Observation> observations = new(StringComparer.Ordinal);

    internal static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(20);

    // Fields of a server definition that the Setup form owns. Other stored fields (`oauth`
    // settings and anything unknown) are kept as they are.
    internal static readonly string[] SetupFields =
    [
        "transport",
        "url",
        "command",
        "args",
        "env",
        "cwd",
        "headers",
        "token",
        "timeoutSeconds",
        "enable",
    ];

    // revision is the stored definition the outcome was obtained with; an outcome of a
    // definition that has since changed is dropped.
    private void RecordObservation(
        string server,
        string revision,
        bool ok,
        string? error,
        int? toolCount
    )
    {
        lock (observationGate)
            if (Revision(configuration.Snapshot()[server]) == revision)
                observations[server] = new(
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ok,
                error,
                toolCount
            );
    }

    private void ForgetObservation(string server)
    {
        lock (observationGate)
            observations.Remove(server);
    }

    internal JsonObject? Observed(string server)
    {
        Observation? observed;
        lock (observationGate)
            observed = observations.GetValueOrDefault(server);
        if (observed is null)
            return null;
        var result = new JsonObject { ["at"] = observed.At, ["ok"] = observed.Ok };
        if (observed.Error is not null)
            result["error"] = observed.Error;
        if (observed.ToolCount is not null)
            result["toolCount"] = observed.ToolCount;
        return result;
    }

    // The revision of one stored server definition: SHA-256 of its stored JSON, or `absent`.
    internal static string Revision(JsonNode? server) =>
        server is null
            ? "absent"
            : "sha256:"
                + Convert.ToHexStringLower(
                    SHA256.HashData(Encoding.UTF8.GetBytes(server.ToJsonString()))
                );

    // A literal credential the form keeps without seeing: `{hidden: field}` plus the header or
    // environment key, or the argument index, where it is stored.
    private static JsonObject Hidden(string field, string? key = null, int? index = null)
    {
        var hidden = new JsonObject { ["hidden"] = field };
        if (key is not null)
            hidden["key"] = key;
        if (index is not null)
            hidden["index"] = index;
        return hidden;
    }

    private static bool HasLiteral(JsonObject document) =>
        InstanceSecrets.Literals(SecretSinks.McpServer, document, path => path).Any();

    // The server definition the Setup form edits: every value as stored, except literal
    // credentials (by the redactor's own classification of mcp.json fields), which become
    // placeholders. `${secret:NAME}` references are shown. OAuth settings are reduced to what
    // the tab displays; saves keep the stored block.
    internal static JsonObject SetupView(JsonObject stored)
    {
        var view = new JsonObject();
        foreach (var field in SetupFields)
            if (stored[field] is { } value)
                view[field] = value.DeepClone();
        foreach (var field in new[] { "token", "url" })
            if (
                SessionWait.Text(view[field]) is string text
                && HasLiteral(new JsonObject { [field] = text })
            )
                view[field] = Hidden(field);
        foreach (var field in new[] { "headers", "env" })
            if (view[field] is JsonObject map)
                foreach (var (key, value) in map.ToArray())
                {
                    var single = new JsonObject { [key] = value?.DeepClone() };
                    if (HasLiteral(new JsonObject { [field] = single }))
                        map[key] = Hidden(field, key);
                }
        if (view["args"] is JsonArray args)
            foreach (
                var secret in InstanceSecrets.Literals(
                    SecretSinks.McpServer,
                    new JsonObject { ["args"] = args.DeepClone() },
                    path => path
                )
            )
                if (
                    secret.Label.StartsWith("args[", StringComparison.Ordinal)
                    && int.TryParse(secret.Label[5..^1], out var index)
                    && index < args.Count
                    && args[index] is JsonValue
                )
                    args[index] = Hidden("args", index: index);
        if (stored["oauth"] is JsonObject oauth)
        {
            var shown = new JsonObject
            {
                ["hasClientSecret"] = oauth["clientSecret"] is not null,
            };
            foreach (var key in new[] { "scope", "clientId" })
                if (oauth[key] is not null)
                    shown[key] = oauth[key]!.DeepClone();
            view["oauth"] = shown;
        }
        return view;
    }

    // The complete definition a Setup save installs: the submitted form fields with each
    // placeholder replaced by the value stored at its original location, plus the stored
    // fields the form doesn't own. A placeholder stays in its own field: a hidden header can
    // only become a header value, a hidden argument an argument.
    internal static JsonObject FromSetupView(JsonObject submitted, JsonObject? stored)
    {
        foreach (var (key, _) in submitted)
            if (key != "oauth" && !SetupFields.Contains(key, StringComparer.Ordinal))
                throw new InvalidDataException("Unsupported MCP server field: " + key);
        var definition = new JsonObject();
        foreach (var (key, value) in stored ?? [])
            if (!SetupFields.Contains(key, StringComparer.Ordinal))
                definition[key] = value?.DeepClone();
        JsonNode Restore(JsonNode? value, string field)
        {
            if (value is not JsonObject hidden || hidden["hidden"] is null)
                return value?.DeepClone()!;
            if (SessionWait.Text(hidden["hidden"]) != field)
                throw new InvalidDataException("A hidden value can only stay in its own field.");
            var original = field switch
            {
                "headers" or "env" => SessionWait.Text(hidden["key"]) is string key
                    ? stored?[field]?[key]
                    : null,
                "args" => SessionWait.Number(hidden["index"]) is double index
                    && stored?["args"] is JsonArray list
                    && index >= 0
                    && index < list.Count
                    && index == Math.Floor(index)
                    ? list[(int)index]
                    : null,
                _ => stored?[field],
            };
            return original is JsonValue text && text.TryGetValue<string>(out _)
                ? original.DeepClone()
                : throw new InvalidDataException(
                    "A hidden value is no longer saved. Reload, then enter it again."
                );
        }
        foreach (var field in SetupFields)
        {
            if (!submitted.TryGetPropertyValue(field, out var value) || value is null)
                continue;
            definition[field] = field switch
            {
                "token" or "url" => Restore(value, field),
                "headers" or "env" when value is JsonObject map => new JsonObject(
                    map.Select(pair => new KeyValuePair<string, JsonNode?>(
                        pair.Key,
                        Restore(pair.Value, field)
                    ))
                ),
                "args" when value is JsonArray list => new JsonArray(
                    list.Select(item => (JsonNode?)Restore(item, "args")).ToArray()
                ),
                _ => value.DeepClone(),
            };
        }
        return definition;
    }

    // Replaces or adds one server through the managed configuration lane. definition receives
    // the stored server inside the lane, so it can check the revision the edit started from
    // and restore hidden values from exactly that definition.
    internal Task ReplaceServerAsync(string name, Func<JsonObject?, JsonObject> definition) =>
        configuration.ReplaceAsync(
            name,
            definition,
            (previous, next) => Published(name, previous, next)
        );

    // Removes one server; its stored OAuth record (tokens and registration) goes with it.
    internal Task RemoveServerAsync(string name, Action<JsonObject?> check) =>
        configuration.RemoveAsync(
            name,
            check,
            _ =>
            {
                try
                {
                    OAuth.ConfigurationChanged(name, clearGrant: true);
                }
                finally
                {
                    ForgetObservation(name);
                    InvalidateServer(name);
                }
            }
        );

    // One bounded administrator check of an enabled server: a connection of its own, never
    // pooled or reused by Sessions and without notification reception, that lists the
    // server's tools and closes. The outcome becomes the server's last observation.
    internal Task<JsonObject> ProbeAsync(string name, CancellationToken cancellationToken) =>
        RunAsync(
            async token =>
            {
                var stored =
                    configuration.Snapshot()[name] as JsonObject
                    ?? throw new InvalidDataException("MCP server not found: " + name);
                if (stored["enable"] is JsonValue enabled && !enabled.GetValue<bool>())
                    throw new InvalidDataException($"MCP server \"{name}\" is disabled.");
                var revision = Revision(stored);
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
                budget.CancelAfter(ProbeTimeout);
                JsonObject? config = null;
                try
                {
                    config = configuration.Get(name);
                    var count = await ProbeToolsAsync(name, config, budget.Token);
                    RecordObservation(name, revision, true, null, count);
                }
                catch (OperationCanceledException) when (!token.IsCancellationRequested)
                {
                    RecordObservation(
                        name,
                        revision,
                        false,
                        $"The server didn't respond within {ProbeTimeout.TotalSeconds:0} seconds.",
                        null
                    );
                }
                catch (Exception error) when (!token.IsCancellationRequested)
                {
                    var safe = SafeError(error.Message, config ?? stored);
                    RecordObservation(name, revision, false, safe, null);
                }
                return Observed(name)
                    ?? throw new InvalidOperationException(
                        "The server changed while it was checked."
                    );
            },
            cancellationToken
        );

    private async Task<int> ProbeToolsAsync(string name, JsonObject config, CancellationToken token)
    {
        var entry = new PoolEntry(new ConnectionKey(name, null, 0, null), config, token);
        try
        {
            var connection = await OAuth.GuardAsync(
                config,
                () => ConnectAsync(name, config, entry.Token, entry)
            );
            await using (connection)
            {
                var count = 0;
                string? cursor = null;
                do
                {
                    var page = await connection.Client.ListToolsAsync(
                        new ListToolsRequestParams { Cursor = cursor },
                        entry.Token
                    );
                    count += page.Tools.Count;
                    cursor = page.NextCursor;
                } while (cursor is not null);
                return count;
            }
        }
        finally
        {
            // The entry was never pooled; closing it releases its lifetime like any other.
            entry.Connected.TrySetCanceled();
            lock (poolGate)
                InvalidateEntry(entry);
        }
    }
}
