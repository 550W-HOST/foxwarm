using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class MainExecLifetimeTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Actual_identity_move_or_retirement_preserves_started_native_effect_and_original_artifact_paths(
        bool retire
    )
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "original", null, null);
        var release = Path.Combine(work, "release");
        try
        {
            var result = await owner.Executor.ExecuteAsync(
                owner.Id,
                new JsonObject
                {
                    ["command"] =
                        "printf x >> launches; while [ ! -f release ]; do sleep .05; done; printf '  retained native output\\n'",
                    ["timeout"] = 1.0,
                },
                default
            );
            Assert.Contains("Switched to background", result["output"]!.GetValue<string>());
            var original = Assert.Single(owner.Executor.Tracked);
            Assert.Equal("original", original["sessionId"]!.GetValue<string>());
            var log = original["logPath"]!.GetValue<string>();
            var status = original["statusPath"]!.GetValue<string>();
            if (retire)
            {
                await manager.DeleteAsync("original");
                Assert.Empty(owner.Executor.Tracked);
            }
            else
            {
                await manager.CreateAgentAsync("destination", false);
                await manager.MoveIdentityAsync(
                    owner,
                    new JsonObject { ["newSessionId"] = "moved", ["newAgentName"] = "destination" }
                );
                Assert.True(
                    owner.Executor.IsOwnedActive(
                        "destination/moved",
                        original["id"]!.GetValue<string>()
                    )
                );
                Assert.Equal(
                    "original",
                    Assert.Single(owner.Executor.Tracked)["sessionId"]!.GetValue<string>()
                );
                Assert.Equal(
                    log,
                    Assert.Single(owner.Executor.Tracked)["logPath"]!.GetValue<string>()
                );
            }
            await File.WriteAllTextAsync(release, "finish");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (!File.Exists(status))
                await Task.Delay(20, deadline.Token);
            await owner.Executor.ReconcileNowAsync();
            Assert.Empty(owner.Executor.Tracked);
            Assert.Equal("x", await File.ReadAllTextAsync(Path.Combine(work, "launches")));
            Assert.Equal("  retained native output\n", await File.ReadAllTextAsync(log));
            if (retire)
                Assert.Null(await manager.GetExistingAsync("original"));
            else
                Assert.Contains(
                    "background-process-finished",
                    JsonSerializer.Serialize(owner.Entry.Snapshot())
                );
            await owner.Executor.ReconcileNowAsync();
            Assert.Equal("x", await File.ReadAllTextAsync(Path.Combine(work, "launches")));
        }
        finally
        {
            await File.WriteAllTextAsync(release, "finish");
        }
    }
}
