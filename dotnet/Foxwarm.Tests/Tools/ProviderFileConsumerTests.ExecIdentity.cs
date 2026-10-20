using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Identity_command_during_actual_start_retains_original_receipt_and_completes_under_moved_lifetime(
        bool native
    )
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(native ? "normal" : "slow-start");
        await f.Manager.CreateAgentAsync("destination", false);
        var originalId = f.Owner.Id;
        var originalAgentDirectory = f.Manager.AgentDirectory("main");
        var previousBashEnv = Environment.GetEnvironmentVariable("BASH_ENV");
        var starting = Path.Combine(f.Work, "native-started");
        var launchRelease = Path.Combine(f.Work, "launch-release");
        var release = native ? Path.Combine(f.Work, "release") : f.FilePath("release");
        var effect = native ? Path.Combine(f.Work, "identity-effect") : f.FilePath("identity-effect");
        Task<JsonObject>? pending = null;
        try
        {
            if (native)
            {
                // Widen the real Bash startup/paths-handshake window, not the registry internals.
                var init = Path.Combine(f.Work, "bash-init.sh");
                await File.WriteAllTextAsync(
                    init,
                    $"printf reached > '{starting}'; while [ ! -f '{launchRelease}' ]; do sleep .02; done\n"
                );
                Environment.SetEnvironmentVariable("BASH_ENV", init);
            }
            else
                Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));

            pending = f.Call(
                "exec",
                Exec("printf x >> identity-effect; while [ ! -f release ]; do sleep .05; done; printf '  retained output\\n'", 1)
            );
            if (native)
                await Until(() => Task.FromResult(File.Exists(starting)));
            else
                await StartRequest(f);
            Assert.False(pending.IsCompleted);
            Assert.Empty(ExecRecords(f.Data));

            var moved = await new MessageRouter(new SessionRuntime(f.Manager)).HandleMessageAsync(
                new ChannelContext(originalId, "webui"),
                new ChannelMessage("/session move destination/renamed", null)
            );
            Assert.Equal(200, moved.Status);
            Assert.Equal("destination/renamed", f.Owner.Id);
            await File.WriteAllTextAsync(launchRelease, "continue");
            Environment.SetEnvironmentVariable("BASH_ENV", previousBashEnv);

            var result = await pending;
            Assert.True(result["error"] is null, result.ToJsonString());
            Assert.Contains("Switched to background", result["output"]!.GetValue<string>());
            var record = Assert.Single(ExecRecords(f.Data));
            var id = record["id"]!.GetValue<string>();
            var log = record["logPath"]!.GetValue<string>();
            Assert.Equal(originalId, record["sessionId"]!.GetValue<string>());
            Assert.Equal("main", record["agentName"]!.GetValue<string>());
            Assert.Contains(id, result["output"]!.GetValue<string>());
            Assert.Contains(log, result["output"]!.GetValue<string>());
            Assert.True(f.Owner.Executor.IsOwnedActive(f.Owner.Id, id));
            Assert.False(f.Owner.Executor.IsOwnedActive(originalId, id));
            if (native)
                Assert.StartsWith(Path.Combine(originalAgentDirectory, ".temp", "exec"), log);
            else
            {
                Assert.Equal(f.Node, record["nodeId"]!.GetValue<string>());
                Assert.NotNull(record["backend"]?["ref"]);
                Assert.Single(await f.Requests(), request => request["operation"]!.GetValue<string>() == "exec-start");
            }

            await File.WriteAllTextAsync(release, "finish");
            await Until(async () =>
            {
                await f.Owner.Executor.ReconcileNowAsync();
                return ExecRecords(f.Data).Length == 0;
            });
            Assert.Equal("x", await File.ReadAllTextAsync(effect));
            Assert.Contains("background-process-finished", JsonSerializer.Serialize(f.Owner.Entry.Snapshot()));
            var read = await f.Call("read", new JsonObject { ["filePath"] = log });
            Success(read);
            Assert.StartsWith("  retained output\n", read["output"]!.GetValue<string>());
            await f.Owner.Executor.ReconcileNowAsync();
            Assert.Equal("x", await File.ReadAllTextAsync(effect));
        }
        finally
        {
            Environment.SetEnvironmentVariable("BASH_ENV", previousBashEnv);
            await File.WriteAllTextAsync(launchRelease, "continue");
            Directory.CreateDirectory(Path.GetDirectoryName(release)!);
            await File.WriteAllTextAsync(release, "finish");
            if (pending is not null)
                await pending;
            // Keep owned files until the detached command has published its actual finish.
            if (native)
                await Until(() => Task.FromResult(Directory.GetFiles(originalAgentDirectory, "*.exit.json", SearchOption.AllDirectories).Length > 0));
            else
                await Until(() => Task.FromResult(Directory.GetFiles(Path.Combine(f.Target, "exec"), "status.json", SearchOption.AllDirectories).Length > 0));
        }
    }
}
