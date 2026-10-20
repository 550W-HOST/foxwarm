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
    Foxwarm.Terminal.TerminalRegistry terminals,
    WebUiDownloadSignatures downloads
)
{
    private readonly WebUiLogFile logs = new(
        MainLog.Destination(sessions.Models.ConfigurationOwner, sessions.DataRoot)
    );
    private WebUiRealtime realtime = null!;
    private readonly Foxwarm.Terminal.TerminalRouter terminalRouter = new(
        terminals,
        sessions.Nodes
    );

    public void Register(WebApplication app)
    {
        realtime = new WebUiRealtime(runtime, logs);
        app.Lifetime.ApplicationStopped.Register(logs.Dispose);
        RegisterLogRoutes(app);
        sessions.ChannelRegistry.Register(
            "webui",
            (conversation, message, token) =>
            {
                token.ThrowIfCancellationRequested();
                sessions.PresentChannelText(conversation, message);
                return Task.CompletedTask;
            }
        );
        app.Lifetime.ApplicationStopped.Register(() =>
            sessions.ChannelRegistry.Unregister("webui")
        );
        var models = sessions.Models;
        app.Lifetime.ApplicationStopped.Register(() =>
            terminalRouter.DisposeAsync().AsTask().GetAwaiter().GetResult()
        );
        app.Use(
            async (context, next) =>
            {
                try
                {
                    await next();
                }
                catch (OperationCanceledException)
                    when (context.RequestAborted.IsCancellationRequested) { }
                catch (WebUiAccessException) when (!context.Response.HasStarted)
                {
                    await Results
                        .Json(
                            new
                            {
                                error = "WebUI identity session binding changed.",
                                code = "WEBUI_SESSION_NOT_ALLOWED",
                            },
                            statusCode: 403
                        )
                        .ExecuteAsync(context);
                }
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
        RegisterSessionNodeRoutes(app);
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
            () => Results.Ok(new { commands = Foxwarm.Channels.ExternalCommands.WebUiCommands() })
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
        RegisterTaskRoutes(app);
        RegisterUploadAndImageRoutes(app);
        RegisterFileRoutes(app);
        RegisterArtifactRoutes(app);
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
                                or "controlRequestId"
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
                var controlId = SessionWait.Text(input["controlRequestId"]);
                if (
                    input.ContainsKey("controlRequestId")
                    && (controlId is null || controlId.Length is < 1 or > 128)
                )
                    return Results.BadRequest(new { error = "Invalid controlRequestId" });
                var scoped = WebUiAccess.Request(request);
                if (scoped is not null)
                {
                    if (
                        input["parts"] is JsonArray scopedParts
                        && scopedParts.Any(part =>
                            part is not JsonObject obj
                            || obj.Count != 1
                            || SessionWait.Text(obj["text"]) is null
                        )
                    )
                        return Results.BadRequest(
                            new { error = "WebUI identity messages may only include text parts." }
                        );
                    bool Slash(string value) =>
                        System.Text.RegularExpressions.Regex.IsMatch(
                            value,
                            @"^\s*(?:@[a-zA-Z_\-.]+\s+)?/"
                        );
                    var partsText = string.Join(
                        "\n",
                        (input["parts"] as JsonArray ?? [])
                            .OfType<JsonObject>()
                            .Select(part => SessionWait.Text(part["text"]) ?? "")
                    );
                    if (Slash(text) || Slash(partsText))
                        return Results.Json(
                            new
                            {
                                error = "WebUI identity tokens cannot use slash commands.",
                                code = "WEBUI_COMMANDS_DISABLED",
                            },
                            statusCode: 403
                        );
                }
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
                    if (scoped is not null && hasUploads)
                        foreach (
                            var entry in input["uploadedFiles"] as JsonArray
                                ?? input["filePaths"] as JsonArray
                                ?? []
                        )
                        {
                            var path =
                                SessionWait.Text(entry)
                                ?? SessionWait.Text((entry as JsonObject)?["path"]);
                            if (path is null)
                                throw new WebUiAccessException();
                            scoped.RequireUpload(ingressOwner!.Id, path);
                        }
                    using var ingress = hasUploads
                        ? sessions.BeginFileIngress(ingressOwner!)
                        : null;
                    var prepared = await new WebUiUploadedFiles(sessions).PrepareAsync(
                        input,
                        ingressOwner,
                        request.HttpContext.RequestAborted,
                        scoped
                    );
                    savedFiles = prepared.SavedFiles;
                    scoped?.Require(canonical);
                    sessions.AttachWebUi(canonical!, ingressOwner);
                    if (ingressOwner is not null)
                        canonical = ingressOwner.Id;
                    var result = await router.HandleMessageAsync(
                        new ChannelContext(canonical, "webui"),
                        new ChannelMessage(text, clientId, prepared.Parts, controlId),
                        hasUploads || scoped is not null ? ingressOwner : null,
                        scoped is null ? null : () => scoped.Require(ingressOwner!.Id)
                    );
                    return Results.Json(result.Value, statusCode: result.Status);
                }
                catch (WebUiAccessException)
                {
                    return Results.Json(
                        new { error = "WebUI identity session binding changed.", savedFiles },
                        statusCode: 403
                    );
                }
                catch (UploadPreparationException error)
                {
                    return Results.Json(
                        new { error = error.Message, savedFiles = error.SavedFiles },
                        statusCode: error.InnerException is WebUiAccessException ? 403
                            : error.InvalidInput ? 400
                            : 500
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
                await realtime.RunAsync(socket, lifetime.Token, WebUiAccess.Request(context));
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
                var scoped = WebUiAccess.Request(context);
                var canonicalId = hosted.Id;
                context.Response.Headers.ContentType = "text/event-stream";
                context.Response.Headers.CacheControl = "no-cache";
                context.Response.Headers["X-Accel-Buffering"] = "no";
                using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(
                    context.RequestAborted, app.Lifetime.ApplicationStopping);
                var (subscriptionId, reader) = hosted.Subscribe();
                try
                {
                    await SendSse(context, new JsonObject { ["type"] = "connected" });
                    await SendSse(
                        context,
                        JsonSerializer
                            .SerializeToNode(
                                new
                                {
                                    type = "session-state",
                                    session = scoped is null
                                        ? hosted.BuildDto()
                                        : scoped.Session(hosted.BuildDto()),
                                }
                            )!
                            .AsObject()
                    );
                    var available = reader.WaitToReadAsync(lifetime.Token).AsTask();
                    var keepAlive = Task.Delay(TimeSpan.FromSeconds(30), lifetime.Token);
                    var deleted = false;
                    while (!deleted)
                    {
                        await Task.WhenAny(available, keepAlive);
                        scoped?.Require(canonicalId);
                        if (keepAlive.IsCompleted)
                        {
                            await keepAlive;
                            await context.Response.WriteAsync(": keep-alive\n\n", lifetime.Token);
                            await context.Response.Body.FlushAsync(lifetime.Token);
                            keepAlive = Task.Delay(TimeSpan.FromSeconds(30), lifetime.Token);
                        }
                        if (!available.IsCompleted)
                            continue;
                        if (!await available)
                            break;
                        while (reader.TryRead(out var item))
                        {
                            if (item.Kind == SessionEventKind.RequestProgress)
                                continue;
                            var payload = WebUiContract.Event(item, runtime);
                            if (scoped is not null && payload["session"] is JsonObject session)
                                payload["session"] = scoped.Session(session);
                            await SendSse(context, payload);
                            if (item.Kind == SessionEventKind.Deleted)
                            {
                                deleted = true;
                                break;
                            }
                        }
                        available = reader.WaitToReadAsync(lifetime.Token).AsTask();
                    }
                }
                catch (WebUiAccessException)
                {
                    context.Abort();
                }
                catch (OperationCanceledException)
                    when (lifetime.IsCancellationRequested) { }
                catch (IOException) when (context.RequestAborted.IsCancellationRequested) { }
                finally
                {
                    lifetime.Cancel();
                    hosted.Unsubscribe(subscriptionId);
                }
            }
        );
    }

    internal static string? RouteIdentity(HttpRequest request, bool sessionOnly = false)
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

    private async Task<SessionOwner?> FindRouteAsync(HttpRequest request, string routeId)
    {
        if (RouteIdentity(request) is not { } id)
            return null;
        var scoped = WebUiAccess.Request(request);
        var canonical = scoped?.Bind(id);
        var owner = await runtime.GetOwnerAsync(id, request.HttpContext.RequestAborted);
        scoped?.Require(id);
        if (scoped is not null && owner?.Id != canonical)
            throw new WebUiAccessException();
        return owner;
    }

    private string? CatalogRoute(HttpRequest request) =>
        RouteIdentity(request) is { } id
            ? SessionCatalog.Text(runtime.Catalog.Resolve(id)["sessionId"])
            : null;

    private static async Task SendSse(HttpContext context, JsonObject payload)
    {
        WebUiAccess.Request(context)?.Require();
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
