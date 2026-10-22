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
    [Theory]
    [InlineData("retained")]
    [InlineData("removed")]
    [InlineData("deleted")]
    public async Task Superseded_initialization_keeps_command_replies_only_for_retained_current_owners(
        string outcome
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local/wire",
            "",
            "",
            713
        );
        await using (
            var seed = new SessionManager(data, work, options, HostModels.ForTest(options))
        )
        {
            await seed.LoadAsync();
            await seed.CreateNamedAsync("main", "current", null, null);
            await seed.CreateNamedAsync("main", "cold", null, null);
        }
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("current");
        var reached = Signal();
        var release = Signal();
        manager.BeforeAdmissionRead = async (id, token) =>
        {
            if (id == "cold")
            {
                reached.TrySetResult();
                await release.Task.WaitAsync(token);
            }
        };
        using var stopped = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        using var socket = new ProbeSocket();
        var runtime = new SessionRuntime(manager);
        var router = new MessageRouter(runtime);
        var running = new WebUiRealtime(runtime).RunAsync(socket, stopped.Token);
        bool Applied(long revision) =>
            socket.Frames.Any(frame =>
                frame["type"]?.ToString() == "subscriptions-applied"
                && frame["revision"]?.GetValue<long>() == revision
            );
        bool Reply(JsonObject frame) =>
            frame["type"]?.ToString() == "message"
            && frame["message"]?["__meta"]?["isCommandResponse"]?.GetValue<bool>() == true;
        try
        {
            socket.SetSessionUnion(1, ["current"]);
            await Until(() => Applied(1), stopped.Token);
            socket.SetSessionUnion(2, ["current", "cold"]);
            await reached.Task.WaitAsync(stopped.Token);
            var reply = await router.HandleMessageAsync(
                new("current", "webui"),
                new("/help", null)
            );
            Assert.Equal(200, reply.Status);
            Assert.DoesNotContain(socket.Frames, Reply);
            Assert.Empty(owner.History());
            if (outcome == "deleted")
                await manager.DeleteAsync("current");
            socket.SetSessionUnion(3, outcome == "removed" ? [] : ["current"]);
            await Until(() => Applied(3), stopped.Token);
            var frames = socket.Frames.ToArray();
            Assert.Equal(outcome == "retained" ? 1 : 0, frames.Count(Reply));
            if (outcome == "retained")
            {
                var accepted = Array.FindIndex(
                    frames,
                    f =>
                        f["type"]?.ToString() == "subscriptions-accepted"
                        && f["revision"]?.GetValue<long>() == 3
                );
                var draft = Array.FindIndex(
                    frames,
                    accepted,
                    f => f["type"]?.ToString() == "model-stream-snapshot"
                );
                var delivered = Array.FindIndex(frames, Reply);
                Assert.True(draft > accepted && delivered > draft);
                Assert.True(
                    delivered
                        < Array.FindIndex(
                            frames,
                            f =>
                                f["type"]?.ToString() == "subscriptions-applied"
                                && f["revision"]?.GetValue<long>() == 3
                        )
                );
            }
            Assert.DoesNotContain(frames, f => f["revision"]?.ToString() == "2");
            Assert.Equal(
                outcome == "deleted" ? 1 : 0,
                frames.Count(f => f["type"]?.ToString() == "session-deleted")
            );
            release.TrySetResult();
            await manager.RequiredAsync("cold").WaitAsync(stopped.Token);
            // Re-register after the superseded loader finishes: neither a stale reply nor snapshot may resurface.
            if (outcome == "deleted")
                owner = await manager.CreateNamedAsync("main", "next", null, null);
            socket.SetSessionUnion(4, [owner.Id]);
            await Until(() => Applied(4), stopped.Token);
            await router.HandleMessageAsync(new(owner.Id, "webui"), new("/help", null));
            await Until(
                () => socket.Frames.Count(Reply) == (outcome == "retained" ? 2 : 1),
                stopped.Token
            );
            Assert.Empty(owner.History());
            Assert.DoesNotContain(socket.Frames, f => f["revision"]?.ToString() == "2");
        }
        finally
        {
            release.TrySetResult();
            stopped.Cancel();
            await running;
        }
    }

    [Fact]
    public async Task QueuedOldBusyFrameCannotFollowNewIdleSubscriptionSnapshot()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "foxwarm-realtime-revision-" + Guid.NewGuid().ToString("N")
        );
        var releaseProvider = Signal();
        var reachedPause = Signal();
        var releaseSend = Signal();
        await using var provider = new LoopbackResponsesServer(
            async (stream, _) =>
            {
                await releaseProvider.Task;
                // Empty completion is a supported normal turn: busy->idle without another history row.
                var body = Encoding.UTF8.GetBytes(
                    "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n"
                );
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    body
                );
            }
        );
        var options = new ResponsesClientOptions(
            provider.BaseUri,
            "wire",
            "local/wire",
            "synthetic-token",
            "",
            1024
        );
        await using var manager = new SessionManager(
            Path.Combine(root, "data"),
            Path.Combine(root, "work"),
            options,
            HostModels.ForTest(options)
        );
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
                if (
                    frame["type"]?.GetValue<string>() != "session-state"
                    || frame["session"]?["busy"]?.GetValue<bool>() != true
                    || Interlocked.Exchange(ref pausedOnce, 1) != 0
                )
                    return;
                pausedBusy = (JsonObject)frame.DeepClone();
                reachedPause.TrySetResult();
                await releaseSend.Task.WaitAsync(token); // Pause a normal queued sender, never mutate Session state.
            },
        };
        var running = realtime.RunAsync(socket, stop.Token);
        try
        {
            socket.SetSubscriptions(1, owner.Id);
            await Until(
                () =>
                    socket.Frames.Any(frame =>
                        frame["type"]?.GetValue<string>() == "subscriptions-applied"
                        && frame["revision"]?.GetValue<long>() == 1
                    ),
                stop.Token
            );
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
            await Until(
                () =>
                {
                    var frames = socket.Frames.ToArray();
                    var accepted = Array.FindIndex(
                        frames,
                        frame =>
                            frame["type"]?.GetValue<string>() == "subscriptions-accepted"
                            && frame["revision"]?.GetValue<long>() == 2
                    );
                    return accepted >= 0
                        && frames
                            .Skip(accepted + 1)
                            .Any(frame =>
                                frame["type"]?.GetValue<string>() == "session-state"
                                && frame["session"]?["busy"]?.GetValue<bool>() == false
                            );
                },
                stop.Token
            );
            var idle = socket.Frames.Last(frame =>
                frame["type"]?.GetValue<string>() == "session-state"
            )["session"]!;
            foreach (var field in new[] { "messageCount", "queueLength", "historyVersion" })
                Assert.True(
                    JsonNode.DeepEquals(pausedBusy!["session"]![field], idle[field]),
                    field
                );
            releaseSend.TrySetResult();
            await Until(
                () =>
                    socket.Frames.Any(frame =>
                        frame["type"]?.GetValue<string>() == "subscriptions-applied"
                        && frame["revision"]?.GetValue<long>() == 2
                    ),
                stop.Token
            );
            var state = socket.Frames.Last(frame =>
                frame["type"]?.GetValue<string>() == "session-state"
            )["session"]!;
            Assert.False(state["busy"]!.GetValue<bool>());
            Assert.Equal(1, state["messageCount"]!.GetValue<int>());
            Assert.Equal(1, provider.RequestCount);
        }
        finally
        {
            releaseProvider.TrySetResult();
            releaseSend.TrySetResult();
            stop.Cancel();
            await running;
            await manager.ShutdownAsync();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task New_revision_and_disconnect_abandon_only_the_subscription_wait_not_shared_cold_admission()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            await SessionCatalogMigrationTests.Authority(data, "one");
            catalog.Upsert([SessionCatalogTests.Row("one", 0)]);
        }
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var reached = Signal();
        var release = Signal();
        var attempts = 0;
        manager.BeforeAdmissionRead = async (_, token) =>
        {
            Interlocked.Increment(ref attempts);
            reached.TrySetResult();
            await release.Task.WaitAsync(token);
        };
        using var stopped = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var socket = new ProbeSocket();
        var logPath = Path.Combine(temp.Path, "main.log");
        await File.WriteAllTextAsync(logPath, "independent initialization\n");
        using var logs = new WebUiLogFile(logPath, 10);
        var running = new WebUiRealtime(new SessionRuntime(manager), logs).RunAsync(
            socket,
            stopped.Token
        );
        socket.SetSubscriptions(1, "one", logsId: "unchanged");
        await reached.Task.WaitAsync(stopped.Token);
        Assert.Equal(0, logs.SubscriberCount);
        socket.SetSubscriptions(2, null, ["one"], logsId: "unchanged");
        await Until(
            () =>
                socket.Frames.Any(frame =>
                    frame["type"]?.GetValue<string>() == "subscriptions-applied"
                    && frame["revision"]?.GetValue<long>() == 2
                ),
            stopped.Token
        );
        await Until(
            () => socket.Frames.Any(f => f["type"]?.ToString() == "logs-snapshot"),
            stopped.Token
        );
        Assert.Single(socket.Frames, f => f["type"]?.ToString() == "logs-snapshot");
        Assert.Empty(manager.Owners());
        Assert.DoesNotContain(
            socket.Frames,
            frame => frame["type"]?.GetValue<string>() is "session-state" or "model-stream-start"
        );
        Assert.DoesNotContain(
            socket.Frames,
            frame =>
                frame["type"]?.GetValue<string>() == "subscriptions-applied"
                && frame["revision"]?.GetValue<long>() == 1
        );
        stopped.Cancel();
        await running;
        Assert.Equal(0, logs.SubscriberCount);
        release.TrySetResult();
        var owner = await manager.RequiredAsync("one").WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal("one", owner.Id);
        Assert.Equal(1, attempts);
        Assert.Single(manager.Owners());
    }

    [Fact]
    public async Task Cataloged_missing_authority_is_an_admission_error_frame_never_session_deleted()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            catalog.Upsert([SessionCatalogTests.Row("known", 0)]);
        }
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        using var stopped = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var socket = new ProbeSocket();
        var running = new WebUiRealtime(new SessionRuntime(manager)).RunAsync(
            socket,
            stopped.Token
        );
        socket.SetSubscriptions(1, "known");
        await running.WaitAsync(stopped.Token);
        Assert.Contains(
            socket.Frames,
            frame =>
                frame["type"]?.GetValue<string>() == "error"
                && frame["code"]?.GetValue<string>() == "SESSION_STATE_UNAVAILABLE"
        );
        Assert.DoesNotContain(
            socket.Frames,
            frame => frame["type"]?.GetValue<string>() == "session-deleted"
        );
        Assert.Equal("exact", manager.Catalog.Resolve("known")["kind"]!.GetValue<string>());
        Assert.Empty(manager.Owners());
    }

    [Theory]
    [InlineData("deleted")]
    [InlineData("retired")]
    [InlineData("replaced")]
    public async Task Actual_delete_during_a_second_cold_admission_does_not_mix_a_retired_or_replaced_owner(
        string outcome
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            foreach (var id in new[] { "target", "other" })
                await SessionCatalogMigrationTests.Authority(data, id);
            catalog.Upsert([
                SessionCatalogTests.Row("target", 0),
                SessionCatalogTests.Row("other", 0),
            ]);
        }
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var reached = Signal();
        var release = Signal();
        manager.BeforeAdmissionRead = async (id, token) =>
        {
            if (id == "other")
            {
                reached.TrySetResult();
                await release.Task.WaitAsync(token);
            }
        };
        using var stopped = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var socket = new ProbeSocket();
        var running = new WebUiRealtime(new SessionRuntime(manager)).RunAsync(
            socket,
            stopped.Token
        );
        try
        {
            socket.SetSessionUnion(1, ["target", "other"]);
            await reached.Task.WaitAsync(stopped.Token);
            await Until(() => manager.Find("target") is not null, stopped.Token);
            if (outcome == "retired")
            {
                var faults = Path.Combine(data, "state", "experiment-faults");
                Directory.CreateDirectory(faults);
                await File.WriteAllTextAsync(
                    Path.Combine(
                        faults,
                        SessionIdentity.ExecDirectorySegment("target") + ".delete-json-unlink"
                    ),
                    "owned unlink fault"
                );
                await Assert.ThrowsAsync<SessionDeletionException>(() =>
                    manager.DeleteAsync("target")
                );
            }
            else
            {
                await manager.DeleteAsync("target");
                if (outcome == "replaced")
                    await manager.CreateNamedAsync("main", "target", null, null);
            }
            release.TrySetResult();
            if (outcome == "deleted")
            {
                await Until(
                    () =>
                        socket.Frames.Any(frame =>
                            frame["type"]?.GetValue<string>() == "subscriptions-applied"
                        ),
                    stopped.Token
                );
                Assert.Contains(
                    socket.Frames,
                    frame =>
                        frame["type"]?.GetValue<string>() == "session-deleted"
                        && frame["sessionId"]?.GetValue<string>() == "target"
                );
                Assert.Contains(
                    socket.Frames,
                    frame =>
                        frame["type"]?.GetValue<string>() == "session-state"
                        && frame["sessionId"]?.GetValue<string>() == "other"
                );
            }
            else
            {
                await running.WaitAsync(stopped.Token);
                Assert.Contains(
                    socket.Frames,
                    frame =>
                        frame["type"]?.GetValue<string>() == "error"
                        && frame["code"]?.GetValue<string>() == "SESSION_STATE_UNAVAILABLE"
                );
                Assert.DoesNotContain(
                    socket.Frames,
                    frame =>
                        frame["type"]?.GetValue<string>()
                            is "session-deleted"
                                or "subscriptions-applied"
                );
            }
            Assert.DoesNotContain(
                socket.Frames,
                frame =>
                    frame["type"]?.GetValue<string>() == "session-state"
                    && frame["sessionId"]?.GetValue<string>() == "target"
            );
        }
        finally
        {
            release.TrySetResult();
            stopped.Cancel();
            await running;
        }
    }

    [Fact]
    public async Task Logs_uses_the_existing_sender_byte_backlog_and_stops_only_its_topic()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "main.log");
        await File.WriteAllTextAsync(path, "initial\n");
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        using var logs = new WebUiLogFile(path, 10);
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var socket = new ProbeSocket();
        var reached = Signal();
        var release = Signal();
        socket.BeforeSend = async (frame, token) =>
        {
            if (frame["type"]?.ToString() != "logs-snapshot")
                return;
            reached.TrySetResult();
            await release.Task.WaitAsync(token);
        };
        var running = new WebUiRealtime(new SessionRuntime(manager), logs).RunAsync(
            socket,
            stop.Token
        );
        try
        {
            socket.SetLogs(1, "slow");
            await reached.Task.WaitAsync(stop.Token);
            // The blocked actual SendAsync leaves the normal output queue observable.
            // Each chunk is below catch-up size; the socket backlog, not a file gap,
            // is what must stop this one topic from accumulating further windows.
            for (var index = 0; index < 20; index++)
            {
                await File.AppendAllTextAsync(path, new string('x', 70 * 1024));
                await Task.Delay(40, stop.Token);
            }
            release.TrySetResult();
            await Until(
                () => socket.Frames.Any(f => f["type"]?.ToString() == "logs-gap"),
                stop.Token
            );
            Assert.Single(socket.Frames, f => f["type"]?.ToString() == "logs-gap");
            Assert.True(
                socket
                    .Frames.Where(f => f["type"]?.ToString() == "logs-delta")
                    .Sum(f => f["window"]!["text"]!.ToString().Length)
                    <= WebUiLogFile.SocketBufferBytes + WebUiLogFile.WindowBytes
            );
            Assert.Equal(0, logs.SubscriberCount);
            socket.SetLogs(2, "slow");
            await Until(
                () =>
                    socket.Frames.Any(f =>
                        f["type"]?.ToString() == "subscriptions-applied"
                        && f["revision"]?.ToString() == "2"
                    ),
                stop.Token
            );
            Assert.Single(socket.Frames, f => f["type"]?.ToString() == "logs-snapshot");
            socket.SetLogs(3, "fresh");
            await Until(
                () =>
                    socket.Frames.Any(f =>
                        f["type"]?.ToString() == "logs-snapshot"
                        && f["logsId"]?.ToString() == "fresh"
                    ),
                stop.Token
            );
            socket.SetLogs(4, null);
            await Until(() => logs.SubscriberCount == 0, stop.Token);
        }
        finally
        {
            release.TrySetResult();
            stop.Cancel();
            await running;
        }
    }

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static async Task Until(Func<bool> condition, CancellationToken token)
    {
        while (!condition())
            await Task.Delay(5, token);
    }

    private sealed class ProbeSocket : WebSocket
    {
        private readonly Channel<byte[]> incoming = Channel.CreateUnbounded<byte[]>();
        private WebSocketState state = WebSocketState.Open;
        public ConcurrentQueue<JsonObject> Frames { get; } = new();
        internal Func<JsonObject, CancellationToken, Task>? BeforeSend { get; set; }

        internal void SetLogs(long revision, string? id) =>
            incoming.Writer.TryWrite(
                Encoding.UTF8.GetBytes(
                    new JsonObject
                    {
                        ["type"] = "set-subscriptions",
                        ["revision"] = revision,
                        ["sessionListActive"] = false,
                        ["sessionIds"] = new JsonArray(),
                        ["sessionListIds"] = new JsonArray(),
                        ["logs"] = id is null ? null : new JsonObject { ["id"] = id },
                    }.ToJsonString()
                )
            );

        public void SetSubscriptions(
            long revision,
            string? id,
            string[]? list = null,
            string? logsId = null
        ) =>
            incoming.Writer.TryWrite(
                Encoding.UTF8.GetBytes(
                    new JsonObject
                    {
                        ["type"] = "set-subscriptions",
                        ["revision"] = revision,
                        ["logs"] = logsId is null ? null : new JsonObject { ["id"] = logsId },
                        ["sessionListActive"] = true,
                        ["sessionIds"] = id is null ? new JsonArray() : new JsonArray(id),
                        ["sessionListIds"] = new JsonArray(
                            (list ?? (id is null ? [] : [id]))
                                .Select(value => (JsonNode?)JsonValue.Create(value))
                                .ToArray()
                        ),
                    }.ToJsonString()
                )
            );

        public void SetSessionUnion(long revision, string[] ids) =>
            incoming.Writer.TryWrite(
                Encoding.UTF8.GetBytes(
                    new JsonObject
                    {
                        ["type"] = "set-subscriptions",
                        ["revision"] = revision,
                        ["sessionListActive"] = false,
                        ["sessionIds"] = new JsonArray(
                            ids.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
                        ),
                        ["sessionListIds"] = new JsonArray(),
                    }.ToJsonString()
                )
            );

        public override WebSocketCloseStatus? CloseStatus =>
            state == WebSocketState.Closed ? WebSocketCloseStatus.NormalClosure : null;
        public override string? CloseStatusDescription => null;
        public override WebSocketState State => state;
        public override string? SubProtocol => null;

        public override void Abort() => state = WebSocketState.Aborted;

        public override void Dispose() => state = WebSocketState.Closed;

        public override Task CloseAsync(
            WebSocketCloseStatus status,
            string? description,
            CancellationToken token
        )
        {
            state = WebSocketState.Closed;
            return Task.CompletedTask;
        }

        public override Task CloseOutputAsync(
            WebSocketCloseStatus status,
            string? description,
            CancellationToken token
        ) => CloseAsync(status, description, token);

        public override async Task<WebSocketReceiveResult> ReceiveAsync(
            ArraySegment<byte> buffer,
            CancellationToken token
        )
        {
            var bytes = await incoming.Reader.ReadAsync(token);
            bytes.AsSpan().CopyTo(buffer.AsSpan());
            return new WebSocketReceiveResult(bytes.Length, WebSocketMessageType.Text, true);
        }

        public override async Task SendAsync(
            ArraySegment<byte> buffer,
            WebSocketMessageType type,
            bool end,
            CancellationToken token
        )
        {
            var frame = JsonNode.Parse(buffer.AsSpan())!.AsObject();
            if (BeforeSend is { } before)
                await before(frame, token);
            Frames.Enqueue(frame);
        }
    }
}
