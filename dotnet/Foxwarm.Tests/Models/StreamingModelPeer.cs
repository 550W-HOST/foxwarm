using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

// A disposable process-local provider endpoint. Test signals, not elapsed sleeps,
// decide when the ordinary client may finish, fail or be stopped.
internal sealed class StreamingModelPeer : IAsyncDisposable
{
    private readonly WebApplication app;
    private readonly CancellationTokenSource stop = new();
    private readonly Func<Context, int, Task> respond;
    private readonly object gate = new();
    internal List<JsonObject> Requests { get; } = [];
    internal Uri Uri { get; private set; } = null!;

    private StreamingModelPeer(WebApplication app, Func<Context, int, Task> respond)
    {
        this.app = app;
        this.respond = respond;
    }

    internal static async Task<StreamingModelPeer> StartAsync(bool websocket, Func<Context, int, Task> respond)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();
        var peer = new StreamingModelPeer(app, respond);
        app.UseWebSockets();
        app.Map("/responses", websocket ? peer.WebSocket : peer.Http);
        await app.StartAsync();
        peer.Uri = new Uri(app.Urls.Single());
        return peer;
    }

    private int Record(JsonObject request)
    {
        lock (gate)
        {
            Requests.Add(request);
            return Requests.Count;
        }
    }

    private async Task Http(HttpContext http)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stop.Token, http.RequestAborted);
        try
        {
            var request = (await JsonNode.ParseAsync(http.Request.Body, cancellationToken: lifetime.Token))!.AsObject();
            http.Response.ContentType = "text/event-stream";
            await http.Response.StartAsync(lifetime.Token);
            var context = new Context(request, lifetime.Token, async frame =>
            {
                await http.Response.WriteAsync("data: " + frame.ToJsonString() + "\n\n", lifetime.Token);
                await http.Response.Body.FlushAsync(lifetime.Token);
            }, http.Abort);
            await respond(context, Record(request));
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (IOException) when (lifetime.IsCancellationRequested) { }
    }

    private async Task WebSocket(HttpContext http)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stop.Token, http.RequestAborted);
        using var socket = await http.WebSockets.AcceptWebSocketAsync();
        async Task<JsonObject?> Read()
        {
            try
            {
                using var bytes = new MemoryStream();
                var buffer = new byte[16384];
                while (!lifetime.IsCancellationRequested)
                {
                    var frame = await socket.ReceiveAsync(buffer.AsMemory(), lifetime.Token);
                    if (frame.MessageType == WebSocketMessageType.Close)
                    {
                        lifetime.Cancel();
                        return null;
                    }
                    bytes.Write(buffer, 0, frame.Count);
                    if (frame.EndOfMessage)
                        return JsonNode.Parse(Encoding.UTF8.GetString(bytes.ToArray()))!.AsObject();
                }
            }
            catch (WebSocketException) { lifetime.Cancel(); }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
            return null;
        }
        try
        {
            var next = Read();
            while (await next is { } request)
            {
                next = Read(); // Also observes caller Stop while a response is held.
                var context = new Context(request, lifetime.Token,
                    frame => socket.SendAsync(Encoding.UTF8.GetBytes(frame.ToJsonString()).AsMemory(), WebSocketMessageType.Text, WebSocketMessageFlags.EndOfMessage, lifetime.Token).AsTask(),
                    () => { socket.Abort(); lifetime.Cancel(); });
                await respond(context, Record(request));
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (WebSocketException) when (lifetime.IsCancellationRequested) { }
    }

    internal sealed record Context(JsonObject Request, CancellationToken Token, Func<JsonObject, Task> Send, Action Abort);

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        await app.StopAsync();
        await app.DisposeAsync();
        stop.Dispose();
    }
}
