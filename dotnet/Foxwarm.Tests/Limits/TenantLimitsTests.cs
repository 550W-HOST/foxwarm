using System.Text.Json.Nodes;
using Foxwarm.Limits;

namespace Foxwarm.Tests.Limits;

// The tenant limits record and the admission primitives the limits use (plan P2 §7.2).
public sealed class TenantLimitsTests
{
    private const long MiB = 1024 * 1024;

    [Fact]
    public void TheDefaultsAreThePlansStartingValues()
    {
        var limits = TenantLimits.Defaults;
        Assert.Equal(512 * MiB, limits.HotOwnerBytes);
        Assert.Equal(8, limits.BusyTurns);
        Assert.Equal(2, limits.ToolScriptRuns);
        Assert.Equal(50, limits.RequestsPerSecond);
        Assert.Equal(100, limits.RequestBurst);
        Assert.Equal(64, limits.WebSockets);
        Assert.Equal(100 * MiB, limits.UploadBytes);
        Assert.Equal(10 * 1024 * MiB, limits.BlobBytes);
        Assert.Equal(10, limits.ResidentNodes);
        Assert.Equal(8, limits.NodeExecs);
        Assert.Equal(16, limits.McpServers);
        Assert.Equal(8, limits.Channels);
        Assert.Equal(32, limits.AccessIdentities);
        Assert.Equal(16, limits.Webhooks);
        Assert.Same(TenantLimits.Defaults, TenantLimits.Parse(null));
        Assert.Null(RuntimeCapabilities.File.Limits);
        Assert.Same(TenantLimits.Defaults, RuntimeCapabilities.Hosted.Limits);
    }

    [Fact]
    public void TheColumnOverridesKnownKeysAndLeavesOtherOwnersKeys()
    {
        var limits = TenantLimits.Parse(
            new JsonObject
            {
                ["busyTurns"] = 3,
                ["uploadBytes"] = 5 * MiB,
                ["agentStoreBytes"] = 12 * MiB,
                ["dbStatements"] = 3,
                ["otherOwnerLimit"] = "anything",
            }
        );
        Assert.Equal(3, limits.BusyTurns);
        Assert.Equal(5 * MiB, limits.UploadBytes);
        Assert.Equal(12 * MiB, limits.AgentStore.TotalBytes);
        Assert.Equal(3, limits.DbStatements);
        Assert.Equal(TenantLimits.Defaults.BlobBytes, limits.BlobBytes);
    }

    [Theory]
    [InlineData(100L * 1024 * 1024, "100 MiB")]
    [InlineData(10L * 1024 * 1024 * 1024, "10 GiB")]
    [InlineData(8_804_682_956L, "8.2 GiB")]
    [InlineData(1_572_864L + 1, "1.5 MiB")]
    [InlineData(2_500L, "2.4 KiB")]
    [InlineData(512L, "512 bytes")]
    public void SizesReadAsWholeUnitsOrOneDecimal(long bytes, string text) =>
        Assert.Equal(text, TenantLimits.Size(bytes));

    [Theory]
    [InlineData("{\"busyTurns\": 0}", "limits.busyTurns")]
    [InlineData("{\"webhooks\": 1.5}", "limits.webhooks")]
    [InlineData("{\"channels\": \"8\"}", "limits.channels")]
    [InlineData("{\"nodeExecs\": 4294967296}", "limits.nodeExecs")]
    public void AMalformedLimitNamesItsKey(string column, string key)
    {
        var error = Assert.Throws<InvalidDataException>(() =>
            TenantLimits.Parse(JsonNode.Parse(column)!.AsObject())
        );
        Assert.StartsWith(key + " ", error.Message);
    }

    [Fact]
    public async Task SlotsQueueAndATenantAtItsLimitHoldsNoReplicaSlot()
    {
        var replica = new AdmissionSlots(3);
        var a = new AdmissionSlots(2, replica);
        var b = new AdmissionSlots(2, replica);
        var a1 = await a.EnterAsync();
        var a2 = await a.EnterAsync();
        var a3 = a.EnterAsync().AsTask();
        Assert.False(a3.IsCompleted);
        // Tenant a waits on its own limit and leaves the replica's third slot to b.
        Assert.Equal(2, replica.InUse);
        var b1 = await b.EnterAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        var b2 = b.EnterAsync().AsTask();
        Assert.False(b2.IsCompleted);
        // a1's replica slot goes to one of the two waiters: a3 (now holding a's slot) or b2.
        a1.Dispose();
        var first = await Task.WhenAny(a3, b2).WaitAsync(TimeSpan.FromSeconds(5));
        var other = first == a3 ? b2 : a3;
        Assert.Equal(3, replica.InUse);
        await Task.Delay(50);
        Assert.False(other.IsCompleted);
        b1.Dispose();
        var otherLease = await other.WaitAsync(TimeSpan.FromSeconds(5));
        a2.Dispose();
        (await first).Dispose();
        otherLease.Dispose();
        Assert.Equal(0, replica.InUse);
        // A cancelled wait takes nothing.
        using var cancel = new CancellationTokenSource();
        var held = await a.EnterAsync();
        var held2 = await a.EnterAsync();
        var waiting = a.EnterAsync(cancel.Token).AsTask();
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
        held.Dispose();
        held2.Dispose();
        Assert.Equal(0, a.InUse);
        Assert.Equal(0, replica.InUse);
    }

    [Fact]
    public void TheRequestRateAllowsItsBurstThenRefillsAtItsRate()
    {
        long now = 1_000;
        var rate = new RequestRate(10, 20, () => now);
        for (var i = 0; i < 20; i++)
            Assert.True(rate.TryTake(out _));
        Assert.False(rate.TryTake(out var retry));
        Assert.Equal(TimeSpan.FromMilliseconds(100), retry);
        now += 100;
        Assert.True(rate.TryTake(out _));
        Assert.False(rate.TryTake(out _));
        // Idle time refills up to the burst, not beyond.
        now += 60_000;
        for (var i = 0; i < 20; i++)
            Assert.True(rate.TryTake(out _));
        Assert.False(rate.TryTake(out _));
    }

    [Fact]
    public void OpenCountsRefuseOneOverTheirLimit()
    {
        var sockets = new OpenCount(2);
        var first = sockets.TryOpen();
        var second = sockets.TryOpen();
        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.Null(sockets.TryOpen());
        first!.Dispose();
        first.Dispose();
        Assert.Equal(1, sockets.Open);
        Assert.NotNull(sockets.TryOpen());
    }

    // A releaser over fake idle owners.
    private sealed class Owners : IHotOwnerReleaser
    {
        internal readonly List<(long Use, Action Release)> Idle = [];
        internal int Released;

        public long? OldestIdle() => Idle.Count == 0 ? null : Idle.Min(item => item.Use);

        public bool ReleaseOldestIdle()
        {
            if (Idle.Count == 0)
                return false;
            var oldest = Idle.MinBy(item => item.Use);
            Idle.Remove(oldest);
            oldest.Release();
            Released++;
            return true;
        }
    }

    [Fact]
    public async Task AHotOwnerReservationReleasesTheLeastRecentlyUsedIdleOwnerFirst()
    {
        var owners = new Owners();
        using var budget = new HotOwnerBudget(100, null, owners);
        var older = await budget.ReserveAsync(40);
        var newer = await budget.ReserveAsync(40);
        owners.Idle.Add((2, newer.Dispose));
        owners.Idle.Add((1, older.Dispose));
        var third = await budget.ReserveAsync(40);
        Assert.Equal(1, owners.Released);
        Assert.Equal(80, budget.UsedBytes);
        Assert.Equal(2, owners.Idle.Single().Use);
        third.Dispose();
        newer.Dispose();
        Assert.Equal(0, budget.UsedBytes);
        // An owner alone in its budget is admitted whatever its size.
        using var oversized = await budget.ReserveAsync(1_000);
        Assert.Equal(1_000, budget.UsedBytes);
    }

    [Fact]
    public async Task WithoutAnIdleOwnerAReservationQueuesThenTimesOut()
    {
        var owners = new Owners();
        using var budget = new HotOwnerBudget(100, null, owners, TimeSpan.FromSeconds(10));
        var busy = await budget.ReserveAsync(80);
        var waiting = budget.ReserveAsync(40);
        await Task.Delay(100);
        Assert.False(waiting.IsCompleted);
        busy.Dispose();
        using var admitted = await waiting.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(40, admitted.Bytes);

        using var quick = new HotOwnerBudget(100, null, owners, TimeSpan.FromMilliseconds(200));
        using var holder = await quick.ReserveAsync(80);
        var error = await Assert.ThrowsAsync<TenantLimitException>(() => quick.ReserveAsync(40));
        Assert.Equal("hotOwnerBytes", error.Limit);
        Assert.Equal(80, quick.UsedBytes);
    }

    [Fact]
    public async Task TheReplicaBudgetReleasesTheOldestIdleOwnerOfAnyTenant()
    {
        var pool = new HotOwnerPool(100);
        var first = new Owners();
        var second = new Owners();
        using var a = new HotOwnerBudget(1_000, pool, first);
        using var b = new HotOwnerBudget(1_000, pool, second);
        var aOwner = await a.ReserveAsync(30);
        var bOwner = await b.ReserveAsync(30);
        var aNewer = await a.ReserveAsync(30);
        first.Idle.Add((5, aNewer.Dispose));
        second.Idle.Add((3, bOwner.Dispose));
        // Tenant a is within its own budget; the replica's is full, and b's owner is older.
        using var next = await a.ReserveAsync(30);
        Assert.Equal(0, first.Released);
        Assert.Equal(1, second.Released);
        Assert.Equal(90, pool.UsedBytes);
        Assert.Equal(90, a.UsedBytes);
        Assert.Equal(0, b.UsedBytes);
        aOwner.Dispose();
    }

    [Fact]
    public void ResizingFollowsAnOwnersHistoryWithoutWaiting()
    {
        var owners = new Owners();
        using var budget = new HotOwnerBudget(100, null, owners);
        var charge = budget.Force(10);
        charge.Resize(500);
        Assert.Equal(500, budget.UsedBytes);
        charge.Resize(20);
        Assert.Equal(20, budget.UsedBytes);
        charge.Dispose();
        charge.Resize(70);
        Assert.Equal(0, budget.UsedBytes);
        Assert.Equal(HotOwnerBudget.OwnerFloorBytes + 10 * 1234, HotOwnerBudget.Estimate(1234));
    }
}
