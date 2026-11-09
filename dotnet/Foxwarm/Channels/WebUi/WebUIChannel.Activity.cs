using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

/// <summary>
/// Administrator installation activity (System › Activity): who ran which tool, on which Node,
/// with which effect. Scoped browser identities are not on the route allowlist.
/// </summary>
internal sealed partial class WebUIChannel
{
    private static readonly HashSet<string> ActivityFields = new(
        [
            "from",
            "to",
            "beforeTime",
            "beforeKey",
            "limit",
            "sessionId",
            "tree",
            "agent",
            "executionAgent",
            "node",
            "tool",
            "kind",
            "outcome",
            "initiator",
            "origin",
            "text",
        ],
        StringComparer.Ordinal
    );

    private static readonly HashSet<string> ActivityOutcomes = new(
        [
            "ok",
            "error",
            "denied",
            "approval-rejected",
            "approval-expired",
            "cancelled",
            "skipped",
            "problems",
        ],
        StringComparer.Ordinal
    );

    private static readonly HashSet<string> ActivityOrigins = new(
        ["model", "timer-script", "webhook-script", "external-mcp"],
        StringComparer.Ordinal
    );

    private static IResult ActivityError(string message) =>
        Results.Json(
            new JsonObject { ["code"] = "ACTIVITY_INVALID_QUERY", ["error"] = message },
            statusCode: 400
        );

    internal static ActivityQuery ParseActivityQuery(JsonObject body, ActivityIndex activity)
    {
        foreach (var pair in body)
            if (!ActivityFields.Contains(pair.Key))
                throw new ArgumentException("Unknown activity filter: " + pair.Key + ".");
        string? Text(string name, int max = 256)
        {
            if (body[name] is null)
                return null;
            if (
                body[name] is not JsonValue value
                || !value.TryGetValue<string>(out var text)
                || text.Length is 0
                || text.Length > max
            )
                throw new ArgumentException(name + " must be a non-empty string.");
            return text;
        }
        long? Time(string name)
        {
            if (body[name] is null)
                return null;
            if (
                SessionWait.Number(body[name]) is not double number
                || !double.IsFinite(number)
                || number < 0
                || number != Math.Floor(number)
            )
                throw new ArgumentException(name + " must be epoch milliseconds.");
            return (long)number;
        }
        var limit = Time("limit") ?? 100;
        if (limit is < 1 or > ActivityIndex.MaxLimit)
            throw new ArgumentException($"limit must be 1 to {ActivityIndex.MaxLimit}.");
        var kind = Text("kind") ?? "changes";
        if (kind is not ("changes" or "all") && !ActivityKinds.All.Contains(kind))
            throw new ArgumentException("Unknown activity kind.");
        var outcome = Text("outcome");
        if (outcome is not null && !ActivityOutcomes.Contains(outcome))
            throw new ArgumentException("Unknown activity outcome.");
        var origin = Text("origin");
        if (origin is not null && !ActivityOrigins.Contains(origin))
            throw new ArgumentException("Unknown activity origin.");
        var beforeTime = Time("beforeTime");
        var beforeKey = Text("beforeKey", 1024);
        if (beforeTime is null != beforeKey is null)
            throw new ArgumentException("beforeTime and beforeKey go together.");
        IReadOnlyCollection<string>? scope = null;
        var sessionId = Text("sessionId");
        var tree = body["tree"] is JsonValue flag && flag.TryGetValue<bool>(out var value) && value;
        if (body["tree"] is not null && body["tree"] is not JsonValue)
            throw new ArgumentException("tree must be a boolean.");
        if (sessionId is not null)
            scope = tree ? activity.TreeSessions(sessionId) : [sessionId];
        if (Text("agent") is { } agent)
        {
            var owned = activity.AgentSessions(agent);
            scope = scope is null
                ? owned
                : scope.Intersect(owned, StringComparer.Ordinal).ToArray();
        }
        return new ActivityQuery(
            Time("from"),
            Time("to"),
            beforeTime,
            beforeKey,
            (int)limit,
            scope,
            Text("executionAgent"),
            Text("node"),
            Text("tool"),
            kind,
            outcome,
            Text("initiator", 64),
            origin,
            Text("text", 200)
        );
    }

    private void RegisterActivityRoutes(WebApplication app)
    {
        app.MapPost(
            "/api/activity",
            async (HttpRequest request) =>
            {
                ActivityQuery query;
                try
                {
                    var body =
                        await JsonNode.ParseAsync(
                            request.Body,
                            cancellationToken: request.HttpContext.RequestAborted
                        ) as JsonObject
                        ?? throw new ArgumentException("Expected an activity filter object.");
                    query = ParseActivityQuery(body, sessions.Activity);
                }
                catch (Exception error)
                    when (error is ArgumentException or System.Text.Json.JsonException)
                {
                    return ActivityError(error.Message);
                }
                var result = await Task.Run(
                    () => sessions.Activity.Query(query),
                    request.HttpContext.RequestAborted
                );
                return Results.Json(result);
            }
        );
    }
}
