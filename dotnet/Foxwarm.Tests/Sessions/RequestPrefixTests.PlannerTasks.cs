using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class RequestPrefixTests
{
    [Fact]
    public async Task Planner_task_status_is_appended_to_the_planning_instruction_only()
    {
        using var temp = new TempDirectory();
        var captures = new List<JsonObject>();
        var finished = "";
        var unknown = "task_0123456789ab";
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, captured) =>
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
                                ["summary"] = "Completed synthetic source work.",
                            }
                        ),
                    };
                }
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(Event(ResponseBody(plan)))
                );
            }
        );
        await using var manager = await CreateManager(temp.Path, peer.BaseUri);
        // A Task of another Session: the compacted Session reads none of it but may mention it.
        var created = await manager.Tasks.ExecuteAsync(
            new JsonObject { ["action"] = "create", ["title"] = "SECRET-TASK-TITLE" },
            "other-session"
        );
        finished = created.Payload["task"]!["id"]!.GetValue<string>();
        await manager.Tasks.ExecuteAsync(
            new JsonObject { ["action"] = "claim", ["taskId"] = finished },
            "other-session"
        );
        await manager.Tasks.ExecuteAsync(
            new JsonObject { ["action"] = "complete", ["taskId"] = finished },
            "other-session"
        );
        var owner = await manager.CreateNamedAsync("main", "prefix-tasks", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await Append(owner, Text($"older-a {finished} " + new string('a', 2500)));
        await Append(owner, Text($"older-b {unknown} " + new string('b', 2500), "model"));
        await Append(owner, Text("older-c " + new string('c', 2500)));
        await Append(owner, Text("older-d " + new string('d', 2500), "model"));
        await Append(owner, Text("recent-e"));
        await Append(owner, Text("recent-f", "model"));
        await Turn(owner);
        owner.Registry.TriggerOverride = _ => owner.StartProcessing();
        var admission = await owner.Compactor.StartManualAsync(keepPercent: .5);
        Assert.True(admission.Started);
        await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(25));

        Assert.Equal(2, captures.Count);
        const string header = "Current status of Tasks mentioned in the sources:";
        Assert.DoesNotContain(header, captures[0].ToJsonString());
        var normal = captures[0]["input"]!.AsArray();
        var compact = captures[1]["input"]!.AsArray();
        Assert.True(compact.Count > 2 && compact.Count < normal.Count);
        for (var i = 0; i < compact.Count - 1; i++)
            Assert.True(JsonNode.DeepEquals(normal[i], compact[i]), $"Wire prefix differs at {i}.");
        Assert.Equal(
            compact.Count - 1,
            compact
                .Select(row => row!.ToJsonString())
                .ToList()
                .FindIndex(row => row.Contains(header))
        );
        var planning = compact[^1]!.ToJsonString().Replace("\\n", "\n");
        Assert.Contains($"{header}\n- {finished}: completed\n", planning);
        Assert.DoesNotContain($"- {unknown}", planning);
        Assert.DoesNotContain("SECRET-TASK-TITLE", captures[1].ToJsonString());
        Assert.Contains(owner.History(), row => row["__meta"]?["contextBlock"] is not null);
        // The planning instruction is not history: no row's model-visible parts carry the section.
        // (The planner diagnostic stored beside the completion row keeps the instruction text.)
        Assert.DoesNotContain(
            header,
            string.Join("", owner.History().Select(row => row["parts"]?.ToJsonString()))
        );
    }
}
