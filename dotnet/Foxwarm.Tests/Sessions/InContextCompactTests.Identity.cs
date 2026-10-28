using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class InContextCompactTests
{
    [Theory]
    [InlineData("builtin:submit_compact_plan ", null, false)]
    [InlineData("builtin:submit_compact_plan ", null, true)]
    [InlineData(null, " builtin ", false)]
    [InlineData(null, " builtin ", true)]
    public async Task Dispatcher_normalized_compact_targets_preserve_rejected_inner_JSON(
        string? toolId,
        string? source,
        bool malformed
    )
    {
        var submitted = Plan(9999).ToJsonString();
        if (malformed)
            submitted = submitted[..^1];
        await using var f = await Fixture.CreateAsync(2, (_, index, _) =>
        {
            if (index > 0)
                return Task.FromResult(Final());
            var wrapper = new JsonObject { ["argsJson"] = submitted };
            if (toolId is not null)
                wrapper["toolId"] = toolId;
            else
            {
                wrapper["source"] = source;
                wrapper["name"] = "submit_compact_plan";
            }
            return Task.FromResult(new JsonArray(Call("unified", "call_tool", wrapper)));
        });
        await f.RunAsync();
        var result = f.ToolResponse("unified")["response"]!;
        Assert.Equal("compact_plan_invalid", SessionWait.Text(result["error"]?["type"]));
        Assert.Equal(submitted, await File.ReadAllTextAsync(result["argsFilePath"]!.GetValue<string>()));
        Assert.Equal(0, f.Owner.Entry.Snapshot().HistoryVersion);
    }
}
