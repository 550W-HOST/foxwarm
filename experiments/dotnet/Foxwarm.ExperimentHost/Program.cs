using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.ExperimentHost;
using Foxwarm.OpenAIResponses.Client;
using Foxwarm.SessionTurns;

static string Required(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
    ? value : throw new InvalidOperationException($"Missing experiment host environment variable {name}.");

var dataRoot = Required("FOXWARM_EXPERIMENT_DATA_ROOT");
var workspaceRoot = Required("FOXWARM_EXPERIMENT_TOOL_ROOT");
var providerUri = new Uri(Required("FOXWARM_EXPERIMENT_RESPONSES_BASE_URI"), UriKind.Absolute);
var providerToken = Required("FOXWARM_EXPERIMENT_PROVIDER_TOKEN");
var apiToken = Required("FOXWARM_EXPERIMENT_API_TOKEN");
var port = int.Parse(Required("FOXWARM_EXPERIMENT_PORT"));
if (port is <= 0 or > 65535) throw new ArgumentException("Port must be between 1 and 65535.");
var options = new ResponsesClientOptions(providerUri, Required("FOXWARM_EXPERIMENT_REQUEST_MODEL"),
    Required("FOXWARM_EXPERIMENT_CONCRETE_MODEL"), providerToken,
    Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_INSTRUCTIONS") ?? "",
    int.TryParse(Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_MAX_OUTPUT_TOKENS"), out var limit) ? limit : 1024);
await using var sessions = new HostSessions(dataRoot, workspaceRoot, options);
await sessions.LoadAsync();
var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
builder.Logging.ClearProviders();
builder.WebHost.ConfigureKestrel(server => server.Limits.MaxRequestBodySize = 2 * 1024 * 1024);
var app = builder.Build();
app.Lifetime.ApplicationStopping.Register(sessions.BeginShutdown);
app.Use(async (context, next) =>
{
    var candidate = context.Request.Headers.Authorization.ToString();
    var expected = "Bearer " + apiToken;
    if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(candidate), Encoding.UTF8.GetBytes(expected)))
    {
        context.Response.StatusCode = 401;
        await context.Response.WriteAsJsonAsync(new { error = "Unauthorized" });
        return;
    }
    await next();
});
app.MapGet("/health", () => Results.Ok(new { status = "ready" }));
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
app.MapGet("/api/sessions/{id}/history", (string id) =>
    sessions.Find(id) is { } hosted ? Results.Ok(new { messages = hosted.History(), nextMessageSeq = hosted.Entry.Snapshot().NextMessageSeq })
        : Results.NotFound(new { error = "Session not found" }));
app.MapPost("/api/sessions/{id}/message", async (string id, HttpRequest request) =>
{
    var hosted = sessions.Find(id);
    if (hosted is null) return Results.NotFound(new { error = "Session not found" });
    if (!sessions.Accepting) return Results.StatusCode(503);
    JsonObject? input;
    try { input = await JsonNode.ParseAsync(request.Body) as JsonObject; }
    catch (JsonException) { return Results.BadRequest(new { error = "Invalid JSON" }); }
    if (input is null || input["text"] is not JsonValue scalar || !scalar.TryGetValue<string>(out var text)
        || string.IsNullOrWhiteSpace(text) || input.Any(pair => pair.Key is not ("text" or "clientMessageId")))
        return Results.BadRequest(new { error = "This experimental endpoint accepts nonempty text and optional clientMessageId only." });
    var clientId = input["clientMessageId"] is JsonValue idValue && idValue.TryGetValue<string>(out var idText)
        && idText.Length is > 0 and <= 160 ? idText : null;
    if (input.ContainsKey("clientMessageId") && clientId is null)
        return Results.BadRequest(new { error = "Invalid clientMessageId" });
    try
    {
        await hosted.Registry.Ingress.EnqueueAsync(id, QueueItem.UserText(text, clientMessageId: clientId));
        return Results.Accepted(value: new { accepted = true, note = "Queue save attempted; model processing and durable completion are not guaranteed." });
    }
    catch (Exception error) { return Results.Problem(error.Message, statusCode: 500); }
});
app.MapPost("/api/sessions/{id}/stop", async (string id) =>
{
    var hosted = sessions.Find(id);
    if (hosted is null) return Results.NotFound(new { error = "Session not found" });
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
