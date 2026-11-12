using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterSessionNodeRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/sessions/{id}/nodes",
            async (string id, HttpRequest request) =>
            {
                var canonical = CatalogRoute(request);
                var row = canonical is null ? null : sessions.Catalog.Get(canonical);
                if (row is null)
                    return Results.NotFound(new JsonObject { ["error"] = "Session not found" });
                var choices = new JsonArray();
                // Administrator selection is not limited by the Session's tool policy; the hint
                // only shows where this Session's tools could not work. No hints without a policy.
                var visibility = sessions.CatalogVisibility(canonical!, row);
                Func<string, bool>? usable = visibility is null
                    ? null
                    : node => sessions.NodeUsable(visibility, node);
                foreach (
                    var node in (
                        await sessions.NodeSummariesAsync(token: request.HttpContext.RequestAborted)
                    ).OfType<JsonObject>()
                )
                {
                    var nodeId = SessionWait.Text(node["id"])!;
                    var ready = node["executable"]!.GetValue<bool>();
                    var online = node["online"]!.GetValue<bool>();
                    string? hint = null;
                    try
                    {
                        if (usable?.Invoke(nodeId) == false)
                            hint = "This session's tools can't use this node.";
                    }
                    catch (Foxwarm.Tools.ToolAuthorizationUnavailableException)
                    {
                        usable = null;
                    }
                    choices.Add(
                        new JsonObject
                        {
                            ["id"] = nodeId,
                            ["label"] =
                                SessionWait.Text(node["displayName"])
                                ?? SessionWait.Text(node["requestedName"])
                                ?? nodeId,
                            ["selectable"] = ready,
                            ["reason"] =
                                ready ? null
                                : online
                                && SessionWait.Text(node["protocolCompatibility"]?["status"])
                                    == "upgrade-required"
                                    ? "Update this node to connect."
                                : !online ? "Offline"
                                : "Unavailable",
                            ["hint"] = hint,
                        }
                    );
                }
                return Results.Ok(new JsonObject { ["nodes"] = choices });
            }
        );
        app.MapPost(
            "/api/sessions/{id}/node",
            async (string id, HttpRequest request) =>
            {
                try
                {
                    var owner = await FindRouteAsync(request, id);
                    if (owner is null)
                        return Results.NotFound(new JsonObject { ["error"] = "Session not found" });
                    if (!sessions.Accepting)
                        return Results.StatusCode(503);
                    var body =
                        await JsonNode.ParseAsync(
                            request.Body,
                            cancellationToken: request.HttpContext.RequestAborted
                        ) as JsonObject;
                    var node = SessionWait.Text(body?["nodeId"])?.Trim();
                    if (string.IsNullOrEmpty(node))
                        throw new InvalidDataException("nodeId is required.");
                    await sessions.SelectNodeAsync(
                        owner,
                        node,
                        request.HttpContext.RequestAborted,
                        clearCwd: false
                    );
                    return Results.Ok(new JsonObject { ["session"] = owner.BuildDto() });
                }
                catch (Exception error)
                    when (error
                            is JsonException
                                or InvalidDataException
                                or IOException
                                or InvalidOperationException
                                or ArgumentException
                                or NotSupportedException
                    )
                {
                    return Results.BadRequest(new JsonObject { ["error"] = error.Message });
                }
            }
        );
    }
}
