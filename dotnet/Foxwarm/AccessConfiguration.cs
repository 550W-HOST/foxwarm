using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm;

internal sealed record AccessIdentity(
    string Token,
    ImmutableArray<string> Sessions,
    bool WebUi,
    bool Mcp
);

internal sealed record AccessChange(
    ImmutableDictionary<string, AccessIdentity> Previous,
    ImmutableDictionary<string, AccessIdentity> Current,
    IReadOnlySet<string> WebUi
);

// Main owns one normalized snapshot. Captured browser authority is checked against live values,
// not reference equality: edits to another surface must not reset an existing browser.
internal sealed class AccessConfiguration
{
    private ImmutableDictionary<string, AccessIdentity> snapshot;
    private string reservedToken = "";
    internal ImmutableDictionary<string, AccessIdentity> Snapshot => Volatile.Read(ref snapshot);
    internal event Func<AccessChange, Task>? Changed;

    internal AccessConfiguration(JsonObject app) =>
        snapshot = Normalize(app["access"], app.ContainsKey("access"));

    internal static ImmutableDictionary<string, AccessIdentity> Normalize(
        JsonNode? value,
        bool present = true
    )
    {
        var result = ImmutableDictionary.CreateBuilder<string, AccessIdentity>(
            StringComparer.Ordinal
        );
        if (!present)
            return result.ToImmutable();
        if (value is not JsonObject access)
            throw new InvalidDataException("access must be a YAML object.");
        Keys(access, "access", "identities");
        if (!access.ContainsKey("identities"))
            return result.ToImmutable();
        if (access["identities"] is not JsonObject identities)
            throw new InvalidDataException("access.identities must be a YAML object.");
        if (identities.Count > 64)
            throw new InvalidDataException("access.identities exceeds 64 entries.");
        var tokens = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (id, raw) in identities)
        {
            if (!Regex.IsMatch(id, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))
                throw new InvalidDataException("access identity ID is invalid.");
            if (raw is not JsonObject identity)
                throw new InvalidDataException(
                    "access identity must contain only token and surfaces."
                );
            Keys(identity, "access identity", "token", "surfaces");
            var token = Text(identity["token"]);
            if (
                token is null
                || Encoding.UTF8.GetByteCount(token) > 4096
                || !Regex.IsMatch(token, "^[A-Za-z0-9._~+/-]+={0,2}$")
            )
                throw new InvalidDataException(
                    "access identity token must be a non-empty bounded Bearer token string."
                );
            if (!tokens.Add(token))
                throw new InvalidDataException("access identities must use distinct tokens.");
            if (identity["surfaces"] is not JsonObject surfaces)
                throw new InvalidDataException("access identity surfaces must be a YAML object.");
            Keys(surfaces, "access identity surfaces", "webui", "mcp");
            if (surfaces.Count == 0)
                throw new InvalidDataException("access identity must enable at least one surface.");
            var sessions = ImmutableArray<string>.Empty;
            if (surfaces.ContainsKey("webui"))
            {
                if (surfaces["webui"] is not JsonObject webui)
                    throw new InvalidDataException(
                        "access identity surfaces.webui must contain only sessions."
                    );
                Keys(webui, "access identity surfaces.webui", "sessions");
                if (webui["sessions"] is not JsonArray list || list.Count is < 1 or > 256)
                    throw new InvalidDataException(
                        "access identity webui.sessions must be a non-empty array of Session IDs."
                    );
                var bindings = new List<string>();
                foreach (var item in list)
                {
                    var binding = Text(item);
                    if (
                        string.IsNullOrWhiteSpace(binding)
                        || binding.Length > 512
                        || binding.Contains('*') && ScopeAgent(binding) is null
                    )
                        throw new InvalidDataException(
                            "access identity webui.sessions contains an invalid Session ID."
                        );
                    if (bindings.Contains(binding, StringComparer.Ordinal))
                        throw new InvalidDataException(
                            "access identity webui.sessions must contain distinct Session IDs."
                        );
                    bindings.Add(binding);
                }
                sessions = bindings.ToImmutableArray();
            }
            if (
                surfaces.ContainsKey("mcp")
                && (surfaces["mcp"] is not JsonObject mcp || mcp.Count != 0)
            )
                throw new InvalidDataException(
                    "access identity surfaces.mcp must be an empty object."
                );
            result[id] = new(
                token,
                sessions,
                surfaces.ContainsKey("webui"),
                surfaces.ContainsKey("mcp")
            );
        }
        return result.ToImmutable();
    }

    private static void Keys(JsonObject value, string name, params string[] keys)
    {
        if (value.Any(pair => !keys.Contains(pair.Key, StringComparer.Ordinal)))
            throw new InvalidDataException(name + " contains an unsupported field.");
    }

    private static string? Text(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    internal static string? ScopeAgent(string binding) =>
        Regex.Match(binding, "^([A-Za-z0-9_-]+)/\\*$") is { Success: true } match
            ? match.Groups[1].Value
            : null;

    internal static bool Equal(string left, string right) =>
        CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(left)),
            SHA256.HashData(Encoding.UTF8.GetBytes(right))
        );

    internal void ReserveInstanceToken(string token)
    {
        Validate(Snapshot, token);
        reservedToken = token;
    }

    internal void Validate(ImmutableDictionary<string, AccessIdentity> next) =>
        Validate(next, reservedToken);

    private static void Validate(ImmutableDictionary<string, AccessIdentity> next, string reserved)
    {
        if (reserved.Length > 0 && next.Values.Any(identity => Equal(identity.Token, reserved)))
            throw new InvalidDataException(
                "access identity tokens must not reuse the instance superuser token."
            );
    }

    internal (string Id, AccessIdentity Identity)? Authenticate(string? token)
    {
        if (string.IsNullOrEmpty(token))
            return null;
        (string, AccessIdentity)? matched = null;
        foreach (var (id, identity) in Snapshot)
            if (identity.WebUi && Equal(token, identity.Token))
                matched = (id, identity);
        return matched;
    }

    internal bool Current(string id, AccessIdentity original) =>
        Snapshot.TryGetValue(id, out var next) && SameWebUi(original, next);

    private static bool SameWebUi(AccessIdentity old, AccessIdentity next) =>
        next.WebUi && old.Token == next.Token && old.Sessions.SequenceEqual(next.Sessions);

    internal async Task ApplyAsync(ImmutableDictionary<string, AccessIdentity> next)
    {
        Validate(next);
        var previous = Snapshot;
        var affected = previous
            .Where(pair =>
                pair.Value.WebUi
                && (!next.TryGetValue(pair.Key, out var current) || !SameWebUi(pair.Value, current))
            )
            .Select(pair => pair.Key)
            .ToHashSet(StringComparer.Ordinal);
        Volatile.Write(ref snapshot, next);
        var change = new AccessChange(previous, next, affected);
        var pending = new List<Task>();
        foreach (var listener in Changed?.GetInvocationList() ?? [])
        {
            try
            {
                pending.Add(((Func<AccessChange, Task>)listener)(change));
            }
            catch (Exception error)
            {
                pending.Add(Task.FromException(error));
            }
        }
        try
        {
            await Task.WhenAll(pending);
        }
        catch
        {
            throw new IOException(
                "Access identities updated, but some affected connections could not be closed."
            );
        }
    }
}
