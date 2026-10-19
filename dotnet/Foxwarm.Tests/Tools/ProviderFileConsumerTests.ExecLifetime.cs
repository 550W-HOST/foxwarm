using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Native_and_provider_read_exec_keep_bounded_display_and_original_byte_offsets(bool provider)
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var backend = provider ? await f.Manager.NodeProviders.AdmitExecAsync(f.Node, default) : null;
        var value = await f.Owner.Executor.ExecuteAsync(f.Owner.Id,
            Exec("python3 -c 'import sys;sys.stdout.buffer.write(bytes([0])*5000)'"), default,
            paths: MainNativePaths.Default(f.Work), backend: backend);
        Success(value);
        var id = System.Text.RegularExpressions.Regex.Match(value["output"]!.GetValue<string>(), "execId: ([a-z]+-[a-z]+)").Groups[1].Value;
        Assert.NotEmpty(id);
        var first = await f.Owner.Executor.ReadAsync(f.Owner.Id, new JsonObject { ["execId"] = id });
        Assert.Equal(16384, first["output"]!.GetValue<string>().Length);
        Assert.Equal(4096, first["nextOffset"]!.GetValue<long>());
        Assert.Equal(5000, first["totalBytes"]!.GetValue<long>());
        var second = await f.Owner.Executor.ReadAsync(f.Owner.Id, new JsonObject { ["execId"] = id, ["offset"] = 4096L });
        Assert.Equal(string.Concat(Enumerable.Repeat("\\x00", 904)), second["output"]!.GetValue<string>());
        Assert.Null(second["nextOffset"]);
    }

    [Fact]
    public async Task Final_launch_fence_has_no_effect_and_independent_hard_cancel_has_unknown_receipt_without_killing_target()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create("hang-start");
        var backend = await f.Manager.NodeProviders.AdmitExecAsync(f.Node, default);
        using var stop = new CancellationTokenSource();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => f.Owner.Executor.ExecuteAsync(
            f.Owner.Id, Exec("printf forbidden >> effect"), stop.Token, backend: backend,
            beforeLaunch: () => { stop.Cancel(); stop.Token.ThrowIfCancellationRequested(); }));
        Assert.DoesNotContain(await f.Requests(), value => value["operation"]!.GetValue<string>() == "exec-start");
        using var hard = new CancellationTokenSource();
        var pending = f.Owner.Executor.ExecuteAsync(f.Owner.Id, Exec("sleep .2; printf x >> effect"), default,
            backend: backend, hardCancellation: hard.Token);
        await StartRequest(f);
        var clock = Stopwatch.StartNew();
        hard.Cancel();
        var error = await Assert.ThrowsAsync<IOException>(() => pending);
        Assert.Contains("outcome is unknown", error.Message);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(2), clock.Elapsed.ToString());
        await Until(() => Task.FromResult(File.Exists(f.FilePath("effect"))));
        Assert.Equal("x", await File.ReadAllTextAsync(f.FilePath("effect")));
        Assert.Single(await f.Requests(), value => value["operation"]!.GetValue<string>() == "exec-start");
        Assert.Empty(Directory.GetFiles(Path.Combine(f.Data, "state/exec"), "tracking.json", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task Provider_notification_retries_until_exact_owner_receipt_and_retirement_does_not_kill_target_or_delete_logs()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var backend = await f.Manager.NodeProviders.AdmitExecAsync(f.Node, default);
        var data = Path.Combine(f.Temp.Path, "exec-owner");
        var attempts = 0;
        var accept = false;
        var delivered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var manager = new LocalExecManager(data, _ => f.Work, (owner, id, message) =>
        {
            Assert.Equal(f.Owner.Id, owner);
            Interlocked.Increment(ref attempts);
            if (!Volatile.Read(ref accept))
                throw new IOException("Fixture strict authority is temporarily unavailable.");
            delivered.TrySetResult();
            return Task.CompletedTask;
        }) { ResolveProviderBackend = f.Manager.NodeProviders.ResolveExecBackend };
        await manager.InitializeAsync(id => id == f.Owner.Id);
        var value = await manager.ExecuteAsync(f.Owner.Id, Exec("sleep 1.5; printf retained", 1), default, backend: backend);
        Success(value);
        await Until(() => Task.FromResult(Volatile.Read(ref attempts) > 0));
        Assert.Single(Directory.GetFiles(Path.Combine(data, "state/exec"), "tracking.json", SearchOption.AllDirectories));
        Volatile.Write(ref accept, true);
        await delivered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Until(() => Task.FromResult(!Directory.GetFiles(Path.Combine(data, "state/exec"), "tracking.json", SearchOption.AllDirectories).Any()));
        var deliveredCount = Volatile.Read(ref attempts);
        await manager.ExecuteAsync(f.Owner.Id, Exec("sleep 2; printf retired >> retired-effect", 1), default, backend: backend);
        await manager.RetireSessionAsync(f.Owner.Id);
        Assert.Empty(Directory.GetFiles(Path.Combine(data, "state/exec"), "tracking.json", SearchOption.AllDirectories));
        await Until(() => Task.FromResult(File.Exists(f.FilePath("retired-effect"))));
        Assert.Equal(deliveredCount, Volatile.Read(ref attempts));
        Assert.Equal("retired", await File.ReadAllTextAsync(f.FilePath("retired-effect")));
        Assert.Equal(2, Directory.GetFiles(Path.Combine(f.Target, "fs/logs"), "*.log").Length);
    }

    [Fact]
    public async Task Recovered_provider_expiry_precedes_queries_and_keeps_target_artifacts_and_command_alive()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var backend = await f.Manager.NodeProviders.AdmitExecAsync(f.Node, default);
        var data = Path.Combine(f.Temp.Path, "expired-owner");
        var notifications = 0;
        await using (var first = new LocalExecManager(data, _ => f.Work, (_, _, _) => Task.CompletedTask)
        { ResolveProviderBackend = f.Manager.NodeProviders.ResolveExecBackend })
            await first.ExecuteAsync(f.Owner.Id, Exec("sleep 2; printf expired >> expiry-effect", 1), default, backend: backend);
        var path = Directory.GetFiles(Path.Combine(data, "state/exec"), "meta.json", SearchOption.AllDirectories).Single();
        var meta = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        meta["StartedAt"] = DateTimeOffset.UtcNow.AddHours(-25).ToUnixTimeMilliseconds();
        await File.WriteAllTextAsync(path, meta.ToJsonString());
        var queries = (await f.Requests()).Count(value => value["operation"]!.GetValue<string>() == "exec-poll");
        await using (var recovered = new LocalExecManager(data, _ => f.Work, (_, _, _) =>
        {
            notifications++;
            return Task.CompletedTask;
        }) { ResolveProviderBackend = f.Manager.NodeProviders.ResolveExecBackend })
        {
            await recovered.InitializeAsync(id => id == f.Owner.Id);
            await Until(() => Task.FromResult(!Directory.GetFiles(Path.Combine(data, "state/exec"), "tracking.json", SearchOption.AllDirectories).Any()));
            Assert.Equal(queries, (await f.Requests()).Count(value => value["operation"]!.GetValue<string>() == "exec-poll"));
            Assert.Equal(0, notifications);
            await Until(() => Task.FromResult(File.Exists(f.FilePath("expiry-effect"))));
            Assert.Equal("expired", await File.ReadAllTextAsync(f.FilePath("expiry-effect")));
            Assert.True(File.Exists(path));
            Assert.Single(Directory.GetFiles(Path.Combine(f.Target, "fs/logs"), "*.log"));
        }
    }
}
