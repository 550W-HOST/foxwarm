using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

internal sealed class QQBotPeer : IAsyncDisposable
{
    private readonly WebApplication app;
    internal Uri Address = null!;
    internal readonly ConcurrentQueue<ProtocolCall> Calls = new();
    internal readonly ConcurrentQueue<JsonObject> Frames = new();
    internal readonly ConcurrentQueue<TimeSpan> Delays = new();
    internal readonly ConcurrentDictionary<int, WebSocket> Sockets = new();
    internal readonly ConcurrentDictionary<string, byte[]> Assets = new();
    private readonly Channel<JsonObject> outgoing = Channel.CreateUnbounded<JsonObject>();
    internal Func<ProtocolCall, Task<IResult?>>? Respond;
    internal bool AutoAck = true;
    internal int HeartbeatMs;
    internal int Connections;
    internal DateTimeOffset Now = DateTimeOffset.UtcNow;
    internal TimeSpan? MediaTimeout;
    internal TimeSpan? PartTimeout;
    private QQBotPeer(WebApplication app) => this.app = app;
    internal static async Task<QQBotPeer> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var peer = new QQBotPeer(builder.Build());
        peer.app.UseWebSockets();
        peer.app.Map("/socket", peer.SocketAsync);
        peer.app.MapMethods("/{**path}", ["GET", "POST", "PUT"], (Delegate)peer.HttpAsync);
        await peer.app.StartAsync();
        peer.Address = new(peer.app.Urls.Single() + "/");
        return peer;
    }
    internal ChannelTransportDependencies Dependencies => new(
        CreateQQBotHttp: () => new HttpClient(new PrivateTransport(Address)),
        Now: () => Now,
        Delay: (span, token) =>
        {
            Delays.Enqueue(span);
            return Task.Delay(span > TimeSpan.FromSeconds(1) ? TimeSpan.FromMilliseconds(30) : span, token);
        },
        QQBotMediaTimeout: MediaTimeout,
        QQBotPartTimeout: PartTimeout
    );
    // Only test transport rewrites the network destination. Production validators still receive the
    // exact HTTPS asset/COS URLs, and the peer records all headers sent to each logical authority.
    private sealed class PrivateTransport(Uri address) : DelegatingHandler(new SocketsHttpHandler
    {
        AllowAutoRedirect = false, UseCookies = false
    })
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var original = request.RequestUri!;
            request.Headers.Add("X-Fixture-Authority", original.Host);
            request.RequestUri = new Uri(address, original.PathAndQuery.TrimStart('/'));
            return base.SendAsync(request, token);
        }
    }
    internal JsonObject Config(bool mention = true, int batch = 0) => new()
    {
        ["type"] = "qqbot", ["appId"] = "fixture-app", ["clientSecret"] = "fixture-secret",
        ["allowedUsers"] = new JsonArray("alice", "bob"), ["requireMention"] = mention,
        ["groupBatchWindowMs"] = batch
    };
    internal static JsonObject Message(string id, string text = "hello", string sender = "alice", string group = "room", JsonArray? attachments = null) => new()
    {
        ["id"] = id, ["content"] = text, ["group_openid"] = group,
        ["author"] = new JsonObject { ["member_openid"] = sender, ["user_openid"] = sender, ["id"] = sender, ["username"] = "Name " + sender },
        ["channel_id"] = "guild-channel", ["guild_id"] = "guild-id", ["attachments"] = attachments?.DeepClone()
    };
    internal static JsonArray Attachment(string path = "/asset", string mime = "file", long? size = null) =>
        new(new JsonObject { ["filename"] = "../../fixture.bin", ["content_type"] = mime, ["size"] = size, ["url"] = "https://qpic.cn" + path });
    internal void Push(string type, JsonObject body, int sequence = 2) => Push(new JsonObject
    {
        ["op"] = 0, ["t"] = type, ["s"] = sequence, ["d"] = body.DeepClone()
    });
    internal void Push(JsonObject frame) => outgoing.Writer.TryWrite(frame);
    internal IEnumerable<ProtocolCall> Sent => Calls.Where(call => call.Path.EndsWith("/messages", StringComparison.Ordinal));
    internal static JsonObject Body(ProtocolCall call) => JsonNode.Parse(call.Bytes)!.AsObject();
    private async Task SocketAsync(HttpContext context)
    {
        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var connection = Interlocked.Increment(ref Connections);
        Sockets[connection] = ws;
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        using var sender = new SemaphoreSlim(1);
        async Task Send(JsonObject value)
        {
            await sender.WaitAsync(stop.Token);
            try
            {
                var bytes = Encoding.UTF8.GetBytes(value.ToJsonString(new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
                for (var offset = 0; offset < bytes.Length; offset += 3)
                    await ws.SendAsync(bytes.AsMemory(offset, Math.Min(3, bytes.Length - offset)),
                        WebSocketMessageType.Binary, offset + 3 >= bytes.Length, stop.Token);
            }
            finally { sender.Release(); }
        }
        async Task PushLoop()
        {
            try
            {
                while (!stop.IsCancellationRequested) await Send(await outgoing.Reader.ReadAsync(stop.Token));
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException) { }
        }
        await Send(new() { ["op"] = 10, ["d"] = new JsonObject { ["heartbeat_interval"] = HeartbeatMs } });
        var push = PushLoop();
        try
        {
            var buffer = new byte[4096];
            while (ws.State == WebSocketState.Open)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult frame;
                do
                {
                    frame = await ws.ReceiveAsync(buffer, stop.Token);
                    if (frame.MessageType == WebSocketMessageType.Close)
                    {
                        await sender.WaitAsync(stop.Token);
                        try { await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", stop.Token); }
                        finally { sender.Release(); }
                        return;
                    }
                    message.Write(buffer, 0, frame.Count);
                } while (!frame.EndOfMessage);
                var value = JsonNode.Parse(message.ToArray())!.AsObject();
                value["fixtureConnection"] = connection;
                Frames.Enqueue(value);
                if (value["op"]?.ToString() == "1" && AutoAck) await Send(new() { ["op"] = 11 });
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
        finally { stop.Cancel(); await push; Sockets.TryRemove(connection, out _); }
    }
    private async Task<IResult> HttpAsync(HttpContext context)
    {
        using var data = new MemoryStream();
        await context.Request.Body.CopyToAsync(data);
        var r = context.Request;
        var call = new ProtocolCall(r.Method, r.Path, "",
            r.Query.ToDictionary(pair => pair.Key, pair => pair.Value.ToString()),
            r.Headers.ToDictionary(pair => pair.Key, pair => pair.Value.ToString()), data.ToArray());
        Calls.Enqueue(call);
        if (Respond is { } respond && await respond(call) is { } response) return response;
        if (r.Path == "/app/getAppAccessToken") return Results.Json(new { access_token = "fixture-token", expires_in = 7200 });
        if (r.Path == "/gateway") return Results.Json(new { url = new UriBuilder(Address) { Scheme = "ws", Path = "socket" }.Uri.ToString() });
        if (Assets.TryGetValue(r.Path, out var asset)) return Results.Bytes(asset);
        if (r.Method == "PUT") return Results.Ok();
        if (r.Path.Value!.EndsWith("/upload_prepare"))
        {
            var size = Body(call)["file_size"]!.GetValue<long>();
            const int block = 3 * 1024 * 1024;
            return Results.Json(new JsonObject
            {
                ["upload_id"] = "fixture-upload", ["block_size"] = block,
                ["parts"] = new JsonArray(Enumerable.Range(1, (int)((size + block - 1) / block))
                    .Select(i => (JsonNode)new JsonObject { ["index"] = i, ["presigned_url"] = "https://cos.myqcloud.com/part/" + i }).ToArray())
            });
        }
        if (r.Path.Value.EndsWith("/files")) return Results.Json(new { file_info = "fixture-file-info" });
        return Results.Json(new { id = "fixture-outgoing" });
    }
    public async ValueTask DisposeAsync() { await app.StopAsync(); await app.DisposeAsync(); }
}
