using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed class NodeSessionRequestTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();
        private readonly List<ClientWebSocket> sockets = [];
        internal SessionManager Manager = null!;
        private WebApplication app = null!;
        private JsonObject credential = null!;
        private readonly CancellationTokenSource cliStop = new();
        private Task? cliRunning;

        internal async Task<NodeClient> Cli()
        {
            var client = new NodeClient(
                new NodeClientOptions(
                    app.Urls.Single(),
                    "one",
                    null,
                    credential["authToken"]!.ToString(),
                    null,
                    LocalTrigger: false
                ),
                new NodePaths(temp.Path)
            );
            cliRunning = client.Run(cliStop.Token);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            while (true)
            {
                try
                {
                    if ((await client.ListBoundSessions()).Count > 0)
                        return client;
                }
                catch (IOException) { }
                await Task.Delay(20, deadline.Token);
            }
        }

        internal async Task Start(bool bound = false)
        {
            var data = Path.Combine(temp.Path, "data");
            var work = Path.Combine(temp.Path, "work");
            Directory.CreateDirectory(work);
            Directory.CreateDirectory(Path.Combine(data, "state"));
            using (var catalog = new SessionCatalog(data))
                catalog.Initialize();
            if (bound)
                await File.WriteAllTextAsync(
                    Path.Combine(data, "state", "agents.json"),
                    "{\"version\":2,\"agents\":[],\"metadata\":{\"main\":{\"isolated\":true,\"isolatedNode\":\"one\"}}}"
                );
            await SessionCatalogMigrationTests.Authority(data, "cold");
            var path = Path.Combine(data, "state", "sessions", "cold.json");
            var authority = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            authority.Remove("currentNode");
            if (!bound)
                authority["currentNode"] = "one";
            authority["history"] = new JsonArray(
                Enumerable
                    .Range(0, 105)
                    .Select(index =>
                        (JsonNode?)
                            new JsonObject
                            {
                                ["role"] = "user",
                                ["parts"] = new JsonArray(
                                    new JsonObject { ["text"] = "message-" + index }
                                ),
                                ["__meta"] = new JsonObject
                                {
                                    ["seq"] = index + 1,
                                    ["timestamp"] = index + 1,
                                },
                            }
                    )
                    .ToArray()
            );
            authority["nextMessageSeq"] = 106;
            authority["meta"] = new JsonObject
            {
                ["messageCount"] = 105,
                ["lastMessageTime"] = 105,
            };
            authority["aliases"] = new JsonArray("old-cold");
            await File.WriteAllTextAsync(path, authority.ToJsonString());
            using (var catalog = new SessionCatalog(data))
            {
                catalog.Initialize();
                var row = SessionCatalogTests.Row("cold", 105, aliases: ["old-cold"]);
                if (!bound)
                    row["currentNode"] = "one";
                row["meta"]!["messageCount"] = 105;
                catalog.Upsert([row]);
            }
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "a",
                "",
                "",
                713
            );
            Manager = new(data, work, options, HostModels.ForTest(options));
            await Manager.LoadAsync();
            credential = Manager.Nodes.Registry.Create("one");
            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            app = builder.Build();
            app.UseWebSockets();
            app.Map("/node_ws", Manager.Nodes.HandleAsync);
            await app.StartAsync();
        }

        internal async Task<ClientWebSocket> Connect(int generation = 3)
        {
            var socket = new ClientWebSocket();
            sockets.Add(socket);
            await socket.ConnectAsync(
                new Uri(
                    app.Urls.Single().Replace("http", "ws")
                        + "/node_ws?id=one&auth="
                        + credential["authToken"]!.GetValue<string>()
                ),
                default
            );
            await Send(
                socket,
                new()
                {
                    ["type"] = "node_register",
                    ["nodeType"] = "session-rpc-peer",
                    ["nodeProtocol"] = new JsonObject
                    {
                        ["min"] = generation,
                        ["max"] = generation,
                    },
                    ["capabilities"] = new JsonObject { ["tools"] = new JsonArray() },
                }
            );
            Assert.Equal(
                generation > 3 ? "node_incompatible" : "registered",
                (await Read(socket))!["type"]!.ToString()
            );
            return socket;
        }

        internal static async Task Send(ClientWebSocket socket, JsonObject value) =>
            await socket.SendAsync(
                Encoding.UTF8.GetBytes(value.ToJsonString()),
                WebSocketMessageType.Text,
                true,
                default
            );

        internal static async Task<JsonObject?> Read(ClientWebSocket socket)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var stream = new MemoryStream();
            var buffer = new byte[65536];
            WebSocketReceiveResult frame;
            do
            {
                frame = await socket.ReceiveAsync(buffer, timeout.Token);
                if (frame.MessageType == WebSocketMessageType.Close)
                    return null;
                stream.Write(buffer, 0, frame.Count);
            } while (!frame.EndOfMessage);
            return JsonNode.Parse(stream.ToArray())!.AsObject();
        }

        internal static async Task<JsonObject> Request(
            ClientWebSocket socket,
            string type,
            JsonNode? count = null,
            string id = "old-cold"
        )
        {
            await Send(
                socket,
                new()
                {
                    ["type"] = type,
                    ["requestId"] = "correlation",
                    ["sessionId"] = id,
                    ["count"] = count,
                }
            );
            var response = (await Read(socket))!;
            Assert.Equal("cli_response", response["type"]!.ToString());
            Assert.Equal("correlation", response["requestId"]!.ToString());
            return response;
        }

        public async ValueTask DisposeAsync()
        {
            cliStop.Cancel();
            if (cliRunning is not null)
                await cliRunning;
            cliStop.Dispose();
            foreach (var socket in sockets)
            {
                socket.Abort();
                socket.Dispose();
            }
            if (app is not null)
            {
                await app.StopAsync();
                await app.DisposeAsync();
            }
            if (Manager is not null)
                await Manager.DisposeAsync();
            temp.Dispose();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Real_cli_API_uses_catalog_alias_history_and_ordinary_owner_ingress(bool bound)
    {
        await using var f = new Fixture();
        await f.Start(bound);
        var client = await f.Cli();
        Assert.Equal("cold", (await client.ListBoundSessions())[0]!["id"]!.ToString());
        Assert.Empty(f.Manager.Owners());
        var history = (await client.GetSessionHistory("old-cold", 1.5))!;
        Assert.Equal(105, history["totalMessages"]!.GetValue<int>());
        Assert.Equal(103.5, history["messages"]![0]!["index"]!.GetValue<double>());
        Assert.Equal(2, history["messages"]!.AsArray().Count);
        var owner = await f.Manager.RequiredAsync("cold");
        Assert.Empty(owner.Entry.Snapshot().Queue);
        await client.SendSessionMessage("old-cold", "ordinary CLI input");
        Assert.True(
            owner.Entry.Snapshot().Queue.Count > 0 || owner.Entry.Snapshot().History.Count > 105
        );
        Assert.Contains(
            "missing",
            (
                await Assert.ThrowsAsync<IOException>(() => client.GetSessionHistory("missing"))
            ).Message
        );
        // Selection/binding belongs to Main, not the client or the local HTTP caller.
        if (bound)
            await f.Manager.SetAgentNodeAsync("main", null);
        else
            await f.Manager.SelectNodeAsync(owner, "master");
        Assert.Empty(await client.ListBoundSessions());
        await Assert.ThrowsAsync<IOException>(() => client.SendSessionMessage("cold", "denied"));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task Existing_generations_keep_correlated_catalog_alias_history_and_bounded_counts(
        int generation
    )
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await f.Connect(generation);
        var list = await Fixture.Request(socket, "session_list_request");
        Assert.True(list["ok"]!.GetValue<bool>());
        Assert.Equal("cold", list["result"]!["sessions"]![0]!["id"]!.ToString());
        Assert.Empty(f.Manager.Owners());
        foreach (
            var (count, expected, firstIndex) in new (JsonNode?, int, double)[]
            {
                (null, 30, 75),
                (0, 30, 75),
                (-1, 1, 104),
                (2, 2, 103),
                (1.5, 2, 103.5),
                (999, 100, 5),
                ("2", 30, 75),
            }
        )
        {
            var response = await Fixture.Request(socket, "session_history_request", count);
            Assert.True(response["ok"]!.GetValue<bool>());
            var result = response["result"]!;
            Assert.Equal("cold", result["session"]!["id"]!.ToString());
            Assert.Equal(105, result["totalMessages"]!.GetValue<int>());
            Assert.Equal(expected, result["messages"]!.AsArray().Count);
            Assert.Equal(
                Enumerable.Range(0, expected).Select(offset => firstIndex + offset),
                result["messages"]!.AsArray().Select(row => row!["index"]!.GetValue<double>())
            );
            Assert.Equal("message-104", result["messages"]!.AsArray().Last()!["text"]!.ToString());
        }
        var absent = await Fixture.Request(socket, "session_history_request", id: "missing");
        Assert.Equal("Target session \"missing\" not found.", absent["error"]!.ToString());
        var malformed = await Fixture.Request(socket, "session_send_message");
        Assert.Equal(
            "Invalid session_send_message: missing sessionId or message",
            malformed["error"]!.ToString()
        );
    }

    [Theory]
    [InlineData("session_history_request")]
    [InlineData("session_send_message")]
    public async Task Assignment_is_rechecked_after_real_cold_owner_admission(string type)
    {
        await using var f = new Fixture();
        await f.Start(bound: true);
        var socket = await f.Connect();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Manager.BeforeAdmissionRead = async (_, token) =>
        {
            entered.SetResult();
            await release.Task.WaitAsync(token);
        };
        await Fixture.Send(
            socket,
            new()
            {
                ["type"] = type,
                ["requestId"] = "held",
                ["sessionId"] = "old-cold",
                ["message"] = "must-not-enter",
            }
        );
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await f.Manager.SetAgentNodeAsync("main", null);
        release.SetResult();
        var response = (await Fixture.Read(socket))!;
        Assert.False(response["ok"]!.GetValue<bool>());
        Assert.Equal(
            type == "session_history_request"
                ? "Node \"one\" cannot read history for session \"old-cold\" because the session assignment changed."
                : "Node \"one\" cannot send messages to session \"old-cold\" because the session is not assigned to that node or its isolated agent.",
            response["error"]!.ToString()
        );
        var owner = await f.Manager.RequiredAsync("cold");
        Assert.Empty(owner.Entry.Snapshot().Queue);
        Assert.Equal(105, owner.Entry.Snapshot().History.Count);
    }

    [Fact]
    public async Task Replaced_connection_cannot_admit_a_late_send_or_deliver_its_response_to_successor()
    {
        await using var f = new Fixture();
        await f.Start();
        var old = await f.Connect();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var consumer = f.Manager.Nodes.SessionRequest!;
        f.Manager.Nodes.SessionRequest = async (node, message, check, token) =>
        {
            entered.SetResult();
            await release.Task.WaitAsync(token);
            try
            {
                return await consumer(node, message, check, token);
            }
            finally
            {
                handled.SetResult();
            }
        };
        await Fixture.Send(
            old,
            new()
            {
                ["type"] = "session_send_message",
                ["requestId"] = "predecessor",
                ["sessionId"] = "cold",
                ["message"] = "stale-input",
            }
        );
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var successor = await f.Connect();
        release.SetResult();
        await handled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        f.Manager.Nodes.SessionRequest = consumer;
        var response = await Fixture.Request(successor, "session_list_request");
        Assert.True(response["ok"]!.GetValue<bool>());
        Assert.Empty(f.Manager.Owners());
        Assert.Null(await Fixture.Read(old));
        var incompatible = await f.Connect(99);
        await Fixture.Send(
            incompatible,
            new() { ["type"] = "session_list_request", ["requestId"] = "quarantined" }
        );
        response = (await Fixture.Read(incompatible))!;
        Assert.Equal("error", response["type"]!.ToString());
        Assert.Equal("NODE_PROTOCOL_INCOMPATIBLE", response["error"]!.ToString());
    }

    [Fact]
    public async Task Host_shutdown_cancels_a_request_waiting_for_cold_owner_admission()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await f.Connect();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var canceled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Manager.BeforeAdmissionRead = async (_, token) =>
        {
            entered.SetResult();
            await release.Task.WaitAsync(token);
        };
        var consumer = f.Manager.Nodes.SessionRequest!;
        f.Manager.Nodes.SessionRequest = async (node, message, check, token) =>
        {
            try
            {
                return await consumer(node, message, check, token);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                canceled.SetResult();
                throw;
            }
        };
        await Fixture.Send(
            socket,
            new() { ["type"] = "session_history_request", ["sessionId"] = "cold" }
        );
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        f.Manager.Nodes.BeginShutdown();
        await canceled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        release.SetResult();
    }

    [Fact]
    public void History_text_preserves_existing_text_system_image_and_tool_shapes_without_optional_timestamp()
    {
        var message = JsonNode
            .Parse(
                """
                {"role":"model","parts":[{"text":"first","system":"ignored"},{"system":"notice"},{"inlineData":{"mimeType":"image/png"}},{"functionCall":{"name":"read","args":{"b":"<file>","1":2}}},{"functionResponse":{"name":"read","response":{"output":"done"}}},{"other":true},0,false,null]}
                """
            )!
            .AsObject();
        var result = SessionManager.NodeHistoryMessage(message, 7);
        Assert.Equal(7, result["index"]!.GetValue<double>());
        Assert.False(result.ContainsKey("timestamp"));
        Assert.Equal(
            "first\n[SYSTEM] notice\n[inline data: image/png]\n[tool call: read {\"1\":2,\"b\":\"<file>\"}]\n[tool response: read {\"output\":\"done\"}]\n{\"other\":true}\n0\nfalse",
            result["text"]!.GetValue<string>()
        );
    }
}
