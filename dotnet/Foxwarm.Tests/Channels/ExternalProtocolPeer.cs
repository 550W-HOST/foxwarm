using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

internal sealed record ProtocolCall(
    string Method,
    string Path,
    string Key,
    Dictionary<string, string> Query,
    Dictionary<string, string> Headers,
    byte[] Bytes
)
{
    internal JsonObject Body =>
        Bytes.Length == 0 ? new() : JsonNode.Parse(Bytes) as JsonObject ?? new();
}

// Controlled Matrix homeserver and ilink protocol peer. Never contacts an account service.
internal sealed class ExternalProtocolPeer : IAsyncDisposable
{
    private readonly WebApplication app;
    private readonly ConcurrentDictionary<string, Channel<JsonObject>> queues = new();
    private readonly ConcurrentDictionary<string, int> syncs = new();
    private long cursor;
    internal readonly ConcurrentQueue<ProtocolCall> Calls = new();
    internal readonly ConcurrentQueue<TimeSpan> Delays = new();
    internal readonly ConcurrentDictionary<string, byte[]> Media = new();
    internal Func<ProtocolCall, Task<IResult?>>? Respond;
    internal Uri Address = null!;
    internal string QrStatus = "confirmed";
    internal string Owner = "owner";

    private ExternalProtocolPeer(WebApplication app) => this.app = app;

    internal static async Task<ExternalProtocolPeer> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var peer = new ExternalProtocolPeer(builder.Build());
        peer.app.MapMethods("/{**path}", ["GET", "POST", "PUT"], (Delegate)peer.HandleAsync);
        await peer.app.StartAsync();
        peer.Address = new Uri(peer.app.Urls.Single() + "/");
        return peer;
    }

    internal ChannelTransportDependencies Dependencies =>
        new(
            Delay: (duration, token) =>
            {
                token.ThrowIfCancellationRequested();
                Delays.Enqueue(duration);
                return Task.CompletedTask;
            }
        );

    internal JsonObject Matrix(string key = "matrix-a", string user = "@bot:fixture") =>
        new()
        {
            ["type"] = "matrix",
            ["homeserver"] = Address.ToString().TrimEnd('/'),
            ["accessToken"] = key,
            ["botUserId"] = user,
            ["allowedUsers"] = new JsonArray("@sender:fixture", "@other:fixture"),
        };

    internal JsonObject Weixin(string key = "weixin-a") =>
        new()
        {
            ["type"] = "weixin",
            ["baseUrl"] = Address.ToString().TrimEnd('/'),
            ["token"] = key,
            ["routeTag"] = "synthetic-route",
            ["longPollTimeoutMs"] = 80,
            ["allowedUsers"] = new JsonArray("alice", "bob"),
        };

    private Channel<JsonObject> Queue(string key) =>
        queues.GetOrAdd(key, _ => Channel.CreateUnbounded<JsonObject>());

    internal void Push(string key, JsonObject response) => Queue(key).Writer.TryWrite(response);

    internal void MatrixEvents(string key, string room, params JsonObject[] events) =>
        Push(
            key,
            new JsonObject
            {
                ["next_batch"] = "cursor-" + Interlocked.Increment(ref cursor),
                ["rooms"] = new JsonObject
                {
                    ["join"] = new JsonObject
                    {
                        [room] = new JsonObject
                        {
                            ["timeline"] = new JsonObject
                            {
                                ["events"] = new JsonArray(
                                    events.Select(item => (JsonNode)item.DeepClone()).ToArray()
                                ),
                            },
                        },
                    },
                },
            }
        );

    internal void WeixinMessages(string key, params JsonObject[] messages) =>
        Push(
            key,
            new JsonObject
            {
                ["ret"] = 0,
                ["get_updates_buf"] = "cursor-" + Interlocked.Increment(ref cursor),
                ["msgs"] = new JsonArray(
                    messages.Select(item => (JsonNode)item.DeepClone()).ToArray()
                ),
            }
        );

    internal static JsonObject MatrixText(
        string id,
        string text,
        string sender = "@sender:fixture"
    ) =>
        new()
        {
            ["type"] = "m.room.message",
            ["event_id"] = id,
            ["sender"] = sender,
            ["origin_server_ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["content"] = new JsonObject { ["msgtype"] = "m.text", ["body"] = text },
        };

    internal static JsonObject WeixinText(
        string user,
        string text,
        string? context = "context-alice"
    ) =>
        new()
        {
            ["from_user_id"] = user,
            ["context_token"] = context,
            ["item_list"] = new JsonArray(
                new JsonObject
                {
                    ["type"] = 1,
                    ["text_item"] = new JsonObject { ["text"] = text },
                }
            ),
        };

    internal ProtocolCall[] Sent(string key) =>
        Calls
            .Where(call =>
                call.Key == key
                && (
                    call.Path.Contains("/send/m.room.message/", StringComparison.Ordinal)
                    || call.Path.EndsWith("/sendmessage", StringComparison.Ordinal)
                )
            )
            .ToArray();

    private async Task<IResult> HandleAsync(HttpContext context)
    {
        var request = context.Request;
        using var buffer = new MemoryStream();
        await request.Body.CopyToAsync(buffer);
        var key = request.Headers.Authorization.ToString().Replace("Bearer ", "");
        var call = new ProtocolCall(
            request.Method,
            request.Path.ToString(),
            key,
            request.Query.ToDictionary(pair => pair.Key, pair => pair.Value.ToString()),
            request.Headers.ToDictionary(
                pair => pair.Key,
                pair => pair.Value.ToString(),
                StringComparer.OrdinalIgnoreCase
            ),
            buffer.ToArray()
        );
        Calls.Enqueue(call);
        if (Respond is { } respond && await respond(call) is { } custom)
            return custom;
        if (call.Path.EndsWith("/versions", StringComparison.Ordinal))
            return Results.Json(new { versions = new[] { "v1.11" }, unstable_features = new { } });
        if (call.Path.EndsWith("/pushrules/", StringComparison.Ordinal))
            return Results.Json(new { global = new { } });
        if (call.Path.EndsWith("/capabilities", StringComparison.Ordinal))
            return Results.Json(new { capabilities = new { } });
        if (call.Path.EndsWith("/filter", StringComparison.Ordinal))
            return Results.Json(new { filter_id = "fixture-filter" });
        if (call.Path.Contains("/join/", StringComparison.Ordinal))
            return Results.Json(new { room_id = "!invite:fixture" });
        if (call.Path.EndsWith("/sync", StringComparison.Ordinal))
        {
            if (syncs.AddOrUpdate(key, 1, (_, count) => count + 1) == 1)
                return Results.Json(
                    new
                    {
                        next_batch = "initial",
                        rooms = new { },
                        to_device = new { events = Array.Empty<object>() },
                    }
                );
            try
            {
                return Results.Json(
                    await Queue(key).Reader.ReadAsync(request.HttpContext.RequestAborted)
                );
            }
            catch (OperationCanceledException)
            {
                return Results.Json(new { next_batch = "aborted" });
            }
        }
        if (call.Path.EndsWith("/getupdates", StringComparison.Ordinal))
        {
            try
            {
                return Results.Json(
                    await Queue(key).Reader.ReadAsync(request.HttpContext.RequestAborted)
                );
            }
            catch (OperationCanceledException)
            {
                return Results.Json(new { ret = 0, msgs = Array.Empty<object>() });
            }
        }
        if (call.Path.EndsWith("/get_bot_qrcode", StringComparison.Ordinal))
            return Results.Json(
                new
                {
                    qrcode = "synthetic QR?code",
                    qrcode_img_content = "data:image/png;base64,iVBORw0KGgo=",
                }
            );
        if (call.Path.EndsWith("/get_qrcode_status", StringComparison.Ordinal))
            return Results.Json(
                new
                {
                    status = QrStatus,
                    bot_token = "confirmed-token",
                    ilink_bot_id = "bot",
                    baseurl = Address.ToString().TrimEnd('/'),
                    ilink_user_id = Owner,
                }
            );
        if (call.Path.Contains("/send/m.room.message/", StringComparison.Ordinal))
            return Results.Json(new { event_id = "$sent" });
        if (
            call.Path.Contains("/typing/", StringComparison.Ordinal)
            || call.Path.EndsWith("/sendmessage", StringComparison.Ordinal)
            || call.Path.EndsWith("/sendtyping", StringComparison.Ordinal)
        )
            return Results.Json(new { ret = 0 });
        if (call.Path.EndsWith("/upload", StringComparison.Ordinal))
            return Results.Json(new { content_uri = "mxc://fixture/uploaded" });
        if (call.Path.Contains("/download/", StringComparison.Ordinal))
            return Media.TryGetValue(call.Path[(call.Path.LastIndexOf('/') + 1)..], out var bytes)
                ? Results.Bytes(bytes)
                : Results.NotFound();
        return Results.Json(new { errcode = "M_UNRECOGNIZED" }, statusCode: 404);
    }

    public async ValueTask DisposeAsync()
    {
        await app.StopAsync();
        await app.DisposeAsync();
    }
}
