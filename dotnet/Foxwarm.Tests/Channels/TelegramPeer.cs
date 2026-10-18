using System.Collections.Concurrent;
using System.Net;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

internal sealed record TelegramPeerCall(
    string Bot,
    string Method,
    JsonObject Body,
    byte[]? Bytes = null
);

// An actual local Bot API HTTP peer; no vendor credentials or production endpoint setting.
internal sealed class TelegramPeer : IAsyncDisposable
{
    private readonly WebApplication app;
    private readonly ConcurrentDictionary<string, Channel<JsonObject>> updates = new();
    internal readonly ConcurrentQueue<TelegramPeerCall> Calls = new();
    internal readonly ConcurrentQueue<TimeSpan> Delays = new();
    internal Func<TelegramPeerCall, (int Code, string Error)?>? Fail;
    internal Func<TelegramPeerCall, Task<IResult?>>? Respond;
    internal readonly Dictionary<string, byte[]> Files = new(StringComparer.Ordinal);
    internal Uri Address = null!;
    private long update;

    private TelegramPeer(WebApplication app) => this.app = app;

    internal static async Task<TelegramPeer> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var peer = new TelegramPeer(builder.Build());
        peer.app.MapPost("/bot{bot}/{method}", peer.HandleAsync);
        peer.app.MapGet(
            "/file/bot{bot}/{**path}",
            (string path) =>
                peer.Files.TryGetValue(path, out var bytes)
                    ? Results.Bytes(bytes)
                    : Results.NotFound()
        );
        await peer.app.StartAsync();
        peer.Address = new Uri(peer.app.Urls.Single() + "/");
        return peer;
    }

    internal Foxwarm.Channels.ChannelTransportDependencies Dependencies =>
        new(
            TelegramApi: token => new Uri(Address, "bot" + token + "/"),
            TelegramFiles: token => new Uri(Address, "file/bot" + token + "/"),
            Delay: (duration, token) =>
            {
                token.ThrowIfCancellationRequested();
                Delays.Enqueue(duration);
                return Task.CompletedTask;
            }
        );

    private Channel<JsonObject> Queue(string bot) =>
        updates.GetOrAdd(bot, _ => Channel.CreateUnbounded<JsonObject>());

    internal void Push(string bot, JsonObject message) =>
        Queue(bot)
            .Writer.TryWrite(
                new JsonObject
                {
                    ["update_id"] = Interlocked.Increment(ref update),
                    ["message"] = message.DeepClone(),
                }
            );

    internal static JsonObject Text(string chat, string sender, string text, bool bot = false) =>
        new()
        {
            ["chat"] = new JsonObject { ["id"] = long.Parse(chat) },
            ["from"] = new JsonObject
            {
                ["id"] = long.Parse(sender),
                ["username"] = "peer",
                ["is_bot"] = bot,
            },
            ["text"] = text,
        };

    internal IEnumerable<TelegramPeerCall> Sent(string bot, string method = "sendMessage") =>
        Calls.Where(call => call.Bot == bot && call.Method == method);

    private async Task<IResult> HandleAsync(string bot, string method, HttpRequest request)
    {
        JsonObject body;
        byte[]? upload = null;
        if (request.HasFormContentType)
        {
            var form = await request.ReadFormAsync(request.HttpContext.RequestAborted);
            body = new JsonObject();
            foreach (var (name, value) in form)
                body[name] = value.ToString();
            if (form.Files.FirstOrDefault() is { } file)
            {
                body["uploadField"] = file.Name;
                body["filename"] = file.FileName;
                await using var stream = file.OpenReadStream();
                using var buffer = new MemoryStream();
                await stream.CopyToAsync(buffer);
                upload = buffer.ToArray();
            }
        }
        else
            body = (await request.ReadFromJsonAsync<JsonObject>())!;
        var call = new TelegramPeerCall(bot, method, body, upload);
        Calls.Enqueue(call);
        if (Respond is { } respond && await respond(call) is { } response)
            return response;
        if (Fail?.Invoke(call) is { } failure)
            return Results.Json(
                new
                {
                    ok = false,
                    error_code = failure.Code,
                    description = failure.Error,
                },
                statusCode: failure.Code
            );
        object? result = true;
        switch (method)
        {
            case "getMe":
                result = new
                {
                    id = 500,
                    is_bot = true,
                    username = "owned_bot",
                };
                break;
            case "getFile":
                result = new { file_path = body["file_id"]!.GetValue<string>() };
                break;
            case "getUpdates":
                var rows = new JsonArray();
                if (body["limit"] is not null)
                {
                    result = rows;
                    break;
                }
                try
                {
                    var next = await Queue(bot)
                        .Reader.ReadAsync(request.HttpContext.RequestAborted);
                    rows.Add(next);
                    while (Queue(bot).Reader.TryRead(out next))
                        rows.Add(next);
                }
                catch (OperationCanceledException) { }
                result = rows;
                break;
        }
        return Results.Json(new { ok = true, result });
    }

    public async ValueTask DisposeAsync()
    {
        await app.StopAsync();
        await app.DisposeAsync();
    }
}
