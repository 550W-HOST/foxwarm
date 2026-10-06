using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionAdmissionTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static async Task Seed(string data, params string[] ids)
    {
        using var catalog = new SessionCatalog(data);
        catalog.Initialize();
        foreach (var id in ids)
            await SessionCatalogMigrationTests.Authority(data, id);
        catalog.Upsert(ids.Select(id => SessionCatalogTests.Row(id, 0)));
    }

    [Fact]
    public async Task Metadata_and_cold_rename_do_not_read_authority_and_first_semantic_use_preserves_real_cache()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await Seed(data, "one", "two");
        var file = Path.Combine(data, "state", "sessions", "one.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        var cache = Guid.NewGuid().ToString("N");
        raw["promptCacheKey"] = cache;
        raw["persistentMemorySnapshot"] = "Existing selected snapshot";
        var original = raw.ToJsonString();
        await File.WriteAllTextAsync(file, original);
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        var reads = 0;
        manager.AdmissionReadObserved = _ => Interlocked.Increment(ref reads);
        await manager.LoadAsync();
        var runtime = new SessionRuntime(manager);
        var view = new SessionListQueries(runtime);
        Assert.Equal(2, view.GlobalSummary()["total"]!.GetValue<long>());
        Assert.NotNull(view.Projection("one"));
        Assert.Equal(
            2,
            System.Text.Json.JsonSerializer.SerializeToNode(manager.AgentRegistry())![0]![
                "sessionCount"
            ]!.GetValue<int>()
        );
        await runtime.UpdateDisplayNameAsync("one", "Main name");
        Assert.Equal(original, await File.ReadAllTextAsync(file));
        Assert.Empty(manager.Owners());
        Assert.Equal(0, reads);
        var owner = await manager.RequiredAsync("one");
        Assert.Single(manager.Owners());
        Assert.Equal(1, reads);
        Assert.Equal("Main name", owner.Metadata().DisplayName);
        Assert.Equal(
            cache,
            owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]!.GetValue<string>()
        );
        Assert.Equal(original, await File.ReadAllTextAsync(file));
    }

    [Fact]
    public async Task Agent_counts_include_cold_members_and_inherit_refresh_selects_recent_catalog_members()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(work, "agents", "team", "memory"));
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "agents.json"),
            "{\"version\":1,\"agents\":[\"team\"]}"
        );
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            foreach (
                var (id, time) in new[]
                {
                    ("team/recent", now),
                    ("team/stale", 0L),
                    ("team/later-stale", 0L),
                }
            )
            {
                var store = new PersistentSessionAuthorityStore(data, id, "team");
                var registry = new SessionRegistry(store, new ControlledChat());
                var entry = registry.Add(id);
                entry.WithState(state =>
                {
                    state.AuthorityEnvelope["agent"] = "team";
                    state.Meta["lastMessageTime"] = time;
                });
                await entry.SaveLane.SaveStrictAsync();
                var row = SessionCatalogTests.Row(id, 0, agent: "team");
                row["meta"]!["lastMessageTime"] = id == "team/later-stale" ? now : time;
                catalog.Upsert([row]);
            }
        }
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var registered = System
            .Text.Json.JsonSerializer.SerializeToNode(manager.AgentRegistry())!
            .AsArray()
            .Single(node => node!["id"]!.GetValue<string>() == "team");
        Assert.Equal(3, registered!["sessionCount"]!.GetValue<int>());
        Assert.Empty(manager.Owners());
        var result = System.Text.Json.JsonSerializer.SerializeToNode(
            await manager.SetAgentInheritAsync("team", "main", refresh: true)
        )!;
        Assert.Equal(
            new[] { "team/recent" },
            result["affectedSessions"]!.AsArray().Select(node => node!.GetValue<string>())
        );
        Assert.Equal(
            new[] { "team/later-stale", "team/recent" },
            manager.Owners().Select(owner => owner.Id).Order(StringComparer.Ordinal)
        );
        Assert.Null(
            manager.Find("team/later-stale")!.Entry.Snapshot().AuthorityEnvelope["memorySnapshot"]
        );
    }

    [Fact]
    public async Task Same_ID_callers_share_admission_cancellation_is_local_and_another_ID_is_independent()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await Seed(data, "one", "two");
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var reached = Signal();
        var release = Signal();
        var reads = new List<string>();
        manager.BeforeAdmissionRead = async (id, token) =>
        {
            if (id == "one")
            {
                reached.TrySetResult();
                await release.Task.WaitAsync(token);
            }
        };
        manager.AdmissionReadObserved = id =>
        {
            lock (reads)
                reads.Add(id);
        };
        using var cancel = new CancellationTokenSource();
        var canceled = manager.GetExistingAsync("one", cancel.Token);
        await reached.Task;
        var others = Enumerable.Range(0, 12).Select(_ => manager.GetExistingAsync("one")).ToArray();
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => canceled);
        var second = await manager.RequiredAsync("two").WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal("two", second.Id);
        Assert.Single(manager.Owners());
        Assert.All(others, task => Assert.False(task.IsCompleted));
        release.TrySetResult();
        var owners = await Task.WhenAll(others);
        Assert.All(owners, owner => Assert.Same(owners[0], owner));
        Assert.Equal(new[] { "two", "one" }, reads);
        Assert.Equal(2, manager.Owners().Count());
    }

    [Fact]
    public async Task Dormant_missing_stopping_and_busy_recovery_preserve_retryable_membership()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await Seed(data, "missing", "busy");
        var missing = Path.Combine(data, "state", "sessions", "missing.json");
        var original = await File.ReadAllTextAsync(missing);
        File.Delete(missing);
        var busy = Path.Combine(data, "state", "sessions", "busy.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(busy))!.AsObject();
        raw["busy"] = true;
        raw["busyStartedAt"] = 1;
        raw["stopping"] = true;
        await File.WriteAllTextAsync(busy, raw.ToJsonString());
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await Assert.ThrowsAsync<InvalidDataException>(() => manager.RequiredAsync("missing"));
        var recovered = await manager.RequiredAsync("busy");
        Assert.False(recovered.Metadata().Busy);
        Assert.False(recovered.Entry.Snapshot().Stopping);
        Assert.Contains(
            recovered.Entry.Snapshot().Queue,
            item => item.Type == QueueItemType.Background
        );
        var recoveredJson = JsonNode.Parse(await File.ReadAllTextAsync(busy))!.AsObject();
        Assert.False(recoveredJson["busy"]!.GetValue<bool>());
        Assert.False(recoveredJson["stopping"]!.GetValue<bool>());
        Assert.Equal("exact", manager.Catalog.Resolve("missing")["kind"]!.GetValue<string>());
        Assert.Null(await manager.GetExistingAsync("unknown"));
        Assert.Single(manager.Owners());
        await File.WriteAllTextAsync(missing, original);
        Assert.Equal("missing", (await manager.RequiredAsync("missing")).Id);
        Assert.Collection(manager.Owners(), _ => { }, _ => { });
    }

    [Fact]
    public async Task Creation_catalog_publication_joins_one_owner_and_shutdown_drains_that_publication()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await Seed(data, "other");
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var reached = Signal();
        var release = Signal();
        var reads = new List<string>();
        manager.BeforeCreationPublication = async id =>
        {
            if (id == "new")
            {
                reached.TrySetResult();
                await release.Task;
            }
        };
        manager.AdmissionReadObserved = id => reads.Add(id);
        var creation = manager.CreateNamedAsync("main", "new", "Created", null);
        await reached.Task;
        Assert.NotNull(manager.Catalog.Get("new"));
        Assert.Null(manager.Find("new"));
        var join = manager.GetExistingAsync("new");
        Assert.False(join.IsCompleted);
        Assert.Equal(
            "other",
            (await manager.RequiredAsync("other").WaitAsync(TimeSpan.FromSeconds(3))).Id
        );
        var shutdown = manager.ShutdownAsync();
        Assert.False(shutdown.IsCompleted);
        release.TrySetResult();
        var owner = await creation;
        Assert.Same(owner, await join);
        await shutdown;
        Assert.Equal(new[] { "other" }, reads);
        Assert.Equal(2, manager.Owners().Count());
        Assert.True(File.Exists(Path.Combine(data, "state", "sessions", "new.json")));
    }

    [Fact]
    public async Task Mandatory_failure_does_not_arm_another_candidates_overdue_deadline()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await Seed(data, "deadline", "broken");
        var file = Path.Combine(data, "state", "sessions", "deadline.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        raw["meta"]!["wait"] = new JsonObject
        {
            ["id"] = "original",
            ["startedAt"] = 1,
            ["timeoutSeconds"] = 1,
            ["declarationVersion"] = 1,
        };
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            var deadline = SessionCatalogTests.Row("deadline", 0);
            deadline["meta"]!["wait"] = raw["meta"]!["wait"]!.DeepClone();
            var broken = SessionCatalogTests.Row("broken", 0);
            broken["queueLength"] = 1;
            catalog.Upsert([deadline, broken]);
        }
        File.Delete(Path.Combine(data, "state", "sessions", "broken.json"));
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await Assert.ThrowsAsync<InvalidDataException>(() => manager.LoadAsync());
        await Task.Delay(450);
        var owner = manager.Find("deadline")!;
        Assert.NotNull(owner);
        Assert.Equal("original", owner.WaitSnapshot()!["id"]!.GetValue<string>());
        Assert.Empty(owner.Entry.Snapshot().Queue);
        Assert.Empty(owner.Entry.Snapshot().History);
        Assert.False(owner.Metadata().Busy);
    }

    [Fact]
    public async Task Shutdown_cancels_shared_admission_before_publication_without_leaking_empty_owner()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await Seed(data, "one");
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var reached = Signal();
        manager.BeforeAdmissionRead = async (_, token) =>
        {
            reached.TrySetResult();
            await Task.Delay(Timeout.Infinite, token);
        };
        var admission = manager.GetExistingAsync("one");
        await reached.Task;
        manager.BeginShutdown();
        await manager.ShutdownAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => admission);
        Assert.Empty(manager.Owners());
        Assert.Equal("exact", manager.Catalog.Resolve("one")["kind"]!.GetValue<string>());
    }
}
