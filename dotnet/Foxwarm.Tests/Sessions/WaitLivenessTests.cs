using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WaitLivenessTests
{
    private static SessionManager Manager(string root, Peer peer) =>
        new(Path.Combine(root, "data"), Path.Combine(root, "work"), peer.Options, HostModels.ForTest(peer.Options));

    private static JsonObject WaitingFor(params string[] ids) =>
        new() { ["waitAnySessions"] = new JsonArray(ids.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()) };

    private static async Task Until(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!condition() && DateTime.UtcNow < deadline)
            await Task.Delay(20);
        Assert.True(condition());
    }

    private static async Task Settle(SessionManager manager)
    {
        await Task.Delay(800);
        foreach (var owner in manager.Owners())
        {
            await owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        }
    }

    private static void Diagnostic(JsonObject request)
    {
        var text = request.ToJsonString();
        Assert.Contains("wait-sources-quiescent", text);
        Assert.DoesNotContain("fingerprint=", text);
        Assert.DoesNotContain("waitLivenessFingerprint", text);
    }

    private sealed class Peer : IAsyncDisposable
    {
        private readonly HttpListener listener = new();
        private readonly CancellationTokenSource stop = new();
        private readonly Task loop;
        private readonly List<Task> responses = [];
        internal readonly ConcurrentQueue<JsonObject> Requests = new();
        internal Func<Task>? BeforeResponse { get; set; }
        internal ResponsesClientOptions Options { get; }

        internal Peer()
        {
            var reserve = new TcpListener(IPAddress.Loopback, 0);
            reserve.Start();
            var port = ((IPEndPoint)reserve.LocalEndpoint).Port;
            reserve.Stop();
            var uri = new Uri("http://127.0.0.1:" + port);
            Options = new(uri, "wire", "a/wire", "", "", 713);
            listener.Prefixes.Add(uri + "/");
            listener.Start();
            loop = Serve();
        }

        private async Task Serve()
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    var context = await listener.GetContextAsync().WaitAsync(stop.Token);
                    responses.Add(Respond(context));
                }
            }
            catch (Exception error)
                when (stop.IsCancellationRequested
                    && error is OperationCanceledException or HttpListenerException or ObjectDisposedException) { }
        }

        private async Task Respond(HttpListenerContext context)
        {
            Requests.Enqueue(
                JsonNode.Parse(await new StreamReader(context.Request.InputStream).ReadToEndAsync())!.AsObject()
            );
            if (BeforeResponse is not null)
                await BeforeResponse();
            var payload = new JsonObject
            {
                ["type"] = "response.completed",
                ["response"] = new JsonObject
                {
                    ["id"] = "synthetic-liveness",
                    ["output"] = new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["content"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "output_text",
                                    ["text"] = "Synthetic diagnostic received.",
                                }
                            ),
                        }
                    ),
                    ["usage"] = new JsonObject
                    {
                        ["input_tokens"] = 10,
                        ["output_tokens"] = 3,
                    },
                },
            };
            context.Response.ContentType = "text/event-stream";
            await context.Response.OutputStream.WriteAsync(
                Encoding.UTF8.GetBytes("data: " + payload.ToJsonString() + "\n\n")
            );
            context.Response.Close();
        }

        public async ValueTask DisposeAsync()
        {
            stop.Cancel();
            listener.Stop();
            await loop;
            await Task.WhenAll(responses);
            listener.Close();
            stop.Dispose();
        }
    }

    [Fact]
    public async Task New_waits_can_repeat_the_same_idle_observation_before_and_after_dependency_work()
    {
        using var temp = new TempDirectory();
        await using var peer = new Peer();
        await using var manager = Manager(temp.Path, peer);
        await manager.LoadAsync();
        var dependency = await manager.CreateNamedAsync("main", "dependency", null, null);
        var waiter = await manager.CreateNamedAsync("main", "waiter", null, null);
        for (var occurrence = 0; occurrence < 3; occurrence++)
        {
            if (occurrence == 2)
            {
                await dependency.Registry.Ingress.EnqueueAsync(dependency.Id, QueueItem.UserText("intervening work"));
                await Settle(manager);
                Assert.False(dependency.Metadata().Busy);
                Assert.Empty(dependency.Entry.Snapshot().Queue);
                Assert.Null(dependency.WaitSnapshot());
            }
            var priorRequests = peer.Requests.Count;
            await manager.DeclareWaitAsync(waiter, WaitingFor(dependency.Id));
            await Until(() => peer.Requests.Count == priorRequests + 1);
            await Settle(manager);
            Assert.Null(waiter.WaitSnapshot());
            Assert.Empty(waiter.Entry.Snapshot().Queue);
            Assert.Null(waiter.Entry.Snapshot().Meta["waitLivenessFingerprints"]);
            Diagnostic(peer.Requests.Last());
        }
        Assert.Equal(3, waiter.History().Count(row => row.ToJsonString().Contains("wait-sources-quiescent", StringComparison.Ordinal)));
        Assert.Equal(4, peer.Requests.Count);
    }

    [Theory]
    [InlineData("idle")]
    [InlineData("cycle")]
    [InlineData("missing")]
    [InlineData("input")]
    public async Task Cold_catalog_diagnosis_loads_only_the_waiter_and_respects_input_backed_progress(string graph)
    {
        using var temp = new TempDirectory();
        await using var peer = new Peer();
        await using (var seed = Manager(temp.Path, peer))
        {
            var waiter = await seed.CreateNamedAsync("main", "waiter", null, null);
            var dependency = await seed.CreateNamedAsync("main", "dependency", null, null);
            if (graph == "cycle")
            {
                var other = await seed.CreateNamedAsync("main", "other", null, null);
                // Supported persisted declarations without the current liveness version.
                foreach (var (from, to) in new[] { (dependency, other), (other, dependency) })
                    await from.Entry.SaveLane.StartWaitAsync(new JsonObject
                    {
                        ["id"] = Guid.NewGuid().ToString(),
                        ["startedAt"] = 1,
                        ["waitAnySessions"] = new JsonArray(to.Id),
                    });
            }
            if (graph == "input")
                await seed.DeclareWaitAsync(dependency, new JsonObject { ["waitForInput"] = true });
            await seed.DeclareWaitAsync(waiter, WaitingFor(dependency.Id));
            if (graph == "missing")
                await seed.DeleteAsync(dependency.Id);
        }
        await using var manager = Manager(temp.Path, peer);
        var reads = new ConcurrentBag<string>();
        manager.AdmissionReadObserved = reads.Add;
        Assert.Empty(manager.Catalog.RestartIds());
        await manager.LoadAsync();
        if (graph == "input")
        {
            await Settle(manager);
            Assert.Empty(peer.Requests);
            Assert.Empty(manager.Owners());
            var dependency = await manager.RequiredAsync("dependency");
            await dependency.Entry.SaveLane.ClearWaitAsync();
        }
        await Until(() => peer.Requests.Count == 1);
        await Settle(manager);
        Assert.Null(manager.Find("other"));
        if (graph != "input")
        {
            Assert.Null(manager.Find("dependency"));
            Assert.Equal(new[] { "waiter" }, reads);
        }
        Assert.Null(manager.Find("waiter")!.WaitSnapshot());
        Diagnostic(peer.Requests.Single());
    }

    [Fact]
    public async Task Stale_diagnostic_wait_ID_is_fenced_during_admission_and_fast_reply_reapplication()
    {
        using var temp = new TempDirectory();
        await using var peer = new Peer();
        await using var manager = Manager(temp.Path, peer);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "waiter", null, null);
        var oldId = await manager.DeclareWaitAsync(owner, new() { ["waitForInput"] = true });
        var old = SessionWait.Event("wait-sources-quiescent", "old queued diagnostic",
            new() { ["fingerprint"] = "old-receipt" },
            new() { ["waitLivenessWaitId"] = oldId, ["waitLivenessFingerprint"] = "old-receipt" });
        Assert.True(await owner.Entry.SaveLane.AdmitAsync(old, SaveKind.Strict));
        Assert.Null(owner.WaitSnapshot());
        Assert.Single(owner.Entry.Snapshot().Queue);
        var currentId = await manager.DeclareWaitAsync(owner, new() { ["waitForInput"] = true });
        Assert.NotEqual(oldId, currentId);
        Assert.Empty(owner.Entry.Snapshot().Queue);
        // A new-style stale event has only the existing correlation field.
        await manager.AdmitWaitEventAsync(owner.Id, SessionWait.Event("wait-sources-quiescent", "stale",
            fields: new() { ["waitLivenessWaitId"] = oldId }));
        await manager.AdmitWaitEventAsync(owner.Id, old);
        Assert.Equal(currentId, SessionWait.Text(owner.WaitSnapshot()?["id"]));
        Assert.Empty(owner.Entry.Snapshot().Queue);
        Assert.Empty(peer.Requests);
        var current = SessionWait.Event("wait-sources-quiescent", "current",
            fields: new() { ["waitLivenessWaitId"] = currentId });
        await manager.AdmitWaitEventAsync(owner.Id, current);
        await Until(() => peer.Requests.Count == 1);
        await Settle(manager);
        Assert.Null(owner.WaitSnapshot());
        await manager.AdmitWaitEventAsync(owner.Id, current);
        Assert.Empty(owner.Entry.Snapshot().Queue);
        Assert.Single(peer.Requests);
    }

    [Fact]
    public async Task Old_receipts_history_and_already_admitted_queue_round_trip_without_controlling_new_waits()
    {
        using var temp = new TempDirectory();
        await using var peer = new Peer();
        await using (var seed = Manager(temp.Path, peer))
        {
            var owner = await seed.CreateNamedAsync("main", "waiter", null, null);
            await seed.CreateNamedAsync("main", "dependency", null, null);
            var waitId = await seed.DeclareWaitAsync(owner, new() { ["waitForInput"] = true });
            var old = SessionWait.Event("wait-sources-quiescent", "stored diagnostic",
                new() { ["fingerprint"] = "old-receipt" },
                new() { ["waitLivenessWaitId"] = waitId, ["waitLivenessFingerprint"] = "old-receipt" });
            await ForkClearLifecycleTests.AppendAsync(owner, new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(old.Parts!.Select(part => (JsonNode)part.DeepClone()).ToArray()),
            });
            // This is ordinary unknown metadata from an older writer, not a new receipt.
            owner.Entry.WithState(state => state.Meta["waitLivenessFingerprints"] = new JsonArray("old-receipt"));
            Assert.True(await owner.Entry.SaveLane.AdmitAsync(old, SaveKind.Strict));
            Assert.Null(owner.WaitSnapshot());
            Assert.Equal("old-receipt", SessionWait.Text(owner.Entry.Snapshot().Queue[0].OpenFields?["waitLivenessFingerprint"]));
        }
        for (var opening = 0; opening < 2; opening++)
        {
            await using var manager = Manager(temp.Path, peer);
            await manager.LoadAsync();
            await Settle(manager);
            var owner = await manager.RequiredAsync("waiter");
            if (opening == 0)
            {
                Assert.Single(peer.Requests);
                Assert.Equal(2, owner.History().Count(row => row.ToJsonString().Contains("fingerprint=", StringComparison.Ordinal)));
                await manager.DeclareWaitAsync(owner, WaitingFor("dependency"));
                await Until(() => peer.Requests.Count == 2);
                await Settle(manager);
                var fresh = owner.History()[^2].ToJsonString();
                Assert.Contains("wait-sources-quiescent", fresh);
                Assert.DoesNotContain("fingerprint=", fresh);
            }
            Assert.Equal(new[] { "old-receipt" }, SessionWait.Strings(owner.Entry.Snapshot().Meta["waitLivenessFingerprints"]));
            Assert.Null(owner.WaitSnapshot());
            Assert.Empty(owner.Entry.Snapshot().Queue);
            await owner.Entry.SaveLane.SaveStrictAsync();
            var stored = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(temp.Path, "data/state/sessions/waiter.json")))!;
            Assert.Equal(new[] { "old-receipt" }, SessionWait.Strings(stored["meta"]?["waitLivenessFingerprints"]));
            Assert.Equal(2, peer.Requests.Count);
        }
    }

    [Fact]
    public async Task Four_active_diagnostic_owners_bound_admission_and_settlement_releases_a_pending_waiter()
    {
        using var temp = new TempDirectory();
        await using var peer = new Peer();
        var releases = Enumerable.Range(0, 5).Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
        var entered = -1;
        peer.BeforeResponse = () => releases[Interlocked.Increment(ref entered)].Task;
        await using var manager = Manager(temp.Path, peer);
        await manager.LoadAsync();
        var dependency = await manager.CreateNamedAsync("main", "dependency", null, null);
        var waiters = new List<SessionOwner>();
        try
        {
            for (var index = 0; index < 5; index++)
            {
                var owner = await manager.CreateNamedAsync("main", "waiter-" + index, null, null);
                waiters.Add(owner);
                await manager.DeclareWaitAsync(owner, WaitingFor(dependency.Id));
            }
            await Until(() => peer.Requests.Count == 4);
            await Task.Delay(800);
            Assert.Equal(4, peer.Requests.Count);
            Assert.Equal(4, waiters.Count(owner => owner.Metadata().Busy));
            Assert.Single(waiters, owner => owner.WaitSnapshot() is not null);
            releases[0].TrySetResult();
            await Until(() => peer.Requests.Count == 5);
        }
        finally
        {
            foreach (var release in releases)
                release.TrySetResult();
        }
        await Settle(manager);
        Assert.Equal(5, peer.Requests.Count);
        Assert.All(peer.Requests, Diagnostic);
        Assert.All(waiters, owner => Assert.Null(owner.WaitSnapshot()));
    }

    [Fact]
    public async Task Ordinary_wait_all_reports_and_user_interruption_keep_their_queue_transitions()
    {
        using var temp = new TempDirectory();
        await using var peer = new Peer();
        await using var manager = Manager(temp.Path, peer);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "waiter", null, null);
        var first = await manager.CreateNamedAsync("main", "first", null, null);
        var second = await manager.CreateNamedAsync("main", "second", null, null);
        var args = new JsonObject
        {
            ["waitAllSessions"] = new JsonArray(first.Id, second.Id),
            ["wakeIfNoActivityAfterSeconds"] = 3600,
        };
        QueueItem Report(string source) => new(QueueItemType.Intersession,
            [new JsonObject { ["text"] = "report from " + source }], SourceSessionId: source);
        await manager.DeclareWaitAsync(owner, args);
        Assert.True(await owner.Entry.SaveLane.AdmitAsync(Report(first.Id), SaveKind.Strict));
        Assert.Empty(owner.Entry.Snapshot().Queue);
        Assert.Single(owner.Entry.Snapshot().Meta["wait"]!["waitAll"]!["deferredQueue"]!.AsArray());
        Assert.True(await owner.Entry.SaveLane.AdmitAsync(Report(second.Id), SaveKind.Strict));
        Assert.Null(owner.WaitSnapshot());
        Assert.Equal(new[] { first.Id, second.Id }, owner.Entry.Snapshot().Queue.Select(item => item.SourceSessionId));
        await owner.StartProcessing();
        await Settle(manager);
        await manager.DeclareWaitAsync(owner, args);
        await owner.Entry.SaveLane.AdmitAsync(Report(first.Id), SaveKind.Strict);
        await owner.Entry.SaveLane.AdmitAsync(QueueItem.UserText("interrupt"), SaveKind.Strict);
        var queued = owner.Entry.Snapshot().Queue;
        Assert.Null(owner.WaitSnapshot());
        Assert.Equal(3, queued.Count);
        Assert.Equal(first.Id, queued[0].SourceSessionId);
        Assert.Equal(QueueItemType.User, queued[1].Type);
        Assert.Contains("wait-all-pending", queued[2].Parts![0].ToJsonString());
        Assert.Contains(second.Id, queued[2].Parts![0].ToJsonString());
        await owner.StartProcessing();
        await Settle(manager);
        Assert.Equal(2, peer.Requests.Count);
    }
}
