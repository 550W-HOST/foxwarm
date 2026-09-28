using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Globalization;
using Foxwarm.Web;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Extensions.FileProviders;

static string Required(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
    ? value : throw new InvalidOperationException($"Missing experiment host environment variable {name}.");

var dataRoot = Required("FOXWARM_EXPERIMENT_DATA_ROOT");
var workspaceRoot = Required("FOXWARM_EXPERIMENT_TOOL_ROOT");
var modelsFile = Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_MODELS_FILE");
if (string.IsNullOrWhiteSpace(modelsFile)) modelsFile = null;
var providerUri = new Uri(modelsFile is null ? Required("FOXWARM_EXPERIMENT_RESPONSES_BASE_URI")
    : Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_RESPONSES_BASE_URI") ?? "http://127.0.0.1:1/v1", UriKind.Absolute);
var providerToken = modelsFile is null ? Required("FOXWARM_EXPERIMENT_PROVIDER_TOKEN")
    : Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_PROVIDER_TOKEN") ?? "";
var apiToken = Required("FOXWARM_EXPERIMENT_API_TOKEN");
var browserCookie = Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(apiToken),
    Encoding.UTF8.GetBytes("foxwarm-experiment-cookie-v1"))).ToLowerInvariant();
var distRoot = Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_WEBUI_DIST");
if (distRoot is not null)
{
    distRoot = Path.GetFullPath(distRoot);
    if (!File.Exists(Path.Combine(distRoot, "index.html")) || !Directory.Exists(Path.Combine(distRoot, "assets")))
        throw new InvalidOperationException("Configured experimental WebUI dist needs index.html and assets/.");
}
var port = int.Parse(Required("FOXWARM_EXPERIMENT_PORT"));
if (port is <= 0 or > 65535) throw new ArgumentException("Port must be between 1 and 65535.");
var options = new ResponsesClientOptions(providerUri, modelsFile is null ? Required("FOXWARM_EXPERIMENT_REQUEST_MODEL") : "placeholder",
    modelsFile is null ? Required("FOXWARM_EXPERIMENT_CONCRETE_MODEL") : "placeholder", providerToken,
    Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_INSTRUCTIONS") ?? "",
    int.TryParse(Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_MAX_OUTPUT_TOKENS"), out var limit) ? limit : 1024);
var models = HostModels.Load(modelsFile, options);
await using var sessions = new HostSessions(dataRoot, workspaceRoot, options, models);
await sessions.LoadAsync();
var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
builder.Logging.ClearProviders();
builder.WebHost.ConfigureKestrel(server => server.Limits.MaxRequestBodySize = 2 * 1024 * 1024);
var app = builder.Build();
app.Lifetime.ApplicationStopping.Register(sessions.BeginShutdown);
if (distRoot is not null)
{
    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = new PhysicalFileProvider(Path.Combine(distRoot, "assets")), RequestPath = "/assets"
    });
    var indexPath = Path.Combine(distRoot, "index.html");
    app.Use(async (context, next) =>
    {
        if (context.Request.Method == "GET" && context.Request.Path == "/")
        {
            context.Response.ContentType = "text/html; charset=utf-8";
            await context.Response.SendFileAsync(indexPath);
            return;
        }
        await next();
    });
}
app.UseWebSockets();
app.Use(async (context, next) =>
{
    var origin = context.Request.Headers.Origin.ToString();
    if (origin.Length > 0 && origin != $"http://127.0.0.1:{port}")
    {
        context.Response.StatusCode = 403;
        return;
    }
    if (context.Request.Path == "/api/auth" && context.Request.Method == "POST")
    {
        await next();
        return;
    }
    var candidate = context.Request.Headers.Authorization.ToString();
    var expected = "Bearer " + apiToken;
    var cookie = context.Request.Cookies["foxwarm_token"] ?? "";
    if (!Equal(candidate, expected) && !Equal(cookie, browserCookie))
    {
        context.Response.StatusCode = 401;
        await context.Response.WriteAsJsonAsync(new { error = "Unauthorized" });
        return;
    }
    await next();
});
app.MapPost("/api/auth", async (HttpContext context) =>
{
    JsonObject? body;
    try { body = await JsonNode.ParseAsync(context.Request.Body) as JsonObject; }
    catch (JsonException) { return Results.BadRequest(new { error = "Invalid JSON" }); }
    if (body is null || body.Count != 1 || body["token"] is not JsonValue value
        || !value.TryGetValue<string>(out var submitted) || !Equal(submitted, apiToken))
        return Results.Unauthorized();
    context.Response.Cookies.Append("foxwarm_token", browserCookie, new CookieOptions
    {
        HttpOnly = true, SameSite = SameSiteMode.Strict, Secure = false, Path = "/",
        MaxAge = TimeSpan.FromHours(8)
    });
    return Results.Ok(new { success = true });
});
app.MapGet("/health", () => Results.Ok(new { status = "ready" }));
app.MapGet("/api/models", () => Results.Ok(models.ToWebUiPayload()));
app.MapPost("/api/sessions/{id}/model", async (string id, HttpRequest request) =>
{
    var hosted = sessions.Find(id);
    if (hosted is null) return Results.NotFound(new { error = "Session not found" });
    if (!sessions.Accepting) return Results.StatusCode(503);
    try
    {
        var body = await JsonNode.ParseAsync(request.Body) as JsonObject
            ?? throw new InvalidDataException("Model settings must be an object.");
        return Results.Ok(await hosted.UpdateModelAsync(body));
    }
    catch (Exception error) when (error is JsonException or InvalidDataException or InvalidOperationException)
    { return Results.BadRequest(new { error = error.Message }); }
});
app.MapGet("/api/commands", () => Results.Ok(new { commands = new[]
{
    new { name = "stop", description = "Stop current run, or use `/stop compact` to cancel compaction only", usage = "/stop [compact]", requiresSession = true },
    new { name = "compact", description = "Compact history.", usage = "/compact", requiresSession = true }
} }));
app.MapGet("/api/asr/status", () => Results.Ok(new { configured = false, available = false }));
app.MapGet("/api/sessions", () => Results.Ok(new { sessions = sessions.List() }));
app.MapPost("/api/sessions", async () =>
{
    try
    {
        var hosted = await sessions.CreateAsync();
        hosted.EnableCommittedNotifications();
        return Results.Ok(new { success = true, sessionId = hosted.Id });
    }
    catch (Exception error) { return Results.Problem(error.Message, statusCode: 500); }
});
app.MapGet("/api/sessions/{id}/state", (string id) =>
    sessions.Find(id) is { } hosted ? Results.Ok(new { session = hosted.State() }) : Results.NotFound(new { error = "Session not found" }));
app.MapGet("/api/sessions/{id}/history", (string id, HttpRequest request) =>
{
    var hosted = sessions.Find(id);
    if (hosted is null) return Results.NotFound(new { error = "Session not found" });
    var query = request.Query;
    if (query.Keys.Any(key => key is not ("tail" or "prefixLength" or "afterSeq" or "historyVersion")))
        return Results.BadRequest(new { error = "Invalid history query", code = "HISTORY_RANGE_INVALID" });
    if (!ReadInt(query, "tail", out var tail) || !ReadInt(query, "prefixLength", out var prefix)
        || !ReadLong(query, "afterSeq", out var after) || !ReadLong(query, "historyVersion", out var version)
        || (tail.HasValue && tail.Value is < 1 or > 500)
        || new[] { tail.HasValue, prefix.HasValue, after.HasValue }.Count(value => value) > 1
        || (version.HasValue != (prefix.HasValue || after.HasValue)))
        return Results.BadRequest(new { error = "Invalid history query", code = "HISTORY_RANGE_INVALID" });
    var snapshot = hosted.Entry.Snapshot();
    if (version.HasValue && version.Value != snapshot.HistoryVersion
        || prefix.HasValue && prefix.Value > snapshot.History.Count)
        return Results.Conflict(new { error = "History changed while loading", code = "SESSION_HISTORY_BOUNDARY_STALE",
            retryable = true, historyVersion = snapshot.HistoryVersion });
    return Results.Ok(hosted.WebUiHistory(snapshot, tail, prefix, after));
});
app.MapGet("/api/sessions/{id}/archive/messages/{seq}", (string id, string seq) =>
{
    var hosted = sessions.Find(id);
    if (hosted is null) return Results.NotFound(new { error = "Session not found" });
    if (!long.TryParse(seq, NumberStyles.None, CultureInfo.InvariantCulture, out var index)
        || index is <= 0 or > 9007199254740991L)
        return Results.BadRequest(new { error = "seq must be a positive safe integer." });
    var record = hosted.Archive.ReadMessageBySeq(index);
    return record is null ? Results.NotFound(new { error = "Archived message not found" })
        : Results.Ok(new { seq = record.Seq, message = record.Message, messageJson = record.MessageJson });
});
app.MapGet("/api/sessions/{id}/context-blocks/{blockId}/expand", (string id, string blockId, HttpRequest request) =>
{
    var hosted = sessions.Find(id);
    if (hosted is null) return Results.NotFound(new { error = "Session not found" });
    if (!long.TryParse(blockId, NumberStyles.None, CultureInfo.InvariantCulture, out var index)
        || index is <= 0 or > 9007199254740991L)
        return Results.BadRequest(new { error = "blockId must be a positive integer.", code = "INVALID_CONTEXT_BLOCK_ID" });
    var preview = 6000;
    if (request.Query.TryGetValue("previewLength", out var rawPreview)
        && (!int.TryParse(rawPreview, NumberStyles.None, CultureInfo.InvariantCulture, out preview)
            || preview is < 1 or > 20000))
        return Results.BadRequest(new { error = "previewLength must be a positive integer at most 20000." });
    var result = ContextBlockExpansion.Render(hosted.Archive, id, index, preview);
    return result is null ? Results.NotFound(new { error = $"CTX-BLOCK B#{index} not found.", code = "CTX_BLOCK_NOT_FOUND" })
        : Results.Ok(result);
});
app.MapPost("/api/sessions/{id}/message", async (string id, HttpRequest request) =>
{
    var hosted = sessions.Find(id);
    if (hosted is null) return Results.NotFound(new { error = "Session not found" });
    if (!sessions.Accepting) return Results.StatusCode(503);
    JsonObject? input;
    try { input = await JsonNode.ParseAsync(request.Body) as JsonObject; }
    catch (JsonException) { return Results.BadRequest(new { error = "Invalid JSON" }); }
    string? text = null;
    if (input?["text"] is JsonValue scalar && scalar.TryGetValue<string>(out var plain)
        && input is not null && input.All(pair => pair.Key is "text" or "clientMessageId")) text = plain;
    else if (input is not null && input["parts"] is JsonArray { Count: 1 } parts && parts[0] is JsonObject part
        && part.Count == 1 && part["text"] is JsonValue content && content.TryGetValue<string>(out var fromChat)
        && input["uploadedFiles"] is JsonArray { Count: 0 }
        && input.All(pair => pair.Key is "parts" or "uploadedFiles" or "clientMessageId")) text = fromChat;
    if (input is null || string.IsNullOrWhiteSpace(text))
        return Results.BadRequest(new { error = "This experimental endpoint accepts text-only messages, without attachments." });
    var clientId = input["clientMessageId"] is JsonValue idValue && idValue.TryGetValue<string>(out var idText)
        && idText.Length is > 0 and <= 160 ? idText : null;
    if (input.ContainsKey("clientMessageId") && clientId is null)
        return Results.BadRequest(new { error = "Invalid clientMessageId" });
    if (text.TrimStart().StartsWith("/", StringComparison.Ordinal))
    {
        if (text.Trim() == "/compact")
        {
            if (await hosted.Compactor.StartManualAsync())
                return Results.Accepted(value: new { accepted = true, compacting = true });
            return Results.Conflict(new { error = "Compaction requires an idle Session." });
        }
        if (text.Trim() == "/stop compact")
        {
            var cancelled = await hosted.Compactor.StopAsync();
            return Results.Ok(new { success = true, stoppedCompact = cancelled.Cancelled, tooLate = cancelled.TooLate });
        }
        if (text.Trim() != "/stop") return Results.UnprocessableEntity(new { error = "Unsupported experimental Session command." });
        if (hosted.Compactor.Active) return Results.Conflict(new { error = "Use /stop compact to cancel compaction only." });
        if (!hosted.Entry.Snapshot().Busy) return Results.Ok(new { success = true, stoppedCurrent = false });
        var stopped = await hosted.Registry.Control.StopAsync(id);
        await hosted.DrainAsync();
        return Results.Ok(new { success = true, stoppedCurrent = stopped.StoppedCurrent });
    }
    try
    {
        await hosted.Registry.Ingress.EnqueueAsync(id, QueueItem.UserText(text, clientMessageId: clientId));
        return Results.Accepted(value: new { accepted = true, note = "Queue save attempted; model processing and durable completion are not guaranteed." });
    }
    catch (Exception error) { return Results.Problem(error.Message, statusCode: 500); }
});
app.MapGet("/api/webui/stream", async (HttpContext context) =>
{
    if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, app.Lifetime.ApplicationStopping);
    await WebUiSocket.RunAsync(socket, sessions, lifetime.Token);
});
app.MapPost("/api/sessions/{id}/stop", async (string id) =>
{
    var hosted = sessions.Find(id);
    if (hosted is null) return Results.NotFound(new { error = "Session not found" });
    if (hosted.Compactor.Active) return Results.Conflict(new { error = "Use /stop compact to cancel compaction only." });
    if (!hosted.Entry.Snapshot().Busy) return Results.Ok(new { stoppedCurrent = false, abortedInFlight = false });
    try
    {
        var result = await hosted.Registry.Control.StopAsync(id);
        await hosted.DrainAsync();
        return Results.Ok(new { stoppedCurrent = result.StoppedCurrent, abortedInFlight = result.AbortedInFlight });
    }
    catch (Exception error) { return Results.Problem(error.Message, statusCode: 500); }
});
app.MapGet("/api/sessions/{id}/stream", async (string id, HttpContext context) =>
{
    var hosted = sessions.Find(id);
    if (hosted is null) { context.Response.StatusCode = 404; return; }
    context.Response.Headers.ContentType = "text/event-stream";
    context.Response.Headers.CacheControl = "no-cache";
    var (subscriptionId, reader) = hosted.Subscribe();
    try
    {
        await SendSse(context, new JsonObject { ["type"] = "connected" });
        await SendSse(context, JsonSerializer.SerializeToNode(new { type = "session-state", session = hosted.State() })!.AsObject());
        await foreach (var item in reader.ReadAllAsync(context.RequestAborted)) await SendSse(context, item);
    }
    catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
    catch (IOException) when (context.RequestAborted.IsCancellationRequested) { }
    finally { hosted.Unsubscribe(subscriptionId); }
});
app.MapPost("/admin/shutdown", (IHostApplicationLifetime lifetime) =>
{
    sessions.BeginShutdown();
    lifetime.StopApplication();
    return Results.Accepted();
});

try { await app.RunAsync(); }
finally
{
    await sessions.ShutdownAsync();
    await app.DisposeAsync();
}

static async Task SendSse(HttpContext context, JsonObject payload)
{
    await context.Response.WriteAsync("data: " + payload.ToJsonString() + "\n\n", context.RequestAborted);
    await context.Response.Body.FlushAsync(context.RequestAborted);
}

static bool Equal(string left, string right) =>
    CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(left), Encoding.UTF8.GetBytes(right));

static bool ReadInt(IQueryCollection query, string name, out int? value)
{
    value = null;
    if (!query.TryGetValue(name, out var text)) return true;
    if (!int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)) return false;
    value = parsed;
    return true;
}

static bool ReadLong(IQueryCollection query, string name, out long? value)
{
    value = null;
    if (!query.TryGetValue(name, out var text)) return true;
    if (!long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)) return false;
    value = parsed;
    return true;
}
