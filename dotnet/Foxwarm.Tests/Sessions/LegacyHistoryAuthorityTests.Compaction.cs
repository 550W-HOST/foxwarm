using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class LegacyHistoryAuthorityTests
{
    private static JsonObject Operation(long start, long end) =>
        new()
        {
            ["level"] = 1,
            ["sourceKind"] = "message",
            ["sourceStart"] = start,
            ["sourceEnd"] = end,
            ["summary"] = "Retained numbered work.",
        };

    [Theory]
    [InlineData("call", false)]
    [InlineData("response", false)]
    [InlineData("notice", false)]
    [InlineData("call", true)]
    [InlineData("response", true)]
    [InlineData("notice", true)]
    public void Partly_identifiable_exchanges_are_retained_as_local_barriers(
        string missing,
        bool preserved
    )
    {
        JsonObject Row(string role, long seq, JsonObject part) =>
            new()
            {
                ["role"] = role,
                ["parts"] = new JsonArray(part),
                ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq },
            };
        JsonObject[] rows =
        [
            Row("user", 1, new JsonObject { ["text"] = new string('x', 7000) }),
            Row(
                "model",
                2,
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "paired",
                        ["name"] = "read",
                        ["args"] = new JsonObject(),
                    },
                }
            ),
            Row("model", 3, new JsonObject { ["text"] = "Display interruption" }),
            Row(
                "tool",
                4,
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = "paired",
                        ["name"] = "read",
                        ["response"] = "retained",
                    },
                }
            ),
            Row("user", 5, new JsonObject { ["text"] = new string('y', 7000) }),
        ];
        rows[2]["modelVisible"] = false;
        if (preserved)
            for (var index = 1; index <= 3; index++)
                rows[index]["__meta"]!["preservedFromBlockId"] = 1;
        var missingIndex =
            missing == "call" ? 1
            : missing == "notice" ? 2
            : 3;
        rows[missingIndex]["__meta"]!.AsObject().Remove("seq");
        foreach (var inContext in new[] { false, true })
        {
            var candidates = CompactCandidateBuilder.Build(
                rows,
                keepTokens: 0,
                inContext: inContext
            );
            Assert.Equal(new long[] { 1, 5 }, candidates.Items.Select(item => item.Start));
            Assert.Empty(candidates.Preserved);
            // In-context ranges stop at the exchange. The regular new level-1 block spans it,
            // and the commit keeps the unsequenced exchange after the block.
            JsonArray Spanning() => new(Operation(1, 5));
            JsonArray Split() => new(Operation(1, 1), Operation(5, 5));
            Assert.Throws<CompactPlanInvalidException>(() =>
                CompactPlanValidator.Validate(
                    new JsonObject { ["replaceAsBlocks"] = inContext ? Spanning() : Split() },
                    candidates
                )
            );
            var plan = CompactPlanValidator.Validate(
                new JsonObject { ["replaceAsBlocks"] = inContext ? Split() : Spanning() },
                candidates
            );
            Assert.Equal(inContext ? 2 : 1, plan.Operations.Count);
        }
    }

    [Fact]
    public async Task Unsequenced_display_only_history_is_not_discarded_by_provider_free_cleanup()
    {
        using var temp = new TempDirectory();
        await SessionUpgradeCompatibilityTests.Seed(temp.Path, "legacy");
        var file = Authority(temp.Path);
        var root = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        root["history"] = new JsonArray(
            new JsonObject
            {
                ["role"] = "model",
                ["modelVisible"] = false,
                ["parts"] = new JsonArray(
                    new JsonObject { ["text"] = "Only retained historical diagnostic" }
                ),
            }
        );
        root["meta"]!["messageCount"] = 1;
        await File.WriteAllTextAsync(file, root.ToJsonString());
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            temp.Path,
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("legacy");
        Assert.True((await owner.Compactor.StartManualAsync(keepPercent: 0)).Started);
        await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(10));
        EqualHistory(root["history"]!.AsArray(), owner.Entry.Snapshot().History);
        Assert.Empty(owner.Archive.ReadMessages());
        Assert.Empty(owner.Archive.ReadBlocks());
    }
}
