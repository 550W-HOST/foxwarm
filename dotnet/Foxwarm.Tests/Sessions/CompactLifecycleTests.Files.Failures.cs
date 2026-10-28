using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactLifecycleTests
{
    [Fact]
    public async Task Unavailable_cleanup_preserves_a_valid_dedicated_plan()
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var data = Path.Combine(temp.Path, "data");
        var target = Path.Combine(temp.Path, "target");
        var planDirectory = Path.Combine(target, "fs", "root", "plans");
        Directory.CreateDirectory(planDirectory);
        var inputFile = Path.Combine(planDirectory, "plan.json");
        var inputPath = "plan.json";
        var repairDirectory = Path.Combine(planDirectory, ".temp");
        var steps = 2;
        await using var peer = new ScriptedResponsesSequenceServer(
            steps,
            async (index, stream, captured) =>
            {
                var request = JsonNode.Parse(captured.Body)!;
                var sourceText = string.Join(
                    "\n",
                    request["input"]!
                        .AsArray()
                        .OfType<JsonObject>()
                        .SelectMany(row =>
                            (row["content"] as JsonArray)?.OfType<JsonObject>() ?? []
                        )
                        .Select(row => SessionWait.Text(row["text"]) ?? "")
                );
                var matches = Regex.Matches(
                    sourceText,
                    "^- M#(\\d+)(?:-#(\\d+))?\\s",
                    RegexOptions.Multiline
                );
                var last = matches[^1];
                var blocks = new JsonArray(
                    new JsonObject
                    {
                        ["level"] = 1,
                        ["sourceKind"] = "message",
                        ["sourceStart"] = long.Parse(matches[0].Groups[1].Value),
                        ["sourceEnd"] = long.Parse(
                            last.Groups[2].Success ? last.Groups[2].Value : last.Groups[1].Value
                        ),
                        ["summary"] = "File plan completion.",
                    }
                );
                JsonObject call;
                if (index == 0)
                {
                    await File.WriteAllTextAsync(inputFile, "{\"replaceAsBlocks\":");
                    call = FunctionCall(
                        "file-first",
                        "submit_compact_plan",
                        new JsonObject { ["argsFilePath"] = inputPath }
                    );
                }
                else
                {
                    Assert.NotEmpty(
                        Directory.EnumerateFiles(repairDirectory, "compact-plan-*.json")
                    );
                    // External provider discovery now reports a different environment; the captured Node is unavailable.
                    await File.WriteAllTextAsync(Path.Combine(target, "node-id"), "gone");
                    call = FunctionCall(
                        "valid-after-removal",
                        "submit_compact_plan",
                        new JsonObject { ["replaceAsBlocks"] = blocks.DeepClone() }
                    );
                }
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "file-first-" + index,
                        ["output"] = new JsonArray(call),
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + payload.ToJsonString() + "\n\n")
                );
            }
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 20000);
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            new JsonObject
            {
                ["vector"] = false,
                ["nodeProviders"] = new JsonObject
                {
                    ["fixture"] = ExecutableNodeProviderTests.Configuration(target),
                },
            }.ToJsonString()
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            "default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: "
                + peer.BaseUri
                + "\n    models: [wire]\n    asyncCompact: false\n"
        );
        var models = new HostModels(
            new ModelConfiguration(HostPaths.ForDataRoot(data, temp.Path, environment: _ => null))
        );
        await using var manager = new SessionManager(data, work, options, models);
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "files", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await manager.SetAgentIsolationAsync("main", "fixture/target", true, new JsonArray());
        await manager.SelectNodeAsync(owner, "fixture/target");
        await owner.UpdateCwdAsync("opaque://root/plans");
        for (var index = 0; index < 8; index++)
            await ForkClearLifecycleTests.AppendAsync(
                owner,
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(
                        new JsonObject { ["text"] = "source " + index + new string('x', 5000) }
                    ),
                }
            );
        var maintenanceFailures = owner.Entry.BestEffortFailureCount;
        Assert.True((await owner.Compactor.StartManualAsync()).Started);
        await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
        await owner.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(steps, peer.RequestCount);
        Assert.True(owner.Entry.BestEffortFailureCount > maintenanceFailures);
        Assert.Single(owner.Archive.ReadBlocks());
        Assert.Equal(1, owner.Entry.Snapshot().HistoryVersion);
        Assert.True(File.Exists(inputFile));
        Assert.NotEmpty(Directory.EnumerateFiles(repairDirectory, "compact-plan-*.json"));
        Assert.False(Directory.Exists(Path.Combine(work, "tmp")));
        Assert.Equal("fixture/target", manager.CurrentNode(owner));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Staging_denial_retains_rejection_but_unavailable_policy_stops_planning(
        bool unavailable
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var policy = Path.Combine(data, "state", "tool-authorization.yaml");
        SessionManager? managerForPeer = null;
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, captured) =>
            {
                var request = JsonNode.Parse(captured.Body)!;
                var text = request.ToJsonString();
                var matches = Regex.Matches(
                    string.Join(
                        "\n",
                        request["input"]!
                            .AsArray()
                            .OfType<JsonObject>()
                            .SelectMany(row =>
                                (row["content"] as JsonArray)?.OfType<JsonObject>() ?? []
                            )
                            .Select(row => SessionWait.Text(row["text"]) ?? "")
                    ),
                    "^- M#(\\d+)(?:-#(\\d+))?\\s",
                    RegexOptions.Multiline
                );
                var last = matches[^1];
                var blocks = new JsonArray(
                    new JsonObject
                    {
                        ["level"] = 1,
                        ["sourceKind"] = "message",
                        ["sourceStart"] = long.Parse(matches[0].Groups[1].Value),
                        ["sourceEnd"] = long.Parse(
                            last.Groups[2].Success ? last.Groups[2].Value : last.Groups[1].Value
                        ),
                        ["summary"] = "Corrected direct plan.",
                    }
                );
                if (index == 1)
                {
                    Assert.Contains("replaceAsBlocks must contain at least one block", text);
                    Assert.Contains("Plan file staging failed", text);
                }
                if (index == 0)
                {
                    await File.WriteAllTextAsync(
                        policy,
                        unavailable
                            ? "version: [invalid"
                            : "version: 1\nrules: [{id: deny-plan-staging, action: deny, match: {tool: {source: node, name: write}}}]\n"
                    );
                    managerForPeer!.Authorization.Invalidate();
                }
                var output = new JsonArray(
                    FunctionCall(
                        "plan-" + index,
                        "submit_compact_plan",
                        new JsonObject
                        {
                            ["replaceAsBlocks"] = index == 0 ? new JsonArray() : blocks,
                        }
                    )
                );
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "staging-" + index,
                        ["output"] = output,
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + payload.ToJsonString() + "\n\n")
                );
            }
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 20000);
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        managerForPeer = manager;
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "denied-staging", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        for (var i = 0; i < 8; i++)
            await ForkClearLifecycleTests.AppendAsync(
                owner,
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(
                        new JsonObject { ["text"] = "source " + i + new string('x', 5000) }
                    ),
                }
            );
        Assert.True((await owner.Compactor.StartManualAsync()).Started);
        await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(15));
        await owner.DrainAsync().WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal(unavailable ? 1 : 2, peer.RequestCount);
        Assert.Equal(unavailable ? 0 : 1, owner.Entry.Snapshot().HistoryVersion);
        Assert.False(Directory.Exists(Path.Combine(work, "tmp")));
        Assert.Equal(unavailable ? 0 : 1, owner.Archive.ReadBlocks().Count);
    }
}
