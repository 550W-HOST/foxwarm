using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http.Features;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel(
    SessionManager sessions,
    SessionRuntime runtime,
    MessageRouter router,
    Foxwarm.Terminal.TerminalRegistry terminals
)
{
    private readonly WebUiRealtime realtime = new(runtime);

    public void Register(WebApplication app)
    {
        var models = sessions.Models;
        app.Use(
            async (context, next) =>
            {
                try
                {
                    await next();
                }
                catch (OperationCanceledException)
                    when (context.RequestAborted.IsCancellationRequested) { }
                catch (BadHttpRequestException error) when (!context.Response.HasStarted)
                {
                    await Results
                        .Problem(
                            "Request body is invalid or too large.",
                            statusCode: error.StatusCode is >= 400 and <= 599
                                ? error.StatusCode
                                : 400
                        )
                        .ExecuteAsync(context);
                }
                catch (Exception error)
                    when (!context.Response.HasStarted
                        && error
                            is IOException
                                or InvalidDataException
                                or InvalidOperationException
                                or NotSupportedException
                    )
                {
                    await Results.Problem(error.Message, statusCode: 500).ExecuteAsync(context);
                }
            }
        );
        app.MapGet(
            "/api/models",
            (HttpRequest request) =>
                Results.Ok(WebUiContract.Models(models, request.Query["current"]))
        );
        RegisterSetupRoutes(app);
        app.MapPost(
            "/api/sessions/{id}/cwd",
            async (string id, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new { error = "Session not found" });
                if (!sessions.Accepting)
                    return Results.StatusCode(503);
                JsonObject body;
                try
                {
                    body =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new JsonException("Cwd settings must be an object.");
                }
                catch (JsonException error)
                {
                    return Results.BadRequest(new { error = error.Message });
                }
                return Results.Ok(await hosted.UpdateCwdAsync(SessionWait.Text(body["cwd"])));
            }
        );
        app.MapPost(
            "/api/sessions/{id}/model",
            async (string id, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new { error = "Session not found" });
                if (!sessions.Accepting)
                    return Results.StatusCode(503);
                try
                {
                    var body =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Model settings must be an object.");
                    return Results.Ok(await runtime.UpdateSettingsAsync(hosted.Id, body));
                }
                catch (Exception error)
                    when (error
                            is JsonException
                                or InvalidDataException
                                or InvalidOperationException
                    )
                {
                    return Results.BadRequest(new { error = error.Message });
                }
            }
        );
        app.MapPost(
            "/api/sessions/{id}/child-model",
            async (string id, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new { error = "Session not found" });
                if (!sessions.Accepting)
                    return Results.StatusCode(503);
                try
                {
                    var body =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Child settings must be an object.");
                    return Results.Ok(await hosted.UpdateSettingsAsync(body, child: true));
                }
                catch (Exception error)
                    when (error
                            is JsonException
                                or InvalidDataException
                                or InvalidOperationException
                    )
                {
                    return Results.BadRequest(new { error = error.Message });
                }
            }
        );
        app.MapGet(
            "/api/commands",
            () =>
                Results.Ok(
                    new
                    {
                        commands = new[]
                        {
                            new
                            {
                                name = "stop",
                                description = "Stop current run, or use `/stop compact` to cancel compaction only",
                                usage = "/stop [compact]",
                                requiresSession = true,
                            },
                            new
                            {
                                name = "continue",
                                description = "Continue an interrupted turn without adding a new message",
                                usage = "/continue",
                                requiresSession = true,
                            },
                            new
                            {
                                name = "fork",
                                description = "Fork current session",
                                usage = "/fork [suffix] [message]",
                                requiresSession = true,
                            },
                            new
                            {
                                name = "session",
                                description = "Clear the current session history",
                                usage = "/session clear",
                                requiresSession = true,
                            },
                            new
                            {
                                name = "compact",
                                description = "Compact history.",
                                usage = "/compact",
                                requiresSession = true,
                            },
                        },
                    }
                )
        );
        new Foxwarm.Asr.AsrProxy(
            models.ConfigurationOwner,
            app.Lifetime.ApplicationStopping
        ).Register(app);
        RegisterTerminalRoutes(app);
        RegisterAgentRoutes(app);
        RegisterListRoutes(app);
        RegisterPresentationRoutes(app);
        RegisterRelationRoutes(app);
        RegisterDeleteRoute(app);
        RegisterHistoryRoutes(app);
        RegisterUploadAndImageRoutes(app);
        RegisterFileRoutes(app);
        app.MapPost(
            "/api/sessions/{id}/message",
            async (string id, HttpRequest request) =>
            {
                var canonical = CatalogRoute(request);
                if (!sessions.Accepting)
                    return Results.StatusCode(503);
                JsonObject? input;
                try
                {
                    input = await JsonNode.ParseAsync(request.Body) as JsonObject;
                }
                catch (JsonException)
                {
                    return Results.BadRequest(new { error = "Invalid JSON" });
                }
                if (
                    input is null
                    || input.Any(pair =>
                        pair.Key
                            is not (
                                "text"
                                or "parts"
                                or "uploadedFiles"
                                or "filePaths"
                                or "clientMessageId"
                            )
                    )
                )
                    return Results.BadRequest(new { error = "Invalid message fields." });
                if (
                    new[] { "parts", "uploadedFiles", "filePaths" }.Any(key =>
                        input.ContainsKey(key) && input[key] is not JsonArray
                    )
                )
                    return Results.BadRequest(
                        new { error = "Message parts and uploaded files must be arrays." }
                    );
                var text =
                    SessionWait.Text(input["text"])
                    ?? string.Join(
                        "\n",
                        (input["parts"] as JsonArray ?? [])
                            .OfType<JsonObject>()
                            .Select(part => SessionWait.Text(part["text"]) ?? "")
                    );
                var hasUploads =
                    (input["uploadedFiles"] as JsonArray ?? input["filePaths"] as JsonArray)?.Count
                    > 0;
                if (string.IsNullOrWhiteSpace(text) && !hasUploads)
                    return Results.BadRequest(new { error = "Missing message content." });
                var clientId =
                    input["clientMessageId"] is JsonValue idValue
                    && idValue.TryGetValue<string>(out var idText)
                    && idText.Length is > 0 and <= 160
                        ? idText
                        : null;
                if (input.ContainsKey("clientMessageId") && clientId is null)
                    return Results.BadRequest(new { error = "Invalid clientMessageId" });
                IReadOnlyList<JsonObject> savedFiles = [];
                try
                {
                    SessionOwner? ingressOwner = null;
                    if (MessageRouter.IsPresentationCommand(text))
                    {
                        if (canonical is null)
                            return Results.NotFound(new { error = "Session not found" });
                    }
                    else
                    {
                        var owner = await FindRouteAsync(request, id);
                        if (owner is null)
                            return Results.NotFound(new { error = "Session not found" });
                        canonical = owner.Id;
                        ingressOwner = owner;
                    }
                    if (hasUploads && text.TrimStart().StartsWith("/", StringComparison.Ordinal))
                        return Results.BadRequest(
                            new
                            {
                                error = "Send attachments as a message without a Session command.",
                            }
                        );
                    using var ingress = hasUploads
                        ? sessions.BeginFileIngress(ingressOwner!)
                        : null;
                    var prepared = await new WebUiUploadedFiles(sessions).PrepareAsync(
                        input,
                        ingressOwner,
                        request.HttpContext.RequestAborted
                    );
                    savedFiles = prepared.SavedFiles;
                    sessions.AttachWebUi(canonical!, ingressOwner);
                    if (ingressOwner is not null)
                        canonical = ingressOwner.Id;
                    var result = await router.HandleMessageAsync(
                        new ChannelContext(canonical, "webui"),
                        new ChannelMessage(text, clientId, prepared.Parts),
                        hasUploads ? ingressOwner : null
                    );
                    return Results.Json(result.Value, statusCode: result.Status);
                }
                catch (UploadPreparationException error)
                {
                    return Results.Json(
                        new { error = error.Message, savedFiles = error.SavedFiles },
                        statusCode: error.InvalidInput ? 400 : 500
                    );
                }
                catch (Foxwarm.Images.ImageInputException error)
                {
                    return Results.BadRequest(new { error = error.Message });
                }
                catch (Exception error)
                {
                    if (!hasUploads)
                        return Results.Problem(error.Message, statusCode: 500);
                    return Results.Json(
                        new
                        {
                            error = error.Message,
                            savedFiles,
                            note = savedFiles.Count > 0
                                ? "Saved attachment files were not removed; message admission did not complete."
                                : null,
                        },
                        statusCode: 500
                    );
                }
            }
        );
        app.MapGet(
            "/api/webui/stream",
            async (HttpContext context) =>
            {
                if (!context.WebSockets.IsWebSocketRequest)
                {
                    context.Response.StatusCode = 400;
                    return;
                }
                using var socket = await context.WebSockets.AcceptWebSocketAsync();
                using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(
                    context.RequestAborted,
                    app.Lifetime.ApplicationStopping
                );
                await realtime.RunAsync(socket, lifetime.Token);
            }
        );
        app.MapPost(
            "/api/sessions/{id}/stop",
            async (string id, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new { error = "Session not found" });
                if (hosted.Compactor.Standalone)
                    return Results.Ok(new { stoppedCurrent = false, abortedInFlight = false });
                if (!hosted.Metadata().Busy)
                    return Results.Ok(new { stoppedCurrent = false, abortedInFlight = false });
                try
                {
                    var result = await runtime.StopAsync(hosted.Id);
                    return Results.Ok(
                        new
                        {
                            stoppedCurrent = result.StoppedCurrent,
                            abortedInFlight = result.AbortedInFlight,
                        }
                    );
                }
                catch (Exception error)
                {
                    return Results.Problem(error.Message, statusCode: 500);
                }
            }
        );
        app.MapGet(
            "/api/sessions/{id}/stream",
            async (string id, HttpContext context) =>
            {
                var hosted = await FindRouteAsync(context.Request, id);
                if (hosted is null)
                {
                    context.Response.StatusCode = 404;
                    return;
                }
                context.Response.Headers.ContentType = "text/event-stream";
                context.Response.Headers.CacheControl = "no-cache";
                var (subscriptionId, reader) = hosted.Subscribe();
                try
                {
                    await SendSse(context, new JsonObject { ["type"] = "connected" });
                    await SendSse(
                        context,
                        JsonSerializer
                            .SerializeToNode(
                                new { type = "session-state", session = hosted.State() }
                            )!
                            .AsObject()
                    );
                    await foreach (var item in reader.ReadAllAsync(context.RequestAborted))
                        await SendSse(context, WebUiContract.CliEvent(item, runtime));
                }
                catch (OperationCanceledException)
                    when (context.RequestAborted.IsCancellationRequested) { }
                catch (IOException) when (context.RequestAborted.IsCancellationRequested) { }
                finally
                {
                    hosted.Unsubscribe(subscriptionId);
                }
            }
        );
    }

    private static string? RouteIdentity(HttpRequest request, bool sessionOnly = false)
    {
        var raw = request
            .HttpContext.Features.Get<IHttpRequestFeature>()
            ?.RawTarget?.Split('?', 2)[0];
        if (raw is null)
            return null;
        // RawTarget retains encoded Session IDs even after the declared mount is removed.
        foreach (
            var segment in (request.PathBase.Value ?? "").Split(
                '/',
                StringSplitOptions.RemoveEmptyEntries
            )
        )
        {
            var next = raw.IndexOf('/', 1);
            raw = next < 0 ? "/" : raw[next..];
        }
        var parts = raw.Split('/');
        if (
            parts.Length < (sessionOnly ? 4 : 5)
            || parts[1] != "api"
            || parts[2] != "sessions"
            || parts[3].Length == 0
        )
            return null;
        try
        {
            return Uri.UnescapeDataString(parts[3]);
        }
        catch (UriFormatException)
        {
            return null;
        }
    }

    private async Task<SessionOwner?> FindRouteAsync(HttpRequest request, string routeId) =>
        RouteIdentity(request) is { } id
            ? await runtime.GetOwnerAsync(id, request.HttpContext.RequestAborted)
            : null;

    private string? CatalogRoute(HttpRequest request) =>
        RouteIdentity(request) is { } id
            ? SessionCatalog.Text(runtime.Catalog.Resolve(id)["sessionId"])
            : null;

    private static async Task SendSse(HttpContext context, JsonObject payload)
    {
        await context.Response.WriteAsync(
            "data: " + Foxwarm.Images.ImageTransport.Project(payload)!.ToJsonString() + "\n\n",
            context.RequestAborted
        );
        await context.Response.Body.FlushAsync(context.RequestAborted);
    }

    static bool ReadInt(IQueryCollection query, string name, out int? value)
    {
        value = null;
        if (!query.TryGetValue(name, out var text))
            return true;
        if (!int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed))
            return false;
        value = parsed;
        return true;
    }

    static bool ReadLong(IQueryCollection query, string name, out long? value)
    {
        value = null;
        if (!query.TryGetValue(name, out var text))
            return true;
        if (!long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed))
            return false;
        value = parsed;
        return true;
    }
}
