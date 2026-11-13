using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class InContextCompactTests
{
    // `tool call` reaches submit_compact_plan with the same rejected-plan recovery as a direct
    // call; malformed valuesJson is a ctl parse error before any target is named.
    [Theory]
    [InlineData("builtin:submit_compact_plan", false)]
    [InlineData("builtin:submit_compact_plan", true)]
    [InlineData(null, false)]
    [InlineData(null, true)]
    public async Task Tool_call_compact_targets_preserve_rejected_plans(string? toolId, bool malformed)
    {
        var submitted = Plan(9999).ToJsonString();
        if (malformed)
            submitted = submitted[..^1];
        await using var f = await Fixture.CreateAsync(
            2,
            (_, index, _) =>
            {
                if (index > 0)
                    return Task.FromResult(Final());
                var wrapper = new JsonObject { ["argsJson"] = submitted };
                if (toolId is not null)
                    wrapper["toolId"] = toolId;
                else
                {
                    wrapper["source"] = "builtin";
                    wrapper["name"] = "submit_compact_plan";
                }
                return Task.FromResult(new JsonArray(Call("unified", "ctl", CtlTestArgs.Unified(wrapper))));
            }
        );
        await f.RunAsync();
        var result = f.ToolResponse("unified")["response"]!;
        if (malformed)
        {
            Assert.Equal("invalid_command", SessionWait.Text(result["error"]?["type"]));
            Assert.Null(result["argsFilePath"]);
        }
        else
        {
            Assert.Equal("compact_plan_invalid", SessionWait.Text(result["error"]?["type"]));
            Assert.True(
                JsonNode.DeepEquals(
                    JsonNode.Parse(submitted),
                    JsonNode.Parse(await File.ReadAllTextAsync(result["argsFilePath"]!.GetValue<string>()))
                )
            );
        }
        Assert.Equal(0, f.Owner.Entry.Snapshot().HistoryVersion);
    }
}
