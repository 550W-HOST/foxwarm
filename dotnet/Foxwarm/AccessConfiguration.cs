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
    bool Mcp,
    WebhookSurface? Webhook = null
);

internal enum WebhookVerification
{
    GitHub,
    Header,
    Bearer,
}

internal enum WebhookAction
{
    Message,
    ToolScript,
}

// An entry capability only: a verified delivery reaches one fixed Session and grants no tool authority.
internal sealed record WebhookSurface(
    string Session,
    WebhookVerification Verify,
    string? Header,
    ImmutableArray<string> Events,
    WebhookAction Action = WebhookAction.Message,
    JsonObject? Script = null,
    bool Wake = true
)
{
    internal bool SameAs(WebhookSurface other) =>
        Session == other.Session
        && Verify == other.Verify
        && string.Equals(Header, other.Header, StringComparison.OrdinalIgnoreCase)
        && Events.SequenceEqual(other.Events, StringComparer.Ordinal)
        && Action == other.Action
        && Wake == other.Wake
        && JsonNode.DeepEquals(Script, other.Script);
}

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
    internal bool McpRuntimeAvailable { get; set; }
    internal bool WebhookRuntimeAvailable { get; set; }
    internal string ReservedInstanceToken => Volatile.Read(ref reservedToken);

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
            Keys(surfaces, "access identity surfaces", "webui", "mcp", "webhook");
            if (surfaces.Count == 0)
                throw new InvalidDataException("access identity must enable at least one surface.");
            WebhookSurface? webhook = null;
            if (surfaces.ContainsKey("webhook"))
            {
                // The secret is shared with a third party, so it must not also open WebUI or MCP.
                if (surfaces.Count != 1)
                    throw new InvalidDataException(
                        "access identity surfaces.webhook cannot be combined with other surfaces."
                    );
                webhook = Webhook(surfaces["webhook"]);
            }
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
                surfaces.ContainsKey("mcp"),
                webhook
            );
        }
        return result.ToImmutable();
    }

    private static readonly string[] ReservedWebhookHeaders =
    [
        "authorization",
        "proxy-authorization",
        "cookie",
        "host",
        "content-type",
        "content-length",
        "transfer-encoding",
    ];

    private static WebhookSurface Webhook(JsonNode? value)
    {
        if (value is not JsonObject hook)
            throw new InvalidDataException(
                "access identity surfaces.webhook must be a YAML object."
            );
        Keys(
            hook,
            "access identity surfaces.webhook",
            "session",
            "verify",
            "events",
            "action",
            "script",
            "wake"
        );
        var session = Text(hook["session"]);
        if (string.IsNullOrWhiteSpace(session) || session.Length > 512 || session.Contains('*'))
            throw new InvalidDataException(
                "access identity webhook.session must be one Session ID."
            );
        WebhookVerification verify;
        string? header = null;
        switch (hook["verify"])
        {
            case JsonValue scalar when Text(scalar) == "github":
                verify = WebhookVerification.GitHub;
                break;
            case JsonValue scalar when Text(scalar) == "bearer":
                verify = WebhookVerification.Bearer;
                break;
            case JsonObject named:
                Keys(named, "access identity webhook.verify", "header");
                header = Text(named["header"]);
                if (
                    header is null
                    || !Regex.IsMatch(header, "^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$")
                    || ReservedWebhookHeaders.Contains(header, StringComparer.OrdinalIgnoreCase)
                )
                    throw new InvalidDataException(
                        "access identity webhook.verify.header must name a non-reserved HTTP header."
                    );
                verify = WebhookVerification.Header;
                break;
            default:
                throw new InvalidDataException(
                    "access identity webhook.verify must be github, bearer, or {header: <name>}."
                );
        }
        var events = ImmutableArray<string>.Empty;
        if (hook.ContainsKey("events"))
        {
            if (verify != WebhookVerification.GitHub)
                throw new InvalidDataException(
                    "access identity webhook.events requires verify: github."
                );
            if (hook["events"] is not JsonArray list || list.Count is < 1 or > 64)
                throw new InvalidDataException(
                    "access identity webhook.events must be a non-empty array of event names."
                );
            var names = new List<string>();
            foreach (var item in list)
            {
                var name = Text(item);
                if (name is null || !WebhookEventName(name))
                    throw new InvalidDataException(
                        "access identity webhook.events contains an invalid event name."
                    );
                if (names.Contains(name, StringComparer.Ordinal))
                    throw new InvalidDataException(
                        "access identity webhook.events must contain distinct event names."
                    );
                names.Add(name);
            }
            events = names.ToImmutableArray();
        }
        var action = Text(hook["action"]) switch
        {
            null when !hook.ContainsKey("action") => WebhookAction.Message,
            "message" => WebhookAction.Message,
            "toolscript" => WebhookAction.ToolScript,
            _ => throw new InvalidDataException(
                "access identity webhook.action must be message or toolscript."
            ),
        };
        JsonObject? script = null;
        if (action == WebhookAction.ToolScript)
            script = WebhookScript(hook["script"]);
        else if (hook.ContainsKey("script"))
            throw new InvalidDataException(
                "access identity webhook.script requires action: toolscript."
            );
        var wake = true;
        if (hook.ContainsKey("wake"))
        {
            if (action != WebhookAction.Message)
                throw new InvalidDataException(
                    "access identity webhook.wake requires action: message."
                );
            if (hook["wake"] is not JsonValue flag || !flag.TryGetValue<bool>(out wake))
                throw new InvalidDataException(
                    "access identity webhook.wake must be true or false."
                );
        }
        return new(session, verify, header, events, action, script, wake);
    }

    // The same specification as a ToolScript timer, always run in the foreground so one
    // identity's handlers stay serialized. `args.webhook` carries the delivery.
    private static JsonObject WebhookScript(JsonNode? value)
    {
        if (value is not JsonObject script)
            throw new InvalidDataException(
                "access identity webhook.script must be a ToolScript specification."
            );
        Keys(
            script,
            "access identity webhook.script",
            "code",
            "filePath",
            "node",
            "args",
            "timeoutSecs"
        );
        if (script["args"] is JsonObject args && args.ContainsKey("webhook"))
            throw new InvalidDataException(
                "access identity webhook.script.args.webhook is reserved for the delivery."
            );
        try
        {
            return Foxwarm.ToolScript.MainToolScript.NormalizeStartArgs(
                (JsonObject)script.DeepClone()
            );
        }
        catch (InvalidDataException error)
        {
            throw new InvalidDataException("access identity webhook.script: " + error.Message);
        }
    }

    internal static bool WebhookEventName(string name) =>
        Regex.IsMatch(name, "^[A-Za-z0-9_.:-]{1,128}$");

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

    internal static void Validate(ImmutableDictionary<string, AccessIdentity> next, string reserved)
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
