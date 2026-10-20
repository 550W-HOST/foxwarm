using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    private static JsonObject Exec(string command, double timeout = 15) =>
        new() { ["command"] = command, ["timeout"] = timeout };

    private static async Task Until(Func<Task<bool>> check, int milliseconds = 10000)
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < milliseconds)
        {
            if (await check())
                return;
            await Task.Delay(25);
        }
        Assert.Fail("Owned fixture did not reach the expected state.");
    }

    private static async Task<JsonObject> StartRequest(Fixture f)
    {
        await Until(async () =>
            File.Exists(Path.Combine(f.Target, "calls.jsonl"))
            && (await f.Requests()).Any(value =>
                value["operation"]!.GetValue<string>() == "exec-start"
            )
        );
        return (await f.Requests()).Last(value =>
            value["operation"]!.GetValue<string>() == "exec-start"
        )["request"]!.AsObject();
    }

    private static JsonObject[] ExecRecords(string data) =>
        File.Exists(Path.Combine(data, "state", "running-exec.json"))
            ? (JsonNode.Parse(File.ReadAllText(Path.Combine(data, "state", "running-exec.json")))!["execs"] as JsonArray ?? []).OfType<JsonObject>().ToArray()
            : [];

    [Fact]
    public async Task Provider_exec_direct_unified_native_ToolScript_retains_raw_output_exact_cwd_and_real_status()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        Directory.CreateDirectory(f.FilePath("next  "));
        var value = await f.Call("exec", Exec("printf '  \\n\\tend  '; cd 'next  '; exit 7"));
        Success(value);
        var output = value["output"]!.GetValue<string>();
        Assert.StartsWith("  \n\tend  \n---\nExit code: 7", output);
        Assert.Contains("had no trailing newline", output);
        Assert.DoesNotContain("Duration: unknown", output);
        Assert.Equal(
            "opaque://root/next  ",
            f.Owner.Entry.Snapshot().AuthorityEnvelope["cwd"]!.GetValue<string>()
        );
        Assert.DoesNotContain("/proc/", output);
        var firstOutputReads = (await f.Requests()).Where(value => value["operation"]!.GetValue<string>() == "filesystem"
            && value["request"]!["path"]!.GetValue<string>().StartsWith("opaque://logs/", StringComparison.Ordinal)).ToArray();
        Assert.NotEmpty(firstOutputReads);
        Assert.All(firstOutputReads, value => Assert.Null(value["request"]!["context"]!["cwd"]));
        var raw = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('node:"
                    + f.Node
                    + "/exec', {'command': \"printf ' \\n\\t  '\"})",
            }
        );
        Success(raw);
        Assert.Equal(" \n\t  ", raw["result"]!["content"]!.GetValue<string>());
        Assert.False(raw["result"]!["truncated"]!.GetValue<bool>());
        var requests = (await f.Requests())
            .Where(value => value["operation"]!.GetValue<string>() == "exec-start")
            .ToArray();
        Assert.Equal(2, requests.Length);
        Assert.Equal("opaque://root/next  ", requests[1]["request"]!["cwd"]!.GetValue<string>());
        Assert.All(
            requests,
            request => Assert.Equal("target", request["request"]!["nodeId"]!.GetValue<string>())
        );
        Assert.All(
            requests,
            request =>
                Assert.DoesNotContain(
                    "agent",
                    request["request"]!.AsObject().Select(pair => pair.Key)
                )
        );
        Assert.Empty(ExecRecords(f.Data));
        Assert.False(Directory.Exists(Path.Combine(f.Data, "state", "exec")));

    }

    [Fact]
    public async Task Ordinary_Stop_during_dispatched_start_does_not_cancel_launcher_or_target_and_unknown_receipt_is_not_replayed()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using (var f = await Fixture.Create("slow-start"))
        {
            Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
            using var stop = new CancellationTokenSource();
            var pending = f.Call("exec", Exec("sleep 2.8; printf x >> effect"), stop.Token);
            await StartRequest(f);
            stop.Cancel();
            var value = await pending;
            Success(value);
            Assert.Contains("ended this call's wait", value["output"]!.GetValue<string>());
            Assert.Contains("output unavailable", value["output"]!.GetValue<string>());
            await Until(() => Task.FromResult(File.Exists(f.FilePath("effect"))));
            Assert.Equal("x", await File.ReadAllTextAsync(f.FilePath("effect")));
            Assert.Single(
                await f.Requests(),
                value => value["operation"]!.GetValue<string>() == "exec-start"
            );
        }
        await using (var f = await Fixture.Create("lost-start"))
        {
            Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
            var value = await f.Call("exec", Exec("printf x >> effect"));
            Assert.Contains("outcome is unknown", value["error"]!["message"]!.GetValue<string>());
            await Until(() => Task.FromResult(File.Exists(f.FilePath("effect"))));
            Assert.Equal("x", await File.ReadAllTextAsync(f.FilePath("effect")));
            Assert.Single(
                await f.Requests(),
                value => value["operation"]!.GetValue<string>() == "exec-start"
            );
            Assert.Empty(ExecRecords(f.Data));
        }
    }

    [Fact]
    public async Task Slow_shared_poll_does_not_extend_foreground_deadline_or_block_independent_same_owner_completion()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        await File.WriteAllTextAsync(Path.Combine(f.Target, "poll-delay"), "{\"*\":12}");
        var clock = Stopwatch.StartNew();
        var slow = await f.Call("exec", Exec("sleep 2; printf slow", 1));
        Success(slow);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(3), clock.Elapsed.ToString());
        var slowId = Assert.Single(ExecRecords(f.Data))["id"]!.GetValue<string>();
        var fast = await f.Call(
            "call_tool",
            new JsonObject
            {
                ["toolId"] = "node:other/target/exec",
                ["args"] = Exec("sleep 1.4; printf fast", 1),
            }
        );
        Success(fast);
        await Task.Delay(500);
        var reconciliation = f.Owner.Executor.ReconcileNowAsync();
        await Until(
            () =>
                Task.FromResult(
                    JsonSerializer
                        .Serialize(f.Owner.Entry.Snapshot())
                        .Contains("background-process-finished")
                ),
            2500
        );
        await reconciliation;
        var calls = await f.Requests();
        Assert.Single(calls, value => value["operation"]!.GetValue<string>() == "exec-poll");
        var history = JsonSerializer.Serialize(f.Owner.Entry.Snapshot());
        Assert.Contains("background-process-finished", history);
        Assert.Single(ExecRecords(f.Data));
    }

    [Fact]
    public async Task Transient_query_error_retains_tracking_while_explicit_loss_has_unknown_exit_and_absent_log_is_not_empty_output()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        await File.WriteAllTextAsync(Path.Combine(f.Target, "poll-error"), "");
        var waiting = await f.Call("exec", Exec("printf retained", 1));
        Success(waiting);
        Assert.Contains("Switched to background", waiting["output"]!.GetValue<string>());
        Assert.Single(ExecRecords(f.Data));
        Assert.DoesNotContain(
            "background-process-finished",
            JsonSerializer.Serialize(f.Owner.Entry.Snapshot())
        );
        Assert.Single(ExecRecords(f.Data));
        File.Delete(Path.Combine(f.Target, "poll-error"));
        await f.Owner.Executor.ReconcileNowAsync();
        Assert.Empty(ExecRecords(f.Data));
        await File.WriteAllTextAsync(Path.Combine(f.Target, "poll-lost"), "");
        var lost = await f.Call("exec", Exec("sleep .3; printf real"));
        Success(lost);
        Assert.Contains("Exit code: unknown", lost["output"]!.GetValue<string>());
        Assert.Contains("Execution lost:", lost["output"]!.GetValue<string>());
        Assert.Contains("Duration: unknown", lost["output"]!.GetValue<string>());
        File.Delete(Path.Combine(f.Target, "poll-lost"));
        await File.WriteAllTextAsync(Path.Combine(f.Target, "missing-output"), "");
        var absent = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "return call_tool('exec', {'command':'exit 7'})" }
        );
        Success(absent);
        Assert.Equal(7, absent["result"]!["exitCode"]!.GetValue<int>());
        Assert.True(absent["result"]!["truncated"]!.GetValue<bool>());
        Assert.Null(absent["result"]!["content"]);
        Assert.Contains("output unavailable", absent["result"]!["output"]!.GetValue<string>());
    }

    [Fact]
    public async Task Provider_programmatic_snapshot_has_inclusive_one_MiB_bound_and_output_observation_uses_only_one_budget()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        foreach (var length in new[] { 1048576, 1048577 })
        {
            var value = await f.Call(
                "run_script",
                new JsonObject
                {
                    ["code"] =
                        "x = call_tool('exec', {'command': \"python3 -c 'import sys;sys.stdout.write(chr(32)*"
                        + length
                        + ")'\"})\nreturn {'sizeBytes':x.get('sizeBytes'), 'truncated':x['truncated'], 'length':len(x['content']) if 'content' in x else None, 'displayLength':len(x['output'])}",
                }
            );
            Success(value);
            var result = value["result"]!;
            Assert.True(result["sizeBytes"] is not null, value.ToJsonString());
            Assert.Equal(length, result["sizeBytes"]!.GetValue<long>());
            Assert.Equal(length > 1048576, result["truncated"]!.GetValue<bool>());
            Assert.Equal(
                length <= 1048576 ? length : (int?)null,
                result["length"]?.GetValue<int>()
            );
            Assert.True(result["displayLength"]!.GetValue<int>() < 22000);
        }
        await File.WriteAllTextAsync(Path.Combine(f.Target, "slow-output"), "");
        var clock = Stopwatch.StartNew();
        var blocked = await f.Call("exec", Exec("sleep 2; printf late", 1));
        Success(blocked);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(3), clock.Elapsed.ToString());
        Assert.Contains("output unavailable", blocked["output"]!.GetValue<string>());
        // A later ordinary read uses a fresh observation, not the expired foreground token.
        File.Delete(Path.Combine(f.Target, "slow-output"));
        var logPath = Assert.Single(ExecRecords(f.Data))["logPath"]!.GetValue<string>();
        await Task.Delay(700);
        var page = await f.Call("read", new JsonObject { ["filePath"] = logPath });
        Assert.Contains("late", page["output"]!.GetValue<string>());

    }

    [Theory]
    [InlineData(20000, false)]
    [InlineData(20001, true)]
    public async Task Provider_foreground_uses_Source_display_limit_and_original_log(int length, bool shortened)
    {
        if (!OperatingSystem.IsLinux()) return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        var response = await f.Call("exec", Exec($"python3 -c 'import sys;sys.stdout.write(chr(65)*{length})'"));
        Success(response);
        var display = response["output"]!.GetValue<string>();
        Assert.True(display.Length < 22000);
        Assert.Equal(shortened, display.Contains("shortened for inline display"));
        Assert.Contains("Exit code: 0", display);
        Assert.Contains("had no trailing newline", display);
        var log = Assert.Single(Directory.GetFiles(Path.Combine(f.Target, "fs/logs"), "*.log"));
        Assert.Equal(new string('A', length), await File.ReadAllTextAsync(log));
    }

    [Fact]
    public async Task Provider_programmatic_capture_retains_original_control_bytes_without_display_parsing()
    {
        if (!OperatingSystem.IsLinux()) return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        var response = await f.Call("run_script", new JsonObject
        {
            ["code"] = "x = call_tool('exec', {'command': \"python3 -c 'import sys;sys.stdout.buffer.write(bytes([0])*4097)'\"})\n"
                + "return {'sizeBytes':x['sizeBytes'], 'truncated':x['truncated'], 'complete':x['content'] == '\\u0000'*4097}",
        });
        Success(response);
        var result = response["result"]!;
        Assert.Equal(4097, result["sizeBytes"]!.GetValue<long>());
        Assert.False(result["truncated"]!.GetValue<bool>());
        Assert.True(result["complete"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Deferred_provider_cwd_replay_checks_exact_current_Node_and_preserves_target_whitespace()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        Directory.CreateDirectory(f.FilePath("next  "));
        TurnToolExecution execution;
        using (f.Tools.CaptureDirectExecSegment())
            execution = await f.Tools.ExecuteAttributedAsync(
                new JsonObject
                {
                    ["id"] = "cwd",
                    ["name"] = "exec",
                    ["args"] = Exec("cd 'next  '"),
                },
                default
            );
        Assert.Equal("opaque://root/next  ", execution.DeferredCwd);
        Assert.Equal(f.Node, execution.DeferredCwdNode);
        Success(await f.Manager.SelectNodeAsync(f.Owner, "other/target"));
        var ignored = await f.Tools.ReplayCwdAsync(execution);
        Assert.Null(f.Owner.Entry.Snapshot().AuthorityEnvelope["cwd"]);
        Assert.DoesNotContain(
            "SESSION CWD CHANGED",
            ignored.Response!["output"]!.GetValue<string>()
        );
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        await f.Tools.ReplayCwdAsync(execution);
        Assert.Equal(
            "opaque://root/next  ",
            f.Owner.Entry.Snapshot().AuthorityEnvelope["cwd"]!.GetValue<string>()
        );
    }
}
