using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WebUiRealtimeRevisionTests
{
    [Fact]
    public async Task QueuedOldBusyFrameCannotFollowNewIdleSubscriptionSnapshot()
    {
        var root = Path.Combine(Path.GetTempPath(), "foxwarm-realtime-revision-" + Guid.NewGuid().ToString("N"));
        var releaseProvider = Signal(); var reachedPause = Signal(); var releaseSend = Signal();
        await using var provider = new LoopbackResponsesServer(async (stream, _) =>
        {
            await releaseProvider.Task;
            // Empty completion is a supported normal turn: busy->idle without another history row.
            var body = Encoding.UTF8.GetBytes("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n");
            await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", body);
        });
        var options = new ResponsesClientOptions(provider.BaseUri, "wire", "local/wire", "synthetic-token", "", 1024);
        await using var manager = new SessionManager(Path.Combine(root, "data"), Path.Combine(root, "work"),
            options, HostModels.Load(null, options));
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        using var socket = new ProbeSocket();
        var runtime = new SessionRuntime(manager);
        await manager.LoadAsync();
        var owner = await manager.CreateAsync();
        var pausedOnce = 0;
        JsonObject? pausedBusy = null;
        var realtime = new WebUiRealtime(runtime)
        {
            BeforeQueuedSend = async (frame, token) =>
            {
                if (frame["type"]?.GetValue<string>() != "session-state"
                    || frame["session"]?["busy"]?.GetValue<bool>() != true
                    || Interlocked.Exchange(ref pausedOnce, 1) != 0) return;
                pausedBusy = (JsonObject)frame.DeepClone();
                reachedPause.TrySetResult();
                await releaseSend.Task.WaitAsync(token); // Pause a normal queued sender, never mutate Session state.
            }
        };
        var running = realtime.RunAsync(socket, stop.Token);
        try
        {
            socket.SetSubscriptions(1, owner.Id);
            await Until(() => socket.Frames.Any(frame => frame["type"]?.GetValue<string>() == "subscriptions-applied"
                && frame["revision"]?.GetValue<long>() == 1), stop.Token);
            await runtime.SubmitAndRunAsync(owner.Id, QueueItem.UserText("finish normally"));
            await reachedPause.Task.WaitAsync(stop.Token);
            await provider.Request.WaitAsync(stop.Token);
            releaseProvider.TrySetResult();
            await owner.DrainAsync();
            Assert.False(owner.Metadata().Busy);
            Assert.Equal(1, owner.Metadata().MessageCount);
            // Same physical socket and Chat stay subscribed; only the normal list union changes.
            var additional = await manager.CreateAsync();
            socket.SetSubscriptions(2, owner.Id, [owner.Id, additional.Id]);
            await Until(() =>
            {
                var frames = socket.Frames.ToArray();
                var accepted = Array.FindIndex(frames, frame => frame["type"]?.GetValue<string>() == "subscriptions-accepted"
                    && frame["revision"]?.GetValue<long>() == 2);
                return accepted >= 0 && frames.Skip(accepted + 1).Any(frame => frame["type"]?.GetValue<string>() == "session-state"
                    && frame["session"]?["busy"]?.GetValue<bool>() == false);
            }, stop.Token);
            var idle = socket.Frames.Last(frame => frame["type"]?.GetValue<string>() == "session-state")["session"]!;
            foreach (var field in new[] { "messageCount", "queueLength", "historyVersion" })
                Assert.True(JsonNode.DeepEquals(pausedBusy!["session"]![field], idle[field]), field);
            releaseSend.TrySetResult();
            await Until(() => socket.Frames.Any(frame => frame["type"]?.GetValue<string>() == "subscriptions-applied"
                && frame["revision"]?.GetValue<long>() == 2), stop.Token);
            var state = socket.Frames.Last(frame => frame["type"]?.GetValue<string>() == "session-state")["session"]!;
            Assert.False(state["busy"]!.GetValue<bool>());
            Assert.Equal(1, state["messageCount"]!.GetValue<int>());
            Assert.Equal(1, provider.RequestCount);
        }
        finally
        {
            releaseProvider.TrySetResult(); releaseSend.TrySetResult(); stop.Cancel();
            await running;
            await manager.ShutdownAsync();
            Directory.Delete(root, recursive: true);
        }
    }
    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static async Task Until(Func<bool> condition, CancellationToken token)
    {
        while (!condition()) await Task.Delay(5, token);
    }
    private sealed class ProbeSocket : WebSocket
    {
        private readonly Channel<byte[]> incoming = Channel.CreateUnbounded<byte[]>();
        private WebSocketState state = WebSocketState.Open;
        public ConcurrentQueue<JsonObject> Frames { get; } = new();
        public void SetSubscriptions(long revision, string id, string[]? list = null) => incoming.Writer.TryWrite(Encoding.UTF8.GetBytes(new JsonObject
        {
            ["type"] = "set-subscriptions", ["revision"] = revision, ["sessionListActive"] = true,
            ["sessionIds"] = new JsonArray(id),
            ["sessionListIds"] = new JsonArray((list ?? [id]).Select(value => (JsonNode?)JsonValue.Create(value)).ToArray())
        }.ToJsonString()));
        public override WebSocketCloseStatus? CloseStatus => state == WebSocketState.Closed ? WebSocketCloseStatus.NormalClosure : null;
        public override string? CloseStatusDescription => null;
        public override WebSocketState State => state;
        public override string? SubProtocol => null;
        public override void Abort() => state = WebSocketState.Aborted;
        public override void Dispose() => state = WebSocketState.Closed;
        public override Task CloseAsync(WebSocketCloseStatus status, string? description, CancellationToken token)
        { state = WebSocketState.Closed; return Task.CompletedTask; }
        public override Task CloseOutputAsync(WebSocketCloseStatus status, string? description, CancellationToken token) => CloseAsync(status, description, token);
        public override async Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken token)
        {
            var bytes = await incoming.Reader.ReadAsync(token); bytes.AsSpan().CopyTo(buffer.AsSpan());
            return new WebSocketReceiveResult(bytes.Length, WebSocketMessageType.Text, true);
        }
        public override Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType type, bool end, CancellationToken token)
        { Frames.Enqueue(JsonNode.Parse(buffer.AsSpan())!.AsObject()); return Task.CompletedTask; }
    }
}
