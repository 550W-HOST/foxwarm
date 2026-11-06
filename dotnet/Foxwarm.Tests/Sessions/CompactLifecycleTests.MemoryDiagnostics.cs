using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactLifecycleTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Failed_compaction_exposes_fixed_prefix_breakdown_through_runtime_diagnostics(
        bool background
    )
    {
        await using var fixture = await CompactFixture.CreateAsync(background);
        await fixture.SeedAsync();
        var observed = new ConcurrentQueue<string>();
        fixture.Owner.Changed += _ =>
            observed.Enqueue(fixture.Owner.RuntimeSnapshot().ToJsonString());
        fixture.Peer.FailPlan = true;
        fixture.Peer.ReleasePlan();
        await fixture.Owner.Compactor.StartManualAsync();
        await fixture.Owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(10));
        var diagnostic = observed.First(text => text.Contains("Estimated request tokens:"));
        Assert.Contains("base instructions 0", diagnostic);
        Assert.Contains(
            "memory snapshot " + CompactCandidateBuilder.Tokens(fixture.Peer.PlanInstructions!),
            diagnostic
        );
        Assert.Contains("tool declarations 0", diagnostic);
        Assert.Contains("history/request remainder ", diagnostic);
        Assert.Equal(1, fixture.Peer.PlannerRequests);
        Assert.Empty(fixture.Store.Archive.ReadBlocks());
    }
}
