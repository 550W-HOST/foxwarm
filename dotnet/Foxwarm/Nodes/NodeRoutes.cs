using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal static class NodeRoutes
{
    internal static void Register(
        WebApplication app,
        SessionManager sessions,
        PublicWebAddress address
    )
    {
        var hub = sessions.Nodes;
        app.MapGet(
            "/api/nodes",
            async (CancellationToken token) =>
                Results.Json(
                    new
                    {
                        nodes = await sessions.NodeSummariesAsync(
                            Foxwarm.Terminal.TerminalRegistry.IsSupported,
                            token
                        ),
                    }
                )
        );
        var bootstrap = sessions.Bootstrap = new NodeBootstrap(hub, address);
        bootstrap.Register(app);
        var configuredBaseUrl = Environment.GetEnvironmentVariable("FOXWARM_PUBLIC_BASE_URL")
            ?? SessionWait.Text(sessions.Models.ConfigurationOwner?.AppConfiguration["url"]);
        app.Map("/node_ws", hub.HandleAsync);
        hub.RegisterShellRoutes(app);
        app.MapGet(
            "/api/nodes/onboarding/pending",
            (HttpContext context) =>
            {
                context.Response.Headers.CacheControl = "no-store";
                var offsetText = context.Request.Query["offset"].FirstOrDefault() ?? "0";
                if (!int.TryParse(offsetText, out var offset) || offset < 0)
                    return Results.BadRequest(new { error = "Invalid pending page." });
                var entries = hub.ListPending()
                    .OfType<JsonObject>()
                    .Where(record => record["approvedNodeId"] is null)
                    .ToArray();
                var items = entries
                    .Skip(offset)
                    .Take(50)
                    .Select(record => new JsonObject
                    {
                        ["id"] = record["id"]!.DeepClone(),
                        ["requestedName"] =
                            record["requestedName"]?.DeepClone() ?? JsonValue.Create(""),
                        ["nodeType"] = record["nodeType"]!.DeepClone(),
                        ["requestedAt"] = record["requestedAt"]!.DeepClone(),
                        ["connected"] = record["connected"]!.DeepClone(),
                    })
                    .ToArray();
                return Results.Ok(
                    new
                    {
                        items,
                        total = entries.Length,
                        nextOffset = offset + items.Length < entries.Length
                            ? (int?)(offset + items.Length)
                            : null,
                    }
                );
            }
        );
        MapPost(
            app,
            "/api/nodes/onboarding/commands",
            (body, _) =>
                Task.FromResult(
                    bootstrap.Commands(
                        NodeBootstrap.OnboardingBaseUrl(body, configuredBaseUrl),
                        Text(body, "nodeId"),
                        Text(body, "installDir") ?? "/opt/foxwarm-node"
                    )
                )
        );
        MapPost(
            app,
            "/api/nodes/onboarding/approve",
            async (body, _) =>
            {
                var result = await hub.ApproveAsync(
                    Required(body, "pendingId"),
                    Text(body, "nodeId")
                );
                result.Remove("authToken");
                return result;
            }
        );
        MapPost(
            app,
            "/api/nodes/onboarding/reject",
            (body, _) =>
            {
                hub.Reject(Required(body, "pendingId"), Text(body, "reason"));
                return Task.FromResult(new JsonObject { ["success"] = true });
            }
        );
        MapPost(
            app,
            "/api/nodes/onboarding/create",
            (body, _) => Task.FromResult(hub.Registry.Create(Required(body, "nodeId")))
        );
        MapPost(
            app,
            "/api/nodes/onboarding/create-shell",
            (body, _) =>
            {
                var id = Required(body, "nodeId");
                // Validate the URL before issuing a one-time credential.
                var commands = bootstrap.Commands(NodeBootstrap.OnboardingBaseUrl(body, configuredBaseUrl), id);
                var created = hub.Registry.Create(id);
                return Task.FromResult(
                    new JsonObject
                    {
                        ["nodeId"] = created["nodeId"]!.DeepClone(),
                        ["command"] = bootstrap.ShellCommand(
                            commands["baseUrl"]!.GetValue<string>(),
                            id,
                            created["authToken"]!.GetValue<string>()
                        ),
                    }
                );
            }
        );
        MapPost(
            app,
            "/api/nodes/{nodeId}/rename",
            (body, context) =>
            {
                hub.Rename(
                    context.Request.RouteValues["nodeId"]!.ToString()!,
                    Required(body, "nodeId")
                );
                return Task.FromResult(new JsonObject { ["success"] = true });
            }
        );
        app.MapDelete(
            "/api/nodes/{nodeId}",
            (string nodeId) =>
            {
                try
                {
                    hub.Remove(nodeId);
                    return Results.Ok(new { success = true });
                }
                catch (InvalidDataException error)
                {
                    return Results.BadRequest(new { error = error.Message });
                }
            }
        );
        app.MapGet(
            "/api/nodes/{nodeId}",
            async (string nodeId, HttpContext context) =>
            {
                nodeId = Uri.UnescapeDataString(nodeId);
                var node = (await sessions.NodeSummariesAsync(token: context.RequestAborted))
                    .OfType<JsonObject>()
                    .FirstOrDefault(value => value["id"]!.GetValue<string>() == nodeId);
                return node is null
                    ? Results.NotFound(new { error = "Node not found." })
                    : Results.Ok(node);
            }
        );
    }

    private static void MapPost(
        WebApplication app,
        string path,
        Func<JsonObject, HttpContext, Task<JsonObject>> action
    )
    {
        app.MapPost(
            path,
            async (HttpContext context) =>
            {
                context.Response.Headers.CacheControl = "no-store";
                try
                {
                    var body =
                        await JsonNode.ParseAsync(
                            context.Request.Body,
                            cancellationToken: context.RequestAborted
                        ) as JsonObject
                        ?? throw new InvalidDataException("Request body must be an object.");
                    return Results.Ok(await action(body, context));
                }
                catch (NotSupportedException error)
                {
                    return Results.Json(new { error = error.Message }, statusCode: 501);
                }
                catch (Exception error)
                    when (error
                            is InvalidDataException
                                or JsonException
                                or InvalidOperationException
                    )
                {
                    return Results.BadRequest(new { error = error.Message });
                }
            }
        );
    }

    private static string Required(JsonObject body, string key) =>
        Text(body, key) is { Length: > 0 } text
            ? text
            : throw new InvalidDataException(key + " is required.");

    private static string? Text(JsonObject body, string key) =>
        body[key] is null
            ? null
            : SessionWait.Text(body[key])
                ?? throw new InvalidDataException(key + " must be a string.");
}
