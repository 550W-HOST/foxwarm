using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactLifecycleTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Dedicated_compaction_accepts_file_first_and_repairs_rejected_file_content(
        bool rejectFirst,
        bool remote
    )
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var data = Path.Combine(temp.Path, "data");
        var target = Path.Combine(temp.Path, "target");
        var planDirectory = remote ? Path.Combine(target, "fs", "root", "plans") : work;
        Directory.CreateDirectory(planDirectory);
        var inputFile = Path.Combine(planDirectory, "plan.json");
        var inputPath = remote ? "plan.json" : inputFile;
        var repairDirectory = Path.Combine(planDirectory, remote ? ".temp" : "tmp");
        var policy = Path.Combine(data, "state", "tool-authorization.yaml");
        SessionManager? managerForPeer = null;
        var steps =
            remote ? 4
            : rejectFirst ? 3
            : 1;
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
                var valid = new JsonObject { ["replaceAsBlocks"] = blocks }.ToJsonString();
                JsonObject call;
                if (index == 0)
                {
                    await File.WriteAllTextAsync(
                        inputFile,
                        rejectFirst ? "{\"replaceAsBlocks\":" : valid
                    );
                    call = FunctionCall(
                        "file-first",
                        "submit_compact_plan",
                        new JsonObject { ["argsFilePath"] = inputPath }
                    );
                }
                else
                {
                    var physical = Directory
                        .EnumerateFiles(repairDirectory, "compact-plan-*.json")
                        .Single();
                    var repairPath = remote ? ".temp/" + Path.GetFileName(physical) : physical;
                    if (index == 1 || remote && index == 2)
                        Assert.Equal(
                            "{\"replaceAsBlocks\":",
                            await File.ReadAllTextAsync(physical)
                        );
                    if (remote && index == 1)
                    {
                        await File.WriteAllTextAsync(
                            policy,
                            "version: 1\nrules: [{id: deny-edit, action: deny, match: {tool: {source: node, name: edit}}}]\n"
                        );
                        managerForPeer!.Authorization.Invalidate();
                    }
                    if (remote && index == 2)
                    {
                        File.Delete(policy);
                        managerForPeer!.Authorization.Invalidate();
                        call = FunctionCall(
                            "patch",
                            "apply_patch",
                            new JsonObject
                            {
                                ["input"] =
                                    "*** Begin Patch\n*** Update File: "
                                    + repairPath
                                    + "\n-{\"replaceAsBlocks\":\n+"
                                    + valid
                                    + "\n*** End Patch",
                            }
                        );
                    }
                    else if (index == 1)
                        call = FunctionCall(
                            "edit",
                            "edit",
                            new JsonObject
                            {
                                ["filePath"] = repairPath,
                                ["oldText"] = "{\"replaceAsBlocks\":",
                                ["newText"] = valid,
                            }
                        );
                    else
                        call = FunctionCall(
                            "submit",
                            "submit_compact_plan",
                            new JsonObject { ["argsFilePath"] = repairPath }
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
        HostModels models = HostModels.ForTest(options);
        if (remote)
        {
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
            models = new HostModels(
                new ModelConfiguration(
                    HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
                )
            );
        }
        await using var manager = new SessionManager(data, work, options, models);
        managerForPeer = manager;
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "files", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        if (remote)
        {
            await manager.SetAgentIsolationAsync("main", "fixture/target", true, new JsonArray());
            await manager.SelectNodeAsync(owner, "fixture/target");
            await owner.UpdateCwdAsync("opaque://root/plans");
        }
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
        Assert.True((await owner.Compactor.StartManualAsync()).Started);
        await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
        await owner.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(steps, peer.RequestCount);
        Assert.Single(owner.Archive.ReadBlocks());
        Assert.Equal(1, owner.Entry.Snapshot().HistoryVersion);
        Assert.True(File.Exists(inputFile));
        if (rejectFirst)
            Assert.Empty(Directory.EnumerateFiles(repairDirectory, "compact-plan-*.json"));
        if (remote)
        {
            Assert.False(Directory.Exists(Path.Combine(work, "tmp")));
            Assert.Equal("fixture/target", manager.CurrentNode(owner));
        }
    }
}
