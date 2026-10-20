using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed partial class AsrRoutesTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        internal const string Key = "synthetic-asr-service-secret";
        internal const string Token = "synthetic-human-token";
        internal readonly TempDirectory Temp = new();
        internal WebApplication Peer = null!;
        internal HttpServer Server = null!;
        internal SessionManager Manager = null!;
        internal HttpClient Client = null!;
        internal Foxwarm.Terminal.TerminalRegistry Terminals = null!;
        internal JsonObject Health = new() { ["ok"] = true, ["streamingSupported"] = true };
        internal int StreamStatus;
        internal int Requests;
        internal int Uploads;
        internal int AudioLength;
        internal JsonObject Metadata = new();
        internal readonly List<JsonObject> Controls = [];
        internal readonly List<string> ReceivedCookies = [];
        internal readonly List<string> ReceivedOrigins = [];
        internal Func<HttpContext, Task>? Upload;
        internal Func<WebSocket, HttpContext, Task>? Stream = null;
        internal Func<HttpContext, Task>? BeforeStream;
        internal string PeerUrl = "";
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string Work => Path.Combine(Temp.Path, "work");
        private readonly string? oldConfig = Environment.GetEnvironmentVariable(
            "FOXWARM_CONFIG_PATH"
        );

        internal static async Task<Fixture> Create(
            Func<string, string>? config = null,
            bool prefix = false,
            bool enabled = true
        )
        {
            var f = new Fixture();
            Directory.CreateDirectory(f.Data);
            Directory.CreateDirectory(f.Work);
            var builder = WebApplication.CreateSlimBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            f.Peer = builder.Build();
            f.Peer.UseWebSockets();
            f.Peer.Use(
                async (context, next) =>
                {
                    Interlocked.Increment(ref f.Requests);
                    lock (f.ReceivedCookies)
                    {
                        f.ReceivedCookies.Add(context.Request.Headers.Cookie.ToString());
                        f.ReceivedOrigins.Add(context.Request.Headers.Origin.ToString());
                    }
                    if (context.Request.Headers.Authorization != "Bearer " + Key)
                    {
                        context.Response.StatusCode = 401;
                        await context.Response.WriteAsJsonAsync(new { error = Key });
                        return;
                    }
                    if (context.Request.Path == "/ws/stream" && f.StreamStatus != 0)
                    {
                        context.Response.StatusCode = f.StreamStatus;
                        context.Response.Headers.Location = f.PeerUrl + "/unexpected-stream";
                        await context.Response.WriteAsJsonAsync(new { error = Key });
                        return;
                    }
                    if (context.Request.Path == "/ws/stream" && f.BeforeStream is not null)
                        await f.BeforeStream(context);
                    await next(context);
                }
            );
            f.Peer.MapGet("/health", () => f.Health);
            f.Peer.MapPost(
                "/transcribe",
                async (HttpContext context) =>
                {
                    Interlocked.Increment(ref f.Uploads);
                    if (f.Upload is not null)
                    {
                        await f.Upload(context);
                        return;
                    }
                    var form = await context.Request.ReadFormAsync(context.RequestAborted);
                    var file = form.Files.GetFile("audio")!;
                    f.AudioLength = (int)file.Length;
                    f.Metadata = new JsonObject
                    {
                        ["context"] = form["context"].ToString(),
                        ["language"] = form["language"].ToString(),
                        ["segmentSeconds"] = form["segmentSeconds"].ToString(),
                    };
                    await context.Response.WriteAsJsonAsync(
                        new
                        {
                            text = "scripted final",
                            language = "English",
                            elapsedMs = 1,
                            privatePath = "/service-private-path",
                            credential = Key,
                        }
                    );
                }
            );
            f.Peer.Map(
                "/ws/stream",
                async (HttpContext context) =>
                {
                    using var socket = await context.WebSockets.AcceptWebSocketAsync();
                    try
                    {
                        if (f.Stream is not null)
                            await f.Stream(socket, context);
                        else
                            await f.EchoStream(socket, context.RequestAborted);
                    }
                    catch (Exception error)
                        when (error is WebSocketException or OperationCanceledException) { }
                }
            );
            await f.Peer.StartAsync();
            f.PeerUrl = f.Peer.Urls.Single();
            var path = Path.Combine(f.Temp.Path, "app.yaml");
            Environment.SetEnvironmentVariable("FOXWARM_CONFIG_PATH", path);
            File.WriteAllText(
                path,
                "bot:\n  enableWebUI: "
                    + (enabled ? "true" : "false")
                    + "\n"
                    + (
                        config?.Invoke(f.PeerUrl)
                        ?? $"asrService:\n  url: {f.PeerUrl}\n  key: {Key}\n"
                    )
            );
            var model = new ModelConfiguration(f.Data);
            f.Manager = new(
                f.Data,
                f.Work,
                new ResponsesClientOptions(
                    new Uri("http://127.0.0.1:1"),
                    "local",
                    "fixture",
                    "",
                    "",
                    1000
                ),
                model.Models
            );
            await f.Manager.LoadAsync();
            var address = prefix
                ? new PublicWebAddress(
                    "https://public.example",
                    new PathString("/prefix"),
                    "/prefix/",
                    true
                )
                : new PublicWebAddress("http://127.0.0.1:0", PathString.Empty, "/", false);
            f.Terminals = new(f.Data, CancellationToken.None);
            f.Server = new([], 0, Token, null, f.Manager, f.Terminals, address, enabled);
            if (enabled)
            {
                var runtime = new SessionRuntime(f.Manager);
                new Foxwarm.Channels.WebUi.WebUIChannel(
                    f.Manager,
                    runtime,
                    new MessageRouter(runtime),
                    f.Terminals,
                    f.Server.Downloads
                ).Register(f.Server.App);
            }
            await f.Server.App.StartAsync();
            f.Client = new HttpClient(new HttpClientHandler { UseCookies = false })
            {
                BaseAddress = new Uri(f.Server.App.Urls.Single()),
                Timeout = TimeSpan.FromSeconds(60),
            };
            f.Client.DefaultRequestHeaders.ExpectContinue = true;
            f.Client.DefaultRequestHeaders.Authorization = new("Bearer", Token);
            return f;
        }

        private async Task EchoStream(WebSocket socket, CancellationToken token)
        {
            while (await Receive(socket, token) is { } frame)
            {
                if (frame.Type == WebSocketMessageType.Binary)
                {
                    AudioLength += frame.Bytes.Length;
                    await Send(socket, new { type = "partial", text = "long hypothesis" }, token);
                    await Send(socket, new { type = "partial", text = "short" }, token);
                    continue;
                }
                var body = JsonNode.Parse(frame.Bytes)!.AsObject();
                lock (Controls)
                    Controls.Add(body);
                if (body["type"]!.ToString() == "start")
                    await Send(socket, new { type = "ready", extension = "service extension" }, token);
                if (body["type"]!.ToString() == "stop")
                {
                    await Send(
                        socket,
                        new
                        {
                            type = "final",
                            text = "scripted final",
                            extension = "service extension",
                        },
                        token
                    );
                }
            }
        }

        internal async Task<ClientWebSocket> Connect(
            string path = "/api/asr/stream",
            string? origin = null,
            string? credential = Token
        )
        {
            var socket = new ClientWebSocket();
            if (credential is not null)
                socket.Options.SetRequestHeader("Authorization", "Bearer " + credential);
            if (origin is not null)
                socket.Options.SetRequestHeader("Origin", origin);
            var uri = new UriBuilder(new Uri(Client.BaseAddress!, path)) { Scheme = "ws" };
            try
            {
                await socket.ConnectAsync(uri.Uri, CancellationToken.None);
                return socket;
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        }

        internal MultipartFormDataContent Audio(int bytes, string? context = null)
        {
            var form = new MultipartFormDataContent();
            var audio = new ByteArrayContent(new byte[bytes]);
            audio.Headers.ContentType = new("audio/wav");
            form.Add(audio, "audio", "synthetic.wav");
            if (context is not null)
                form.Add(new StringContent(context), "context");
            return form;
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await Server.App.StopAsync();
            await Server.App.DisposeAsync();
            await Terminals.DisposeAsync();
            await Manager.DisposeAsync();
            await Peer.StopAsync();
            await Peer.DisposeAsync();
            Environment.SetEnvironmentVariable("FOXWARM_CONFIG_PATH", oldConfig);
            Temp.Dispose();
        }
    }

    private sealed record Received(WebSocketMessageType Type, byte[] Bytes);

    private static async Task<Received?> Receive(
        WebSocket socket,
        CancellationToken token = default
    )
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(40));
        using var data = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var part = await socket.ReceiveAsync(buffer, timeout.Token);
            if (part.MessageType == WebSocketMessageType.Close)
                return null;
            data.Write(buffer, 0, part.Count);
            if (part.EndOfMessage)
                return new(part.MessageType, data.ToArray());
        }
    }

    private static Task Send(WebSocket socket, object value, CancellationToken token = default) =>
        socket.SendAsync(
            Encoding.UTF8.GetBytes(System.Text.Json.JsonSerializer.Serialize(value)),
            WebSocketMessageType.Text,
            true,
            token
        );

    private static async Task<JsonObject> Json(WebSocket socket) =>
        JsonNode.Parse((await Receive(socket))!.Bytes)!.AsObject();

    private static async Task<JsonObject> Json(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonObject>())!;
}
