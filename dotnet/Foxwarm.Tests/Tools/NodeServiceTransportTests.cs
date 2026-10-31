using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed class NodeServiceTransportTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal SessionManager Manager = null!;
        internal WebApplication App = null!;
        private readonly List<ClientWebSocket> sockets = [];

        internal async Task Start()
        {
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "a",
                "",
                "",
                713
            );
            Manager = new(
                Path.Combine(Temp.Path, "data"),
                Path.Combine(Temp.Path, "work"),
                options,
                HostModels.ForTest(options)
            );
            await Manager.LoadAsync();
            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            App = builder.Build();
            App.UseWebSockets();
            App.Map("/node_ws", Manager.Nodes.HandleAsync);
            await App.StartAsync();
        }

        internal async Task<ClientWebSocket> Connect(
            string id,
            JsonObject services,
            JsonObject? credential = null
        )
        {
            credential ??= Manager.Nodes.Registry.Create(id);
            var socket = new ClientWebSocket();
            sockets.Add(socket);
            await socket.ConnectAsync(
                new Uri(
                    App.Urls.Single().Replace("http", "ws")
                        + "/node_ws?id="
                        + id
                        + "&auth="
                        + credential["authToken"]!.GetValue<string>()
                ),
                default
            );
            await Send(
                socket,
                new()
                {
                    ["type"] = "node_register",
                    ["nodeType"] = "service-protocol-peer",
                    ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
                    ["capabilities"] = new JsonObject
                    {
                        ["tools"] = new JsonArray(),
                        ["services"] = services,
                    },
                }
            );
            Assert.Equal("registered", (await Read(socket))["type"]!.ToString());
            return socket;
        }

        internal static async Task Send(ClientWebSocket socket, JsonObject value) =>
            await socket.SendAsync(
                Encoding.UTF8.GetBytes(value.ToJsonString()),
                WebSocketMessageType.Text,
                true,
                default
            );

        internal static async Task<JsonObject> Read(ClientWebSocket socket)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var stream = new MemoryStream();
            var buffer = new byte[65536];
            WebSocketReceiveResult frame;
            do
            {
                frame = await socket.ReceiveAsync(buffer, deadline.Token);
                stream.Write(buffer, 0, frame.Count);
            } while (!frame.EndOfMessage);
            return JsonNode.Parse(stream.ToArray())!.AsObject();
        }

        internal static JsonObject Reply(JsonObject request, string marker) =>
            new()
            {
                ["type"] = "node_service_response",
                ["requestId"] = request["requestId"]!.DeepClone(),
                ["result"] = new JsonObject { ["marker"] = marker },
            };

        internal static async Task Fence(ClientWebSocket socket)
        {
            await Send(socket, new() { ["type"] = "ping" });
            Assert.Equal("pong", (await Read(socket))["type"]!.ToString());
        }

        public async ValueTask DisposeAsync()
        {
            foreach (var socket in sockets)
            {
                socket.Abort();
                socket.Dispose();
            }
            if (App is not null)
            {
                await App.StopAsync();
                await App.DisposeAsync();
            }
            if (Manager is not null)
                await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    [Fact]
    public async Task Versioned_services_are_advertised_and_exact_connection_request_and_service_are_correlated()
    {
        await using var f = new Fixture();
        await f.Start();
        var one = await f.Connect("one", new() { ["vscode-fs"] = 1, ["vscode-git"] = 1 });
        var two = await f.Connect("two", new() { ["vscode-fs"] = 1 });
        Assert.Equal(1, f.Manager.Nodes.List()[0]!["services"]!["vscode-git"]!.GetValue<int>());
        var unsupported = Assert.Throws<CodeServiceException>(() =>
            f.Manager.Nodes.Service("one", "vscode-git", 2)
        );
        Assert.Equal("UnsupportedService", unsupported.Code);
        Assert.Throws<CodeServiceException>(() => f.Manager.Nodes.Service("two", "vscode-pty"));
        var pending = f.Manager.Nodes.RequestServiceAsync(
            "one",
            "vscode-fs",
            "stat",
            new() { ["path"] = "/real-remote" },
            default
        );
        var request = await Fixture.Read(one);
        Assert.Equal("node_service_request", request["type"]!.ToString());
        Assert.Equal("vscode-fs", request["service"]!.ToString());
        Assert.Null(request["sessionId"]);
        Assert.Null(request["agentName"]);
        await Fixture.Send(two, Fixture.Reply(request, "wrong-node"));
        await Fixture.Fence(two);
        var wrong = Fixture.Reply(request, "wrong-service");
        wrong["service"] = "vscode-git";
        await Fixture.Send(one, wrong);
        await Fixture.Fence(one);
        Assert.False(pending.IsCompleted);
        await Fixture.Send(one, Fixture.Reply(request, "right"));
        Assert.Equal("right", (await pending)["marker"]!.ToString());
        var target = f.Manager.Nodes.Service("one", "vscode-fs");
        await f.Manager.Nodes.CommandServiceAsync(target, "stat", new() { ["path"] = "/fixed" });
        Assert.Equal("node_service_command", (await Fixture.Read(one))["type"]!.ToString());
    }

    [Fact]
    public async Task Cancellation_disconnect_and_replacement_release_only_their_service_correlations()
    {
        await using var f = new Fixture();
        await f.Start();
        var credential = f.Manager.Nodes.Registry.Create("one");
        var one = await f.Connect("one", new() { ["vscode-pty"] = 1 }, credential);
        var target = f.Manager.Nodes.Service("one", "vscode-pty");
        using var stop = new CancellationTokenSource();
        var canceled = f.Manager.Nodes.RequestServiceAsync(target, "create", new(), stop.Token);
        var first = await Fixture.Read(one);
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => canceled);
        var second = f.Manager.Nodes.RequestServiceAsync(target, "get", new(), default);
        var next = await Fixture.Read(one);
        await Fixture.Send(one, Fixture.Reply(first, "late"));
        await Fixture.Fence(one);
        Assert.False(second.IsCompleted);
        var replacement = await f.Connect("one", new() { ["vscode-pty"] = 1 }, credential);
        var error = await Assert.ThrowsAsync<CodeServiceException>(() => second);
        Assert.Equal("NodeUnavailable", error.Code);
        await Assert.ThrowsAsync<CodeServiceException>(() =>
            f.Manager.Nodes.CommandServiceAsync(target, "input", new())
        );
        var staleRead = await Assert.ThrowsAsync<CodeServiceException>(() =>
            f.Manager.Nodes.RequestServiceAsync(target, "get", new(), default)
        );
        Assert.Equal("NodeUnavailable", staleRead.Code);
        var replacementTarget = f.Manager.Nodes.Service("one", "vscode-pty");
        Assert.NotEqual(target.ConnectionId, replacementTarget.ConnectionId);
        var replacementCall = f.Manager.Nodes.RequestServiceAsync(
            replacementTarget,
            "get",
            new(),
            default
        );
        var current = await Fixture.Read(replacement);
        await Fixture.Send(replacement, Fixture.Reply(first, "stale-request"));
        await Fixture.Fence(replacement);
        Assert.False(replacementCall.IsCompleted);
        await Fixture.Send(replacement, Fixture.Reply(current, "reconnected"));
        Assert.Equal("reconnected", (await replacementCall)["marker"]!.ToString());
        var unfinished = f.Manager.Nodes.RequestServiceAsync(
            replacementTarget,
            "attach",
            new(),
            default
        );
        await Fixture.Read(replacement);
        f.Manager.Nodes.Disconnect("one", "Owned test disconnect");
        Assert.Equal(
            "NodeUnavailable",
            (await Assert.ThrowsAsync<CodeServiceException>(() => unfinished)).Code
        );
    }

    [Fact]
    public async Task Service_errors_and_immediate_output_preserve_consumer_readiness_and_canceled_receivers_are_not_reused()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await f.Connect("one", new() { ["vscode-pty"] = 1 });
        var endpoint = f.Manager.Nodes.Service("one", "vscode-pty");
        var errorCall = f.Manager.Nodes.RequestServiceAsync(endpoint, "attach", new(), default);
        var errorRequest = await Fixture.Read(socket);
        await Fixture.Send(
            socket,
            new()
            {
                ["type"] = "node_service_error",
                ["requestId"] = errorRequest["requestId"]!.DeepClone(),
                ["error"] = new JsonObject
                {
                    ["code"] = "TerminalNotFound",
                    ["message"] = "Real peer rejection",
                    ["statusCode"] = 404,
                },
            }
        );
        var failure = await Assert.ThrowsAsync<CodeServiceException>(() => errorCall);
        Assert.Equal("TerminalNotFound", failure.Code);
        Assert.Equal(404, failure.Status);
        var events = new List<string>();
        f.Manager.Nodes.ServiceReceived += value => events.Add(value.Event["data"]!.ToString());
        var attaching = f.Manager.Nodes.RequestServiceAsync(
            endpoint,
            "attach",
            new(),
            default,
            _ => events.Add("ready/backlog")
        );
        var request = await Fixture.Read(socket);
        await Fixture.Send(socket, Fixture.Reply(request, "attached"));
        await Fixture.Send(
            socket,
            new()
            {
                ["type"] = "node_service_event",
                ["service"] = "vscode-pty",
                ["event"] = new JsonObject
                {
                    ["type"] = "output",
                    ["terminalId"] = "fixture",
                    ["data"] = "immediate output",
                },
            }
        );
        await Fixture.Fence(socket);
        await attaching;
        Assert.Equal(new[] { "ready/backlog", "immediate output" }, events);
        using var cancellation = new CancellationTokenSource();
        var canceled = f.Manager.Nodes.RequestServiceAsync(
            endpoint,
            "attach",
            new(),
            cancellation.Token,
            _ => events.Add("late attachment")
        );
        var abandoned = await Fixture.Read(socket);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => canceled);
        await Fixture.Send(socket, Fixture.Reply(abandoned, "late"));
        await Fixture.Fence(socket);
        Assert.Equal(2, events.Count);
    }

    [Fact]
    public async Task Service_events_use_authenticated_generation_and_never_peer_identity_or_unadvertised_capability()
    {
        await using var f = new Fixture();
        await f.Start();
        var one = await f.Connect("one", new() { ["vscode-pty"] = 1 });
        var two = await f.Connect("two", new());
        var received = new List<NodeConnectionHub.ServiceEvent>();
        f.Manager.Nodes.ServiceReceived += value => received.Add(value);
        var message = new JsonObject
        {
            ["type"] = "node_service_event",
            ["nodeId"] = "master",
            ["service"] = "vscode-pty",
            ["event"] = new JsonObject
            {
                ["type"] = "output",
                ["terminalId"] = "term",
                ["data"] = "real protocol data",
            },
        };
        await Fixture.Send(two, message);
        await Fixture.Fence(two);
        Assert.Empty(received);
        await Fixture.Send(one, message);
        await Fixture.Fence(one);
        Assert.Single(received);
        Assert.Equal("one", received[0].Target.NodeId);
        Assert.Equal(f.Manager.Nodes.Service("one", "vscode-pty"), received[0].Target);
        message["service"] = "arbitrary";
        await Fixture.Send(one, message);
        await Fixture.Fence(one);
        Assert.Single(received);
    }
}
