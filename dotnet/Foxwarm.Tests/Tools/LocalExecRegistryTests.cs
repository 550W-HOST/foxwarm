using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class LocalExecRegistryTests
{
    private static string Registry(string root) => Path.Combine(root, "state", "running-exec.json");

    private static JsonObject Record(string root, string id = "exec_source_record_1234") =>
        new()
        {
            ["id"] = id,
            ["pid"] = Environment.ProcessId,
            ["sessionId"] = "main/owned",
            ["agentName"] = "main",
            ["nodeId"] = "master",
            ["command"] = "printf original",
            ["initialCwd"] = root,
            ["logPath"] = Path.Combine(root, "original.log"),
            ["statusPath"] = Path.Combine(root, "original.exit.json"),
            ["cwdPath"] = Path.Combine(root, "original.cwd.txt"),
            ["startedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["notifyOnCompletion"] = false,
        };

    private static async Task Seed(string root, params JsonObject[] entries)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Registry(root))!);
        await File.WriteAllTextAsync(
            Registry(root),
            new JsonObject
            {
                ["execs"] = new JsonArray(entries.Cast<JsonNode>().ToArray()),
                ["recentExecIds"] = new JsonArray("quiet-otter"),
            }.ToJsonString()
        );
    }

    [Fact]
    public async Task Source_shaped_native_recovery_keeps_original_paths_and_retries_only_unaccepted_delivery()
    {
        using var temp = new TempDirectory();
        var entry = Record(temp.Path);
        await Seed(temp.Path, entry);
        await File.WriteAllTextAsync(entry["logPath"]!.GetValue<string>(), "  original\n");
        await File.WriteAllTextAsync(
            entry["statusPath"]!.GetValue<string>(),
            "{\"exitCode\":7,\"finishedAt\":\"2026-10-20T12:00:00Z\"}"
        );
        var attempts = 0;
        var accepted = false;
        await using var manager = new LocalExecManager(
            temp.Path,
            _ => temp.Path,
            (owner, id, message) =>
            {
                Assert.Equal("main/owned", owner);
                Assert.Equal("exec_source_record_1234", id);
                Assert.Contains("Exit code: 7", message);
                Assert.Contains(
                    "Command output in " + entry["logPath"]!.GetValue<string>(),
                    message
                );
                attempts++;
                if (!accepted)
                    throw new IOException("Owned receiver rejects admission.");
                return Task.CompletedTask;
            }
        );
        await Task.WhenAll(
            Enumerable
                .Range(0, 8)
                .Select(_ => manager.RegisterRecordsAsync(owner => owner == "main/owned"))
        );
        var recovered = Assert.Single(manager.Tracked);
        Assert.True(recovered["notifyOnCompletion"]!.GetValue<bool>());
        Assert.True(recovered["recoveredAfterRestart"]!.GetValue<bool>());
        Assert.Equal(
            entry["logPath"]!.GetValue<string>(),
            recovered["logPath"]!.GetValue<string>()
        );
        await manager.ReconcileNowAsync();
        Assert.Single(manager.Tracked);
        accepted = true;
        await manager.ReconcileNowAsync();
        await manager.ReconcileNowAsync();
        Assert.Equal(2, attempts);
        Assert.Empty(manager.Tracked);
        var saved = JsonNode.Parse(await File.ReadAllTextAsync(Registry(temp.Path)))!;
        Assert.Empty(saved["execs"]!.AsArray());
        Assert.Contains(
            "exec_source_record_1234",
            saved["recentExecIds"]!.AsArray().Select(value => value!.GetValue<string>())
        );
        Assert.Equal(
            "  original\n",
            await File.ReadAllTextAsync(entry["logPath"]!.GetValue<string>())
        );
    }

    [Fact]
    public async Task Strictly_older_than_24_hours_expires_before_provider_resolution_without_killing_or_removing_artifacts()
    {
        using var temp = new TempDirectory();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var entry = Record(temp.Path, "quiet-fox");
        entry.Remove("statusPath");
        entry["nodeId"] = "external/target";
        entry["backend"] = new JsonObject
        {
            ["providerId"] = "external",
            ["ref"] = "owned-original",
        };
        entry["startedAt"] = now - 24 * 60 * 60 * 1000;
        await File.WriteAllTextAsync(entry["logPath"]!.GetValue<string>(), "retained");
        await Seed(temp.Path, entry);
        var observations = 0;
        var notifications = 0;
        await using var manager = new LocalExecManager(
            temp.Path,
            _ => temp.Path,
            (_, _, _) =>
            {
                notifications++;
                return Task.CompletedTask;
            }
        )
        {
            Now = () => now,
            ResolveProviderBackend = (_, _) =>
            {
                observations++;
                throw new InvalidOperationException("Owned provider is absent.");
            },
        };
        await manager.RegisterRecordsAsync(_ => true);
        await manager.ReconcileNowAsync();
        Assert.Single(manager.Tracked);
        Assert.Equal(1, observations);
        now++;
        await manager.ReconcileNowAsync();
        Assert.Empty(manager.Tracked);
        Assert.Equal(1, observations);
        Assert.Equal(0, notifications);
        Assert.True(ExecNative.IsRunning(Environment.ProcessId));
        Assert.Equal("retained", await File.ReadAllTextAsync(entry["logPath"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Recovery_opens_only_the_active_registry_not_tens_of_thousands_of_retained_artifacts()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var agentExec = Path.Combine(temp.Path, "agent", ".temp", "exec");
        var date = Path.Combine(agentExec, "2026-10-20");
        var obsolete = Path.Combine(temp.Path, "state", "exec");
        Directory.CreateDirectory(date);
        Directory.CreateDirectory(obsolete);
        for (var index = 0; index < 20000; index++)
            File.WriteAllText(Path.Combine(date, index + ".log"), "");
        File.WriteAllText(Path.Combine(obsolete, "tracking.json"), "not a registry");
        await Seed(temp.Path, Record(temp.Path));
        // Linux IN_OPEN observes directory enumeration itself, not just attempted metadata reads.
        var descriptor = InotifyInit(0x800 | 0x80000);
        Assert.True(descriptor >= 0);
        try
        {
            foreach (var root in new[] { agentExec, date, obsolete })
                Assert.True(InotifyWatch(descriptor, root, 0x20) >= 0);
            await using var manager = new LocalExecManager(
                temp.Path,
                _ => temp.Path,
                (_, _, _) => Task.CompletedTask
            );
            await manager.InitializeAsync(_ => true);
            Assert.Single(manager.Tracked);
            Assert.Equal(-1, Read(descriptor, new byte[4096], 4096));
            Assert.Equal(11, Marshal.GetLastPInvokeError()); // EAGAIN: no watched directory was opened.
        }
        finally
        {
            Close(descriptor);
        }
    }

    [Fact]
    public async Task Concurrent_native_starts_use_one_bounded_registry_and_inherit_nonreserved_environment()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        const string name = "FOXWARM_OWNED_EXEC_PARITY";
        var previous = Environment.GetEnvironmentVariable(name);
        Environment.SetEnvironmentVariable(name, "ordinary inherited value");
        try
        {
            await using var manager = new LocalExecManager(
                temp.Path,
                _ => temp.Path,
                (_, _, _) => Task.CompletedTask
            );
            var results = await Task.WhenAll(
                Enumerable
                    .Range(0, 12)
                    .Select(index =>
                        manager.ExecuteAsync(
                            "main/owned",
                            new JsonObject
                            {
                                ["command"] =
                                    "printf '%s' \"$"
                                    + name
                                    + "\"; printf x > \"$fw_tmp/effect-"
                                    + index
                                    + "\"",
                            },
                            default
                        )
                    )
            );
            Assert.All(
                results,
                value =>
                    Assert.StartsWith(
                        "ordinary inherited value\n---\nExit code: 0",
                        value["output"]!.GetValue<string>()
                    )
            );
            Assert.Equal(12, Directory.GetFiles(Path.Combine(temp.Path, "tmp"), "effect-*").Length);
            var saved = JsonNode.Parse(await File.ReadAllTextAsync(Registry(temp.Path)))!;
            Assert.Empty(saved["execs"]!.AsArray());
            Assert.Equal(
                12,
                saved["recentExecIds"]!
                    .AsArray()
                    .DistinctBy(value => value!.GetValue<string>())
                    .Count()
            );
            Assert.False(Directory.Exists(Path.Combine(temp.Path, "state", "exec")));
            var artifacts = Directory.GetFiles(
                Path.Combine(temp.Path, ".temp", "exec"),
                "*",
                SearchOption.AllDirectories
            );
            Assert.Equal(12, artifacts.Count(path => path.EndsWith(".command.sh")));
            Assert.Equal(12, artifacts.Count(path => path.EndsWith(".log")));
            Assert.DoesNotContain(artifacts, path => path.EndsWith(".paths.json"));
        }
        finally
        {
            Environment.SetEnvironmentVariable(name, previous);
        }
    }

    [Fact]
    public async Task Missing_status_recreates_pruned_parent_but_never_invents_exit_or_duration()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var entry = Record(temp.Path);
        entry["pid"] = int.MaxValue;
        entry["startedAt"] = DateTimeOffset.UtcNow.AddMinutes(-1).ToUnixTimeMilliseconds();
        var status = Path.Combine(temp.Path, "pruned", "original.exit.json");
        entry["statusPath"] = status;
        await Seed(temp.Path, entry);
        string? delivered = null;
        await using var manager = new LocalExecManager(
            temp.Path,
            _ => temp.Path,
            (_, _, message) =>
            {
                delivered = message;
                return Task.CompletedTask;
            }
        );
        await manager.RegisterRecordsAsync(_ => true);
        await manager.ReconcileNowAsync();
        Assert.NotNull(delivered);
        Assert.Contains("Exit code: unknown", delivered);
        Assert.Contains("Duration: unknown", delivered);
        Assert.Null(JsonNode.Parse(await File.ReadAllTextAsync(status))!["exitCode"]);
    }

    [DllImport("libc", EntryPoint = "inotify_init1", SetLastError = true)]
    private static extern int InotifyInit(int flags);

    [DllImport("libc", EntryPoint = "inotify_add_watch", SetLastError = true)]
    private static extern int InotifyWatch(int fd, string path, uint mask);

    [DllImport("libc", EntryPoint = "read", SetLastError = true)]
    private static extern long Read(int fd, byte[] bytes, nuint count);

    [DllImport("libc", EntryPoint = "close")]
    private static extern int Close(int fd);
}
