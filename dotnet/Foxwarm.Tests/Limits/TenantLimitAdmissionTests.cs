using System.Text.Json.Nodes;
using Foxwarm.Limits;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Limits;

// Each tenant limit at its admission point (plan P2 §7.2), over file storage with the limits
// a hosted runtime has. File mode, without limits, admits as before.
public sealed class TenantLimitAdmissionTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal SessionManager Manager = null!;

        internal string Data => Path.Combine(Temp.Path, "data");

        internal static async Task<Fixture> Create(TenantLimits? limits, ReplicaLimits? replica = null)
        {
            var f = new Fixture();
            Directory.CreateDirectory(Path.Combine(f.Temp.Path, "work"));
            f.Manager = new SessionManager(
                f.Data,
                Path.Combine(f.Temp.Path, "work"),
                Options,
                HostModels.ForTest(Options),
                capabilities: RuntimeCapabilities.File with { Limits = limits }
            )
            {
                ReplicaLimits = replica ?? new ReplicaLimits(long.MaxValue),
            };
            await f.Manager.LoadAsync();
            return f;
        }

        public async ValueTask DisposeAsync()
        {
            await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    private static TenantLimits Limits => TenantLimits.Defaults;

    private static bool Resident(SessionManager manager, string id) =>
        manager.Owners().Any(owner => owner.Id == id);

    [Fact]
    public async Task FileModeHasNoAdmissionState()
    {
        await using var f = await Fixture.Create(null);
        Assert.Null(f.Manager.Admission);
        Assert.Null(f.Manager.BlobQuota);
        Assert.Null(f.Manager.ToolScript.AdmitProcess);
        Assert.Null(f.Manager.Nodes.AdmitCall);
        Assert.Null(f.Manager.Nodes.Registry.MaxApprovedNodes);
        Assert.Null(f.Manager.OutboundMcp.Configuration.MaxServers);
        var owner = await f.Manager.CreateNamedAsync("main", "plain", null, null);
        Assert.Null(owner.Registry.TurnAdmission);
    }

    [Fact]
    public async Task HotOwnerBytesReleaseTheLeastRecentlyUsedIdleOwnerAtOwnerAdmission()
    {
        // Room for one empty owner.
        var one = HotOwnerBudget.Estimate(0) * 3 / 2;
        await using var f = await Fixture.Create(Limits with { HotOwnerBytes = one });
        var first = await f.Manager.CreateNamedAsync("main", "first", null, null);
        var budget = f.Manager.Admission!.HotOwners;
        Assert.InRange(budget.UsedBytes, HotOwnerBudget.OwnerFloorBytes, one);
        // A created owner is charged at once; the older idle owner leaves memory.
        var second = await f.Manager.CreateNamedAsync("main", "second", null, null);
        Assert.False(Resident(f.Manager, first.Id));
        Assert.True(Resident(f.Manager, second.Id));
        Assert.Equal(1, f.Manager.ReleasedOwnerCount);
        Assert.InRange(budget.UsedBytes, HotOwnerBudget.OwnerFloorBytes, one);
        // Loading the first again releases the second.
        var reloaded = await f.Manager.GetExistingAsync(first.Id);
        Assert.NotNull(reloaded);
        Assert.False(Resident(f.Manager, second.Id));
        Assert.Equal(2, f.Manager.ReleasedOwnerCount);
        Assert.InRange(budget.UsedBytes, HotOwnerBudget.OwnerFloorBytes, one);
        // Idle release returns the charge.
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());
        Assert.Equal(0, budget.UsedBytes);
    }

    [Fact]
    public async Task TheReplicasHotOwnerBudgetReleasesAnotherTenantsIdleOwner()
    {
        var one = HotOwnerBudget.Estimate(0) * 3 / 2;
        var replica = new ReplicaLimits(one);
        await using var a = await Fixture.Create(Limits, replica);
        await using var b = await Fixture.Create(Limits, replica);
        var older = await a.Manager.CreateNamedAsync("main", "older", null, null);
        Assert.True(Resident(a.Manager, older.Id));
        var newer = await b.Manager.CreateNamedAsync("main", "newer", null, null);
        Assert.False(Resident(a.Manager, older.Id));
        Assert.True(Resident(b.Manager, newer.Id));
        Assert.Equal(0, a.Manager.Admission!.HotOwners.UsedBytes);
        Assert.InRange(replica.HotOwners.UsedBytes, HotOwnerBudget.OwnerFloorBytes, one);
    }

    [Fact]
    public async Task BusyTurnsQueueAtTheTurnAndStopEndsTheWait()
    {
        var turns = new AdmissionSlots(1);
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        var registry = new SessionRegistry(store, chat) { TurnAdmission = turns.EnterAsync };
        var first = registry.Add("first");
        var second = registry.Add("second");
        first.State.Queue.Add(QueueItem.UserText("one"));
        second.State.Queue.Add(QueueItem.UserText("two"));
        chat.QueueAwaitingResult();
        chat.QueueResult("second answer");
        var running = registry.Runner.ProcessQueueAsync("first");
        await chat.WaitForStarted("first").WaitAsync(TimeSpan.FromSeconds(5));
        var queued = registry.Runner.ProcessQueueAsync("second");
        await Task.Delay(200);
        // The second turn claimed its Session and waits for the tenant's slot.
        Assert.Single(chat.Calls);
        Assert.True(second.Snapshot().Busy);
        chat.Complete("first answer");
        await running.WaitAsync(TimeSpan.FromSeconds(5));
        await queued.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, chat.Calls.Count);
        Assert.Equal(0, turns.InUse);

        // A Stop of a waiting turn ends its wait like a running turn's.
        var held = await turns.EnterAsync();
        var third = registry.Add("third");
        third.State.Queue.Add(QueueItem.UserText("three"));
        var waiting = registry.Runner.ProcessQueueAsync("third");
        await TelegramChannelTests.Until(() => third.Snapshot().Busy);
        await registry.Control.StopAsync("third");
        await waiting.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(third.Snapshot().Busy);
        Assert.Equal(2, chat.Calls.Count);
        held.Dispose();
    }

    [Fact]
    public async Task TheRuntimesTurnsTakeTheTenantsBusyTurnSlots()
    {
        await using var f = await Fixture.Create(Limits with { BusyTurns = 1 });
        var owner = await f.Manager.CreateNamedAsync("main", "turns", null, null);
        var admit = owner.Registry.TurnAdmission!;
        using var slot = await admit(default);
        Assert.Equal(1, f.Manager.Admission!.Turns.InUse);
        var next = admit(default).AsTask();
        await Task.Delay(50);
        Assert.False(next.IsCompleted);
        slot.Dispose();
        (await next.WaitAsync(TimeSpan.FromSeconds(5))).Dispose();
    }

    [Fact]
    public async Task ToolScriptProcessesWaitForTheTenantsAndTheReplicasSlots()
    {
        var replica = new ReplicaLimits(long.MaxValue, toolScriptRuns: 3);
        await using var a = await Fixture.Create(Limits, replica);
        await using var b = await Fixture.Create(Limits, replica);
        var admitA = a.Manager.ToolScript.AdmitProcess!;
        var admitB = b.Manager.ToolScript.AdmitProcess!;
        var a1 = await admitA(default);
        var a2 = await admitA(default);
        // The tenant's two slots are taken: a third process waits.
        var a3 = admitA(default).AsTask();
        var b1 = await admitB(default).AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        // The replica's three slots are taken: b waits too.
        var b2 = admitB(default).AsTask();
        await Task.Delay(50);
        Assert.False(a3.IsCompleted);
        Assert.False(b2.IsCompleted);
        a1.Dispose();
        var first = await Task.WhenAny(a3, b2).WaitAsync(TimeSpan.FromSeconds(5));
        (await first).Dispose();
        (await (first == a3 ? b2 : a3).WaitAsync(TimeSpan.FromSeconds(5))).Dispose();
        a2.Dispose();
        b1.Dispose();
        Assert.Equal(0, replica.ToolScripts.InUse);
    }

    [Fact]
    public async Task RemoteCallsWaitForTheTenantsExecSlots()
    {
        await using var f = await Fixture.Create(Limits with { NodeExecs = 1 });
        var slots = f.Manager.Admission!.NodeExecs;
        var held = await slots.EnterAsync();
        var call = f.Manager.Nodes.ExecuteAsync(
            "absent",
            "exec",
            new JsonObject(),
            "session",
            "main",
            "absent",
            null,
            false,
            default
        );
        await Task.Delay(100);
        Assert.False(call.IsCompleted);
        held.Dispose();
        // Admitted, the call proceeds (and finds no such Node), releasing its slot.
        await Assert.ThrowsAnyAsync<Exception>(() => call.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(0, slots.InUse);
    }

    [Fact]
    public async Task PairingStopsAtTheResidentNodeLimit()
    {
        await using var f = await Fixture.Create(Limits with { ResidentNodes = 2 });
        f.Manager.Nodes.Registry.Create("node-a");
        f.Manager.Nodes.Registry.Create("node-b");
        var error = Assert.Throws<TenantLimitException>(() => f.Manager.Nodes.Registry.Create("node-c"));
        Assert.Equal("residentNodes", error.Limit);
        Assert.Equal(2, f.Manager.Nodes.Registry.ListApproved().Count);
        f.Manager.Nodes.Registry.Remove("node-a");
        f.Manager.Nodes.Registry.Create("node-c");
    }

    [Fact]
    public async Task McpServersStopAtTheLimitWhenAdded()
    {
        await using var f = await Fixture.Create(Limits with { McpServers = 1 });
        var configuration = f.Manager.OutboundMcp.Configuration;
        Assert.Equal(1, configuration.MaxServers);
        static JsonObject Server(string url) =>
            new() { ["transport"] = "streamable-http", ["url"] = url, ["enable"] = false };
        await configuration.UpdateAsync("first", Server("https://one.example/mcp"), false);
        var error = await Assert.ThrowsAsync<TenantLimitException>(() =>
            configuration.UpdateAsync("second", Server("https://two.example/mcp"), false)
        );
        Assert.Equal("mcpServers", error.Limit);
        // Changing an existing server isn't an addition.
        await configuration.UpdateAsync("first", Server("https://three.example/mcp"), false);
        Assert.Single(configuration.Snapshot());
    }

    private static string Identities(int count, int webhooks = 0)
    {
        var yaml = "access:\n  identities:\n";
        for (var i = 0; i < count; i++)
            yaml += $"    id{i}:\n      token: synthetic-token-{i}\n      surfaces:\n        webui: {{sessions: [main]}}\n";
        for (var i = 0; i < webhooks; i++)
            yaml += $"    hook{i}:\n      token: synthetic-hook-{i}\n      surfaces:\n        webhook: {{session: main, verify: bearer}}\n";
        return yaml;
    }

    [Fact]
    public async Task ConfigurationCountsAreCheckedWhenTheConfigurationIsSaved()
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(Path.Combine(temp.Path, "data"), temp.Path, environment: _ => null);
        Directory.CreateDirectory(Path.Combine(paths.DataRoot, "state"));
        var config = new ModelConfiguration(paths)
        {
            Limits = Limits with { AccessIdentities = 2, Webhooks = 1, Channels = 1 },
        };
        await config.SaveAppAsync(Identities(2));
        var identities = await Assert.ThrowsAsync<TenantLimitException>(() => config.SaveAppAsync(Identities(3)));
        Assert.Equal("accessIdentities", identities.Limit);
        var webhooks = await Assert.ThrowsAsync<TenantLimitException>(() => config.SaveAppAsync(Identities(0, webhooks: 2)));
        Assert.Equal("webhooks", webhooks.Limit);
        var channels = new JsonObject
        {
            ["channels"] = new JsonObject
            {
                ["a"] = ExternalChannelFixture.Channel("a"),
                ["b"] = ExternalChannelFixture.Channel("b"),
            },
        };
        var refused = await Assert.ThrowsAsync<TenantLimitException>(() => config.SaveAppAsync(channels.ToJsonString()));
        Assert.Equal("channels", refused.Limit);

        // A configuration already above a limit (an import) can be saved unchanged or smaller.
        await File.WriteAllTextAsync(paths.ConfigPath, Identities(4));
        var over = new ModelConfiguration(paths) { Limits = Limits with { AccessIdentities = 2 } };
        await over.SaveAppAsync(Identities(4));
        await over.SaveAppAsync(Identities(3));
        await Assert.ThrowsAsync<TenantLimitException>(() => over.SaveAppAsync(Identities(4)));
    }

    // An image blob name: a SHA-256 and an extension.
    private static string Key(char fill) => new string(fill, 64) + ".bin";

    [Fact]
    public async Task BlobsAreRefusedOverTheLimitAndWarnPastEightyPercent()
    {
        using var temp = new TempDirectory();
        var store = new Foxwarm.Images.ImageBlobFiles(temp.Path);
        var quota = new BlobQuota(1000, _ => Task.FromResult(500L));
        var limited = quota.Apply(store);
        Assert.False(quota.Warned);
        Assert.True(await limited.CreateAsync(Key('a'), new byte[300], keepExisting: true, default));
        Assert.Equal(800, await quota.UsedAsync(default));
        // 80% of the limit: the operator log is warned once.
        Assert.True(quota.Warned);
        // Stored content costs nothing again.
        Assert.False(await limited.CreateAsync(Key('a'), new byte[300], keepExisting: true, default));
        var error = await Assert.ThrowsAsync<TenantLimitException>(() =>
            limited.CreateAsync(Key('b'), new byte[201], keepExisting: true, default)
        );
        Assert.Equal("blobBytes", error.Limit);
        Assert.False(store.Exists(Key('b')));
        Assert.True(await limited.CreateAsync(Key('c'), new byte[200], keepExisting: true, default));
        Assert.Equal(1000, await quota.UsedAsync(default));
    }

    [Fact]
    public async Task TheRuntimesImagesAndArtifactsCarryTheBlobLimit()
    {
        await using var f = await Fixture.Create(Limits with { BlobBytes = 1024 });
        Assert.Equal(1024, f.Manager.BlobQuota!.Limit);
        var error = await Assert.ThrowsAsync<TenantLimitException>(() =>
            f.Manager.Images.PutAsync(new byte[2048], "application/octet-stream", "large")
        );
        Assert.Equal("blobBytes", error.Limit);
        await f.Manager.Images.PutAsync(new byte[512], "application/octet-stream", "small");
        Assert.Equal(512, await f.Manager.BlobQuota.UsedAsync(default));
    }
}
