using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class WaitLivenessTests
{
    private static async Task SetActivity(SessionOwner owner, long lastMessageTime)
    {
        owner.Entry.WithState(state => state.Meta["lastMessageTime"] = lastMessageTime);
        await owner.Entry.SaveLane.SaveStrictAsync();
    }

    [Fact]
    public void Activity_cutoff_includes_exactly_24_hours_and_catalog_selects_only_recent_waits()
    {
        const long now = 1800000000000;
        var cutoff = WaitLiveness.ActivityCutoff(now);
        Assert.False(WaitLiveness.Recent(cutoff - 1, now));
        Assert.True(WaitLiveness.Recent(cutoff, now));
        Assert.True(WaitLiveness.Recent(cutoff + 1, now));
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        foreach (
            var (id, time, waiting) in new[]
            {
                ("older", cutoff - 1, true),
                ("boundary", cutoff, true),
                ("recent", cutoff + 1, true),
                ("idle", now, false),
            }
        )
        {
            var row = SessionCatalogTests.Row(id, 0);
            row["meta"]!["lastMessageTime"] = time;
            if (waiting)
                row["meta"]!["wait"] = new JsonObject { ["id"] = id, ["startedAt"] = 1 };
            catalog.Upsert([row]);
        }
        Assert.Equal(
            new[] { "boundary", "recent" },
            catalog.RecentWaitIds(cutoff).Order(StringComparer.Ordinal)
        );
        Assert.Equal(4, catalog.List().Length);
    }

    [Fact]
    public async Task Cold_start_filters_old_waiters_but_authority_rechecks_recent_catalog_candidates()
    {
        using var temp = new TempDirectory();
        await using var peer = new Peer();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var oldTime = now - WaitLiveness.MaxInactivityMilliseconds - 60000;
        await using (var seed = Manager(temp.Path, peer))
        {
            await seed.CreateNamedAsync("main", "dependency", null, null);
            foreach (var id in new[] { "old", "recent", "stale-projection" })
            {
                var owner = await seed.CreateNamedAsync("main", id, null, null);
                await seed.DeclareWaitAsync(owner, WaitingFor("dependency"));
                // Wait age is deliberately unrelated to Session activity.
                owner.Entry.WithState(state => state.Meta["wait"]!["startedAt"] = 1);
                await SetActivity(owner, id == "recent" ? now : oldTime);
            }
        }
        using (var catalog = new SessionCatalog(Path.Combine(temp.Path, "data")))
        {
            catalog.Initialize();
            var row = catalog.Get("stale-projection")!;
            row["meta"]!["lastMessageTime"] = now;
            catalog.Upsert([row]);
        }
        var oldPath = Path.Combine(temp.Path, "data/state/sessions/old.json");
        var oldContent = await File.ReadAllTextAsync(oldPath);
        await using var manager = Manager(temp.Path, peer);
        var reads = new ConcurrentBag<string>();
        var candidateCounts = new List<int>();
        manager.AdmissionReadObserved = reads.Add;
        manager.Catalog.QueryObserved = (sql, count) =>
        {
            if (sql.Contains("recent_rank<=", StringComparison.Ordinal))
                candidateCounts.Add(count);
        };
        await manager.LoadAsync();
        await Until(() => peer.Requests.Count == 1);
        await Settle(manager);
        Assert.Equal(new[] { 2 }, candidateCounts);
        Assert.Equal(new[] { "recent", "stale-projection" }, reads.Order(StringComparer.Ordinal));
        Assert.Null(manager.Find("old"));
        Assert.Null(manager.Find("dependency"));
        Assert.NotNull(manager.Find("stale-projection")!.WaitSnapshot());
        Assert.Null(manager.Find("recent")!.WaitSnapshot());
        Assert.Equal(oldContent, await File.ReadAllTextAsync(oldPath));
        Diagnostic(peer.Requests.Single());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Old_waits_ignore_later_transitions_and_new_input_reactivates_diagnosis(
        bool hot
    )
    {
        using var temp = new TempDirectory();
        await using var peer = new Peer();
        string? waitId;
        await using (var seed = Manager(temp.Path, peer))
        {
            await seed.CreateNamedAsync("main", "dependency", null, null);
            var seededWaiter = await seed.CreateNamedAsync("main", "waiter", null, null);
            waitId = await seed.DeclareWaitAsync(seededWaiter, WaitingFor("dependency"));
            await SetActivity(seededWaiter, 1);
        }
        await using var manager = Manager(temp.Path, peer);
        await manager.LoadAsync();
        if (hot)
        {
            var owner = await manager.RequiredAsync("waiter");
            // A fresh wait declaration alone does not advance Session activity.
            waitId = await manager.DeclareWaitAsync(owner, WaitingFor("dependency"));
            await manager.RenameAsync(owner.Id, "Renamed old waiter");
        }
        var dependency = await manager.RequiredAsync("dependency");
        await dependency.Registry.Ingress.EnqueueAsync(dependency.Id, QueueItem.UserText("work"));
        await Settle(manager);
        Assert.Single(peer.Requests);
        Assert.Equal(waitId, SessionWait.Text(manager.CatalogMetadata("waiter")!.Wait!["id"]));
        await manager.AdmitWaitEventAsync(
            "waiter",
            SessionWait.Event(
                "wait-sources-quiescent",
                "old",
                fields: new() { ["waitLivenessWaitId"] = waitId }
            )
        );
        Assert.Equal(hot, manager.Find("waiter") is not null);
        var waiter = await manager.RequiredAsync("waiter");
        await waiter.Registry.Ingress.EnqueueAsync(waiter.Id, QueueItem.UserText("new activity"));
        await Settle(manager);
        Assert.Equal(2, peer.Requests.Count);
        Assert.Null(waiter.WaitSnapshot());
        Assert.True(
            WaitLiveness.Recent(
                waiter.Metadata().LastMessageTime,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            )
        );
        await manager.DeclareWaitAsync(waiter, WaitingFor("dependency"));
        await Until(() => peer.Requests.Count == 3);
        await Settle(manager);
        Diagnostic(peer.Requests.Last());
    }

    [Fact]
    public async Task Strict_diagnostic_admission_rechecks_authoritative_activity()
    {
        using var temp = new TempDirectory();
        await using var peer = new Peer();
        await using var manager = Manager(temp.Path, peer);
        var owner = await manager.CreateNamedAsync("main", "waiter", null, null);
        var waitId = await manager.DeclareWaitAsync(owner, new() { ["waitForInput"] = true });
        var diagnostic = SessionWait.Event(
            "wait-sources-quiescent",
            "old",
            fields: new() { ["waitLivenessWaitId"] = waitId }
        );
        await SetActivity(owner, 1);
        Assert.False(await owner.Entry.SaveLane.AdmitAsync(diagnostic, SaveKind.Strict));
        Assert.Equal(waitId, SessionWait.Text(owner.WaitSnapshot()!["id"]));
        await SetActivity(owner, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        Assert.True(await owner.Entry.SaveLane.AdmitAsync(diagnostic, SaveKind.Strict));
        Assert.Single(owner.Entry.Snapshot().Queue);
        Assert.Empty(peer.Requests);
    }

    [Fact]
    public async Task Old_activity_does_not_suppress_deadlines_or_real_busy_and_queued_recovery()
    {
        using var temp = new TempDirectory();
        await using var peer = new Peer();
        await using (var seed = Manager(temp.Path, peer))
        {
            foreach (var id in new[] { "timed", "busy", "queued" })
            {
                var owner = await seed.CreateNamedAsync("main", id, null, null);
                if (id == "timed")
                {
                    await seed.DeclareWaitAsync(
                        owner,
                        new() { ["wakeIfNoActivityAfterSeconds"] = 1 }
                    );
                    owner.Entry.WithState(state => state.Meta["wait"]!["startedAt"] = 1);
                }
                else if (id == "busy")
                    owner.Entry.WithState(state => state.Busy = true);
                else
                    await owner.Entry.SaveLane.AdmitAsync(
                        QueueItem.UserText("queued work"),
                        SaveKind.Strict
                    );
                await SetActivity(owner, 1);
            }
        }
        await using var manager = Manager(temp.Path, peer);
        Assert.Equal(
            new[] { "busy", "queued" },
            manager.Catalog.RestartIds().Order(StringComparer.Ordinal)
        );
        await manager.LoadAsync();
        await Until(() => peer.Requests.Count == 3);
        await Settle(manager);
        Assert.Equal(
            new[] { "busy", "queued", "timed" },
            manager.Owners().Select(owner => owner.Id).Order(StringComparer.Ordinal)
        );
        Assert.Contains("wait-timeout", manager.Find("timed")!.History()[0].ToJsonString());
        Assert.Contains("session-resumed", manager.Find("busy")!.History()[0].ToJsonString());
        Assert.All(manager.Owners(), owner => Assert.Null(owner.WaitSnapshot()));
    }
}
