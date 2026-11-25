using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class SessionIdleReleaseTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal SessionManager Manager = null!;
        internal SessionRuntime Runtime = null!;
        internal string Data => Path.Combine(Temp.Path, "data");

        internal static async Task<Fixture> Create()
        {
            var f = new Fixture();
            Directory.CreateDirectory(Path.Combine(f.Temp.Path, "work"));
            f.Manager = new SessionManager(
                f.Data,
                Path.Combine(f.Temp.Path, "work"),
                Options,
                HostModels.ForTest(Options)
            );
            await f.Manager.LoadAsync();
            f.Runtime = new SessionRuntime(f.Manager);
            return f;
        }

        public async ValueTask DisposeAsync()
        {
            await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    private static JsonObject Text(string text, string role = "user") =>
        new() { ["role"] = role, ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private static Task Append(SessionOwner owner, params JsonObject[] rows) =>
        owner.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
            LocalSessionTurnHost.PrepareCanonicalAppend(
                state,
                rows,
                [],
                true,
                false,
                () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            )
        );

    private static QueueItem Passive(string text) =>
        new(QueueItemType.Background, [new JsonObject { ["system"] = text }], Trigger: false);

    // The authority fields of an owner. Envelope keys can be limited to a fresh creation's
    // keys: loading adds the stored format fields (zero stats, cursors) as any cold load does.
    private static string Durable(SessionOwner owner, string? keysOf = null)
    {
        var snapshot = owner.Entry.Snapshot();
        var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
        if (keysOf is not null)
        {
            var keys = JsonNode.Parse(keysOf)!["envelope"]!.AsObject().Select(pair => pair.Key);
            foreach (var key in envelope.Select(pair => pair.Key).Except(keys).ToArray())
                envelope.Remove(key);
        }
        return new JsonObject
        {
            ["history"] = new JsonArray(
                owner.History().Select(row => (JsonNode?)row.DeepClone()).ToArray()
            ),
            ["envelope"] = envelope,
            ["meta"] = snapshot.Meta.DeepClone(),
            ["queue"] = new JsonArray(
                snapshot
                    .Queue.Select(item =>
                        (JsonNode?)JsonValue.Create(item.Parts?[0].ToJsonString())
                    )
                    .ToArray()
            ),
            ["nextMessageSeq"] = snapshot.NextMessageSeq,
            ["historyVersion"] = snapshot.HistoryVersion,
        }.ToJsonString();
    }

    // A resident owner's runtime projection also declares per-call tool activity coverage;
    // a catalog row has no tool calls to cover.
    private static string Row(SessionListQueries view, string id)
    {
        var row = view.Projection(id)!;
        (row["runtimeState"] as JsonObject)?.Remove("perCallToolActivity");
        return row.ToJsonString();
    }

    private static bool Delivered(SessionOwner owner, string text) =>
        owner.History().Any(row => row.ToJsonString().Contains(text))
        || owner.Entry.Snapshot().Queue.Any(item =>
            item.Parts?.Any(part => part.ToJsonString().Contains(text)) == true
        );

    // Loaded objects keep the stored property order.
    private static void AssertSame(string expected, string actual) =>
        Assert.True(
            JsonNode.DeepEquals(JsonNode.Parse(expected), JsonNode.Parse(actual)),
            expected + "\n" + actual
        );

    private static string AuthorityFile(Fixture f, string id) =>
        Path.Combine(f.Data, "state", "sessions", id + ".json");

    [Fact]
    public async Task Idle_owner_is_released_and_rehydrated_with_identical_authority_and_projection()
    {
        await using var f = await Fixture.Create();
        var owner = await f.Manager.CreateNamedAsync("main", "idle", null, null);
        await Append(owner, Text("first question"), Text("first answer", "model"));
        await owner.Entry.SaveLane.AdmitAsync(Passive("passive note"), SaveKind.Strict);
        var before = Durable(owner);
        var view = new SessionListQueries(f.Runtime);
        var projection = Row(view, owner.Id);
        var bytes = await File.ReadAllTextAsync(AuthorityFile(f, owner.Id));

        f.Manager.IdleReleaseDelay = TimeSpan.FromHours(1);
        Assert.Equal(0, f.Manager.ReleaseIdleOwners());
        Assert.Same(owner, f.Manager.Find(owner.Id));

        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        Assert.Null(f.Manager.IdleReleaseBlocker(owner));
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());
        Assert.Empty(f.Manager.Owners());
        Assert.Null(f.Manager.Find(owner.Id));
        Assert.Equal(1, f.Manager.ReleasedOwnerCount);
        // Release writes nothing and the cold list row is the one the owner projected.
        Assert.Equal(bytes, await File.ReadAllTextAsync(AuthorityFile(f, owner.Id)));
        Assert.Equal(projection, Row(view, owner.Id));

        // A stale reference can neither persist nor start work.
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            owner.Entry.SaveLane.AdmitAsync(Passive("stale"), SaveKind.Strict)
        );
        Assert.ThrowsAny<InvalidOperationException>(() =>
        {
            _ = owner.StartProcessing();
        });
        Assert.Equal(bytes, await File.ReadAllTextAsync(AuthorityFile(f, owner.Id)));

        var rehydrated = await f.Manager.RequiredAsync(owner.Id);
        Assert.NotSame(owner, rehydrated);
        AssertSame(before, Durable(rehydrated, keysOf: before));
        Assert.Single(f.Manager.Owners());
        // A second release and rehydration reproduces the first loaded state exactly.
        var loaded = Durable(rehydrated);
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());
        rehydrated = await f.Manager.RequiredAsync(owner.Id);
        AssertSame(loaded, Durable(rehydrated));
        await Append(rehydrated, Text("second question"));
        Assert.Equal(3, rehydrated.History().Count);
        Assert.Contains("second question", await File.ReadAllTextAsync(AuthorityFile(f, owner.Id)));
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static async Task<WeakReference> CreateAndRelease(Fixture f)
    {
        var owner = await f.Manager.CreateNamedAsync("main", "collected", null, null);
        await Append(owner, Text(new string('x', 200_000)));
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());
        return new WeakReference(owner);
    }

    [Fact]
    public async Task Released_owner_is_collectable()
    {
        await using var f = await Fixture.Create();
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        var weak = await CreateAndRelease(f);
        for (var attempt = 0; attempt < 10 && weak.IsAlive; attempt++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            await Task.Delay(50);
        }
        Assert.False(weak.IsAlive);
    }

    [Fact]
    public async Task Live_state_keeps_the_owner_resident()
    {
        await using var f = await Fixture.Create();
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        var owner = await f.Manager.CreateNamedAsync("main", "live", null, null);
        var (subscription, _) = owner.Subscribe();
        Assert.Equal("subscriber", f.Manager.IdleReleaseBlocker(owner));
        Assert.Equal(0, f.Manager.ReleaseIdleOwners());
        owner.Unsubscribe(subscription);

        owner.ApprovalWaiters.Register("approval", new JsonObject());
        Assert.Equal("approval", f.Manager.IdleReleaseBlocker(owner));
        Assert.Equal(0, f.Manager.ReleaseIdleOwners());
        owner.ApprovalWaiters.Remove("approval");

        // Runnable input belongs to the owner that will process it.
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("run me"));
        Assert.Equal("runnable-queue", f.Manager.IdleReleaseBlocker(owner));
        Assert.Equal(0, f.Manager.ReleaseIdleOwners());
        Assert.Same(owner, f.Manager.Find(owner.Id));
    }

    [Fact]
    public async Task Semantic_admission_during_release_keeps_the_owner()
    {
        await using var f = await Fixture.Create();
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        var owner = await f.Manager.CreateNamedAsync("main", "admitted", null, null);
        SessionOwner? admitted = null;
        f.Manager.IdleReleaseChecked = checkedOwner =>
            admitted = f.Manager.RequiredAsync(checkedOwner.Id).GetAwaiter().GetResult();
        Assert.Equal(0, await Task.Run(f.Manager.ReleaseIdleOwners));
        Assert.Same(owner, admitted);
        Assert.Same(owner, f.Manager.Find(owner.Id));
        // The admitted reference stays usable.
        await admitted!.Entry.SaveLane.AdmitAsync(Passive("after admission"), SaveKind.Strict);
        Assert.Single(owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Persisted_change_through_an_older_reference_during_release_keeps_the_owner()
    {
        await using var f = await Fixture.Create();
        var owner = await f.Manager.CreateNamedAsync("main", "older", null, null);
        // Obtained before the quiet period, as a long-lived holder would have it.
        var held = owner;
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        f.Manager.IdleReleaseChecked = _ =>
            held.Entry.SaveLane.AdmitAsync(Passive("late write"), SaveKind.Strict)
                .GetAwaiter()
                .GetResult();
        Assert.Equal(0, await Task.Run(f.Manager.ReleaseIdleOwners));
        Assert.Same(owner, f.Manager.Find(owner.Id));
        Assert.Single(owner.Entry.Snapshot().Queue);
        f.Manager.IdleReleaseChecked = null;
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());
        var rehydrated = await f.Manager.RequiredAsync(owner.Id);
        Assert.Single(rehydrated.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Accepted_mutation_during_release_keeps_the_owner()
    {
        await using var f = await Fixture.Create();
        var owner = await f.Manager.CreateNamedAsync("main", "mutating", null, null);
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        IDisposable? admission = null;
        f.Manager.IdleReleaseChecked = checkedOwner =>
            admission = checkedOwner.Entry.AdmitMutation();
        Assert.Equal(0, await Task.Run(f.Manager.ReleaseIdleOwners));
        Assert.Same(owner, f.Manager.Find(owner.Id));
        admission!.Dispose();
        f.Manager.IdleReleaseChecked = null;
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());
    }

    [Fact]
    public async Task Persisted_wait_survives_release_and_its_timeout_rehydrates_the_owner()
    {
        await using var f = await Fixture.Create();
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        var owner = await f.Manager.CreateNamedAsync("main", "waiting", null, null);
        var waitId = await owner.Entry.SaveLane.StartWaitAsync(
            new JsonObject
            {
                ["id"] = "release-wait",
                ["startedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["declarationVersion"] = 1,
                ["waitForInput"] = true,
                ["timeoutSeconds"] = 2,
            }
        );
        Assert.NotNull(waitId);
        Assert.NotNull(owner.WaitSnapshot());
        Assert.Null(f.Manager.IdleReleaseBlocker(owner));
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());
        Assert.Null(f.Manager.Find(owner.Id));
        // The cold catalog row still presents the wait.
        Assert.NotNull(f.Manager.CatalogMetadata(owner.Id)?.Wait);

        var deadline = DateTime.UtcNow.AddSeconds(15);
        SessionOwner? woken = null;
        while (DateTime.UtcNow < deadline)
        {
            woken = f.Manager.Find(owner.Id);
            if (woken is not null && Durable(woken).Contains("wait-timeout"))
                break;
            await Task.Delay(100);
        }
        Assert.NotNull(woken);
        Assert.NotSame(owner, woken);
        Assert.Contains("wait-timeout", Durable(woken!));
        await woken!.Registry.Control.StopAsync(woken.Id);
        await woken.DrainForegroundAsync();
    }

    [Fact]
    public async Task Waiting_ToolScript_snapshot_survives_release_and_continues_on_the_new_owner()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        var waiting = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] = "print('before')\nanswer = ask_agent('Next?')\nreturn 'got ' + answer\n",
                ["mode"] = "background",
            }
        );
        Assert.Equal("waiting", SessionWait.Text(waiting["status"]));
        var runId = SessionWait.Text(waiting["runId"])!;
        var continuation = SessionWait.Text(waiting["continuationId"])!;
        // A paused run is persisted, not executing: it does not hold the owner.
        Assert.Null(f.Manager.IdleReleaseBlocker(f.Owner));
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());

        var rehydrated = await f.Manager.RequiredAsync(f.Owner.Id);
        Assert.NotSame(f.Owner, rehydrated);
        var tools = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            rehydrated,
            f.Manager,
            f.Registry
        );
        tools.BeginTurn();
        var completed = (
            await tools.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = "continue",
                    ["name"] = "continue_script",
                    ["args"] = new JsonObject
                    {
                        ["runId"] = runId,
                        ["continuationId"] = continuation,
                        ["input"] = "yes",
                    },
                },
                default
            )
        )!.AsObject();
        Assert.Equal("completed", SessionWait.Text(completed["status"]));
        Assert.Equal("got yes", SessionWait.Text(completed["result"]));
    }

    [Fact]
    public async Task Timer_firing_after_release_delivers_to_the_rehydrated_owner_and_realtime_events_follow()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        var id = f.Owner.Id;
        var events = new List<SessionRuntimeEvent>();
        var runtime = new SessionRuntime(f.Manager);
        runtime.Changed += value =>
        {
            if (value.SessionId == id)
                lock (events)
                    events.Add(value);
        };
        await f.Manager.ExecuteTimerForOwnerAsync(
            id,
            "create_timer",
            new JsonObject { ["message"] = "timer payload after release", ["afterSeconds"] = 2 }
        );
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());
        lock (events)
            events.Clear();

        var deadline = DateTime.UtcNow.AddSeconds(20);
        SessionOwner? woken = null;
        var delivered = false;
        // The rehydrated owner may start processing the input against the unreachable
        // provider; the delivered row is observed before that settles.
        while (!delivered && DateTime.UtcNow < deadline)
        {
            woken = f.Manager.Find(id);
            delivered = woken is not null && Delivered(woken, "timer payload after release");
            if (!delivered)
                await Task.Delay(20);
        }
        Assert.True(delivered);
        Assert.NotSame(f.Owner, woken);
        // Manager-level listeners (the WebSocket realtime path) receive the new owner's events.
        while (DateTime.UtcNow < deadline)
        {
            lock (events)
                if (events.Any(value => value.Kind == SessionEventKind.StateChanged))
                    break;
            await Task.Delay(20);
        }
        lock (events)
            Assert.Contains(events, value => value.Kind == SessionEventKind.StateChanged);
        await woken!.Registry.Control.StopAsync(id);
        await woken.DrainForegroundAsync();
    }

    [Fact]
    public async Task Many_idle_owners_release_and_rehydrate_independently()
    {
        await using var f = await Fixture.Create();
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        var ids = new List<string>();
        for (var index = 0; index < 5; index++)
        {
            var owner = await f.Manager.CreateNamedAsync("main", "many" + index, null, null);
            await Append(owner, Text("row " + index));
            ids.Add(owner.Id);
        }
        Assert.Equal(5, f.Manager.ReleaseIdleOwners());
        Assert.Empty(f.Manager.Owners());
        foreach (var id in ids)
            Assert.Contains("row", Durable(await f.Manager.RequiredAsync(id)));
        Assert.Equal(5, f.Manager.Owners().Count());
    }
}
