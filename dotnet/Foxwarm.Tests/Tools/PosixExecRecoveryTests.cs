using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class PosixExecRecoveryTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Timeout_or_stop_retains_process_and_restart_delivers_completion_once(bool stop)
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        using var temp = new TempDirectory();
        var release = Path.Combine(temp.Path, "release");
        var entered = Path.Combine(temp.Path, "entered");
        var delivered = new List<string>();
        Task Deliver(string owner, string id, string message)
        {
            Assert.Equal("main/owned", owner);
            delivered.Add(message);
            return Task.CompletedTask;
        }
        string? statusPath = null;
        try
        {
            await using (var first = new LocalExecManager(temp.Path, _ => temp.Path, Deliver))
            {
                using var cancellation = new CancellationTokenSource();
                var running = first.ExecuteAsync("main/owned", new JsonObject
                {
                    ["command"] = "printf x >> launches; touch entered; while [ ! -f release ]; do sleep .05; done; printf 'completed 🦊\\n'; printf 'stderr\\n' >&2; exit 7",
                    ["timeout"] = stop ? 30.0 : 1.0,
                }, cancellation.Token);
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                while (!File.Exists(entered)) await Task.Delay(20, deadline.Token);
                if (stop) cancellation.Cancel();
                var response = await running;
                Assert.Null(response["error"]);
                var record = Assert.Single(first.Tracked);
                Assert.NotNull(record["processStartTicks"]);
                statusPath = record["statusPath"]!.GetValue<string>();
                Assert.False(File.Exists(statusPath));
            }
            await using var recovered = new LocalExecManager(temp.Path, _ => temp.Path, Deliver);
            await recovered.InitializeAsync(owner => owner == "main/owned");
            // Cross the missing-status grace period: a live Darwin PID must not
            // be mistaken for a finished command merely because /proc is absent.
            await Task.Delay(3200);
            await recovered.ReconcileNowAsync();
            Assert.Single(recovered.Tracked);
            Assert.Empty(delivered);
            Assert.False(File.Exists(statusPath));
            await File.WriteAllTextAsync(release, "finish");
            using var finish = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (!File.Exists(statusPath)) await Task.Delay(20, finish.Token);
            await recovered.ReconcileNowAsync();
            await recovered.ReconcileNowAsync();
            var message = Assert.Single(delivered);
            Assert.Contains("Exit code: 7", message);
            Assert.Equal("x", await File.ReadAllTextAsync(Path.Combine(temp.Path, "launches")));
            Assert.Empty(recovered.Tracked);
        }
        finally
        {
            await File.WriteAllTextAsync(release, "finish");
            if (statusPath is not null)
                for (var i = 0; i < 100 && !File.Exists(statusPath); i++) await Task.Delay(20);
        }
    }
}
