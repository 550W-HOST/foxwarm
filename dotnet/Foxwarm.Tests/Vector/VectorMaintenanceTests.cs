using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorMaintenanceTests
{
    [Fact]
    public async Task Source_maintenance_coalesces_mutations_and_preserves_the_one_hour_retry_not_before_time()
    {
        var clock = new ManualWsClock();
        var checks = new List<string[]>();
        var errors = 0;
        await using var maintenance = new VectorMaintenance(true, clock, triggers =>
        {
            checks.Add(triggers.ToArray());
            if (checks.Count == 1)
                throw new IOException("synthetic check failure");
            return Task.CompletedTask;
        }, () => errors++);
        maintenance.Start();
        await maintenance.StartupAsync();
        Assert.Equal("startup", Assert.Single(checks[0]));
        Assert.Equal(1, errors);
        maintenance.Request("mutation-threshold");
        clock.Advance(TimeSpan.FromMinutes(59));
        Assert.Single(checks);
        clock.Advance(TimeSpan.FromMinutes(1));
        await maintenance.StartupAsync();
        Assert.Equal(2, checks.Count);
        Assert.Equal(new[] { "retry", "mutation-threshold" }, checks[1]);
        for (var index = 0; index < 127; index++) maintenance.RecordMutation();
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(2, checks.Count);
        maintenance.RecordMutation();
        clock.Advance(TimeSpan.FromMinutes(1));
        await maintenance.StartupAsync();
        Assert.Equal("mutation-threshold", Assert.Single(checks[2]));
    }
    [Fact]
    public async Task Source_table_gate_runs_queued_exclusive_work_before_waiting_regular_work()
    {
        var gate = new VectorOperationGate();
        var initial = await gate.EnterAsync();
        var firstWriter = gate.EnterAsync(exclusive: true);
        var lateReader = gate.EnterAsync();
        var secondWriter = gate.EnterAsync(exclusive: true);
        initial.Dispose();
        var first = await firstWriter;
        Assert.False(lateReader.IsCompleted);
        Assert.False(secondWriter.IsCompleted);
        first.Dispose();
        var second = await secondWriter;
        Assert.False(lateReader.IsCompleted);
        second.Dispose();
        using var finalReader = await lateReader;
    }
}
