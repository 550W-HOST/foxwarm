using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ToolScriptStopSettlementTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Ordinary_stop_delivers_settled_exec_to_script_before_the_next_host_fence(
        bool printReceipt
    )
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        string? code = null;
        await using var peer = await StreamingModelPeer.StartAsync(
            false,
            async (ctx, number) =>
            {
                if (number == 1)
                {
                    var call = new JsonObject
                    {
                        ["type"] = "function_call",
                        ["id"] = "fc_script",
                        ["call_id"] = "script",
                        ["name"] = "run_script",
                        ["arguments"] = new JsonObject { ["code"] = code }.ToJsonString(),
                    };
                    await ctx.Send(ResponsesPrefixCommitTests.Done(0, call));
                    await ctx.Send(ResponsesPrefixCommitTests.Completed(call));
                }
                else
                {
                    var answer = new JsonObject
                    {
                        ["type"] = "message",
                        ["role"] = "assistant",
                        ["phase"] = "final_answer",
                        ["status"] = "completed",
                        ["content"] = new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "output_text",
                                ["text"] = "Follow-up received.",
                            }
                        ),
                    };
                    await ctx.Send(ResponsesPrefixCommitTests.Done(0, answer));
                    await ctx.Send(ResponsesPrefixCommitTests.Completed(answer));
                }
            }
        );
        var models = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "fixture/offline",
                ["providers"] = new JsonObject
                {
                    ["fixture"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = peer.Uri.ToString(),
                        ["models"] = new JsonArray("offline"),
                    },
                },
            },
            new JsonObject()
        );
        var defaults = new ResponsesClientOptions(
            peer.Uri,
            "offline",
            "fixture/offline",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(root, work, defaults, models);
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "stop-visibility", null, null);
        // Keep idle event delivery queued until explicitly invoking the ordinary owner.
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var toolWork = manager.IdentityWorkspace(owner)!.ToolDirectory;
        var ready = Path.Combine(toolWork, "launched");
        var release = Path.Combine(toolWork, "release");
        var finished = Path.Combine(toolWork, "finished");
        var skipped = Path.Combine(toolWork, "skipped");
        var command =
            $"printf launched > '{ready}'; for n in $(seq 1 500); do test -f '{release}' && break; sleep 0.02; done; printf finished > '{finished}'";
        code =
            (printReceipt ? "receipt = " : "")
            + "call_tool('exec', {'command': "
            + JsonSerializer.Serialize(command)
            + ", 'timeout': 10})\n"
            + (printReceipt ? "print('SETTLED_RECEIPT', receipt)\n" : "")
            + "call_tool('write', {'filePath': "
            + JsonSerializer.Serialize(skipped)
            + ", 'content': 'wrong'})\nreturn True\n";
        await owner.Registry.Ingress.EnqueueAsync(
            owner.Id,
            QueueItem.UserText("Launch owned script.")
        );
        var running = owner.Registry.Runner.ProcessQueueAsync(owner.Id);
        await Until(() => File.Exists(ready));
        await owner.Registry.Control.StopAsync(owner.Id);
        await running.WaitAsync(TimeSpan.FromSeconds(15));
        var outer = owner
            .History()
            .SelectMany(row => row["parts"]!.AsArray())
            .Select(part => part?["functionResponse"])
            .OfType<JsonObject>()
            .Single(response => response["name"]?.GetValue<string>() == "run_script");
        var runId = outer["response"]!["runId"]!.GetValue<string>();
        var record = await manager.ToolScript.Store.ReadAsync(runId, default);
        var tracked = new JsonArray(
            owner.Executor.Tracked.Select(row => (JsonNode)row.DeepClone()).ToArray()
        );
        var persistedRegistry = JsonNode.Parse(
            await File.ReadAllTextAsync(Path.Combine(root, "state", "running-exec.json"))
        );
        Assert.Single(tracked);
        Assert.False(File.Exists(skipped));
        Assert.False(File.Exists(finished));
        Assert.False(owner.Entry.Snapshot().Busy);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        await owner.Registry.Ingress.EnqueueAsync(
            owner.Id,
            QueueItem.UserText("New user input after Stop: explain prior outcome.")
        );
        await owner.Registry.Runner.ProcessQueueAsync(owner.Id).WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal(2, peer.Requests.Count);
        await File.WriteAllTextAsync(release, "release");
        await Until(() => File.Exists(finished));
        await owner.Executor.ReconcileNowAsync();
        await Until(() =>
            owner
                .Entry.Snapshot()
                .Queue.Any(item =>
                    JsonSerializer
                        .Serialize(item)
                        .Contains("background-process-finished", StringComparison.Ordinal)
                )
        );
        var exec = Assert.Single(tracked)!;
        var execId = exec["id"]!.GetValue<string>();
        var pid = exec["pid"]!.GetValue<long>();
        var log = exec["logPath"]!.GetValue<string>();
        Assert.True(exec["notifyOnCompletion"]!.GetValue<bool>());
        Assert.Contains(execId, persistedRegistry!.ToJsonString());
        Assert.Equal("failed", outer["response"]!["status"]!.GetValue<string>());
        Assert.Contains("not started", outer["response"]!["error"]!.GetValue<string>());
        Assert.Equal(
            "completed",
            Assert.Single(outer["__meta"]!["toolScriptSubCalls"]!.AsArray())![
                "status"
            ]!.GetValue<string>()
        );
        Assert.Equal(
            "exec",
            Assert.Single(record!["executedTools"]!.AsArray())!.GetValue<string>()
        );
        Assert.Equal("completed", record["lastHostCall"]!["status"]!.GetValue<string>());
        Assert.Equal("exec", record["lastHostCall"]!["summaryName"]!.GetValue<string>());
        var stdout = outer["response"]!["stdout"]?.GetValue<string>() ?? "";
        Assert.Equal(printReceipt, stdout.Contains(execId, StringComparison.Ordinal));
        Assert.Equal(stdout, record["stdout"]!.GetValue<string>());
        var output = peer.Requests[1]["input"]!
            .AsArray()
            .OfType<JsonObject>()
            .Single(item => item["type"]?.ToString() == "function_call_output")["output"]!;
        var nextText = string.Join(
            "\n",
            output.AsArray().Select(part => part?["text"]?.GetValue<string>())
        );
        Assert.Equal(printReceipt, nextText.Contains(execId, StringComparison.Ordinal));
        if (printReceipt)
        {
            Assert.Contains("SETTLED_RECEIPT", stdout);
            Assert.Contains("running", stdout);
            Assert.Contains("not killed", stdout);
            Assert.Contains(
                pid.ToString(System.Globalization.CultureInfo.InvariantCulture),
                stdout
            );
            Assert.Contains(log, stdout);
            Assert.Contains("SETTLED_RECEIPT", nextText);
            Assert.Contains("not killed", nextText);
            Assert.Contains(log, nextText);
        }
        else
        {
            Assert.DoesNotContain(execId, outer["response"]!.ToJsonString());
        }
        var completion = Assert.Single(
            owner.Entry.Snapshot().Queue,
            item => item.OpenFields?["execId"]?.ToString() == execId
        );
        var completionText = JsonSerializer.Serialize(completion);
        Assert.Contains("Exit code: 0", completionText);
        Assert.Contains(log, completionText);
    }

    private static async Task Until(Func<bool> condition)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (!condition())
            await Task.Delay(20, deadline.Token);
    }
}
