using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http.Features;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterAgentRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/agents/tree",
            () =>
            {
                var sessions = runtime.ListSessions();
                var children = sessions
                    .Where(row => SessionCatalog.Text(row["parentSessionId"]) is not null)
                    .GroupBy(
                        row => SessionCatalog.Text(row["parentSessionId"])!,
                        StringComparer.Ordinal
                    )
                    .ToDictionary(
                        group => group.Key,
                        group => group.Select(row => SessionCatalog.Text(row["id"])!).ToArray(),
                        StringComparer.Ordinal
                    );
                var agents = sessions
                    .Select(row =>
                    {
                        var id = SessionCatalog.Text(row["id"])!;
                        return new
                        {
                            id,
                            displayName = SessionCatalog.Text(row["displayName"]) ?? id,
                            busy = SessionCatalog.Flag(row["busy"]),
                            queueLength = SessionCatalog.Number(row["queueLength"]) ?? 0,
                            parentSessionId = SessionCatalog.Text(row["parentSessionId"]),
                            childSessions = children.TryGetValue(id, out var childIds)
                                ? childIds
                                : [],
                            messageCount = SessionCatalog.Number(row["messageCount"]) ?? 0,
                            lastMessageTime = SessionCatalog.Number(row["lastMessageTime"]),
                            archived = SessionCatalog.Flag(row["archived"]),
                        };
                    })
                    .ToArray();
                return Results.Ok(
                    new
                    {
                        agents,
                        rootAgents = agents
                            .Where(row => row.parentSessionId is null)
                            .Select(row => row.id)
                            .ToArray(),
                    }
                );
            }
        );
        app.MapGet("/api/agents", () => Results.Ok(new { agents = sessions.AgentRegistry() }));
        app.MapPost(
            "/api/agents",
            async (HttpRequest request) =>
            {
                try
                {
                    var body =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Agent creation needs an object.");
                    if (
                        body.Any(item =>
                            item.Key
                                is not (
                                    "agentId"
                                    or "inheritAgent"
                                    or "isolatedNode"
                                    or "rules"
                                    or "defaultNode"
                                    or "restore"
                                )
                        )
                        || body["agentId"] is not JsonValue agent
                        || !agent.TryGetValue<string>(out var name)
                    )
                        return Results.BadRequest(new { error = "agentId is required." });
                    if (
                        body.ContainsKey("restore")
                        && (
                            body["restore"] is not JsonValue restoreValue
                            || !restoreValue.TryGetValue<bool>(out _)
                        )
                    )
                        throw new InvalidDataException("restore must be a boolean.");
                    if (SessionCatalog.Flag(body["restore"]))
                    {
                        if (body.Any(pair => pair.Key is not ("agentId" or "restore")))
                            throw new InvalidDataException(
                                "Restoration does not accept metadata overrides."
                            );
                        await sessions.RestoreRetainedAgentAsync(name.Trim());
                        return Results.Json(
                            new
                            {
                                success = true,
                                agentId = name.Trim(),
                                sessionId = (string?)null,
                                restored = true,
                            },
                            statusCode: 201
                        );
                    }
                    var inherit = body["inheritAgent"] is null
                        ? null
                        : body["inheritAgent"]!.GetValue<string>()?.Trim();
                    if (!string.IsNullOrEmpty(inherit) && sessions.AgentIsolated(inherit))
                        return Results.BadRequest(
                            new { error = "An isolated Agent cannot be used as an inherit source." }
                        );
                    if (body.ContainsKey("rules") && body["rules"] is not JsonArray)
                        throw new InvalidDataException("rules must be an array.");
                    var created = await sessions.CreateAgentAsync(
                        name.Trim(),
                        inherit: string.IsNullOrEmpty(inherit) ? null : inherit,
                        isolatedNode: body["isolatedNode"]?.GetValue<string>(),
                        rules: body["rules"] as JsonArray,
                        defaultNode: body["defaultNode"]?.GetValue<string>()
                    );
                    if (created.MainSessionId is not null)
                        runtime.ChangePresentation(catalog =>
                            catalog.Move(
                                created.MainSessionId,
                                new JsonObject
                                {
                                    ["parentSessionId"] = null,
                                    ["position"] = "first",
                                }
                            )
                        );
                    return Results.Json(
                        new
                        {
                            success = true,
                            agentId = created.AgentName,
                            sessionId = created.MainSessionId,
                        },
                        statusCode: 201
                    );
                }
                catch (CommittedSessionCreationException error)
                {
                    return Results.Json(
                        new
                        {
                            error = error.Message,
                            sessionId = error.SessionId,
                            agentCreated = true,
                        },
                        statusCode: 409
                    );
                }
                catch (Exception error)
                    when (error
                            is InvalidDataException
                                or IOException
                                or JsonException
                                or InvalidOperationException
                    )
                {
                    return Results.BadRequest(new { error = error.Message });
                }
            }
        );
        app.MapDelete(
            "/api/agents/{agentId}",
            async (string agentId, HttpRequest request) =>
            {
                try
                {
                    var body = await JsonNode.ParseAsync(request.Body) as JsonObject;
                    if (SessionWait.Text(body?["confirmAgentId"]) != agentId)
                        return Results.BadRequest(
                            new
                            {
                                error = "Agent deletion requires confirmAgentId to match the target Agent.",
                            }
                        );
                    if (
                        body!.ContainsKey("retainedOnly")
                        && (
                            body["retainedOnly"] is not JsonValue retainedValue
                            || !retainedValue.TryGetValue<bool>(out _)
                        )
                    )
                        throw new InvalidDataException("retainedOnly must be a boolean.");
                    if (SessionCatalog.Flag(body["retainedOnly"]))
                    {
                        await sessions.CleanupRetainedAgentAsync(agentId);
                        return Results.Ok(
                            new
                            {
                                success = true,
                                agentId,
                                retainedRecordRemoved = true,
                                deletedSessions = Array.Empty<string>(),
                            }
                        );
                    }
                    var deleted = await sessions.DeleteAgentAsync(agentId);
                    return Results.Ok(
                        new
                        {
                            success = true,
                            agentId,
                            deletedSessions = deleted,
                        }
                    );
                }
                catch (Exception error)
                    when (error
                            is InvalidDataException
                                or IOException
                                or JsonException
                                or InvalidOperationException
                                or UnauthorizedAccessException
                    )
                {
                    var status =
                        System.Text.RegularExpressions.Regex.IsMatch(
                            error.Message,
                            "not found",
                            System.Text.RegularExpressions.RegexOptions.IgnoreCase
                        )
                            ? 404
                        : System.Text.RegularExpressions.Regex.IsMatch(
                            error.Message,
                            "active|busy|attached|inherited by|mutation|deletion stopped",
                            System.Text.RegularExpressions.RegexOptions.IgnoreCase
                        )
                            ? 409
                        : 400;
                    return Results.Json(new { error = error.Message }, statusCode: status);
                }
            }
        );
        app.MapGet(
            "/api/agents/{agentId}/memory",
            (string agentId) =>
            {
                try
                {
                    var manifest = sessions.AgentManifest(agentId);
                    return Results.Ok(
                        new
                        {
                            memoryRoot = manifest.MemoryRoot,
                            files = manifest.Files.Select(file => new
                            {
                                path = file.Path,
                                absolutePath = file.AbsolutePath,
                                size = file.Size,
                                modifiedAt = file.ModifiedAt,
                            }),
                        }
                    );
                }
                catch (Exception error)
                    when (error is IOException or InvalidDataException or ArgumentException)
                {
                    return Results.Json(
                        new { error = error.Message },
                        statusCode: sessions.Agents().Contains(agentId) ? 400 : 404
                    );
                }
            }
        );
        app.MapPut(
            "/api/agents/{agentId}",
            async (string agentId, HttpRequest request) =>
            {
                try
                {
                    var body =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Agent update needs an object.");
                    if (
                        body.Any(item =>
                            item.Key
                                is not (
                                    "inheritAgent"
                                    or "isolatedNode"
                                    or "rules"
                                    or "defaultNode"
                                )
                        )
                        || !new[] { "inheritAgent", "isolatedNode", "rules", "defaultNode" }.Any(
                            body.ContainsKey
                        )
                    )
                        throw new InvalidDataException(
                            "Provide inheritAgent, isolatedNode, rules or defaultNode."
                        );
                    if (!sessions.Agents().Contains(agentId))
                        return Results.NotFound(new { error = "Agent not found." });
                    if (body.ContainsKey("rules"))
                        await sessions.SetAgentRulesAsync(
                            agentId,
                            body["rules"] as JsonArray
                                ?? throw new InvalidDataException("rules must be an array.")
                        );
                    if (body.ContainsKey("defaultNode"))
                        await sessions.SetAgentDefaultNodeAsync(
                            agentId,
                            body["defaultNode"] is null
                                ? null
                                : body["defaultNode"]!.GetValue<string>()
                        );
                    if (body.ContainsKey("isolatedNode"))
                        await sessions.SetAgentNodeAsync(
                            agentId,
                            SessionWait.Text(body["isolatedNode"])
                        );
                    if (body.ContainsKey("inheritAgent"))
                        await sessions.SetAgentInheritAsync(
                            agentId,
                            body["inheritAgent"]?.GetValue<string>()
                        );
                    return Results.Ok(
                        new
                        {
                            success = true,
                            agent = new
                            {
                                id = agentId,
                                inherit = sessions.AgentInherit(agentId),
                                inheritanceChain = sessions.AgentChain(agentId),
                                createdBy = sessions
                                    .AgentMetadata[agentId]
                                    ?["createdBy"]?.DeepClone(),
                                rules = sessions.AgentMetadata[agentId]?["rules"]?.DeepClone()
                                    ?? new JsonArray(),
                                defaultNode = sessions
                                    .AgentMetadata[agentId]
                                    ?["defaultNode"]?.DeepClone(),
                                isolated = sessions.AgentIsolated(agentId),
                                isolatedNode = sessions.RecordedIsolationNode(agentId),
                            },
                        }
                    );
                }
                catch (Exception error)
                    when (error
                            is InvalidDataException
                                or IOException
                                or JsonException
                                or InvalidOperationException
                    )
                {
                    return Results.BadRequest(new { error = error.Message });
                }
            }
        );
        app.MapGet(
            "/api/sessions",
            (HttpContext context) =>
            {
                var scoped = WebUiAccess.Request(context);
                var rows = runtime.ListSessions();
                scoped?.Require();
                return Results.Ok(
                    new
                    {
                        sessions = scoped is null
                            ? rows
                            : rows.Where(row => scoped.Allows(SessionCatalog.Text(row["id"])!))
                                .Select(row => new JsonObject
                                {
                                    ["id"] = row["id"]?.DeepClone(),
                                    ["displayName"] = row["displayName"]?.DeepClone(),
                                    ["busy"] = row["busy"]?.DeepClone(),
                                })
                                .ToArray(),
                    }
                );
            }
        );
        app.MapPost(
            "/api/sessions",
            async (HttpRequest request) =>
            {
                try
                {
                    JsonObject? body = null;
                    if (
                        request.ContentLength is > 0
                        || request.Headers.ContainsKey("Transfer-Encoding")
                    )
                    {
                        // A zero-byte chunked JSON stream is the same as a bodyless request.
                        using var input = new MemoryStream();
                        await request.Body.CopyToAsync(input);
                        if (input.Length > 0)
                        {
                            input.Position = 0;
                            body =
                                await JsonNode.ParseAsync(input) as JsonObject
                                ?? throw new InvalidDataException(
                                    "Session creation must be an object."
                                );
                        }
                    }
                    SessionOwner hosted;
                    if (body is null || body.Count == 0)
                        hosted = await sessions.CreateAsync();
                    else
                    {
                        if (
                            body.Any(item => item.Key is not ("agentId" or "sessionId" or "runtime"))
                            || body.ContainsKey("agentId")
                                && (
                                    body["agentId"] is not JsonValue agent
                                    || !agent.TryGetValue<string>(out _)
                                )
                            || body.ContainsKey("sessionId")
                                && (
                                    body["sessionId"] is not JsonValue named
                                    || !named.TryGetValue<string>(out _)
                                )
                        )
                            throw new InvalidDataException("Invalid Session creation fields.");
                        var agentName = body["agentId"]?.GetValue<string>()?.Trim();
                        if (string.IsNullOrEmpty(agentName))
                            agentName = "main";
                        var requested = body["sessionId"]?.GetValue<string>();
                        var runtimeSelection = ClaudeRuntimeState.ValidateSelection(body["runtime"], body.ContainsKey("runtime"));
                        hosted =
                            agentName == "main" && string.IsNullOrEmpty(requested) && runtimeSelection == "foxwarm"
                                ? await sessions.CreateAsync()
                                : await sessions.CreateNamedAsync(
                                    agentName,
                                    string.IsNullOrEmpty(requested) ? null : requested,
                                    null,
                                    null,
                                    runtime: runtimeSelection
                                );
                    }
                    runtime.ChangePresentation(catalog =>
                        catalog.Move(
                            hosted.Id,
                            new JsonObject { ["parentSessionId"] = null, ["position"] = "first" }
                        )
                    );
                    return Results.Ok(new { success = true, sessionId = hosted.Id });
                }
                catch (CommittedSessionCreationException error)
                {
                    return Results.Json(
                        new
                        {
                            error = error.Message,
                            sessionId = error.SessionId,
                            committed = true,
                            initialDeliveryCommitted = error.InitialDeliveryCommitted,
                        },
                        statusCode: 409
                    );
                }
                catch (InvalidDataException error)
                    when (error.Message.Contains("already reserved", StringComparison.Ordinal))
                {
                    return Results.Conflict(new { error = error.Message });
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
                catch (Exception error)
                {
                    return Results.Problem(error.Message, statusCode: 500);
                }
            }
        );
        app.MapPost(
            "/api/sessions/{id}/children",
            async (string id, HttpRequest request) =>
            {
                var parent = await FindRouteAsync(request, id);
                if (parent is null)
                    return Results.NotFound(new { error = "Parent Session not found" });
                if (!sessions.Accepting)
                    return Results.StatusCode(503);
                try
                {
                    var body =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Child creation must be an object.");
                    if (
                        body.Any(item =>
                            item.Key
                                is not (
                                    "suffix"
                                    or "agentName"
                                    or "displayName"
                                    or "message"
                                    or "runtime"
                                    or "forceModel"
                                )
                        )
                        || body["suffix"] is not JsonValue suffixValue
                        || !suffixValue.TryGetValue<string>(out var suffix)
                        || new[] { "agentName", "displayName", "message" }.Any(key =>
                            body.ContainsKey(key)
                            && (body[key] is not JsonValue item || !item.TryGetValue<string>(out _))
                        )
                        || body.ContainsKey("forceModel") && body["forceModel"] is not JsonObject
                    )
                        throw new InvalidDataException("Invalid child creation fields.");
                    var (child, delivered) = await sessions.CreateChildAsync(
                        parent,
                        suffix,
                        body["agentName"]?.GetValue<string>(),
                        body["displayName"]?.GetValue<string>(),
                        body["message"]?.GetValue<string>(),
                        body["forceModel"] as JsonObject,
                        userInitiated: true,
                        runtime: ClaudeRuntimeState.ValidateSelection(body["runtime"], body.ContainsKey("runtime"))
                    );
                    return Results.Ok(
                        new
                        {
                            success = true,
                            sessionId = child.Id,
                            parentSessionId = parent.Id,
                            delivered,
                        }
                    );
                }
                catch (CommittedSessionCreationException error)
                {
                    return Results.Json(
                        new
                        {
                            error = error.Message,
                            sessionId = error.SessionId,
                            committed = true,
                            initialDeliveryCommitted = error.InitialDeliveryCommitted,
                        },
                        statusCode: 409
                    );
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
        app.MapPost(
            "/api/sessions/{id}/refresh-memory",
            async (string id, HttpRequest request) =>
            {
                var session = await FindRouteAsync(request, id);
                if (session is null)
                    return Results.NotFound(new { error = "Session not found" });
                if (!sessions.Accepting)
                    return Results.StatusCode(503);
                try
                {
                    var model = await sessions.RefreshSnapshotAsync(session);
                    return Results.Ok(
                        new
                        {
                            success = true,
                            sessionId = session.Id,
                            concreteModelId = model,
                        }
                    );
                }
                catch (Exception error)
                {
                    return Results.Problem(error.Message, statusCode: 500);
                }
            }
        );
    }
}
