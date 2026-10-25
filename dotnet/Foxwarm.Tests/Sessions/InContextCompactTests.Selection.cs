using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class InContextCompactTests
{
    [Fact]
    public void Deliberate_sources_relax_automatic_windows_size_and_single_block_policy_but_not_exchange_boundaries()
    {
        JsonObject Row(string role, long seq, JsonObject part) =>
            new()
            {
                ["role"] = role,
                ["parts"] = new JsonArray(part),
                ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq },
            };
        var block = new ArchiveBlockRecord(
            "s",
            "main",
            7,
            1,
            "message",
            4,
            5,
            null,
            4,
            5,
            4,
            5,
            "Short source block.",
            null,
            7
        );
        JsonObject[] history =
        [
            Row("user", 1, new JsonObject { ["text"] = "small" }),
            Row(
                "model",
                2,
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "old",
                        ["name"] = "read",
                        ["args"] = new JsonObject(),
                    },
                }
            ),
            Row(
                "tool",
                3,
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = "old",
                        ["response"] = new JsonObject { ["output"] = "small" },
                    },
                }
            ),
            block.ToMessage(),
            Row("user", 6, new JsonObject { ["text"] = "recent small" }),
        ];
        Assert.Empty(CompactCandidateBuilder.Build(history, keepPercent: 0).Items);
        var candidates = CompactCandidateBuilder.Build(history, inContext: true);
        var args = Plan(6);
        args["replaceAsBlocks"]!
            .AsArray()
            .Add(
                new JsonObject
                {
                    ["level"] = 2,
                    ["sourceKind"] = "block",
                    ["sourceStart"] = 7,
                    ["sourceEnd"] = 7,
                    ["summary"] = "Single child.",
                }
            );
        Assert.Equal(2, CompactPlanValidator.Validate(args, candidates).Operations.Count);
        Assert.Throws<CompactPlanInvalidException>(() =>
            CompactPlanValidator.Validate(Plan(3), candidates)
        );
        Assert.Throws<CompactPlanInvalidException>(() =>
            CompactPlanValidator.Validate(Plan(1, 6), candidates)
        );
        var preserved = Plan(2, 3);
        preserved["preserveMessages"] = new JsonArray(3);
        Assert.Equal(
            new long[] { 2, 3 },
            CompactPlanValidator.Validate(preserved, candidates).Preserve.Order()
        );
    }

    [Fact]
    public async Task Middle_replacement_retains_unselected_display_and_skill_history_and_does_not_claim_it_was_compacted()
    {
        await using var fixture = await Fixture.CreateAsync(
            2,
            (f, index, _) =>
                Task.FromResult(
                    index == 0
                        ? new JsonArray(Call("plan", "submit_compact_plan", Plan()))
                        : Final()
                )
        );
        var display = Text("unselected display", "model");
        display["modelVisible"] = false;
        await fixture.AppendAsync(display);
        var skill = Text("retained skill call", "model");
        skill["parts"]!
            .AsArray()
            .Add(
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "prior-skill",
                        ["name"] = "skill",
                        ["args"] = new JsonObject
                        {
                            ["action"] = "load",
                            ["skillName"] = "retained-skill",
                        },
                    },
                }
            );
        await fixture.AppendAsync(skill);
        await fixture.AppendAsync(
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "prior-skill",
                            ["name"] = "skill",
                            ["response"] = new JsonObject
                            {
                                ["output"] = "retained skill instructions",
                            },
                        },
                    }
                ),
            }
        );
        var retained = fixture
            .Owner.History()
            .Where(row => CompactCandidateBuilder.Number(row["__meta"]?["seq"]) >= 4)
            .Select(row => row.ToJsonString())
            .ToArray();
        await fixture.RunAsync();
        var rows = fixture.Owner.History();
        Assert.All(retained, row => Assert.Contains(rows, active => active.ToJsonString() == row));
        var marker = Assert.Single(rows, CompactCandidateBuilder.Completion);
        Assert.DoesNotContain("retained-skill", marker.ToJsonString());
        Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
    }

    [Fact]
    public async Task Missing_false_mistyped_flags_and_current_exchange_sources_leave_history_uncompacted()
    {
        await using var fixture = await Fixture.CreateAsync(
            2,
            (f, index, _) =>
            {
                if (index > 0)
                    return Task.FromResult(Final());
                var missing = Plan();
                missing.Remove("inContext");
                var disabled = Plan();
                disabled["inContext"] = false;
                var wrongType = Plan();
                wrongType["inContext"] = "true";
                return Task.FromResult(
                    new JsonArray(
                        Call("missing", "submit_compact_plan", missing),
                        Call("disabled", "submit_compact_plan", disabled),
                        Call("wrong-type", "submit_compact_plan", wrongType),
                        Call("current", "submit_compact_plan", Plan(5))
                    )
                );
            }
        );
        await fixture.RunAsync();
        foreach (var id in new[] { "missing", "disabled", "wrong-type", "current" })
            Assert.NotNull(fixture.ToolResponse(id)["response"]!["error"]);
        Assert.Equal(0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.False(fixture.Owner.Compactor.Active);
        Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.False(
            CompactPrompt.ToolDefinition()["parameters"]!["properties"]!
                .AsObject()
                .ContainsKey("inContext")
        );
    }

    [Fact]
    public async Task Native_nested_toolscript_cannot_admit_a_foreground_compaction_plan()
    {
        await using var fixture = await Fixture.CreateAsync(
            2,
            (f, index, _) =>
                Task.FromResult(
                    index == 0
                        ? new JsonArray(
                            Call(
                                "script",
                                "run_script",
                                new JsonObject
                                {
                                    ["code"] = "return call_tool('submit_compact_plan', args)",
                                    ["args"] = Plan(),
                                }
                            )
                        )
                        : Final()
                )
        );
        await fixture.RunAsync();
        Assert.Contains(
            "compact_plan_invalid",
            fixture.ToolResponse("script")["response"]!.ToJsonString()
        );
        Assert.Equal(0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.False(fixture.Owner.Compactor.Active);
        Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
    }

    [Fact]
    public async Task Hidden_opt_in_does_not_bypass_the_existing_tool_policy()
    {
        await using var fixture = await Fixture.CreateAsync(
            2,
            (f, index, _) =>
                Task.FromResult(
                    index == 0
                        ? new JsonArray(Call("denied", "submit_compact_plan", Plan()))
                        : Final()
                )
        );
        var policy = Path.Combine(fixture.Data, "state", "tool-authorization.yaml");
        await File.WriteAllTextAsync(
            policy,
            "version: 1\nrules: [{id: deny-plan, action: deny, match: {tool: {source: builtin, name: submit_compact_plan}}}]\n"
        );
        fixture.Manager.Authorization.Invalidate();
        await fixture.RunAsync();
        Assert.Equal(
            "tool_authorization_denied",
            fixture.ToolResponse("denied")["response"]!["error"]!["type"]!.GetValue<string>()
        );
        Assert.Equal(0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.False(fixture.Owner.Compactor.Active);
    }
}
