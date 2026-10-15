using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactLifecycleTests
{
    [Theory]
    [InlineData("direct", true)]
    [InlineData("dispatcher", true)]
    [InlineData("json-dispatcher", true)]
    [InlineData("legacy", true)]
    [InlineData("list", false)]
    [InlineData("external", false)]
    [InlineData("malformed", false)]
    [InlineData("duplicate", false)]
    [InlineData("unpaired", false)]
    public async Task Pruning_retains_only_genuine_uniquely_paired_skill_loads_and_keeps_archive_originals(
        string kind,
        bool retained
    )
    {
        await using var fixture = await CompactFixture.CreateAsync();
        fixture.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var skillArgs = new JsonObject { ["action"] = "load", ["skillName"] = "fixture" };
        var name = "skill";
        JsonObject args = skillArgs;
        if (kind is "dispatcher" or "json-dispatcher" or "external" or "malformed")
        {
            name = "call_tool";
            args =
                kind == "json-dispatcher"
                    ? new JsonObject
                    {
                        ["source"] = "builtin",
                        ["name"] = "skill",
                        ["argsJson"] = skillArgs.ToJsonString(),
                    }
                    : new JsonObject
                    {
                        ["toolId"] = kind == "external" ? "mcp:peer/skill" : "builtin:skill",
                        ["args"] = skillArgs.DeepClone(),
                    };
            if (kind == "malformed")
            {
                args.Remove("args");
                args["argsJson"] = "{broken";
            }
        }
        else if (kind == "legacy")
        {
            name = "load_skill";
            args = new JsonObject { ["skillName"] = "fixture" };
        }
        else if (kind == "list")
            args["action"] = "list";
        var skillOutput = "SKILL_MIDDLE:" + new string('s', 10000);
        async Task Append(string role, JsonObject part)
        {
            var item = QueueItem.Prebuilt(
                new JsonObject { ["role"] = role, ["parts"] = new JsonArray(part) }
            );
            await fixture.Owner.Registry.Ingress.EnqueueAsync("s", item);
            await fixture
                .Owner.Registry.HostFor("s")
                .AppendQueuedInputsAsync(
                    fixture.Owner.Entry.WithState(state => state.Queue.ToArray())
                );
        }
        async Task Exchange(
            string id,
            string callName,
            JsonObject callArgs,
            string responseId,
            string output
        )
        {
            await Append(
                "model",
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = id,
                        ["name"] = callName,
                        ["args"] = callArgs.DeepClone(),
                    },
                }
            );
            await Append(
                "tool",
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = responseId,
                        ["name"] = callName,
                        ["response"] = new JsonObject { ["output"] = output },
                    },
                }
            );
        }
        await Exchange(
            "skill-id",
            name,
            args,
            kind == "unpaired" ? "different-id" : "skill-id",
            skillOutput
        );
        if (kind == "duplicate")
            await Exchange("skill-id", name, args, "skill-id", skillOutput);
        await Exchange(
            "ordinary-id",
            "read",
            new JsonObject { ["filePath"] = "fixture" },
            "ordinary-id",
            "ORDINARY_MIDDLE:" + new string('o', 100000)
        );
        for (var i = 0; i < 4; i++)
            await Append("user", new JsonObject { ["text"] = "tail " + i });
        var before = fixture.Owner.Entry.Snapshot();
        Assert.True(
            await fixture.Owner.Compactor.AutoAfterTurnAsync(
                new(null, new JsonObject { ["inputTokens"] = 18000d })
            )
        );
        Assert.Equal(0, fixture.Peer.PlannerRequests);
        Assert.Equal(1, fixture.Owner.Entry.Snapshot().HistoryVersion);
        var activeSkill = fixture.Owner.History()[1]["parts"]![0]!["functionResponse"]![
            "response"
        ]!["output"]!.ToString();
        if (retained)
            Assert.Equal(skillOutput, activeSkill);
        else
            Assert.Contains("historical tool response pruned", activeSkill);
        var ordinary = fixture
            .Owner.History()
            .Single(row =>
                row["parts"]!.ToJsonString().Contains("ordinary-id")
                && row["role"]!.ToString() == "tool"
            );
        Assert.Contains("historical tool response pruned", ordinary.ToJsonString());
        foreach (var row in fixture.Store.Archive.ReadMessages())
            Assert.True(
                JsonNode.DeepEquals(
                    row.Message,
                    before.History.Materialize().Single(message =>
                        message["__meta"]!["seq"]!.ToString() == row.Seq.ToString()
                    )
                )
            );
    }

    [Fact]
    public async Task Nonmaterial_response_pruning_keeps_originals_and_requests_layered_planning_instead()
    {
        await using var fixture = await CompactFixture.CreateAsync();
        fixture.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        JsonObject[] messages =
        [
            new()
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "call",
                            ["name"] = "read",
                            ["args"] = new JsonObject(),
                        },
                    }
                ),
            },
            new()
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "call",
                            ["name"] = "read",
                            ["response"] = new JsonObject { ["output"] = new string('o', 10000) },
                        },
                    }
                ),
            },
            new()
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = new string('x', 20000) }),
            },
            new()
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "tail" }),
            },
        ];
        foreach (var message in messages)
            await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.Prebuilt(message));
        await fixture
            .Owner.Registry.HostFor("s")
            .AppendQueuedInputsAsync(fixture.Owner.Entry.WithState(state => state.Queue.ToArray()));
        var before = fixture.Owner.Entry.Snapshot();
        Assert.False(
            await fixture.Owner.Compactor.AutoAfterTurnAsync(
                new(null, new JsonObject { ["inputTokens"] = 18000d })
            )
        );
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.True(JsonNode.DeepEquals(before.History.Materialize()[1], fixture.Owner.History()[1]));
        await fixture.Owner.Compactor.StopAsync();
    }
}
