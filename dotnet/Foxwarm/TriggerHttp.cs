using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

// Registered behind the ordinary administrator middleware, independently of WebUI.
// Deprecated in favor of /webhooks/{id}; retained for one release while callers migrate.
internal static class TriggerHttp
{
    // RFC 9745 deprecation date (2026-11-08T00:00:00Z).
    private const string Deprecation = "@1794096000";
    private static int warned;

    internal static void Register(WebApplication app, SessionRuntime runtime)
    {
        app.MapPost(
            "/trigger",
            async (HttpContext context) =>
            {
                context.Response.Headers["Deprecation"] = Deprecation;
                if (Interlocked.Exchange(ref warned, 1) == 0)
                    Console.Error.WriteLine(
                        "POST /trigger is deprecated and will be removed; configure a webhook identity and use /webhooks/<id> instead."
                    );
                try
                {
                    var body = await JsonNode.ParseAsync(context.Request.Body) as JsonObject;
                    var text = body?["text"];
                    if (!Truthy(text))
                        throw new InvalidDataException("Missing text");
                    var target = body?["sessionId"];
                    var id = Truthy(target) ? SessionWait.Text(target) : "main";
                    if (id is null || runtime.Catalog.Resolve(id)["sessionId"] is null)
                        throw new InvalidDataException(
                            $"Session \"{id ?? target?.ToJsonString()}\" is unavailable. Choose an existing session or create one first."
                        );
                    if (SessionWait.Text(text) is not { Length: > 0 } message)
                        throw new InvalidDataException("text must be a non-empty string.");
                    await runtime.QueueTriggerAsync(id, message);
                    return Results.Ok(
                        new JsonObject { ["success"] = true, ["message"] = "Triggered" }
                    );
                }
                catch (Exception error)
                    when (error
                            is JsonException
                                or InvalidDataException
                                or InvalidOperationException
                                or IOException
                    )
                {
                    return Results.BadRequest(
                        new JsonObject
                        {
                            ["error"] = error is JsonException ? "Invalid JSON" : error.Message,
                        }
                    );
                }
            }
        );
    }

    private static bool Truthy(JsonNode? value) =>
        value is not null
        && (
            value is JsonObject or JsonArray
            || SessionWait.Text(value) is { Length: > 0 }
            || value is JsonValue scalar && scalar.TryGetValue<bool>(out var flag) && flag
            || SessionWait.Number(value) is { } number && number != 0
        );
}
