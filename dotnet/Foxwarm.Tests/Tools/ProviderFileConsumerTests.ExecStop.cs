using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

// Stopping Provider commands through the optional exec-stop operation.
public sealed partial class ProviderFileConsumerTests
{
    private static string[] CompletionEvents(Fixture f, string id) =>
        f.Owner.Entry.Snapshot()
            .Queue.SelectMany(item => item.Parts ?? [])
            .Concat(f.Owner.Entry.Snapshot().History.Materialize())
            .Select(value => JsonSerializer.Serialize(value))
            .Where(text =>
                text.Contains("background-process-finished", StringComparison.Ordinal)
                && text.Contains($"[{id}]", StringComparison.Ordinal)
            )
            .ToArray();

    private static async Task<string> BackgroundId(Fixture f, string command)
    {
        var started = await f.Call("exec", Exec(command, 1));
        Success(started);
        return ExecReceipt.Id(ExecReceipt.Header(started["output"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Provider_without_exec_stop_reports_unsupported_and_never_sends_the_operation()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        var id = await BackgroundId(f, "sleep 30");
        var listed = await f.Manager.ListExecsToolAsync(f.Owner, new JsonObject(), default);
        var row = Assert.Single(listed["execs"]!.AsArray())!;
        Assert.Equal(id, row["execId"]!.GetValue<string>());
        Assert.Equal(f.Node, row["nodeId"]!.GetValue<string>());
        Assert.Equal("sleep 30", row["command"]!.GetValue<string>());
        Assert.Equal("opaque://logs", Path.GetDirectoryName(row["logPath"]!.GetValue<string>())!.Replace("opaque:/", "opaque://"));

        var (result, node, _) = await f.Manager.StopExecAsync(f.Owner, id, default);
        Assert.Equal(Foxwarm.Sessions.SessionManager.ExecStopResult.Unsupported, result);
        Assert.Equal(f.Node, node);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            f.Manager.StopExecToolAsync(f.Owner, new JsonObject { ["execId"] = id }, default)
        );
        Assert.DoesNotContain(
            await f.Requests(),
            request => request["operation"]!.GetValue<string>() == "exec-stop"
        );
        Assert.Single(ExecRecords(f.Data));
    }

    [Fact]
    public async Task Provider_exec_stop_ends_the_command_and_its_completion_arrives_once_marked_stopped()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        await File.WriteAllTextAsync(Path.Combine(f.Target, "exec-stop"), "");
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        var id = await BackgroundId(f, "sleep 30");
        await Until(() =>
            Task.FromResult(
                Directory
                    .EnumerateFiles(Path.Combine(f.Target, "exec"), "shell-pid", SearchOption.AllDirectories)
                    .Any()
            )
        );
        var stopped = await f.Manager.StopExecToolAsync(
            f.Owner,
            new JsonObject { ["execId"] = id },
            default
        );
        Assert.Equal("stopped", stopped["outcome"]!.GetValue<string>());
        var stop = Assert.Single(
            await f.Requests(),
            request => request["operation"]!.GetValue<string>() == "exec-stop"
        );
        Assert.Equal(5000, stop["request"]!["graceMs"]!.GetValue<long>());

        await Until(async () =>
        {
            await f.Owner.Executor.ReconcileNowAsync();
            return CompletionEvents(f, id).Length > 0;
        });
        var completion = Assert.Single(CompletionEvents(f, id));
        Assert.Contains("143", completion);
        Assert.Empty(ExecRecords(f.Data));

        // Afterwards the command is finished, not someone else's or unknown.
        var again = await f.Manager.StopExecToolAsync(
            f.Owner,
            new JsonObject { ["execId"] = id },
            default
        );
        Assert.Equal("finished", again["outcome"]!.GetValue<string>());
        await f.Owner.Executor.ReconcileNowAsync();
        Assert.Single(CompletionEvents(f, id));
    }
}
