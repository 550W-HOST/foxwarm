using Foxwarm.Channels;

namespace Foxwarm.Tests;

public sealed class ChannelProgressTests
{
    private sealed class Clock : TimeProvider
    {
        private DateTimeOffset now = DateTimeOffset.UnixEpoch;
        private readonly List<Timer> timers = [];
        public override DateTimeOffset GetUtcNow() => now;
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new Timer(this, callback, state);
            timers.Add(timer);
            timer.Change(dueTime, period);
            return timer;
        }
        internal void Advance(TimeSpan elapsed)
        {
            now += elapsed;
            foreach (var timer in timers.ToArray().Where(timer => timer.Due <= now)) timer.Fire();
        }
        private sealed class Timer(Clock clock, TimerCallback callback, object? state) : ITimer
        {
            internal DateTimeOffset Due = DateTimeOffset.MaxValue;
            public bool Change(TimeSpan dueTime, TimeSpan period) { Due = dueTime == Timeout.InfiniteTimeSpan ? DateTimeOffset.MaxValue : clock.now + dueTime; return true; }
            internal void Fire() { Due = DateTimeOffset.MaxValue; callback(state); }
            public void Dispose() => Due = DateTimeOffset.MaxValue;
            public ValueTask DisposeAsync() { Dispose(); return ValueTask.CompletedTask; }
        }
    }

    [Fact]
    public async Task Cadence_is_fixed_target_baselines_are_independent_and_exact_wait_is_silent()
    {
        var clock = new Clock();
        var progress = new ChannelProgress(clock);
        var first = new List<string>();
        var second = new List<string>();
        var targets = new[]
        {
            new ChannelProgressTarget("alpha:42", TimeSpan.FromSeconds(30), text => { first.Add(text); return Task.CompletedTask; }),
            new ChannelProgressTarget("beta:42", TimeSpan.FromSeconds(60), text => { second.Add(text); return Task.CompletedTask; }),
        };
        progress.Report("turn", targets, "wait-1", "wait", true);
        clock.Advance(TimeSpan.FromMinutes(2));
        progress.Finish("turn");
        Assert.Empty(first);
        Assert.Empty(second);
        progress.Report("turn", targets, "one", "read_exec", true);
        clock.Advance(TimeSpan.FromSeconds(20));
        progress.Report("turn", targets, "two", "exec", true);
        clock.Advance(TimeSpan.FromSeconds(10));
        await TelegramChannelTests.Until(() => first.Count == 1);
        Assert.Contains("read_exec", first.Single());
        Assert.Contains("exec", first.Single());
        Assert.Empty(second);
        Assert.Equal("normal text", progress.Decorate("turn", "alpha:42", "normal text"));
        Assert.Contains("read_exec", progress.Decorate("turn", "beta:42", "normal text"));
        clock.Advance(TimeSpan.FromSeconds(30));
        await TelegramChannelTests.Until(() => first.Count == 2 && second.Count == 1);
        Assert.Contains("running", first.Last());
        progress.Report("turn", targets, "one", "read_exec", false);
        progress.Report("turn", targets, "two", "exec", false);
        progress.Finish("turn");
        clock.Advance(TimeSpan.FromHours(2));
        Assert.Equal(2, first.Count);
        Assert.Single(second);
    }

    [Fact]
    public async Task Terminal_cleanup_does_not_wait_for_inflight_send_and_reset_fences_future_timer_or_flush_work()
    {
        var clock = new Clock();
        var progress = new ChannelProgress(clock);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var count = 0;
        var targets = new[] { new ChannelProgressTarget("alpha:42", TimeSpan.FromSeconds(30), async _ =>
        {
            Interlocked.Increment(ref count);
            entered.TrySetResult();
            await release.Task;
        }) };
        progress.Report("turn", targets, "one", "read", true);
        clock.Advance(TimeSpan.FromSeconds(30));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        progress.Report("turn", targets, "two", "write", true);
        progress.Finish("turn");
        progress.Reset();
        release.TrySetResult();
        clock.Advance(TimeSpan.FromHours(2));
        Assert.Equal(1, count);
    }
}
