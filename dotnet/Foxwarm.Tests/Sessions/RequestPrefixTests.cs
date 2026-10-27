using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class RequestPrefixTests
{
    [Fact]
    public async Task Ordinary_and_committed_compaction_share_instructions_tools_and_older_wire_prefix()
    {
        using var temp = new TempDirectory();
        var captures = new List<JsonObject>();
        await using var peer = new ScriptedResponsesSequenceServer(2, async (index, stream, captured) =>
        {
            captures.Add(JsonNode.Parse(captured.Body)!.AsObject());
            JsonObject? plan = null;
            if (index == 1)
            {
                var candidates = Regex.Matches(
                    captured.Body.Replace("\\n", "\n"),
                    "^- M#(\\d+)(?:-#(\\d+))?\\s",
                    RegexOptions.Multiline
                );
                Assert.NotEmpty(candidates);
                var last = candidates[^1];
                plan = new JsonObject
                {
                    ["replaceAsBlocks"] = new JsonArray(new JsonObject
                    {
                        ["level"] = 1,
                        ["sourceKind"] = "message",
                        ["sourceStart"] = long.Parse(candidates[0].Groups[1].Value),
                        ["sourceEnd"] = long.Parse(last.Groups[2].Success ? last.Groups[2].Value : last.Groups[1].Value),
                        ["summary"] = "Completed synthetic source work.",
                    }),
                };
            }
            await LoopbackResponsesServer.WriteResponseAsync(
                stream, 200, "text/event-stream", Encoding.UTF8.GetBytes(Reply(plan))
            );
        });
        await using var manager = await CreateManager(temp.Path, peer.BaseUri);
        var owner = await manager.CreateNamedAsync("main", "prefix", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await Append(owner, Text("older-a " + new string('a', 2500)));
        await Append(owner, Text("older-b " + new string('b', 2500), "model"));
        await Append(owner, new JsonObject
        {
            ["role"] = "model",
            ["parts"] = new JsonArray(new JsonObject
            {
                ["functionCall"] = new JsonObject
                {
                    ["id"] = "historical-read", ["name"] = "read",
                    ["args"] = new JsonObject { ["filePath"] = "synthetic.txt" },
                },
            }),
        });
        await Append(owner, new JsonObject
        {
            ["role"] = "tool",
            ["parts"] = new JsonArray(new JsonObject
            {
                ["functionResponse"] = new JsonObject
                {
                    ["tool_use_id"] = "historical-read", ["name"] = "read",
                    ["response"] = new JsonObject { ["output"] = "Synthetic historical result." },
                },
            }),
        });
        await Append(owner, Text("older-c " + new string('c', 2500)));
        await Append(owner, Text("older-d " + new string('d', 2500)));
        await Append(owner, Text("older-e " + new string('e', 2500), "model"));
        await Append(owner, Text("recent-f"));
        await Append(owner, Text("recent-g", "model"));
        await Turn(owner);
        var before = owner.Entry.Snapshot();
        var memoryPath = Path.Combine(temp.Path, "work", "memory", "prefix.md");
        await File.WriteAllTextAsync(memoryPath, "Refreshed memory after compact commit.");
        var admission = await owner.Compactor.StartManualAsync(keepPercent: .5);
        Assert.True(admission.Started);
        await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(25));

        Assert.Equal(2, peer.RequestCount);
        Assert.Equal(Instructions(captures[0]), Instructions(captures[1]));
        Assert.True(JsonNode.DeepEquals(captures[0]["tools"], captures[1]["tools"]));
        var normal = captures[0]["input"]!.AsArray();
        var compact = captures[1]["input"]!.AsArray();
        Assert.True(compact.Count > 2 && compact.Count < normal.Count);
        for (var i = 0; i < compact.Count - 1; i++)
            Assert.True(JsonNode.DeepEquals(normal[i], compact[i]), $"Wire prefix differs at {i}.");
        Assert.Contains("sourceStart", compact[^1]!.ToJsonString());
        Assert.Contains("historical-read", string.Join("", compact.Select(row => row!.ToJsonString())));
        Assert.Contains(owner.History(), row => row["__meta"]?["contextBlock"] is not null);
        Assert.Contains("Refreshed memory after compact commit.", owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.GetValue<string>());
        Assert.Equal(before.AuthorityEnvelope["promptCacheKey"]!.GetValue<string>(), owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]!.GetValue<string>());
    }

    [Fact]
    public async Task Node_selection_cwd_and_connection_changes_leave_ordinary_and_BTW_instructions_stable()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var captures = new List<JsonObject>();
        await using var peer = new ScriptedResponsesSequenceServer(8, async (_, stream, captured) =>
        {
            captures.Add(JsonNode.Parse(captured.Body)!.AsObject());
            await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", Encoding.UTF8.GetBytes(Reply(null)));
        });
        await using var manager = await CreateManager(temp.Path, peer.BaseUri, providerNode: true);
        var owner = await manager.CreateNamedAsync("main", "placement-prefix", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await Turn(owner);
        await manager.RunBtwAsync(owner, "Synthetic side question.");
        var original = owner.Entry.Snapshot();
        await owner.UpdateCwdAsync(Path.Combine(temp.Path, "work"));
        await Turn(owner);
        await manager.NodeProviders.LifecycleAsync("create", "fixture", "fixture/selected", new JsonObject(), owner.Id, owner.Agent, default);
        await manager.SelectNodeAsync(owner, "fixture/selected");
        Assert.Equal("fixture/selected", manager.ExecutionPlacement(owner).Node);
        Assert.Null(manager.ExecutionPlacement(owner).Cwd);
        await Turn(owner);
        await owner.UpdateCwdAsync("opaque://root/changed");
        Assert.Equal("opaque://root/changed", manager.ExecutionPlacement(owner).Cwd);
        await Turn(owner);
        await manager.RunBtwAsync(owner, "Synthetic selected-Node side question.");
        Assert.True(manager.NodeProviders.Connected("fixture/selected"));
        await manager.NodeProviders.LifecycleAsync("destroy", null, "fixture/selected", new JsonObject(), owner.Id, owner.Agent, default);
        Assert.False(manager.NodeProviders.Connected("fixture/selected"));
        await Turn(owner);
        await manager.RunBtwAsync(owner, "Synthetic offline side question.");

        Assert.Equal(8, captures.Count);
        Assert.All(captures, request => Assert.Equal(Instructions(captures[0]), Instructions(request)));
        Assert.True(JsonNode.DeepEquals(original.AuthorityEnvelope["persistentMemorySnapshot"], owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]));
        Assert.True(JsonNode.DeepEquals(original.AuthorityEnvelope["promptCacheKey"], owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]));
        Assert.Contains(captures[4]["tools"]!.AsArray(), tool => tool?["name"]?.GetValue<string>() == "read");
        Assert.DoesNotContain(captures[6]["tools"]!.AsArray(), tool => tool?["name"]?.GetValue<string>() == "read");
        Assert.Equal("fixture/selected", manager.ExecutionPlacement(owner).Node);
        Assert.Equal("opaque://root/changed", manager.ExecutionPlacement(owner).Cwd);
        var sideResults = owner.History().Where(row => row["__meta"]?["noticeType"]?.GetValue<string>() == "btw").ToArray();
        Assert.Equal(3, sideResults.Length);
        Assert.All(sideResults, row => Assert.Contains("Synthetic completed reply.", row["parts"]![0]!["text"]!.GetValue<string>()));
    }

    private static async Task<SessionManager> CreateManager(string root, Uri uri, bool providerNode = false)
    {
        var data = Path.Combine(root, "data");
        var work = Path.Combine(root, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(Path.Combine(work, "memory"));
        await File.WriteAllTextAsync(Path.Combine(work, "memory", "prefix.md"), "Stable synthetic memory.");
        var app = new JsonObject { ["vector"] = false };
        if (providerNode)
            app["nodeProviders"] = new JsonObject { ["fixture"] = ExecutableNodeProviderTests.Configuration(Path.Combine(root, "provider"), "lifecycle") };
        await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), app.ToJsonString());
        await File.WriteAllTextAsync(Path.Combine(data, "state", "models.yaml"), new JsonObject
        {
            ["default"] = "synthetic/wire",
            ["providers"] = new JsonObject
            {
                ["synthetic"] = new JsonObject
                {
                    ["providerType"] = "openai-responses", ["baseUrl"] = uri.ToString(),
                    ["models"] = new JsonArray("wire"), ["contextLimit"] = 200000, ["asyncCompact"] = false,
                },
            },
        }.ToJsonString());
        var models = new HostModels(new ModelConfiguration(HostPaths.ForDataRoot(data, root, environment: _ => null)));
        var options = new ResponsesClientOptions(uri, "wire", "synthetic/wire", "", "Stable base instructions.", 1000);
        var manager = new SessionManager(data, work, options, models, Path.Combine(root, "skills"));
        await manager.LoadMainHostAsync();
        return manager;
    }

    private static JsonObject Text(string text, string role = "user") => new()
    {
        ["role"] = role, ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
    };

    private static async Task Append(SessionOwner owner, JsonObject row)
    {
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.Prebuilt(row));
        await owner.Registry.HostFor(owner.Id).AppendQueuedInputsAsync(owner.Entry.State.Queue.ToArray());
    }

    private static async Task Turn(SessionOwner owner)
    {
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("Synthetic normal request."));
        await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(20));
    }

    private static string Instructions(JsonObject request) => request["instructions"]!.GetValue<string>();

    private static string Reply(JsonObject? plan)
    {
        const string text = "Synthetic completed reply.";
        static string Event(JsonObject value) => "data: " + value.ToJsonString() + "\n\n";
        var output = plan is null
            ? new JsonObject { ["type"] = "message", ["role"] = "assistant", ["content"] = new JsonArray(new JsonObject { ["type"] = "output_text", ["text"] = text }) }
            : new JsonObject { ["type"] = "function_call", ["call_id"] = "compact-call", ["name"] = "submit_compact_plan", ["arguments"] = plan.ToJsonString() };
        return Event(new JsonObject { ["type"] = "response.completed", ["response"] = new JsonObject { ["id"] = "synthetic-reply", ["output"] = new JsonArray(output) } });
    }
}
