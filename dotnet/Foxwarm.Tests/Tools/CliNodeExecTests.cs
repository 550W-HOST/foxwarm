using System.Text.Json.Nodes;
using Foxwarm.CliNode;

namespace Foxwarm.Tests;

public sealed class CliNodeExecTests
{
    private sealed class OwnedPaths : IDisposable
    {
        private readonly string? previous = Environment.GetEnvironmentVariable("FOXWARM_AGENT_DIR");
        internal readonly TempDirectory Temp = new();
        internal NodePaths Paths { get; }
        internal string Registry => Path.Combine(Temp.Path, ".temp", "exec", "running-exec.json");

        internal OwnedPaths()
        {
            Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", Temp.Path);
            Paths = new NodePaths(Temp.Path);
        }

        public void Dispose()
        {
            Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", previous);
            Temp.Dispose();
        }
    }

    private static JsonObject Frame(string id = "quiet-otter") => new()
    {
        ["sessionId"] = "main/owned",
        ["backgroundExecId"] = id,
        ["completionCapability"] = "synthetic-test-grant",
        ["args"] = new JsonObject { ["command"] = "printf once", ["timeout"] = 1 },
    };

    private static JsonObject Record(OwnedPaths owned, string id, long startedAt, bool notify = true) => new()
    {
        ["id"] = id,
        ["pid"] = Environment.ProcessId,
        ["sessionId"] = "main/owned",
        ["agentName"] = "main",
        ["nodeId"] = "original-node",
        ["command"] = "printf once",
        ["initialCwd"] = owned.Temp.Path,
        ["logPath"] = Path.Combine(owned.Temp.Path, id + ".log"),
        ["statusPath"] = Path.Combine(owned.Temp.Path, id + ".exit.json"),
        ["cwdPath"] = Path.Combine(owned.Temp.Path, id + ".cwd.txt"),
        ["startedAt"] = startedAt,
        ["notifyOnCompletion"] = notify,
        ["completionCapability"] = "synthetic-original-grant",
    };

    private static async Task Seed(OwnedPaths owned, params JsonObject[] records)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(owned.Registry)!);
        await File.WriteAllTextAsync(owned.Registry, new JsonObject { ["execs"] = new JsonArray(records.Cast<JsonNode>().ToArray()), ["recentExecIds"] = new JsonArray("exec_old_identity_1234") }.ToJsonString());
    }

    [Fact]
    public async Task Final_prelaunch_cancellation_and_launch_failure_never_claim_an_effect()
    {
        using var owned = new OwnedPaths();
        using var stop = new CancellationTokenSource();
        var launches = 0;
        var started = 0;
        await using (var manager = new NodeExecManager(owned.Paths, owned.Registry, (_, _, _) => Task.CompletedTask)
        {
            BeforeLaunch = stop.Cancel,
            Launch = _ => { launches++; return Environment.ProcessId; },
        })
        {
            var error = await Assert.ThrowsAsync<InvalidDataException>(() => manager.Start(Frame(), "main", "owned", stop.Token, () => started++));
            Assert.Contains("not executed", error.Message);
            Assert.Equal(0, launches);
            Assert.Equal(0, started);
            Assert.Empty(manager.Tracked);
        }
        await using var failed = new NodeExecManager(owned.Paths, owned.Registry, (_, _, _) => Task.CompletedTask)
        {
            Launch = _ => throw new IOException("owned launch failed"),
        };
        await Assert.ThrowsAsync<IOException>(() => failed.Start(Frame(), "main", "owned", CancellationToken.None, () => started++));
        Assert.Equal(0, started);
        Assert.Empty(failed.Tracked);
    }

    [Fact]
    public async Task Launch_receipt_before_registry_failure_remains_started_and_is_never_replayed()
    {
        using var owned = new OwnedPaths();
        var launches = 0;
        var started = 0;
        await using var manager = new NodeExecManager(owned.Paths, owned.Registry, (_, _, _) => Task.CompletedTask)
        {
            Launch = start =>
            {
                launches++;
                var paths = start.Environment["FOXWARM_EXEC_PATHS_PATH"]!;
                var log = Path.Combine(owned.Temp.Path, "owned.log");
                File.WriteAllText(paths, new JsonObject { ["logPath"] = log, ["statusPath"] = log + ".exit.json", ["cwdPath"] = log + ".cwd.txt" }.ToJsonString());
                Directory.CreateDirectory(owned.Registry); // Owned deterministic failure of the existing post-launch save window.
                return Environment.ProcessId;
            },
        };
        await Assert.ThrowsAnyAsync<IOException>(() => manager.Start(Frame(), "main", "owned", CancellationToken.None, () => started++));
        Assert.Equal(1, launches);
        Assert.Equal(1, started);
        Assert.Single(manager.Tracked);
        await Assert.ThrowsAsync<ExecCollisionException>(() => manager.Start(Frame(), "main", "owned", CancellationToken.None, () => started++));
        Assert.Equal(1, launches);
    }

    [Fact]
    public async Task Status_wins_over_Stop_and_recovered_foreground_retains_original_authority()
    {
        using var owned = new OwnedPaths();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var record = Record(owned, "exec_recovered_foreground_1234", now, false);
        await Seed(owned, record);
        var delivered = 0;
        await using var manager = new NodeExecManager(owned.Paths, owned.Registry, (_, _, _) => { delivered++; return Task.CompletedTask; });
        await manager.Initialize();
        var recovered = Assert.Single(manager.Tracked);
        Assert.True(recovered["notifyOnCompletion"]!.GetValue<bool>());
        Assert.True(recovered["recoveredAfterRestart"]!.GetValue<bool>());
        foreach (var field in new[] { "id", "sessionId", "nodeId", "logPath", "statusPath", "initialCwd", "completionCapability" }) Assert.True(JsonNode.DeepEquals(record[field], recovered[field]), field);
        await File.WriteAllTextAsync(record["statusPath"]!.GetValue<string>(), new JsonObject { ["exitCode"] = 7, ["finishedAt"] = DateTimeOffset.UtcNow.ToString("O") }.ToJsonString());
        using var stop = new CancellationTokenSource(); stop.Cancel();
        Assert.Equal(7, (await manager.Wait(recovered, 1, stop.Token))!["exitCode"]!.GetValue<int>());
        Assert.Equal(0, delivered);
        await Assert.ThrowsAsync<ExecCollisionException>(() => manager.Start(Frame("exec_old_identity_1234"), "main", "owned", CancellationToken.None, () => { }));
    }

    [Fact]
    public async Task Rejected_ACK_retains_tracking_and_strict_24_hour_expiry_does_not_inspect_or_kill()
    {
        using var owned = new OwnedPaths();
        const long now = 1800000000000;
        var boundary = Record(owned, "quiet-otter", now - NodeExecManager.RetentionMilliseconds);
        var expired = Record(owned, "warm-fox", now - NodeExecManager.RetentionMilliseconds - 1);
        await File.WriteAllTextAsync(boundary["statusPath"]!.GetValue<string>(), "{\"exitCode\":0,\"finishedAt\":\"2026-10-20T00:00:00.000Z\"}");
        await File.WriteAllTextAsync(expired["statusPath"]!.GetValue<string>(), "invalid status must not be inspected");
        await File.WriteAllTextAsync(expired["logPath"]!.GetValue<string>(), "retained output");
        await Seed(owned, boundary, expired);
        var accept = false;
        var attempts = 0;
        await using var manager = new NodeExecManager(owned.Paths, owned.Registry, (entry, _, _) =>
        {
            Assert.Equal("quiet-otter", entry["id"]!.GetValue<string>());
            attempts++;
            return accept ? Task.CompletedTask : Task.FromException(new IOException("owned ACK rejection"));
        }) { Now = () => now };
        await manager.Initialize();
        Assert.Equal(1, attempts);
        Assert.Equal("quiet-otter", Assert.Single(manager.Tracked)["id"]!.GetValue<string>());
        Assert.True(ExecNative.IsRunning(Environment.ProcessId));
        Assert.Equal("retained output", await File.ReadAllTextAsync(expired["logPath"]!.GetValue<string>()));
        Assert.Equal("invalid status must not be inspected", await File.ReadAllTextAsync(expired["statusPath"]!.GetValue<string>()));
        accept = true;
        await manager.Reconcile();
        Assert.Empty(manager.Tracked);
        Assert.Equal(2, attempts);
        Assert.Empty(JsonNode.Parse(await File.ReadAllTextAsync(owned.Registry))!["execs"]!.AsArray());
    }

    [Fact]
    public void Recovery_discovery_matches_Source_directory_entries_without_following_Agent_symlinks()
    {
        using var temp = new TempDirectory();
        var previousAgent = Environment.GetEnvironmentVariable("FOXWARM_AGENT_DIR");
        var previousAgents = Environment.GetEnvironmentVariable("FOXWARM_AGENTS_DIR");
        try
        {
            Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", null);
            Environment.SetEnvironmentVariable("FOXWARM_AGENTS_DIR", "agents");
            var owned = Path.Combine(temp.Path, "agents", "owned");
            Directory.CreateDirectory(owned);
            Directory.CreateSymbolicLink(Path.Combine(temp.Path, "agents", "linked"), owned);
            Assert.Equal([owned], new NodePaths(temp.Path).RecoveryDirectories());
        }
        finally
        {
            Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", previousAgent);
            Environment.SetEnvironmentVariable("FOXWARM_AGENTS_DIR", previousAgents);
        }
    }

    [Theory]
    [InlineData(1048576, false)]
    [InlineData(1048577, true)]
    public async Task Programmatic_capture_uses_inclusive_raw_byte_limit_and_preserves_whitespace(int bytes, bool truncated)
    {
        using var owned = new OwnedPaths();
        var record = Record(owned, "quiet-otter", 1);
        var content = new byte[bytes]; Array.Fill(content, (byte)' '); content[^1] = 10;
        await File.WriteAllBytesAsync(record["logPath"]!.GetValue<string>(), content);
        var result = await NodeExecManager.Result(record, new JsonObject { ["exitCode"] = 0 }, "display is not capture", true);
        Assert.Equal(truncated, result["truncated"]!.GetValue<bool>());
        Assert.Equal(bytes, result["sizeBytes"]!.GetValue<long>());
        if (truncated) Assert.Null(result["content"]);
        else Assert.Equal(System.Text.Encoding.UTF8.GetString(content), result["content"]!.GetValue<string>());
    }
}
