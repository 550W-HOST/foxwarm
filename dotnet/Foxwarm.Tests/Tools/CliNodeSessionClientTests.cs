using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.CliNode;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed class CliNodeSessionClientTests
{
    private sealed class Peer : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();
        private readonly CancellationTokenSource stop = new();
        private readonly Channel<JsonObject> incoming = Channel.CreateUnbounded<JsonObject>();
        private WebApplication app = null!;
        private WebSocket socket = null!;
        private Task running = null!;
        internal NodeClient Client = null!;

        internal string Root => temp.Path;

        internal async Task Start(
            Func<NodeToolCall, CancellationToken, Task<ToolApproval>>? intercept = null
        )
        {
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            app = builder.Build();
            app.UseWebSockets();
            app.Map(
                "/node_ws",
                async context =>
                {
                    using var connection = await context.WebSockets.AcceptWebSocketAsync();
                    socket = connection;
                    try
                    {
                        var buffer = new byte[65536];
                        while (connection.State == WebSocketState.Open)
                        {
                            using var frame = new MemoryStream();
                            ValueWebSocketReceiveResult read;
                            do
                            {
                                read = await connection.ReceiveAsync(buffer.AsMemory(), stop.Token);
                                if (read.MessageType == WebSocketMessageType.Close)
                                {
                                    await connection.CloseOutputAsync(
                                        WebSocketCloseStatus.NormalClosure,
                                        "",
                                        default
                                    );
                                    return;
                                }
                                frame.Write(buffer, 0, read.Count);
                            } while (!read.EndOfMessage);
                            await incoming.Writer.WriteAsync(
                                JsonNode.Parse(frame.ToArray())!.AsObject()
                            );
                        }
                    }
                    catch (Exception error)
                        when (error is OperationCanceledException or WebSocketException) { }
                }
            );
            await app.StartAsync();
            Client = new(
                new NodeClientOptions(
                    app.Urls.Single(),
                    "one",
                    null,
                    "synthetic-client-token",
                    null,
                    LocalTrigger: false,
                    ToolCallInterceptor: intercept
                ),
                new NodePaths(temp.Path)
            );
            running = Client.Run(stop.Token);
            Assert.Equal("node_register", (await Next())["type"]!.ToString());
            await Send(new JsonObject { ["type"] = "registered", ["nodeId"] = "one" });
        }

        internal async Task<JsonObject> Next() =>
            await incoming.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));

        internal async Task Send(JsonObject frame) =>
            await socket.SendAsync(
                Encoding.UTF8.GetBytes(frame.ToJsonString()),
                WebSocketMessageType.Text,
                true,
                default
            );

        internal Task Reply(JsonObject request, JsonNode? result = null, string? error = null) =>
            Send(
                new JsonObject
                {
                    ["type"] = "cli_response",
                    ["requestId"] = request["requestId"]!.DeepClone(),
                    ["ok"] = error is null,
                    ["result"] = result,
                    ["error"] = error,
                }
            );

        internal async Task Close() =>
            await socket.CloseOutputAsync(
                WebSocketCloseStatus.NormalClosure,
                "owned disconnect",
                default
            );

        internal async Task Shutdown()
        {
            stop.Cancel();
            if (running is not null)
                await running.WaitAsync(TimeSpan.FromSeconds(5));
        }

        public async ValueTask DisposeAsync()
        {
            await Shutdown();
            if (app is not null)
            {
                await app.StopAsync();
                await app.DisposeAsync();
            }
            stop.Dispose();
            temp.Dispose();
        }
    }

    [Fact]
    public async Task Ignored_interceptor_cancellation_cannot_launch_and_does_not_cancel_another_call()
    {
        await using var peer = new Peer();
        var waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lateApproval = new TaskCompletionSource<ToolApproval>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        await peer.Start(
            (call, _) =>
            {
                if (call.CallId != "stopped")
                    return Task.FromResult(ToolApproval.Approved);
                waiting.TrySetResult();
                return lateApproval.Task; // Deliberately ignores its cancellation token.
            }
        );
        var never = Path.Combine(peer.Root, "never-launched");
        await peer.Send(
            new JsonObject
            {
                ["type"] = "tool_call",
                ["callId"] = "stopped",
                ["tool"] = "exec",
                ["sessionId"] = "main/one",
                ["agentName"] = "main",
                ["sessionCwd"] = peer.Root,
                ["args"] = new JsonObject { ["command"] = "touch '" + never + "'" },
            }
        );
        await waiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await peer.Send(new JsonObject { ["type"] = "tool_call_cancel", ["callId"] = "other" });
        Assert.False(lateApproval.Task.IsCompleted);
        await peer.Send(new JsonObject { ["type"] = "tool_call_cancel", ["callId"] = "stopped" });
        var rejected = await peer.Next();
        Assert.Equal("tool_call_error", rejected["type"]!.ToString());
        Assert.False(rejected["execStarted"]!.GetValue<bool>());
        Assert.Contains("not executed", rejected["error"]!["message"]!.ToString());
        lateApproval.SetResult(ToolApproval.Approved);
        var admitted = Path.Combine(peer.Root, "admitted");
        await peer.Send(
            new JsonObject
            {
                ["type"] = "tool_call",
                ["callId"] = "admitted",
                ["tool"] = "write",
                ["sessionId"] = "main/one",
                ["agentName"] = "main",
                ["args"] = new JsonObject { ["filePath"] = admitted, ["content"] = "one" },
            }
        );
        Assert.Equal("tool_call_response", (await peer.Next())["type"]!.ToString());
        Assert.Equal("one", await File.ReadAllTextAsync(admitted));
        Assert.False(File.Exists(never));
    }

    [Fact]
    public async Task Connection_loss_settles_an_uncooperative_nonexec_approval_before_drain()
    {
        await using var peer = new Peer();
        var waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lateApproval = new TaskCompletionSource<ToolApproval>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        await peer.Start(
            (_, _) =>
            {
                waiting.TrySetResult();
                return lateApproval.Task;
            }
        );
        var never = Path.Combine(peer.Root, "never-written");
        await peer.Send(
            new JsonObject
            {
                ["type"] = "tool_call",
                ["callId"] = "lost",
                ["tool"] = "write",
                ["sessionId"] = "main/one",
                ["args"] = new JsonObject { ["filePath"] = never, ["content"] = "never" },
            }
        );
        await waiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await peer.Close();
        // Dispose must finish without a cooperative interceptor or a human response.
        await peer.Shutdown();
        lateApproval.SetResult(ToolApproval.Approved);
        Assert.False(File.Exists(never));
    }

    [Fact]
    public async Task Actual_client_calls_correlate_concurrent_results_preserve_payloads_and_propagate_errors()
    {
        await using var peer = new Peer();
        await peer.Start();
        var list = peer.Client.ListBoundSessions();
        var history = peer.Client.GetSessionHistory("old-name", 1.5);
        var send = peer.Client.SendSessionMessage("old-name", "  ordinary input  ");
        var requests = new[] { await peer.Next(), await peer.Next(), await peer.Next() };
        Assert.Equal(3, requests.Select(row => row["requestId"]!.ToString()).Distinct().Count());
        var historyRequest = requests.Single(row =>
            row["type"]!.ToString() == "session_history_request"
        );
        Assert.Equal(1.5, historyRequest["count"]!.GetValue<double>());
        Assert.Equal("old-name", historyRequest["sessionId"]!.ToString());
        var sendRequest = requests.Single(row => row["type"]!.ToString() == "session_send_message");
        Assert.Equal("  ordinary input  ", sendRequest["message"]!.ToString());
        Assert.Equal("trigger", sendRequest["eventType"]!.ToString());
        await peer.Reply(sendRequest, error: "Node one cannot send messages to this session");
        Assert.Equal(
            "Node one cannot send messages to this session",
            (await Assert.ThrowsAsync<IOException>(() => send)).Message
        );
        var expected = JsonNode.Parse(
            "{\"session\":{\"id\":\"canonical\"},\"messages\":[{\"index\":103.5,\"role\":\"user\",\"text\":\"history\"}],\"totalMessages\":105}"
        )!;
        await peer.Reply(historyRequest, expected.DeepClone());
        Assert.True(JsonNode.DeepEquals(expected, await history));
        var listRequest = requests.Single(row => row["type"]!.ToString() == "session_list_request");
        await peer.Reply(
            listRequest,
            new JsonObject { ["sessions"] = new JsonArray(new JsonObject { ["id"] = "canonical" }) }
        );
        Assert.Equal("canonical", (await list)[0]!["id"]!.ToString());
        var empty = peer.Client.ListBoundSessions();
        await peer.Reply(await peer.Next(), new JsonObject { ["sessions"] = false });
        Assert.Empty(await empty);
        // An empty ID sends nothing, even when another request is pending.
        await peer.Client.SendSessionEvent("", "not sent");
        var ordinary = peer.Client.SendSessionEvent("canonical", "ACK required");
        var frame = await peer.Next();
        Assert.Equal("session_event", frame["type"]!.ToString());
        Assert.Equal("background", frame["eventType"]!.ToString());
        Assert.False(ordinary.IsCompleted);
        await peer.Reply(new JsonObject { ["requestId"] = "wrong-id" });
        Assert.False(ordinary.IsCompleted);
        await peer.Reply(frame);
        await ordinary;
    }

    [Fact]
    public async Task Real_request_deadlines_and_disconnect_reject_without_resending_effects()
    {
        await using var peer = new Peer();
        await peer.Start();
        var list = peer.Client.ListBoundSessions();
        var listFrame = await peer.Next();
        Assert.Equal(
            "cli-node request session_list_request timed out",
            (await Assert.ThrowsAsync<IOException>(() => list)).Message
        );
        await peer.Reply(listFrame); // A late response cannot settle another request.
        var history = peer.Client.GetSessionHistory("one");
        var historyFrame = await peer.Next();
        Assert.Equal(30, historyFrame["count"]!.GetValue<double>());
        var send = peer.Client.SendSessionMessage("one", "never resent");
        await peer.Next();
        await peer.Close();
        Assert.Contains(
            "1000: owned disconnect",
            (await Assert.ThrowsAsync<IOException>(() => history)).Message
        );
        Assert.Contains(
            "1000: owned disconnect",
            (await Assert.ThrowsAsync<IOException>(() => send)).Message
        );
        await peer.Client.SendSessionEvent("", "still no send");
        Assert.Equal(
            "Remote node is not connected to master",
            (
                await Assert.ThrowsAsync<IOException>(() =>
                    peer.Client.SendSessionEvent("one", "offline")
                )
            ).Message
        );
    }
}
