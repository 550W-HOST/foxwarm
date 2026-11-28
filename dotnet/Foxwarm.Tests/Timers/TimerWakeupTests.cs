using System.Text.Json.Nodes;
using Foxwarm.Timers;

namespace Foxwarm.Tests;

public sealed class TimerWakeupTests
{
    private static async Task<MainTimers> Open(string root, TimerOccurrence? carried, Func<JsonObject, Task> deliver)
    {
        var clock = new MainTimers(root, deliver);
        clock.EnableWakeups(carried);
        await clock.LoadAsync();
        clock.Start();
        return clock;
    }

    [Fact]
    public async Task ACarriedDailyCronFiresLateOnceAndTheNextOwnerDoesNotRepeatIt()
    {
        using var temp = new TempDirectory();
        var calls = 0;
        var fired = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task Deliver(JsonObject row) { Interlocked.Increment(ref calls); fired.TrySetResult(); return Task.CompletedTask; }
        TimerOccurrence nomination;
        await using (var first = await Open(temp.Path, null, Deliver))
        {
            var row = await first.CreateAsync(new JsonObject { ["sessionId"] = "main", ["cron"] = "13 2 * * *", ["message"] = "daily" }, default);
            var next = first.NextWakeup()!.Value;
            nomination = Assert.IsType<TimerOccurrence>(next.Cron);
            Assert.Equal(row["id"]!.GetValue<string>(), nomination.TimerId);
            Assert.Equal(TimeSpan.FromMinutes(2).TotalMilliseconds, nomination.ScheduledAt - next.DueAt);
        }
        // Start after the nominated occurrence; this is the payload read by the new grant.
        var prior = nomination with { ScheduledAt = DateTimeOffset.UtcNow.AddSeconds(-5).ToUnixTimeMilliseconds() };
        await using (var second = await Open(temp.Path, TimerOccurrence.FromJson(prior.ToJson()), Deliver))
        {
            await fired.Task.WaitAsync(TimeSpan.FromSeconds(3));
            await second.DisposeAsync(); // Includes the completion save.
            nomination = second.NextWakeup()!.Value.Cron!;
            Assert.True(nomination.ScheduledAt > prior.ScheduledAt);
        }
        await using var third = await Open(temp.Path, nomination, Deliver);
        Assert.Equal(1, calls);
        Assert.Equal(nomination, third.NextWakeup()!.Value.Cron);
        Assert.Equal(1, third.Detail(nomination.TimerId, "main")["recentRuns"]!.AsArray().Count);
    }

    [Fact]
    public async Task AnEditInTheSaveLaneSuppliesTheReleasedScheduleAfterArmingStops()
    {
        using var temp = new TempDirectory();
        await using var clock = await Open(temp.Path, null, _ => Task.CompletedTask);
        var initial = await clock.CreateAsync(new JsonObject { ["sessionId"] = "main", ["cron"] = "13 2 * * *", ["message"] = "daily" }, default);
        var id = initial["id"]!.GetValue<string>();
        var first = clock.NextWakeup()!.Value.Cron!;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var replacement = clock.Get(id, "main");
        replacement["cron"] = "23 5 * * *";
        var writing = clock.UpdateAsync(id, replacement, default, () => { started.SetResult(); return resume.Task; });
        await started.Task;
        clock.StopFuture();
        var settling = clock.DisposeAsync().AsTask();
        Assert.False(settling.IsCompleted);
        resume.SetResult();
        await writing;
        await settling;
        var carried = clock.NextWakeup()!.Value.Cron!;
        Assert.Equal(id, carried.TimerId);
        Assert.NotEqual(first.Generation, carried.Generation);
        Assert.Equal(new CronSchedule("23 5 * * *", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).Next(), carried.ScheduledAt);
    }

    [Fact]
    public async Task AnEditedScheduleRejectsTheOldCronOccurrence()
    {
        using var temp = new TempDirectory();
        TimerOccurrence old;
        await using (var first = await Open(temp.Path, null, _ => Task.CompletedTask))
        {
            var row = await first.CreateAsync(new JsonObject { ["sessionId"] = "main", ["cron"] = "15 3 * * *", ["message"] = "daily" }, default);
            old = first.NextWakeup()!.Value.Cron!;
            var update = first.Get(old.TimerId, "main");
            update["cron"] = "16 4 * * *";
            await first.UpdateAsync(old.TimerId, update, default);
        }
        await using var later = await Open(temp.Path, old with { ScheduledAt = 1 }, _ => Task.CompletedTask);
        var next = later.NextWakeup()!.Value.Cron!;
        Assert.NotEqual(old.Generation, next.Generation);
        Assert.True(next.ScheduledAt > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }
}
