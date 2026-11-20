using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AnthropicHostedSearchTests
{
    [Fact]
    public async Task Single_shot_search_can_finish_but_pause_is_nonretryable_and_not_a_successful_partial_answer()
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, request) =>
            {
                Assert.True(AnthropicRequestSerializer.HasSearchTool(Obj(request.Body)));
                await Respond(
                    stream,
                    index == 0
                        ? Reply("end_turn", Search(), Sources(), Cited())
                        : Reply("pause_turn", Search()),
                    false
                );
            }
        );
        using var temp = new TempDirectory();
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a/wire",
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "anthropic",
                        ["baseUrl"] = new Uri(peer.BaseUri, "/").ToString(),
                        ["models"] = new JsonArray("wire"),
                        ["webSearch"] = true,
                        ["extraFields"] = new JsonObject { ["stream"] = false },
                    },
                },
            },
            new JsonObject()
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            new(peer.BaseUri, "wire", "a/wire", "", "", 1000),
            catalog
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "one-shot", null, null);
        var answer = await manager.RequestToolScriptModelAsync(
            owner,
            "Search synthetic information",
            "a/wire",
            new Foxwarm.ToolScript.ToolScriptDataBudget(),
            default
        );
        Assert.Contains("supported claim", SessionWait.Text(answer["text"]));
        var failure = await Assert.ThrowsAsync<ModelRequestException>(() =>
            manager.RequestToolScriptModelAsync(
                owner,
                "Pause synthetic search",
                "a/wire",
                new Foxwarm.ToolScript.ToolScriptDataBudget(),
                default
            )
        );
        Assert.Contains("single-request", failure.Message);
        Assert.Equal(1, failure.Final.Attempt);
        Assert.Equal(2, peer.RequestCount);
        Assert.Empty(owner.History());
        await manager.ShutdownAsync();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Compact_planner_preserves_normal_prefix_and_continues_pause_without_user_feedback(
        bool clientTool
    )
    {
        using var temp = new TempDirectory();
        var captures = new List<JsonObject>();
        var peerFailure = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var paused = clientTool
            ? Reply("tool_use", Search("plan-search"), LocalTask())
            : Reply("pause_turn", Search("plan-search"));
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, request) =>
            {
                try
                {
                    var body = Obj(request.Body);
                    captures.Add(body);
                    JsonObject reply;
                    if (index == 0)
                        reply = Reply("end_turn", Text("Normal response."));
                    else if (index == 1)
                        reply = paused;
                    else
                    {
                        var messages = body["messages"]!.AsArray();
                        var assistant = clientTool ? messages[^2]! : messages[^1]!;
                        Assert.Equal("assistant", assistant["role"]!.ToString());
                        Assert.True(JsonNode.DeepEquals(paused["content"], assistant["content"]));
                        Assert.Equal(
                            captures[1]["messages"]!.AsArray().Count + (clientTool ? 2 : 1),
                            messages.Count
                        );
                        if (clientTool)
                            Assert.All(
                                messages[^1]!["content"]!.AsArray(),
                                block => Assert.Equal("tool_result", block!["type"]!.ToString())
                            );
                        var candidates = Regex.Matches(
                            request.Body.Replace("\\n", "\n"),
                            "^- M#(\\d+)(?:-#(\\d+))?\\s",
                            RegexOptions.Multiline
                        );
                        Assert.NotEmpty(candidates);
                        var last = candidates[^1];
                        var plan = new JsonObject
                        {
                            ["replaceAsBlocks"] = new JsonArray(
                                new JsonObject
                                {
                                    ["level"] = 1,
                                    ["sourceKind"] = "message",
                                    ["sourceStart"] = long.Parse(candidates[0].Groups[1].Value),
                                    ["sourceEnd"] = long.Parse(
                                        last.Groups[2].Success
                                            ? last.Groups[2].Value
                                            : last.Groups[1].Value
                                    ),
                                    ["summary"] = "Completed synthetic work with sources.",
                                }
                            ),
                        };
                        reply = Reply(
                            "tool_use",
                            Sources("plan-search"),
                            new JsonObject
                            {
                                ["type"] = "tool_use",
                                ["id"] = "plan",
                                ["name"] = "submit_compact_plan",
                                ["input"] = plan,
                            }
                        );
                    }
                    await Respond(stream, reply, true);
                }
                catch (Exception error)
                {
                    Console.WriteLine(error);
                    peerFailure.TrySetException(error);
                    throw;
                }
            }
        );
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), "vector: false\n");
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a/wire",
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "anthropic",
                        ["baseUrl"] = new Uri(peer.BaseUri, "/").ToString(),
                        ["models"] = new JsonArray("wire"),
                        ["webSearch"] = true,
                        ["asyncCompact"] = false,
                    },
                },
            },
            new JsonObject()
        );
        await using var manager = new SessionManager(
            data,
            Path.Combine(temp.Path, "work"),
            new(peer.BaseUri, "wire", "a/wire", "", "Stable instructions", 1000),
            catalog
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "search-prefix", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        for (var index = 0; index < 6; index++)
        {
            await owner.Registry.Ingress.EnqueueAsync(
                owner.Id,
                QueueItem.Prebuilt(
                    new JsonObject
                    {
                        ["role"] = index % 2 == 0 ? "user" : "model",
                        ["parts"] = new JsonArray(
                            new JsonObject { ["text"] = $"Source {index} " + new string('a', 2500) }
                        ),
                    }
                )
            );
            await owner
                .Registry.HostFor(owner.Id)
                .AppendQueuedInputsAsync(owner.Entry.State.Queue.ToArray());
        }
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("Normal request"));
        await await Task.WhenAny(owner.StartProcessing(), peerFailure.Task)
            .WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        var admission = owner.Compactor.StartManualAsync(keepPercent: .3);
        await await Task.WhenAny(admission, peerFailure.Task).WaitAsync(TimeSpan.FromSeconds(20));
        Assert.True((await admission).Started);
        await await Task.WhenAny(owner.Compactor.DrainAsync(), peerFailure.Task)
            .WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(3, captures.Count);
        Assert.Equal(captures[0]["system"]!.ToJsonString(), captures[1]["system"]!.ToJsonString());
        Assert.Equal(captures[0]["tools"]!.ToJsonString(), captures[1]["tools"]!.ToJsonString());
        var normal = captures[0]["messages"]!.AsArray();
        var compact = captures[1]["messages"]!.AsArray();
        for (var index = 0; index < compact.Count - 1; index++)
            Assert.Equal(normal[index]!.ToJsonString(), compact[index]!.ToJsonString());
        Assert.Contains(owner.History(), row => row["__meta"]?["contextBlock"] is not null);
        Assert.Contains(
            owner.History(),
            row => row["compaction"]?["planner"]?["steps"]?.GetValue<int>() == 2
        );
        await manager.ShutdownAsync();
    }
}
