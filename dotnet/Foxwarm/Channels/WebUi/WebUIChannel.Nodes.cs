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
                    return Results.NotFound(new { error = "Session not found" });
                var bound = sessions.BoundNode(SessionWait.Text(row["agent"]) ?? "main");
                var locked = bound is null ? null : $"This agent is bound to node {bound}.";
                var choices = new JsonArray();
                foreach (var node in (await sessions.NodeSummariesAsync(token: request.HttpContext.RequestAborted)).OfType<JsonObject>())
                {
                    var nodeId = SessionWait.Text(node["id"])!;
                    if (bound is not null && nodeId != bound)
                        continue;
                    var ready = node["executable"]!.GetValue<bool>();
                    var online = node["online"]!.GetValue<bool>();
                    choices.Add(
                        new JsonObject
                        {
                            ["id"] = nodeId,
                            ["label"] =
                                SessionWait.Text(node["displayName"])
                                ?? SessionWait.Text(node["requestedName"])
                                ?? nodeId,
                            ["selectable"] = bound is null && ready,
                            ["reason"] =
                                locked
                                ?? (
                                    ready ? null
                                    : online
                                    && SessionWait.Text(node["protocolCompatibility"]?["status"])
                                        == "upgrade-required"
                                        ? "Update this node to connect."
                                    : !online ? "Offline"
                                    : "Unavailable"
                                ),
                        }
                    );
                }
                return Results.Ok(
                    new JsonObject { ["nodes"] = choices, ["lockedReason"] = locked }
                );
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
                        return Results.NotFound(new { error = "Session not found" });
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
                    var bound = sessions.BoundNode(owner.Agent);
                    if (bound is not null)
                        throw new InvalidOperationException(
                            $"This agent is bound to node {bound}."
                        );
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
                    return Results.BadRequest(new { error = error.Message });
                }
            }
        );
    }
}
