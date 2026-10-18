using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
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

internal sealed class WeWorkPeer : IAsyncDisposable
{
    private readonly WebApplication app;
    private readonly Channel<JsonObject> outgoing = Channel.CreateUnbounded<JsonObject>();
    internal readonly ConcurrentQueue<JsonObject> Frames = new();
    internal readonly ConcurrentQueue<ProtocolCall> Calls = new();
    internal Func<JsonObject, Task<JsonObject?>>? Ack;
    internal Func<ProtocolCall, Task<IResult?>>? Respond;
    internal readonly ConcurrentDictionary<string, byte[]> Media = new();
    internal readonly ConcurrentQueue<TimeSpan> Delays = new();
    internal int Connections;
    internal Uri Address = null!;
    internal string Webhook => new Uri(Address, "webhook?key=synthetic-key").ToString();
    internal string WsUrl => new UriBuilder(Address) { Scheme = "ws", Path = "socket" }.Uri.ToString();
    internal const string AesKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    internal static int Port()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
    private WeWorkPeer(WebApplication app) => this.app = app;

    internal static async Task<WeWorkPeer> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var peer = new WeWorkPeer(builder.Build());
        peer.app.UseWebSockets();
        peer.app.Map("/socket", peer.SocketAsync);
        peer.app.MapMethods("/{**path}", ["GET", "POST"], (Delegate)peer.HttpAsync);
        await peer.app.StartAsync();
        peer.Address = new Uri(peer.app.Urls.Single() + "/");
        return peer;
    }

    internal ChannelTransportDependencies Dependencies => new(CallbackAddress: IPAddress.Loopback,
        Delay: (span, token) => { Delays.Enqueue(span); return Task.Delay(span > TimeSpan.FromSeconds(2) ? TimeSpan.FromSeconds(2) : span, token); });

    internal JsonObject Config(int? port = null, bool stream = true, bool socket = false) => new()
    {
        ["type"] = "wework", ["webhookUrl"] = Webhook, ["allowedUsers"] = new JsonArray("alice", "bob"),
        ["selfName"] = "企业机器人",
        ["token"] = "fixture-token", ["encodingAESKey"] = AesKey,
        ["listenPort"] = port, ["listenPath"] = "/callback",
        ["aibot"] = new JsonObject
        {
            ["stream"] = stream, ["websocket"] = new JsonObject
            {
                ["enabled"] = socket, ["botId"] = "fixture-bot", ["secret"] = "fixture-secret",
                ["url"] = WsUrl, ["heartbeatMs"] = 60000, ["reconnectMs"] = 100,
            },
        },
    };

    internal static JsonObject Text(string id, string text = "hello", string chat = "wrk-chat", string user = "alice") => new()
    {
        ["msgid"] = id, ["aibotid"] = "fixture-bot", ["chatid"] = chat, ["chattype"] = "group",
        ["from"] = new JsonObject { ["userid"] = user, ["name"] = "Fixture " + user },
        ["msgtype"] = "text", ["text"] = new JsonObject { ["content"] = text },
    };

    internal void Push(JsonObject body, string reqId = "callback-request") => outgoing.Writer.TryWrite(new JsonObject
    {
        ["cmd"] = "aibot_msg_callback", ["headers"] = new JsonObject { ["req_id"] = reqId }, ["body"] = body.DeepClone(),
    });
    internal void Event(string type) => outgoing.Writer.TryWrite(new JsonObject
    {
        ["cmd"] = "aibot_event_callback", ["body"] = new JsonObject { ["event"] = new JsonObject { ["eventtype"] = type } },
    });

    private async Task SocketAsync(HttpContext context)
    {
        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        Interlocked.Increment(ref Connections);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        using var send = new SemaphoreSlim(1);
        async Task SendAsync(JsonObject message, bool fragmented)
        {
            var bytes = Encoding.UTF8.GetBytes(message.ToJsonString(new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
            await send.WaitAsync(stop.Token);
            try
            {
                // Three-byte boundaries split Unicode scalars, not just logical JSON fields.
                if (fragmented)
                    for (var offset = 0; offset < bytes.Length; offset += 3)
                        await ws.SendAsync(bytes.AsMemory(offset, Math.Min(3, bytes.Length - offset)), WebSocketMessageType.Text, offset + 3 >= bytes.Length, stop.Token);
                else
                    await ws.SendAsync(bytes, WebSocketMessageType.Text, true, stop.Token);
            }
            finally { send.Release(); }
        }
        async Task PushAsync()
        {
            try { while (!stop.IsCancellationRequested) await SendAsync(await outgoing.Reader.ReadAsync(stop.Token), true); }
            catch (OperationCanceledException) { }
            catch (WebSocketException) { }
        }
        async Task ReplyAsync(JsonObject command)
        {
            try
            {
                var ack = Ack is null ? new JsonObject() : await Ack(command).WaitAsync(stop.Token);
                if (ack is null)
                    return;
                if (ack["close"]?.GetValue<bool>() == true)
                {
                    await ws.CloseOutputAsync(WebSocketCloseStatus.InternalServerError, "fixture close", default);
                    return;
                }
                ack["headers"] = command["headers"]?.DeepClone();
                if (!ack.ContainsKey("errcode")) ack["errcode"] = 0;
                if (!ack.ContainsKey("body") && command["cmd"]?.GetValue<string>() == "aibot_upload_media_init")
                    ack["body"] = new JsonObject { ["upload_id"] = "upload-fixture" };
                if (!ack.ContainsKey("body") && command["cmd"]?.GetValue<string>() == "aibot_upload_media_finish")
                    ack["body"] = new JsonObject { ["media_id"] = "media-fixture" };
                await SendAsync(ack, false);
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException) { }
        }
        var pushing = PushAsync();
        try
        {
            var buffer = new byte[65536];
            while (ws.State == WebSocketState.Open)
            {
                using var data = new MemoryStream();
                WebSocketReceiveResult frame;
                do
                {
                    frame = await ws.ReceiveAsync(buffer, stop.Token);
                    if (frame.MessageType == WebSocketMessageType.Close)
                    {
                        await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", default);
                        return;
                    }
                    data.Write(buffer, 0, frame.Count);
                } while (!frame.EndOfMessage);
                var command = JsonNode.Parse(data.ToArray())!.AsObject();
                Frames.Enqueue(command);
                _ = ReplyAsync(command);

            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
        finally { stop.Cancel(); await pushing; }
    }

    private async Task<IResult> HttpAsync(HttpContext context)
    {
        using var buffer = new MemoryStream();
        await context.Request.Body.CopyToAsync(buffer);
        var request = context.Request;
        var call = new ProtocolCall(request.Method, request.Path, "", request.Query.ToDictionary(pair => pair.Key, pair => pair.Value.ToString()),
            request.Headers.ToDictionary(pair => pair.Key, pair => pair.Value.ToString()), buffer.ToArray());
        Calls.Enqueue(call);
        if (Respond is { } respond && await respond(call) is { } custom)
            return custom;
        if (Media.TryGetValue(request.Path, out var media))
            return Results.Bytes(media);
        return Results.Json(new { errcode = 0, media_id = "legacy-media" });
    }

    public async ValueTask DisposeAsync()
    {
        await app.StopAsync();
        await app.DisposeAsync();
    }
}
